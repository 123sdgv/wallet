// ============================================================
// calc.js — 所有「算钱」的逻辑：账户、预算、流水对余额的影响、总结统计
// 这里只算数，不碰页面。
// ============================================================

// ---------- 查找 ----------
function acc(id) { return S.accounts.find(a => a.id === id); }

function tag(id) {
  return S.tags.find(t => t.id === id)
    || S.tags.find(t => t.id === 'other')
    || { id: '', name: '其他', color: '#94a3b8' };
}

// ---------- 账户与可安排 ----------
function allocSum(map) { return S.accounts.reduce((a, x) => a + Number((map || {})[x.id] || 0), 0); }
function safeAllocOn(id) { return Number((S.safeAlloc || {})[id] || 0); }
function goalAllocOn(g, id) { return (g.log || []).reduce((a, x) => a + (x.acc === id ? Number(x.amt) : 0), 0); }
function goalsOn(id) { return S.goals.reduce((a, g) => a + goalAllocOn(g, id), 0); }
function syncGoal(g) {
  g.log = g.log || [];
  g.saved = r2(g.log.reduce((s, x) => s + Number(x.amt), 0));
}

// 某个账户扣掉安全余额和专项之后还能自由安排的钱
function accFree(a) { return r2(Number(a.balance || 0) - safeAllocOn(a.id) - goalsOn(a.id)); }
function totalAssets() { return S.accounts.reduce((a, b) => a + Number(b.balance || 0), 0); }
function savings() { return S.goals.reduce((a, b) => a + Number(b.saved || 0), 0); }
function free() { return r2(totalAssets() - Number(S.settings.safe || 0) - savings()); }

// ---------- 流水 ----------
const isRefund = t => t.type === 'expense' && Number(t.amount) < 0;
// 真实发生的支出（退款是负数支出，会自然冲抵）
const isExpense = t => t.type === 'expense' && !t.refunded;
// 算进预算的支出：预算外（noBudget）的不算
const inBudget = t => isExpense(t) && !t.noBudget;
const sumAmount = list => list.reduce((a, t) => a + Number(t.amount || 0), 0);
const inPeriod = (t, p) => periodKey(t.date) === p;

// 一条流水对账户余额的影响。sign=1 记上，sign=-1 撤销（删除或修改前）
function applyTx(t, sign = 1) {
  if (t.refunded) return;
  const amt = Number(t.amount || 0) * sign;
  const from = acc(t.accountId);
  if (t.type === 'transfer') {
    const to = acc(t.toAccountId);
    if (from) from.balance = r2(from.balance - amt);
    if (to) to.balance = r2(to.balance + amt);
  } else if (t.type === 'income') {
    if (from) from.balance = r2(from.balance + amt);
  } else if (t.type === 'expense') {
    if (from) from.balance = r2(from.balance - amt); // 退款金额是负数，这里就是加回去
  }
}

// ---------- 预算 ----------
function budget(p = periodKey()) {
  if (!S.budgets[p]) S.budgets[p] = { total: 0, set: false, tagLimits: {} };
  return S.budgets[p];
}

// 本月已花（只算预算内）
function spentTotal(p = periodKey()) {
  return sumAmount(S.txs.filter(t => inBudget(t) && inPeriod(t, p)));
}

// 某个标签本月已花（只算预算内）
function spentByTag(tagId, p = periodKey()) {
  return sumAmount(S.txs.filter(t => inBudget(t) && t.tagId === tagId && inPeriod(t, p)));
}

// 本月预算外支出合计
function offBudgetTotal(p = periodKey()) {
  return sumAmount(S.txs.filter(t => isExpense(t) && t.noBudget && inPeriod(t, p)));
}

// 本月还能花；没设预算返回 null
function remain(p = periodKey()) {
  const b = budget(p);
  return b.set ? Number(b.total) - spentTotal(p) : null;
}

// ---------- 月度 / 年度总结 ----------
// 日均、各标签、最贵一笔、最高一天、超额标签都只看预算内的「日常」支出；
// 预算外的大额（比如买手机）单独列出来，不拉高日均。
function calcSummary(mode, year, month) {
  const prefix = mode === 'year' ? String(year) : month;
  const all = S.txs.filter(t => isExpense(t) && t.date.startsWith(prefix));
  const daily = all.filter(t => !t.noBudget);
  const off = all.filter(t => t.noBudget).sort((a, b) => Number(b.amount) - Number(a.amount));

  // 统计天数：到今天为止（未来的日子不算）
  const now = new Date();
  let start, end;
  if (mode === 'year') {
    start = new Date(year, 0, 1);
    end = new Date(year, 11, 31);
  } else {
    const [y, m] = month.split('-').map(Number);
    start = new Date(y, m - 1, 1);
    end = new Date(y, m, 0);
  }
  const last = end > now ? now : end;
  const days = Math.max(1, Math.floor((last - start) / 86400000) + 1);

  const byTag = {};
  const byDay = {};
  let maxTx = null;
  daily.forEach(t => {
    const amt = Number(t.amount);
    const k = t.tagId || 'other';
    byTag[k] = (byTag[k] || 0) + amt;
    byDay[t.date] = (byDay[t.date] || 0) + amt;
    if (amt > 0 && (!maxTx || amt > Number(maxTx.amount))) maxTx = t;
  });

  let topDay = null;
  Object.entries(byDay).forEach(([d, v]) => { if (!topDay || v > topDay[1]) topDay = [d, v]; });

  // 超额：每个月每个设了上限的标签，超了多少（只算预算内）
  const months = mode === 'year'
    ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    : [month];
  const overMap = {};
  let overTotal = 0;
  months.forEach(mk => {
    const bd = S.budgets[mk];
    if (!bd) return;
    if (bd.set) overTotal += Math.max(0, spentTotal(mk) - Number(bd.total || 0));
    Object.keys(bd.tagLimits || {}).forEach(tid => {
      const over = spentByTag(tid, mk) - Number(bd.tagLimits[tid]);
      if (over > 0) overMap[tid] = (overMap[tid] || 0) + over;
    });
  });
  let topOver = null;
  Object.entries(overMap).forEach(([k, v]) => { if (!topOver || v > topOver[1]) topOver = [k, v]; });

  return {
    total: sumAmount(all),
    dailyTotal: sumAmount(daily),
    offTotal: sumAmount(off),
    off,
    days,
    count: all.length,
    byTag,
    maxTx,
    topDay,
    topOver,
    overTotal,
  };
}
