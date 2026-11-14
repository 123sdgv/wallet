// ============================================================
// calendar.js — 日历页：月历、当月流水列表、各标签折线图
// ============================================================

// 流水排序：日期新的在前，同一天按记录时间
const cmpTx = (a, b) => b.date.localeCompare(a.date) || ((b.ts || 0) - (a.ts || 0));

function viewCal() {
  const month = S.ui.month || ym(new Date());
  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();

  const monTxs = S.txs.filter(t => t.date.startsWith(month));
  const monIncome = sumAmount(monTxs.filter(t => t.type === 'income'));
  const monExpense = sumAmount(monTxs.filter(isExpense));
  const monOff = sumAmount(monTxs.filter(t => isExpense(t) && t.noBudget));

  // 月历格子
  let cells = '';
  for (let i = 0; i < firstWeekday; i++) cells += '<div></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${month}-${String(d).padStart(2, '0')}`;
    const dayTxs = monTxs.filter(t => t.date === ds);
    const exp = sumAmount(dayTxs.filter(isExpense));
    const inc = sumAmount(dayTxs.filter(t => t.type === 'income'));
    const cls = ['day', 'on', ds === today() ? 'today' : '', S.ui.calDay === ds ? 'sel' : ''].join(' ');
    let marks = inc ? `<i>+${inc.toFixed(0)}</i>` : '';
    if (exp > 0.004) marks += `<em>-${exp.toFixed(0)}</em>`;
    else if (exp < -0.004) marks += `<i>+${Math.abs(exp).toFixed(0)}</i>`;
    cells += `<button type="button" class="${cls}" data-day="${ds}"><b>${d}</b>${marks}</button>`;
  }

  // 下面的流水列表（全部显示，不再截断）
  const dayFilter = S.ui.calDay;
  const f = S.ui.calFilter || null;
  const base = (dayFilter ? S.txs.filter(t => t.date === dayFilter) : monTxs).slice().sort(cmpTx);
  const income = f === 'expense' ? [] : base.filter(t => t.type === 'income');
  const expense = f === 'income' ? [] : base.filter(t => t.type === 'expense');
  const transfer = f ? [] : base.filter(t => t.type === 'transfer');
  const label = (txt, color, first) => f ? '' : `<div class="muted" style="margin:${first ? '0 0 4px' : '10px 0 4px'};color:${color}">${txt}</div>`;
  const total = income.length + expense.length + transfer.length;

  return `
  <div class="card">
    <div class="row">
      <button class="ib" type="button" id="prevM">${svgBack()}</button>
      <button type="button" id="monthChartBtn" style="border:0;background:transparent;font-weight:700;font-size:15px;color:var(--text);display:flex;align-items:center;gap:5px">${month} ${svgChartIcon()}</button>
      <button class="ib" type="button" id="nextM">${svgNext()}</button>
    </div>
    <div class="hero" style="margin-top:6px">
      <div class="metric"><span>${m}月收入</span><b style="color:#047857">${money(monIncome)}</b></div>
      <div class="metric"><span>${m}月支出</span><b style="color:#b91c1c">${money(monExpense)}</b>${monOff > 0.004 ? `<small>含预算外 ${money(monOff)}</small>` : ''}</div>
    </div>
    <div class="cal" style="margin-top:12px">
      ${['日', '一', '二', '三', '四', '五', '六'].map(x => `<div class="hd">${x}</div>`).join('')}${cells}
    </div>
  </div>
  <div class="section-title">
    <div style="display:flex;align-items:baseline;gap:12px">
      <h2>${dayFilter || m + '月流水'}</h2>
      <button type="button" class="fl inc ${f === 'income' ? 'on' : f ? 'off' : ''}" data-fl="income">收入</button>
      <button type="button" class="fl exp ${f === 'expense' ? 'on' : f ? 'off' : ''}" data-fl="expense">支出</button>
    </div>
    ${dayFilter ? '<button class="lnk" type="button" id="clearDay">看全月</button>' : ''}
  </div>
  <div class="card" id="dayList">
    ${income.length ? label('收入', '#047857', true) + income.map(txLine).join('') : ''}
    ${expense.length ? label('支出', '#b91c1c', !income.length) + expense.map(txLine).join('') : ''}
    ${transfer.length ? `<div class="muted" style="margin:10px 0 4px">内部转账（不计收支）</div>${transfer.map(txLine).join('')}` : ''}
    ${!total ? '<div class="empty">这里还没有流水</div>' : ''}
    ${total ? '<div class="muted" style="text-align:center;padding-top:10px">点一条可以修改 · 左滑删除</div>' : ''}
  </div>`;
}

// 一条流水
function txLine(t) {
  const refund = isRefund(t);
  const plus = t.type === 'income' || refund;
  const sign = plus ? '+' : t.type === 'expense' ? '-' : '';
  const color = plus ? '#047857' : t.type === 'expense' ? '#b91c1c' : '#0d9488';
  const tg = t.tagId ? tag(t.tagId) : null;
  const generic = isGenericItem(t.item);

  const title = generic && tg
    ? `<span class="dot" style="background:${tg.color}"></span>${esc(tg.name)}`
    : esc(t.item || t.type);
  const accName = id => esc(acc(id)?.name || '未知账户');
  const where = t.type === 'transfer' ? `${accName(t.accountId)} → ${accName(t.toAccountId)}` : accName(t.accountId);
  const sub = [
    t.date,
    where,
    tg && !generic ? esc(tg.name) : '',
    refund ? '退款' : '',
    t.refunded ? '已退款' : '',
  ].filter(Boolean).join(' · ');
  const amount = Math.abs(Number(t.amount)).toFixed(2).replace(/\.00$/, '');

  const inner = `<div class="row tappable" data-open-tx="${t.id}">
    <div style="min-width:0">
      <div style="font-weight:600${t.refunded ? ';text-decoration:line-through;color:#9ca3af' : ''}">${title}${t.noBudget ? offTag() : ''}</div>
      <div class="muted">${sub}</div>
    </div>
    <div style="font-weight:700;color:${color};flex:0 0 auto">${sign}${amount}</div>
  </div>`;
  return swipeRow(inner, `data-del-tx="${t.id}"`);
}

