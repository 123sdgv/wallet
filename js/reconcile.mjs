// Read-only totals for checking a Wallet ledger before and after migration.
// Account balances are authoritative even when transaction history has been cleared.
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function reconcileWallet(s) {
  const collections = ['accounts','tags','txs','goals','plans','memos'];
  if (!isObject(s) || !collections.every(k => Array.isArray(s[k])) || !isObject(s.budgets)
      || !isObject(s.settings) || !isObject(s.safeAlloc)) throw Error('账本结构不完整，请保留原始备份。');
  const issues = new Set();
  function cents(value, label) {
    if (typeof value !== 'number' && !(typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value))) {
      throw Error(label + '存在无效金额。');
    }
    const n = Number(value), result = Math.round(n * 100);
    if (!Number.isSafeInteger(result) || n !== result / 100) throw Error(label + '存在超出范围或精度超过分的金额。');
    return result;
  }
  function add(left, right) {
    const sum = left + right;
    if (!Number.isSafeInteger(sum)) throw Error('合计金额超出可核对范围。');
    return sum;
  }
  function sumValues(values, label) { return values.reduce((a, x) => add(a, cents(x, label)), 0); }
  const ids = {};
  const counts = {};
  for (const name of collections) {
    counts[name] = s[name].length;
    ids[name] = new Set();
    for (const item of s[name]) {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || ids[name].has(item.id)) {
        throw Error('记录编号缺失或重复，无法逐笔核对。');
      }
      ids[name].add(item.id);
    }
  }
  const accounts = s.accounts.map(a => ({ id: a.id, name: a.name, balance_fen: cents(a.balance, '账户') }));
  const assets = accounts.reduce((a, row) => add(a, row.balance_fen), 0);
  const safe = cents(s.settings.safe ?? 0, '安全余额');
  const allocated = sumValues(Object.values(s.safeAlloc), '安全余额分配');
  if (safe !== allocated) issues.add('安全余额总数与各账户分配不一致');
  if (Object.keys(s.safeAlloc).some(id => !ids.accounts.has(id))) issues.add('安全余额分配引用了已移除的账户');
  let savings = 0;
  for (const g of s.goals) {
    const saved = cents(g.saved, '专项储蓄');
    savings = add(savings, saved);
    if (!Array.isArray(g.log)) { issues.add('旧版专项缺少存取明细'); continue; }
    const total = sumValues(g.log.map(x => x.amt), '专项存取');
    if (saved !== total) issues.add('专项储蓄金额与存取明细不一致');
    if (g.log.some(x => !ids.accounts.has(x.acc))) issues.add('专项存取引用了已移除的账户');
  }
  const months = new Map();
  function month(key) {
    if (!monthPattern.test(key)) throw Error('预算月份或流水日期无效。');
    if (!months.has(key)) months.set(key, { month: key, budget_fen: null, in_budget_fen: 0, off_budget_fen: 0, refund_fen: 0 });
    return months.get(key);
  }
  for (const [key, b] of Object.entries(s.budgets)) {
    if (!isObject(b) || !isObject(b.tagLimits ?? {})) throw Error('月预算结构无效。');
    const total = sumValues(Object.values(b.tagLimits ?? {}), '分类预算');
    month(key).budget_fen = total > 0 ? total : null;
    if (b.total !== undefined && cents(b.total, '月预算') !== total) issues.add('已存月预算与分类额度合计不一致');
  }
  let refunds = 0;
  for (const tx of s.txs) {
    if (!['expense','transfer','income'].includes(tx.type)) throw Error('流水存在无法识别的类型。');
    if (typeof tx.date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(tx.date)) throw Error('流水日期无效。');
    const parsed = new Date(tx.date + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== tx.date) throw Error('流水日期无效。');
    const group = month(tx.date.slice(0, 7)), value = cents(tx.amount, '流水');
    if (!ids.accounts.has(tx.accountId) || (tx.type === 'transfer' && !ids.accounts.has(tx.toAccountId))) issues.add('历史流水引用了已移除的账户');
    if (tx.type !== 'expense' || tx.refunded) continue;
    const field = tx.noBudget ? 'off_budget_fen' : 'in_budget_fen';
    group[field] = add(group[field], value);
    if (value < 0) { group.refund_fen = add(group.refund_fen, -value); refunds = add(refunds, -value); }
  }
  counts.budgets = Object.keys(s.budgets).length;
  return { currency: 'CNY', counts, accounts, assets_fen: assets, safe_fen: safe, savings_fen: savings,
    free_fen: add(add(assets, -safe), -savings), refund_fen: refunds,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ ...m,
      remaining_fen: m.budget_fen === null ? null : add(m.budget_fen, -m.in_budget_fen) })), issues: [...issues] };
}
