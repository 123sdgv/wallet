import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { Miniflare } from 'miniflare';
import { recordTransaction, readAccountBalances, readTransactionChanges } from '../business-ledger.js';

test('D1 postings agree with the Wallet calculation and preserve receipts and paged changes under concurrent writes', async t => {
  const mf = new Miniflare({ modules: true, script: 'export default {}', cf: false,
    host: '127.0.0.1', compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const schema = await readFile(new URL('../business-schema.sql', import.meta.url), 'utf8');
  for (const statement of schema.replace(/^--.*$/gm, '').trim().split(/\n\s*\n/)) {
    await db.prepare(statement).run();
  }
  await db.prepare("INSERT INTO wallet_accounts VALUES ('a',10000), ('b',2500)").run();
  const accounts = [{ id: 'a', balance: 100 }, { id: 'b', balance: 25 }];
  const app = vm.createContext({ S: { accounts, txs: [], budgets: {}, goals: [], settings: {} },
    r2: n => Math.round(n * 100) / 100, periodKey: date => date.slice(0, 7) });
  vm.runInContext(await readFile(new URL('../../js/calc.js', import.meta.url), 'utf8'), app);
  const first = { operation_id: randomUUID(), expected_revision: 0, kind: 'expense',
    amount_fen: 123, account_id: 'a', tag_id: 'daily', local_date: '2026-11-26', item: '虚拟午餐' };
  const ops = [first,
    { ...first, operation_id: randomUUID(), expected_revision: 1, kind: 'income', tag_id: null },
    { ...first, operation_id: randomUUID(), expected_revision: 2, kind: 'refund', amount_fen: 12 },
    { ...first, operation_id: randomUUID(), expected_revision: 3, kind: 'transfer', tag_id: null, to_account_id: 'b' },
    { ...first, operation_id: randomUUID(), expected_revision: 4, off_budget: true }];
  for (const op of ops) {
    const receipt = await recordTransaction(db, op);
    assert.equal(receipt.receipt_revision, op.expected_revision + 1);
    app.tx = { type: op.kind === 'refund' ? 'expense' : op.kind,
      amount: op.amount_fen / 100 * (op.kind === 'refund' ? -1 : 1), accountId: op.account_id,
      toAccountId: op.to_account_id, noBudget: op.off_budget, tagId: op.tag_id, date: op.local_date };
    vm.runInContext('applyTx(tx); S.txs.push(tx)', app);
    const balances = await readAccountBalances(db);
    assert.equal(balances.revision, receipt.revision);
    assert.deepEqual(balances.accounts.map(a => a.balance_fen), accounts.map(a => Math.round(a.balance * 100)));
  }
  assert.deepEqual(await recordTransaction(db, first), {
    operation_id: first.operation_id, revision: 5, receipt_revision: 1, replayed: true });
  assert.equal((await recordTransaction(db, { ...first, note: 'changed' })).error, 'operation_id_reused');
  const page = await readTransactionChanges(db, 0, null, 2);
  assert.deepEqual(page.changes.map(c => c.revision), [1, 2]);
  const next = { ...first, expected_revision: 5, operation_id: randomUUID() };
  const both = await Promise.all([next, { ...next, operation_id: randomUUID() }].map(op => recordTransaction(db, op)));
  assert.equal(both.filter(x => x.receipt_revision === 6).length, 1);
  assert.equal(both.filter(x => x.error === 'revision_conflict').length, 1);
  const rest = await readTransactionChanges(db, page.next_revision, page.through_revision);
  assert.deepEqual(rest.changes.map(c => c.revision), [3, 4, 5]);
  assert.equal(rest.has_more, false);
  assert.equal((await readTransactionChanges(db, rest.next_revision)).changes[0].revision, 6);

  const state = await readAccountBalances(db);
  for (const invalid of [{ amount_fen: 1.1 }, { local_date: '2026-02-30' }, { kind: 'transfer', to_account_id: 'a' },
    { account_id: 'missing' }, { kind: 'transfer', tag_id: null, to_account_id: 'missing' }, { kind: 'delete' }]) {
    const failed = await recordTransaction(db, { ...next, operation_id: randomUUID(), expected_revision: 6, ...invalid });
    assert.ok(failed.error);
  }
  assert.deepEqual(await readAccountBalances(db), state);
});
