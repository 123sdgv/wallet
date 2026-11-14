// ============================================================
// summary.js — 「我的 → 消费总结」：月度 / 年度
// 日均和各项排行只看预算内的日常支出；预算外的大额单独列出来。
// ============================================================

function sumState() {
  const u = S.ui;
  const now = new Date();
  if (!u.sumMode) u.sumMode = 'month';
  if (!u.sumYear) u.sumYear = now.getFullYear();
  if (!u.sumMonth) u.sumMonth = ym(now);
  return u;
}

// 流水显示用的名字：没备注的显示标签名
function txName(t) {
  return isGenericItem(t.item) ? tag(t.tagId).name : t.item;
}

function viewSummary(back) {
  const u = sumState();
  const R = calcSummary(u.sumMode, u.sumYear, u.sumMonth);
  const mm = (u.sumMonth || '').slice(5, 7) || '01';
  const title = u.sumMode === 'year' ? `${u.sumYear} 年` : `${u.sumYear} 年 ${Number(mm)} 月`;

  const monthGrid = u.sumMode === 'month'
    ? `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px">
        ${Array.from({ length: 12 }, (_, i) => {
          const k = `${u.sumYear}-${String(i + 1).padStart(2, '0')}`;
          return `<button type="button" class="quiz-opt ${k === u.sumMonth ? 'active' : ''}" data-sm="${k}" style="text-align:center">${i + 1}月</button>`;
        }).join('')}
      </div>`
    : '';

  const tagRows = Object.entries(R.byTag)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const t = tag(k);
      return `<div class="row" style="padding:8px 0">
        <span class="nm"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</span>
        <span><b>${money(v / R.days)}</b><span class="muted"> /天 · 共 ${money(v)}</span></span>
      </div>`;
    }).join('');

  const mx = R.maxTx;
  const budgetRow = u.sumMode === 'month' && S.budgets[u.sumMonth]?.set
    ? (() => {
      const bd = S.budgets[u.sumMonth];
      const used = spentTotal(u.sumMonth);
      const over = used - Number(bd.total || 0);
      return `<div class="row item"><span class="muted">预算执行</span><span style="text-align:right">
        <b style="${over > 0 ? 'color:var(--danger)' : ''}">${over > 0 ? '超 ' + money(over) : '剩 ' + money(-over)}</b>
        <div class="muted">已花 ${money(used)} / ${money(bd.total)}</div></span></div>`;
    })()
    : u.sumMode === 'year' && R.overTotal > 0.004
      ? `<div class="row item"><span class="muted">各月超出总预算</span><span style="text-align:right"><b style="color:var(--danger)">${money(R.overTotal)}</b><div class="muted">全年合计</div></span></div>`
      : '';

  const offCard = R.off.length ? `
    <div class="card">
      <div class="section-title" style="margin-top:0"><h2>预算外支出</h2><b>${money(R.offTotal)}</b></div>
      <div class="muted" style="margin:-4px 2px 6px">不占预算，也不算进上面的日均</div>
      ${R.off.map(t => `<div class="row item">
        <div class="nm" style="min-width:0"><span class="dot" style="background:${tag(t.tagId).color}"></span>${esc(txName(t))}<div class="muted">${t.date} · ${esc(tag(t.tagId).name)}</div></div>
        <b>${money(t.amount)}</b>
      </div>`).join('')}
    </div>` : '';

  const body = R.count ? `
    <div class="hero" style="margin-bottom:14px">
      <div class="metric"><span>总消费</span><b>${money(R.total)}</b>${R.offTotal ? `<small>含预算外 ${money(R.offTotal)}</small>` : ''}</div>
      <div class="metric big"><span>日均消费</span><b>${money(R.dailyTotal / R.days)}</b>${R.offTotal ? '<small>不含预算外</small>' : `<small>共 ${R.days} 天</small>`}</div>
    </div>
    ${tagRows ? `<div class="card"><div class="section-title" style="margin-top:0"><h2>各标签日均</h2></div>${tagRows}</div>` : ''}
    <div class="card">
      <div class="row item" style="padding-top:0"><span class="muted">单笔最贵</span><span style="text-align:right">
        <b>${mx ? money(mx.amount) : '-'}</b><div class="muted">${mx ? esc(txName(mx)) + ' · ' + mx.date : ''}</div></span></div>
      <div class="row item"><span class="muted">消费最高那天</span><span style="text-align:right">
        <b>${R.topDay ? money(R.topDay[1]) : '-'}</b><div class="muted">${R.topDay ? R.topDay[0] : ''}</div></span></div>
      ${budgetRow}
      <div class="row item"><span class="muted">超额最厉害的标签</span><span style="text-align:right">
        ${R.topOver ? `<b style="color:var(--danger)">${esc(tag(R.topOver[0]).name)}</b><div class="muted">超 ${money(R.topOver[1])}</div>` : '<b>没有超额</b>'}</span></div>
    </div>
    ${offCard}` : `<div class="card"><div class="empty">${title}还没有支出记录</div></div>`;

  return `<div class="section-title"><h2>消费总结</h2>${back}</div>
  <div class="card">
    <div class="segmented">
      <button type="button" class="qa-type ${u.sumMode === 'month' ? 'active' : ''}" data-sum-mode="month">月度总结</button>
      <button type="button" class="qa-type ${u.sumMode === 'year' ? 'active' : ''}" data-sum-mode="year">年度总结</button>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="ib" type="button" id="sumPrevY">${svgBack()}</button><b>${u.sumYear} 年</b><button class="ib" type="button" id="sumNextY">${svgNext()}</button>
    </div>
    ${monthGrid}
  </div>${body}`;
}

function bindSummary() {
  const u = sumState();
  const shiftYear = d => {
    u.sumYear += d;
    u.sumMonth = u.sumYear + '-' + (u.sumMonth || '').slice(5, 7);
    save();
    render();
  };
  $('sumPrevY').onclick = () => shiftYear(-1);
  $('sumNextY').onclick = () => shiftYear(1);
  document.querySelectorAll('[data-sum-mode]').forEach(b => b.onclick = () => { u.sumMode = b.dataset.sumMode; save(); render(); });
  document.querySelectorAll('[data-sm]').forEach(b => b.onclick = () => { u.sumMonth = b.dataset.sm; save(); render(); });
}
