// The preview only exchanges fixed-size expense receipts. Labels and notes stay on the device.
export const key = 'wallet.synthetic.phone.v1';
const fen = value => Math.round(value * 100);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function initial(defaults) {
  const ledger = defaults();
  ledger.accounts = [{ id: 'cash', kind: 'cash', name: '虚拟现金', balance: 100, note: '' }];
  return { format: 1, ledger, pending: [], revision: 0, balance_fen: 10000, lastSync: null, conflict: false };
}

export function localEdit(book, next, newId) {
  const old = book.ledger;
  const appended = next.txs.length === old.txs.length + 1 && eq(next.txs.slice(1), old.txs);
  const amount = appended ? fen(next.txs[0].amount) : 0;
  const tx = appended && next.txs[0];
  const account = next.accounts[0];
  if (next.accounts.length !== 1 || account?.id !== 'cash' || !Number.isFinite(account.balance)
      || (!appended && !eq(next.txs, old.txs))
      || (appended && (tx.accountId !== 'cash' || tx.type !== 'expense' || tx.refunded
        || !Number.isSafeInteger(amount) || amount < 1 || amount > 1000 || account.balance < 0))
      || fen(account.balance) !== fen(old.accounts[0].balance) - amount) {
    throw Error('此虚拟账本只同步新增的 0.01 至 10 元支出。刚才的改动没有保存。');
  }
  const updated = structuredClone(book);
  updated.ledger = structuredClone(next);
  if (appended) updated.pending.push({ id: newId(), localId: tx.id, amount, expected: null });
  return updated;
}

export function applyPage(book, page) {
  if (page.dataset !== 'synthetic' || page.currency !== 'CNY' || !Number.isSafeInteger(page.revision)
      || page.revision < book.revision || !Array.isArray(page.changes)) throw Error('云端版本与测试账本不一致。');
  const next = structuredClone(book);
  for (const row of page.changes) {
    if (row.revision !== next.revision + 1 || !Number.isInteger(row.expense_fen) || row.expense_fen <= 0
        || row.expense_fen > 1000 || row.balance_fen !== next.balance_fen - row.expense_fen
        || !/^[0-9a-f-]{36}$/.test(row.operation_id)) throw Error('虚拟流水校验失败。');
    const index = next.pending.findIndex(p => p.id === row.operation_id);
    if (index >= 0) {
      if (next.pending[index].amount !== row.expense_fen) throw Error('本机收据与云端不一致。');
      next.pending.splice(index, 1);
      if (index === 0) next.conflict = false;
    } else {
      const ts = Date.parse(row.recorded_at);
      const date = new Date(ts + 8 * 3600000).toISOString().slice(0, 10);
      next.ledger.txs.unshift({ id: row.operation_id, ts, type: 'expense', amount: row.expense_fen / 100,
        accountId: 'cash', tagId: 'other', item: '虚拟支出', note: '', date, refunded: false });
    }
    next.revision = row.revision;
    next.balance_fen = row.balance_fen;
  }
  if (next.revision > page.revision || (!page.changes.length && next.revision !== page.revision)
      || (next.revision === page.revision && next.balance_fen !== page.balance_fen)) throw Error('虚拟余额校验失败。');
  next.ledger.accounts[0].balance = (next.balance_fen - next.pending.reduce((n, p) => n + p.amount, 0)) / 100;
  return next;
}

export async function exchange({ read, persist, pull, post }) {
  async function catchUp() {
    for (;;) {
      const rev = read().revision;
      const page = await pull(rev);
      const updated = applyPage(read(), page);
      persist(updated);
      if (updated.revision === page.revision) return;
    }
  }
  await catchUp();
  while (read().pending.length && !read().conflict) {
    const book = structuredClone(read());
    const p = book.pending[0];
    if (p.expected === null) { p.expected = book.revision; persist(book); }
    const receipt = await post({ operation_id: p.id, expected_revision: p.expected, amount_fen: p.amount });
    if (receipt.error) {
      if (receipt.error !== 'revision_conflict') throw Error(receipt.error === 'insufficient_funds' ? '虚拟余额不足，待同步记录仍在本机。' : '写入被拒绝，已保留待同步记录。');
      await catchUp();
      if (read().pending[0]?.id === p.id) persist({ ...read(), conflict: true });
      return;
    }
    if (receipt.operation_id !== p.id || receipt.receipt_revision !== p.expected + 1) throw Error('收据不匹配，已保留待同步记录。');
    await catchUp();
    if (read().pending.some(item => item.id === p.id)) throw Error('云端收据暂未读回，稍后可安全重试。');
  }
  if (!read().conflict) persist({ ...read(), lastSync: new Date().toISOString() });
}