function bindCal() {
  const shiftMonth = d => {
    const [y, m] = S.ui.month.split('-').map(Number);
    S.ui.month = ym(new Date(y, m - 1 + d, 1));
    S.ui.calDay = null;
    save();
    render();
  };
  $('prevM').onclick = () => shiftMonth(-1);
  $('nextM').onclick = () => shiftMonth(1);
  $('monthChartBtn').onclick = () => openMonthChart(S.ui.month || ym(new Date()));
  document.querySelectorAll('[data-day]').forEach(b => b.onclick = () => {
    S.ui.calDay = S.ui.calDay === b.dataset.day ? null : b.dataset.day;
    save();
    render();
  });
  const cd = $('clearDay');
  if (cd) cd.onclick = () => { S.ui.calDay = null; save(); render(); };
  document.querySelectorAll('[data-fl]').forEach(b => b.onclick = () => {
    S.ui.calFilter = S.ui.calFilter === b.dataset.fl ? null : b.dataset.fl;
    save();
    render();
  });

  const guard = bindSwipe($('view'));
  document.querySelectorAll('[data-open-tx]').forEach(el => el.onclick = () => {
    if (guard(el)) return;
    openTxEditor(el.dataset.openTx);
  });
  document.querySelectorAll('[data-del-tx]').forEach(b => b.onclick = () => deleteTx(b.dataset.delTx));
}

// ---------- 月度折线图：按标签分线 ----------
// 预算外的大额不画进去（不然一笔手机钱会把其他线全压扁），在下面注明
function openMonthChart(month) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const map = {};
  let offSum = 0;
  S.txs.forEach(t => {
    if (!isExpense(t) || !t.date.startsWith(month)) return;
    if (t.noBudget) { offSum += Number(t.amount); return; }
    const tg = tag(t.tagId);
    const key = tg.id || 'other';
    if (!map[key]) map[key] = { key, label: tg.name, color: tg.color, data: Array(days).fill(0), total: 0 };
    const d = Number(t.date.slice(8, 10)) - 1;
    map[key].data[d] += Number(t.amount);
    map[key].total += Number(t.amount);
  });
  const series = Object.values(map).filter(s => s.total > 0).sort((a, b) => b.total - a.total);
  const offNote = offSum > 0.004 ? `<div class="muted" style="margin-top:8px">不含预算外支出 ${money(offSum)}</div>` : '';

  openModal(`<div class="row"><h3>${month} 各标签支出</h3>${closeBtn()}</div>
    ${series.length
      ? `<canvas id="monthChartCanvas" class="chart-modal-canvas"></canvas><div class="chart-legend" id="chartLegend"></div>`
      : '<div class="empty">这个月还没有支出记录</div>'}
    ${offNote}`);
  $('mc').onclick = closeModal;
  if (!series.length) return;

  let sel = null;
  const paint = () => {
    drawLineChart('monthChartCanvas', sel ? series.filter(s => s.key === sel) : series);
    const box = $('chartLegend');
    box.innerHTML = `<button type="button" class="chart-chip ${sel ? '' : 'active'}" data-k="">全部</button>`
      + series.map(s => `<button type="button" class="chart-chip ${sel === s.key ? 'active' : ''}" data-k="${esc(s.key)}"><i style="background:${s.color}"></i>${esc(s.label)} ${money(s.total)}</button>`).join('');
    box.querySelectorAll('.chart-chip').forEach(b => b.onclick = () => {
      const k = b.dataset.k;
      sel = (k === '' || k === sel) ? null : k;
      paint();
    });
  };
  paint();
}

function drawLineChart(canvasId, series) {
  const canvas = $(canvasId);
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 360;
  const h = rect.height || 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const max = Math.max(1, ...series.flatMap(s => s.data));
  const days = series[0]?.data.length || 30;
  const padL = 32, padR = 10, padT = 10, padB = 20;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const x = i => padL + (i / (days - 1 || 1)) * plotW;
  const yy = v => padT + plotH - (Math.max(0, v) / max) * plotH;

  // 网格和刻度
  ctx.strokeStyle = '#eef0f2';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#9ca3af';
  ctx.font = '9px -apple-system,sans-serif';
  for (let i = 0; i <= 3; i++) {
    const val = max / 3 * i;
    ctx.beginPath();
    ctx.moveTo(padL, yy(val));
    ctx.lineTo(w - padR, yy(val));
    ctx.stroke();
    ctx.fillText(Math.round(val), 2, yy(val) + 3);
  }
  ctx.textAlign = 'center';
  [1, Math.round(days / 2), days].forEach(d => ctx.fillText(d + '日', x(d - 1), h - 6));

  // 每个标签一条线
  series.forEach(s => {
    if (!s.data.some(v => v > 0)) return;
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.data.forEach((v, i) => (i === 0 ? ctx.moveTo(x(i), yy(v)) : ctx.lineTo(x(i), yy(v))));
    ctx.stroke();
    s.data.forEach((v, i) => {
      if (v > 0) { ctx.beginPath(); ctx.arc(x(i), yy(v), 2.5, 0, Math.PI * 2); ctx.fill(); }
    });
  });
}
