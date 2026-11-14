// ============================================================
// memo.js — 资金备忘：记下钱放在哪
// 比如往 Apple 账号充了 $30，记账时已经算作支出了，
// 但钱其实还在那里没用 —— 在这里记一笔，免得以后忘了。
// 备忘只是提醒，不影响账户余额、预算和统计。
// ============================================================

const CURRENCIES = [
  ['CNY', '¥', '人民币'],
  ['USD', '$', '美元'],
  ['HKD', 'HK$', '港币'],
  ['JPY', 'JP¥', '日元'],
  ['EUR', '€', '欧元'],
  ['GBP', '£', '英镑'],
];
const curSign = code => (CURRENCIES.find(c => c[0] === code) || CURRENCIES[0])[1];
const curColor = code => ({ CNY: '#0d9488', USD: '#16a34a', HKD: '#dc2626', JPY: '#e11d48', EUR: '#2563eb', GBP: '#7c3aed' }[code] || '#64748b');

// $30 / ¥12.5
function memoMoney(amount, cur) {
  const n = r2(amount);
  return curSign(cur) + Math.abs(n).toFixed(2).replace(/\.00$/, '');
}

// 还没用完的，按币种合计：[['USD', 30], ['CNY', 50]]
function memoTotals() {
  const map = {};
  S.memos.filter(m => !m.done && Number(m.amount) > 0).forEach(m => {
    map[m.cur] = r2((map[m.cur] || 0) + Number(m.amount));
  });
  return Object.entries(map);
}

// 「我的」入口下面那行小字
function memoSummaryText() {
  const open = S.memos.filter(m => !m.done);
  if (!open.length) return '记下钱放在哪，比如 Apple 账号余额';
  const totals = memoTotals().map(([c, v]) => memoMoney(v, c)).join(' · ');
  return `${open.length} 笔钱在别处${totals ? '：' + totals : ''}`;
}

function memoRow(m) {
  const sub = [m.note ? esc(m.note) : '', m.date].filter(Boolean).join(' · ');
  const amount = Number(m.amount) > 0 ? `<b class="memo-amt">${memoMoney(m.amount, m.cur)}</b>` : '';
  return swipeRow(
    cell({
      attrs: `data-memo="${m.id}"`,
      badge: esc(curSign(m.cur)),
      color: m.done ? '#cbd5e1' : curColor(m.cur),
      title: esc(m.title),
      sub,
      end: amount,
      chevron: false,
      tag: 'div',
    }),
    `data-del-memo="${m.id}"`, '删除', 'padding:0');
}

function viewMemo(back) {
  const byTime = (a, b) => (b.date || '').localeCompare(a.date || '') || (b.ts || 0) - (a.ts || 0);
  const open = S.memos.filter(m => !m.done).sort(byTime);
  const done = S.memos.filter(m => m.done).sort(byTime);
  const totals = memoTotals();

  const head = `<div class="card soft memo-head">
    <div class="muted">还在别处的钱</div>
    <div class="memo-totals">${totals.length
      ? totals.map(([c, v]) => `<span>${memoMoney(v, c)}</span>`).join('')
      : '<span class="muted" style="font-size:14px;font-weight:600">暂时没有</span>'}</div>
    <div class="muted" style="line-height:1.5">记账时这些钱已经算作支出，这里只是提醒自己它们还在、放在哪。不影响余额和预算。</div>
  </div>`;

  const empty = `<div class="group"><div class="empty">
    还没有备忘<br>比如：Apple 账号里还有 $30、校园卡里有 ¥50、游戏账户的余额……
  </div></div>`;

  return `<div class="section-title"><h2>资金备忘</h2>${back}</div>
  ${head}
  <button class="btn block" type="button" id="addMemo" style="margin-bottom:6px">＋ 记一条</button>
  ${open.length ? `<div class="group-title">还在</div><div class="group">${open.map(memoRow).join('')}</div>` : (done.length ? '' : empty)}
  ${done.length ? `<div class="group-title">已用完</div><div class="group done-group">${done.map(memoRow).join('')}</div>` : ''}
  ${S.memos.length ? '<div class="foot-note">点一条修改 · 左滑删除</div>' : ''}`;
}

function bindMemo() {
  const guard = bindSwipe($('view'));
  $('addMemo').onclick = () => openMemoEditor(null);
  document.querySelectorAll('[data-memo]').forEach(el => el.onclick = () => {
    if (guard(el)) return;
    openMemoEditor(S.memos.find(m => m.id === el.dataset.memo));
  });
  document.querySelectorAll('[data-del-memo]').forEach(b => b.onclick = () => deleteMemo(b.dataset.delMemo));
}

function deleteMemo(id) {
  const m = S.memos.find(x => x.id === id);
  if (!m || !confirm(`删除备忘「${m.title}」？`)) return false;
  S.memos = S.memos.filter(x => x.id !== id);
  save();
  render();
  return true;
}

// 新增 / 编辑备忘。m 为空表示新增
function openMemoEditor(m) {
  const cur = m ? m.cur : 'CNY';
  openModal(`<div class="row"><h3>${m ? '编辑备忘' : '记一条资金备忘'}</h3>${closeBtn()}</div>
    <label class="field" style="margin-top:8px"><span>钱在哪</span><input id="mm_title" value="${m ? esc(m.title) : ''}" placeholder="比如：Apple 账号余额" maxlength="30"></label>
    <label class="field"><span>还剩多少（可不填）</span><input id="mm_amt" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${m && Number(m.amount) > 0 ? m.amount : ''}"></label>
    <div class="field"><span>币种</span><div class="chips">
      ${CURRENCIES.map(([code, sign, name]) => `<button type="button" class="quiz-opt${code === cur ? ' active' : ''}" data-cur="${code}">${sign} ${name}</button>`).join('')}
    </div></div>
    <label class="field"><span>日期</span><input id="mm_date" type="date" value="${m?.date || today()}"></label>
    <label class="field"><span>备注</span><textarea id="mm_note" style="min-height:64px" placeholder="比如：换号前的旧账号，可以拿来续会员">${m ? esc(m.note || '') : ''}</textarea></label>
    ${m ? `<div class="switch"><span>已经用完了<small>用完后会移到「已用完」，不再算进合计</small></span><input id="mm_done" type="checkbox" ${m.done ? 'checked' : ''}></div>` : ''}
    <div class="sheet-btns">
      ${m ? '<button class="btn danger" type="button" id="mm_del">删除</button>' : ''}
      <button class="btn" type="button" id="mm_ok">保存</button>
    </div>`);
  const root = $('modal');
  $('mc').onclick = closeModal;
  bindChips(root, 'cur');

  $('mm_ok').onclick = () => {
    const title = $('mm_title').value.trim();
    if (!title) return toast('写一下钱在哪');
    const data = {
      title,
      amount: r2($('mm_amt').value || 0),
      cur: picked(root, 'cur') || 'CNY',
      date: $('mm_date').value || today(),
      note: $('mm_note').value.trim(),
      done: m ? $('mm_done').checked : false,
    };
    if (m) Object.assign(m, data);
    else S.memos.unshift({ id: uid(), ts: Date.now(), ...data });
    save();
    closeModal();
    toast(m ? '已保存' : '已记下');
    render();
  };
  if (m) $('mm_del').onclick = () => { if (deleteMemo(m.id)) closeModal(); };
}
