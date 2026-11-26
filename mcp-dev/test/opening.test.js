import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Miniflare } from 'miniflare';
import { reconcileWallet } from '../../js/reconcile.mjs';
import { openingLedger, initializeOpeningLedger } from '../opening-ledger.js';
import { addLedgerPosting } from '../financial-write.js';
import { readAccountBalances } from '../business-ledger.js';

function fixture() {
  const s = { settings: { safe: 10 }, accounts: [{ id: 'cash', name: '测试 A', balance: 80 }, { id: 'bank', name: '测试 B', balance: 220 }],
    safeAlloc: { cash: 10 }, tags: [{ id: 'daily', name: '虚拟' }], budgets: { '2026-11': { total: 25, set: true, tagLimits: { daily: 25 } } },
    goals: [{ id: 'g', name: '测试目标', saved: 20, target: 50, log: [{ id: 'g1', amt: 20, acc: 'bank', ts: 1 }] }],
    plans: [{ id: 'p', status: 'open', amount: 50, item: '虚拟计划' }], memos: [{ id: 'm', text: '虚拟备忘', ts: 1 }],
    txs: [], ui: { setPanel: 'data' }, sessions: ['local-only-marker'] };
  s.txs = [{ type: 'expense', amount: 5 }, { type: 'expense', amount: -1.2 }, { type: 'expense', amount: 10, noBudget: true },
    { type: 'expense', amount: 40, refunded: true }, { type: 'transfer', amount: 99, toAccountId: 'bank' },
    { type: 'income', amount: 1, date: '2026-12-01' }].map((t, i) => ({ id: String(i + 1), accountId: 'cash', date: '2026-11-26', ...t }));
  return s;
}
test('migration totals agree with the original Wallet and leave all source fields untouched', async () => {
  const source = fixture(), original = JSON.stringify(source);
  const local = vm.createContext({ S: structuredClone(source), r2: n => Math.round(100*n)/100, periodKey: date => date.slice(0,7) });
  vm.runInContext(await readFile(new URL('../../js/calc.js', import.meta.url), 'utf8'), local);
  const { ledger, report } = openingLedger(source);
  assert.deepEqual(report.issues, []);
  for (const [name, expression] of [['assets_fen','totalAssets()'],['free_fen','free()'],['savings_fen','savings()']]) {
    assert.equal(report[name], Math.round(100*vm.runInContext(expression, local)));
  }
  assert.equal(report.accounts[0].balance_fen,8000);
  assert.equal(report.refund_fen,120);
  const [nov,dec] = report.months;
  for (const [name, expression] of [['in_budget_fen','spentTotal'],['off_budget_fen','offBudgetTotal'],['remaining_fen','remain']]) {
    assert.equal(nov[name], Math.round(100*vm.runInContext(expression+"('2026-11')",local)));
  }
  assert.equal(dec.remaining_fen,null);
  assert.equal(JSON.stringify(source),original);
  assert.doesNotMatch(JSON.stringify(ledger),/local-only-marker|setPanel/);
  assert.deepEqual(reconcileWallet(ledger),report);
  const altered=fixture();altered.goals[0].saved=30;
  assert.ok(reconcileWallet(altered).issues.length);
  assert.throws(()=>openingLedger(altered),/needs_review/);
  const extra=fixture();extra.txs[0].unrecognized='fixture';
  assert.throws(()=>openingLedger(extra),/unrecognized/);
});
test('opening initialization is atomic and retries never overwrite later account balances', async t => {
  const mf = new Miniflare({ modules:true, script:'export default {}', host:'127.0.0.1', cf:false, compatibilityDate:'2026-07-01', d1Databases:['DB'] });
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB');
  const sql=await readFile(new URL('../business-schema.sql',import.meta.url),'utf8');
  for(const statement of sql.replace(/^--.*$/gm,'').trim().split(/\n\s*\n/)) await db.prepare(statement).run();
  const s=fixture();
  const parallel=await Promise.all([initializeOpeningLedger(db,s),initializeOpeningLedger(db,s)]);
  assert.deepEqual(parallel.map(r=>r.replayed).sort(),[false,true]);
  assert.equal((await readAccountBalances(db)).accounts.find(a=>a.id==='cash').balance_fen,8000);
  const expense = {operation_id:crypto.randomUUID(),expected_revision:0,kind:'expense',amount_fen:123,account_id:'cash',local_date:'2026-11-26'};
  const first = await addLedgerPosting(db,expense);
  assert.deepEqual(first.account_changes,[{id:'cash',before_fen:8000,after_fen:7877}]);
  assert.equal((await initializeOpeningLedger(db,s)).replayed,true);
  assert.equal((await readAccountBalances(db)).accounts.find(a=>a.id==='cash').balance_fen,7877);
  const transfer = {...expense,operation_id:crypto.randomUUID(),expected_revision:1,kind:'transfer',to_account_id:'bank',amount_fen:20};
  const moved = await addLedgerPosting(db,transfer);
  assert.deepEqual(moved.account_changes,[{id:'bank',before_fen:22000,after_fen:22020},{id:'cash',before_fen:7877,after_fen:7857}]);
  const replayed = await addLedgerPosting(db,expense);
  assert.equal(replayed.replayed,true);
  assert.deepEqual(replayed.account_changes,first.account_changes);
  const changed=fixture();changed.accounts[0].balance=95;
  assert.equal((await initializeOpeningLedger(db,changed)).error,'opening_already_in_use');
  const stored=await db.prepare('SELECT ledger_json FROM wallet_opening').first();
  assert.doesNotMatch(stored.ledger_json,/local-only-marker|setPanel/);
  assert.deepEqual(JSON.parse(stored.ledger_json),openingLedger(s).ledger);
});
