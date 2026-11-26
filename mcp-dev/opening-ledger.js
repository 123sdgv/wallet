import { reconcileWallet } from '../js/reconcile.mjs';

const fields = {
  accounts: 'id kind name balance note', tags: 'id name color',
  txs: 'id ts type amount accountId toAccountId tagId item note date noBudget refunded',
  plans: 'id status amount tagId accountId item date note inBudget createdAt',
  memos: 'id text ts', goals: 'id name target saved', log: 'id acc amt ts',
};
const scalar = value => ['number','string','boolean'].includes(typeof value) || value === null;
function pick(record, names, nested = []) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('invalid_record');
  const result = {};
  const keys = names.split(' ');
  for (const key of Object.keys(record)) {
    if (!keys.includes(key) && !nested.includes(key)) throw Error('unrecognized_financial_field');
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (!scalar(value) || (typeof value === 'number' && !Number.isFinite(value))) throw Error('invalid_financial_field');
    result[key] = value;
  }
  return result;
}
function moneyMap(map = {}) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) throw Error('invalid_allocations');
  const entries = Object.entries(map).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [id, value] of entries) {
    if (!/^[\w-]{1,96}$/.test(id) || ['constructor', 'prototype', '__proto__'].includes(id)
        || !scalar(value)) throw Error('invalid_allocation');
  }
  return Object.fromEntries(entries);
}

// Ordered key projection makes receipts insensitive to JSON object-key order. UI and credentials never enter the snapshot.
export function openingLedger(source) {
  const report = reconcileWallet(source);
  if (report.issues.length) throw Error('opening_needs_review');
  const ledger = { settings: pick(source.settings, 'safe'), safeAlloc: moneyMap(source.safeAlloc) };
  for (const kind of ['accounts','tags','txs','plans','memos']) ledger[kind] = source[kind].map(x => pick(x, fields[kind]));
  ledger.goals = source.goals.map(g => ({ ...pick(g, fields.goals, ['log']), log: g.log.map(x => pick(x, fields.log)) }));
  ledger.budgets = Object.fromEntries(Object.keys(source.budgets).sort().map(month => {
    const b = source.budgets[month];
    return [month, { ...pick(b, 'total set', ['tagLimits']), tagLimits: moneyMap(b.tagLimits) }];
  }));
  return { ledger, report };
}

// Called by migration tests with fictitious data. There is deliberately no HTTP upload route.
export async function initializeOpeningLedger(db, source) {
  const { ledger, report } = openingLedger(source);
  const json = JSON.stringify(ledger);
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > 512 * 1024) throw Error('opening_too_large');
  const fingerprint = await crypto.subtle.digest('SHA-256', bytes);
  const digest = Array.from(new Uint8Array(fingerprint), n => n.toString(16).padStart(2, '0')).join('');
  const session = db.withSession('first-primary');
  const [created, , stored] = await session.batch([
    session.prepare(`INSERT INTO wallet_opening (singleton, digest, ledger_json)
      SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM wallet_accounts)
      AND NOT EXISTS (SELECT 1 FROM wallet_transactions) ON CONFLICT(singleton) DO NOTHING RETURNING singleton`).bind(digest, json),
    session.prepare(`INSERT INTO wallet_accounts(id, balance_fen)
      SELECT json_extract(a.value,'$.id'), CAST(round(json_extract(a.value,'$.balance') * 100) AS INTEGER)
      FROM wallet_opening o, json_each(o.ledger_json,'$.accounts') a
      WHERE o.singleton = 1 AND o.digest = ? AND changes() > 0`).bind(digest),
    session.prepare('SELECT digest FROM wallet_opening WHERE singleton = 1'),
  ]);
  if (stored.results[0]?.digest !== digest) return { error: 'opening_already_in_use' };
  return { digest, replayed: created.results.length === 0, report };
}
