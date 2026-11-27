// ============================================================
// store.js — 数据：默认结构、读写本地存储、旧数据迁移、通用小工具
// 所有数据只存在手机浏览器的 localStorage 里，没有服务器。
// ============================================================

const KEY = 'sober_wallet_v3';

// 第一次打开时的默认标签（之后可以在「我的 → 消费标签」里改）
const DEFAULT_TAGS = () => [
  { id: 'fixed', name: '固定支出', color: '#475569' },
  { id: 'daily', name: '日常生活', color: '#0d9488' },
  { id: 'temp', name: '临时必要', color: '#0891b2' },
  { id: 'meal', name: '正常吃饭', color: '#16a34a' },
  { id: 'takeout', name: '外卖', color: '#f59e0b' },
  { id: 'snack', name: '零食饮料', color: '#db2777' },
  { id: 'consumable', name: '消耗品', color: '#7c3aed' },
  { id: 'upgrade', name: '功能升级', color: '#c2410c' },
  { id: 'stock', name: '囤货', color: '#a16207' },
  { id: 'hobby', name: '兴趣手工', color: '#0ea5e9' },
  { id: 'fun', name: '娱乐', color: '#dc2626' },
  { id: 'gift', name: '礼物', color: '#e11d48' },
  { id: 'other', name: '其他', color: '#94a3b8' },
];

/*
 * 数据结构说明
 * accounts: [{ id, name, balance }]                    账户和余额
 * tags:     [{ id, name, color }]                      消费标签
 * txs:      流水，最新的在前面
 *   支出 { type:'expense', amount, accountId, tagId, item, note, date, noBudget? }
 *   退款 { type:'expense', amount: 负数, ... }          负数支出，会冲抵已花
 *   收入 { type:'income', amount, accountId, item, note, date }
 *   转账 { type:'transfer', amount, accountId(转出), toAccountId(转入), date }
 *   noBudget: true 表示「预算外」：照常扣余额、算进当月支出，但不占预算、不算进日均
 * plans:    消费计划 [{ id, item, amount, tagId, accountId, date, note, inBudget }]
 * budgets:  { '2026-11': { total, set, tagLimits: { 标签id: 金额 } } }
 * safeAlloc: { 账户id: 金额 }                           每个账户里锁住的安全余额
 * goals:    专项储蓄 [{ id, name, target, saved, log: [{ id, acc, amt, ts }] }]
 * memos:    资金备忘，纯文字 [{ id, text, ts }]。不影响任何金额
 */
const DEFAULT = () => ({
  settings: { safe: 0 },
  accounts: [
    { id: 'cash', kind: 'cash', name: '现金', balance: 0, note: '' },
    { id: 'wechat', kind: 'wechat', name: '微信', balance: 0, note: '' },
    { id: 'alipay', kind: 'alipay', name: '支付宝', balance: 0, note: '' },
    { id: 'bank', kind: 'bank', name: '银行卡', balance: 0, note: '' },
  ],
  tags: DEFAULT_TAGS(),
  safeAlloc: {},
  budgets: {},
  goals: [],
  plans: [],
  txs: [],
  memos: [],
  ui: { month: ym(new Date()), setPanel: null, calDay: null, calFilter: null },
});

// ---------- 小工具 ----------
function uid() {
  return Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-2);
}

// 本地日期 YYYY-MM-DD
function today(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function ym(d) { return today(d).slice(0, 7); }
function periodKey(date = today()) { return date.slice(0, 7); }
function periodName(k) { return `${Number(k.slice(5, 7))}月`; }

// 保留两位小数
function r2(n) { return Math.round(Number(n || 0) * 100) / 100; }

// ¥12.5 / -¥3（整数不显示 .00）
function money(n) {
  n = r2(n);
  const s = Math.abs(n).toFixed(2).replace(/\.00$/, '');
  return (n < 0 ? '-' : '') + '¥' + s;
}
const moneyS = money; // 旧名字，保留兼容

// 防止名字里有 < > 之类的字符把页面弄乱
function esc(s) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, m => map[m]);
}

// 快速记账没填备注时自动生成的名字
function isGenericItem(item) {
  return !item || /^(快速|快捷指令)(支出|收入)$/.test(item);
}

// ---------- 读写 ----------
// 旧版本数据迁移：专项改为存取流水；安全余额总数由各账户分配汇总；清掉已下线功能的数据
function migrate(d) {
  delete d.api;
  delete d.sessions;
  delete d.chat;
  if (d.settings) {
    delete d.settings.modelOn;
    delete d.settings.quizAmount;
  }
  if (d.ui) delete d.ui.curSession;

  (d.goals || []).forEach(g => {
    if (!Array.isArray(g.log)) {
      g.log = [];
      const al = g.alloc || {};
      Object.keys(al).forEach(k => {
        if (Number(al[k]) > 0) g.log.push({ id: uid(), acc: k, amt: Number(al[k]), ts: Date.now() });
      });
      const unassigned = r2(Number(g.saved || 0) - g.log.reduce((s, x) => s + x.amt, 0));
      if (unassigned > 0.004 && d.accounts && d.accounts[0]) {
        g.log.push({ id: uid(), acc: d.accounts[0].id, amt: unassigned, ts: Date.now() });
      }
    }
    g.saved = r2(g.log.reduce((s, x) => s + x.amt, 0));
    delete g.alloc;
  });

  d.safeAlloc = d.safeAlloc || {};
  const safeSum = Object.values(d.safeAlloc).reduce((a, b) => a + Number(b || 0), 0);
  if (safeSum > 0) d.settings.safe = r2(safeSum);
  return d;
}

// 把读到的数据和默认结构合并，缺的字段补上
function normalize(parsed) {
  const base = DEFAULT();
  const merged = Object.assign(base, parsed, {
    settings: Object.assign(base.settings, parsed.settings || {}),
    ui: Object.assign(base.ui, parsed.ui || {}),
    tags: Array.isArray(parsed.tags) && parsed.tags.length ? parsed.tags : base.tags,
  });
  ['accounts', 'txs', 'plans', 'goals', 'memos'].forEach(k => {
    if (!Array.isArray(merged[k])) merged[k] = [];
  });
  // 资金备忘改成了纯文字，旧格式（带金额币种的）不再保留
  merged.memos = merged.memos.filter(m => typeof m.text === 'string');
  delete merged.settings.lastBackup;
  // 每次打开都回到当月，不停留在上次翻到的月份
  merged.ui.month = ym(new Date());
  merged.ui.calDay = null;
  if (merged.ui.setPanel === 'accounts') merged.ui.setPanel = null;
  return migrate(merged);
}

function load() {
  if (globalThis.walletSandbox) return walletSandbox.load(DEFAULT);
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalize(JSON.parse(raw)) : DEFAULT();
  } catch {
    return DEFAULT();
  }
}

function save() {
  if (globalThis.walletSandbox) return walletSandbox.save(S);
  globalThis.walletPages?.beforeSave();
  localStorage.setItem(KEY, JSON.stringify(S));
  globalThis.walletPages?.saved();
}

// 全局数据，所有页面都读写它
let S = load();
try { save(); } catch {}
