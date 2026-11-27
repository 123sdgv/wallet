import { reconcileWallet } from '../js/reconcile.mjs';

export const FULL_READ = 'wallet:ledger:read';
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const kinds = ['accounts','tags','goals','plans','memos','txs'];
const jsonSchema = scopes => [{ type: 'oauth2', scopes }];
const scopes = jsonSchema(['wallet:read', FULL_READ]);
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
function tool(name, title, description, properties, required = []) {
  return { name, title, description, inputSchema: { type: 'object', additionalProperties: false, properties, required },
    annotations, securitySchemes: scopes, _meta: { securitySchemes: scopes } };
}
export const financialReads = [
  tool('get_financial_overview', '查询账本概览', 'Ledger balances in integer CNY fen. Includes the requested month’s budget, net spending and refunds. No notes or transaction details.', {
    month: { type: 'string', pattern: monthPattern.source },
  }),
  tool('get_financial_records', '按需查询账本记录', 'Read one limited page of accounts, tags, savings goals, plans, memos or transactions. Use a revision from the first page for later pages. Transaction filters apply before pagination. Amount fields in original Wallet records are CNY yuan.', {
    collection: { type: 'string', enum: kinds }, month: { type: 'string', pattern: monthPattern.source },
    account_id: { type:'string', maxLength:96 }, tag_id: { type:'string', maxLength:96 },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, revision: { type: 'integer', minimum: 0 },
  }, ['collection']),
];

function dateInShanghai() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0,7);
}

export const changeAsWalletTx = `json_object('id', operation_id, 'ts', CAST(unixepoch(recorded_at, 'subsec') * 1000 AS INTEGER),
  'type', CASE kind WHEN 'refund' THEN 'expense' ELSE kind END,
  'amount', (CASE kind WHEN 'refund' THEN -amount_fen ELSE amount_fen END) / 100.0,
  'date',local_date,'accountId',account_id,'toAccountId',to_account_id,'tagId',tag_id,'item',item,'note',note,
  'noBudget',json(CASE off_budget WHEN 1 THEN 'true' ELSE 'false' END),'refunded',json('false'))`;
const head = 'SELECT revision FROM wallet_latest_version';

function validate(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const schema = financialReads.find(t => t.name === name)?.inputSchema;
  if (!schema || Object.keys(args).some(k => !Object.hasOwn(schema.properties,k))) return false;
  if (args.month !== undefined && (typeof args.month !== 'string' || !monthPattern.test(args.month))) return false;
  if (name === 'get_financial_overview') return true;
  if (!kinds.includes(args.collection)) return false;
  for (const k of ['offset','limit','revision']) if (args[k] !== undefined && (!Number.isSafeInteger(args[k]) || args[k]<0)) return false;
  if (args.limit !== undefined && (args.limit<1 || args.limit>50)) return false;
  for (const k of ['tag_id','account_id']) if (args[k] !== undefined && (typeof args[k] !== 'string' || !args[k] || args[k].length>96)) return false;
  return args.collection === 'txs' || [args.account_id,args.tag_id,args.month].every(v=>v===undefined);
}

