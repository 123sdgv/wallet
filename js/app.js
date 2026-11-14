// ============================================================
// app.js — 启动：底部导航、页面切换、快捷指令入口、离线缓存
// ============================================================

let page = 'home'; // 当前页面：home / cal / settings

const PAGES = {
  home: { title: '首页', view: viewHome, bind: bindHome },
  cal: { title: '日历', view: viewCal, bind: bindCal },
  settings: { title: '我的', view: viewSettings, bind: bindSettings },
};

// ---------- 底部导航 ----------
const NAV = [
  ['page', 'home', '首页', '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>'],
  ['page', 'cal', '日历', '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'],
  ['act', 'add', '记一笔', '<path d="M12 5v14M5 12h14"/>'],
  ['page', 'settings', '我的', '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'],
];
$('nav').innerHTML = NAV.map(([kind, key, name, icon]) => kind === 'act'
  ? `<button type="button" class="plus" data-act="${key}" aria-label="${name}"><i><svg ${SV}>${icon}</svg></i><span>${name}</span></button>`
  : `<button type="button" data-page="${key}"><svg ${SV}>${icon}</svg><span>${name}</span></button>`).join('');

$('nav').addEventListener('click', e => {
  if (e.target.closest('button[data-act]')) {
    openAddSheet('rec', page === 'cal' ? S.ui.calDay : null);
    return;
  }
  const btn = e.target.closest('button[data-page]');
  if (!btn) return;
  page = btn.dataset.page;
  if (page !== 'settings') S.ui.setPanel = null;
  save();
  render();
});

// ---------- 渲染 ----------
function render() {
  const p = PAGES[page] || PAGES.home;
  $('title').textContent = p.title;
  document.querySelectorAll('#nav button[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $('view').innerHTML = p.view();
  $('view').onclick = null;
  p.bind();
}

// ---------- 快捷指令记账 ----------
// 用法：index.html?quickadd=expense&amount=12.5&note=午饭&account=微信&tag=伙食
//   quickadd  expense（支出）或 income（收入）
//   account   账户名称或 id，不填用第一个账户
//   tag       标签名称或 id（支出用），不填用「其他」
//   budget=0  这笔记成预算外
function handleQuickAddURL() {
  const params = new URLSearchParams(location.search);
  const type = params.get('quickadd');
  if (type !== 'expense' && type !== 'income') return false;

  const amount = r2(params.get('amount') || 0);
  const note = (params.get('note') || '').slice(0, 60);
  const accParam = params.get('account') || '';
  const tagParam = params.get('tag') || '';
  history.replaceState(null, '', location.pathname);

  if (!(amount > 0)) { renderQuickAddResult(false, '金额无效，没有记录任何内容。'); return true; }
  const account = S.accounts.find(a => a.id === accParam || a.name === accParam) || S.accounts[0];
  if (!account) { renderQuickAddResult(false, '没有可用账户。'); return true; }

  const tx = { id: uid(), ts: Date.now(), type, amount, accountId: account.id, date: today(), note, refunded: false };
  if (type === 'expense') {
    const tg = S.tags.find(t => t.id === tagParam || t.name === tagParam) || S.tags.find(t => t.id === 'other') || S.tags[0];
    tx.tagId = tg?.id;
    tx.item = note || '快捷指令支出';
    if (params.get('budget') === '0') tx.noBudget = true;
  } else {
    tx.item = note || '快捷指令收入';
  }
  applyTx(tx, 1);
  S.txs.unshift(tx);
  save();
  const what = type === 'expense' ? (tx.noBudget ? '预算外支出' : '支出') : '收入';
  renderQuickAddResult(true, `已记录 ${what} ${money(amount)}${note ? '，' + esc(note) : ''}（${esc(account.name)}）`);
  return true;
}

function renderQuickAddResult(ok, message) {
  const icon = ok ? '<path d="M20 6L9 17l-5-5"/>' : '<path d="M18 6L6 18M6 6l12 12"/>';
  document.body.innerHTML = `
  <div style="max-width:430px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;background:${ok ? '#f7f8f8' : '#fef2f2'}">
    <div style="width:64px;height:64px;border-radius:50%;background:${ok ? '#0d9488' : '#dc2626'};display:flex;align-items:center;justify-content:center;margin-bottom:16px">
      <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" style="width:32px;height:32px">${icon}</svg>
    </div>
    <div style="font-size:16px;font-weight:600;color:#111827;line-height:1.6">${message}</div>
    <a href="index.html" style="margin-top:20px;color:#0d9488;font-size:13px;font-weight:600;text-decoration:none">打开完整应用 ›</a>
  </div>`;
}

// ---------- 启动 ----------
if (!handleQuickAddURL()) render();

// 离线缓存（见 sw.js）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
