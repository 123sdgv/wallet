import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { applyPage, exchange, initial, localEdit } from '../phone/state.js';

const defaults = () => ({ txs: [], accounts: [], ui: {}, budgets: {}, tags: [], plans: [], goals: [], memos: [], settings: {} });
function addLocal(book, amount) {
  const s = structuredClone(book.ledger);
  s.accounts[0].balance = (Math.round(s.accounts[0].balance * 100) - amount) / 100;
  s.txs.unshift({ id: randomUUID(), accountId: 'cash', type: 'expense', amount: amount / 100, note: 'device-only fixture' });
  return localEdit(book, s, randomUUID);
}
function ledger() {
  const rows = [];
  return { rows, post(args) {
    if (args.expected_revision !== rows.length) return { error: 'revision_conflict' };
    const balance = (rows.at(-1)?.balance_fen ?? 10000) - args.amount_fen;
    rows.push({ operation_id: args.operation_id, revision: rows.length + 1, expense_fen: args.amount_fen,
      balance_fen: balance, recorded_at: '2026-11-26T10:00:00Z' });
    return { operation_id: args.operation_id, receipt_revision: rows.length };
  }, pull(after) { return { dataset: 'synthetic', currency: 'CNY', revision: rows.length, balance_fen: rows.at(-1)?.balance_fen ?? 10000, changes: rows.slice(after, after + 1) }; } };
}
test('offline postings survive restart and lost replies; later MCP postings arrive once', async () => {
  let book = addLocal(initial(defaults), 77);
  const cloud = ledger();
  cloud.post({ operation_id: randomUUID(), expected_revision: 0, amount_fen: 123 });
  const opts = { read: () => book, persist: value => { book = JSON.parse(JSON.stringify(value)); }, pull: r => cloud.pull(r),
    post: args => { assert.deepEqual(Object.keys(args).sort(), ['amount_fen', 'expected_revision', 'operation_id']); cloud.post(args); throw Error('lost response'); } };
  await assert.rejects(exchange(opts), /lost response/);
  assert.equal(book.pending[0].expected, 1);
  assert.equal(cloud.rows.length, 2);
  book = JSON.parse(JSON.stringify(book));
  await exchange({ ...opts, post: () => assert.fail('already committed') });
  assert.equal(book.pending.length, 0);
  assert.equal(book.ledger.accounts[0].balance, 98);
  assert.equal(book.ledger.txs.length, 2);
  assert.equal(book.ledger.txs.filter(t => t.note === 'device-only fixture').length, 1);
  cloud.post({ operation_id: randomUUID(), expected_revision: 2, amount_fen: 1 });
  await exchange(opts);
  assert.equal(book.ledger.accounts[0].balance, 97.99);
  assert.equal(book.revision, 3);
});
test('changed version pauses with a durable local operation, and a new local edit during a pull is retained', async () => {
  let book = addLocal(initial(defaults), 12);
  const cloud = ledger();
  const opts = { read: () => book, persist: b => { book = b; }, pull: r => cloud.pull(r),
    post: args => { cloud.post({ operation_id: randomUUID(), expected_revision: 0, amount_fen: 50 }); return cloud.post(args); } };
  await exchange(opts);
  assert.equal(book.conflict, true);
  const id = book.pending[0].id;
  book.pending[0].expected = null; book.conflict = false;
  let first = true;
  await exchange({ ...opts, pull: r => {
    if (first) { first = false; book = addLocal(book, 9); }
    return cloud.pull(r);
  }, post: args => cloud.post(args) });
  assert.equal(cloud.rows[1].operation_id, id);
  assert.equal(book.revision, 3);
  assert.equal(book.ledger.accounts[0].balance, 99.29);
  assert.throws(() => applyPage(book, { ...cloud.pull(3), revision: 0 }));
});