export async function readFinancial(db, name, args) {
  if (!validate(name,args)) return { error: 'invalid_arguments' };
  const session = db.withSession('first-primary');
  if (name === 'get_financial_overview') {
    const month = args.month ?? dateInShanghai();
    const [opening, version, live, activity] = await session.batch([
      session.prepare('SELECT ledger_json FROM wallet_effective_opening WHERE singleton = 1'), session.prepare(head),
      session.prepare('SELECT id, balance_fen FROM wallet_accounts ORDER BY id'),
      session.prepare(`SELECT SUM(CASE WHEN off_budget=0 THEN net ELSE 0 END) AS inside,
        SUM(CASE WHEN off_budget=1 THEN net ELSE 0 END) AS outside,
        SUM(CASE WHEN net<0 THEN -net ELSE 0 END) AS refunds FROM
        (SELECT off_budget, CASE kind WHEN 'refund' THEN -amount_fen ELSE amount_fen END AS net FROM wallet_transactions
         WHERE revision > (SELECT revision FROM wallet_effective_opening) AND kind IN ('expense','refund') AND local_date >= ? AND local_date < ?)`).bind(month+'-01',month+'-32'),
    ]);
    if (!opening.results.length) return { error: 'ledger_not_initialized' };
    const s = JSON.parse(opening.results[0].ledger_json);
    const balances = new Map(live.results.map(a=>[a.id,a.balance_fen]));
    for (const account of s.accounts) account.balance = balances.get(account.id) / 100;
    const report = reconcileWallet(s);
    const initialMonth = report.months.find(m=>m.month===month);
    const totals = activity.results[0];
    const budget = initialMonth?.budget_fen ?? null;
    const inside = (initialMonth?.in_budget_fen ?? 0) + (totals.inside ?? 0);
    return { as_of: new Date().toISOString(), revision: version.results[0].revision, currency: 'CNY',
      assets_fen: report.assets_fen, safe_fen: report.safe_fen, savings_fen: report.savings_fen, free_fen: report.free_fen,
      month, budget_fen: budget, in_budget_fen: inside, off_budget_fen: (initialMonth?.off_budget_fen ?? 0) + (totals.outside ?? 0),
      refund_fen: (initialMonth?.refund_fen ?? 0) + (totals.refunds ?? 0), remaining_fen: budget===null ? null : budget-inside };
  }
  const {collection, offset=0, limit=25} = args;
  let stmt;
  if (collection==='txs') {
    const conditions=[], bindings=[];
    if (args.month) { conditions.push("json_extract(row,'$.date') BETWEEN ? AND ?"); bindings.push(args.month+'-01',args.month+'-31'); }
    if (args.account_id) { conditions.push("(json_extract(row,'$.accountId')=? OR json_extract(row,'$.toAccountId')=?)"); bindings.push(args.account_id,args.account_id); }
    if (args.tag_id) { conditions.push("json_extract(row,'$.tagId')=?"); bindings.push(args.tag_id); }
    stmt=session.prepare(`WITH tx(row,seq) AS (
      SELECT j.value, -CAST(j.key AS INTEGER) FROM wallet_effective_opening o, json_each(o.ledger_json,'$.txs') j
      UNION ALL SELECT ${changeAsWalletTx},revision FROM wallet_transactions WHERE revision > (SELECT revision FROM wallet_effective_opening))
      SELECT row FROM tx ${conditions.length ? 'WHERE '+conditions.join(' AND ') : ''} ORDER BY seq DESC LIMIT ? OFFSET ?`).bind(...bindings,limit+1,offset);
  } else if (collection==='accounts') {
    stmt=session.prepare(`SELECT json_set(j.value,'$.balance',a.balance_fen/100.0) AS row FROM wallet_effective_opening o,
      json_each(o.ledger_json,'$.accounts') j JOIN wallet_accounts a ON a.id=json_extract(j.value,'$.id')
      ORDER BY CAST(j.key AS INTEGER) LIMIT ? OFFSET ?`).bind(limit+1,offset);
  } else {
    stmt=session.prepare(`SELECT j.value AS row FROM wallet_effective_opening o,json_each(o.ledger_json,?) j
      ORDER BY CAST(j.key AS INTEGER) LIMIT ? OFFSET ?`).bind('$.'+collection,limit+1,offset);
  }
  const [opening, version, rows]=await session.batch([session.prepare('SELECT singleton FROM wallet_effective_opening WHERE singleton=1'),session.prepare(head),stmt]);
  if (!opening.results.length) return {error:'ledger_not_initialized'};
  const revision=version.results[0].revision;
  if (args.revision!==undefined && args.revision!==revision) return {error:'revision_conflict',revision};
  return {as_of:new Date().toISOString(),revision,currency:'CNY',collection,records:rows.results.slice(0,limit).map(r=>JSON.parse(r.row)),
    next_offset:rows.results.length>limit ? offset+limit : null};
}
