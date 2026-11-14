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

  const isYear = u.sumMode === 'year';
  return `<div class="section-title"><h2>消费总结</h2>${back}</div>
  <div class="card period-bar">
    <button class="period-mode" type="button" id="sumMode" aria-label="${isYear ? '年' : '月'}">${isYear ? svgYear() : svgMonth()}</button>
    <span class="period-slash">/</span>
    <button class="period-date" type="button" id="sumDate">${isYear ? u.sumYear : u.sumMonth.replace('-', '.')}</button>
  </div>${body}`;
}

// 年 / 月 两个小图标
const svgMonth = () => `<svg ${SV}><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/><rect x="8" y="13" width="3" height="3" rx=".5" fill="currentColor" stroke="none"/></svg>`;
const svgYear = () => `<svg ${SV}><rect x="3" y="7" width="14" height="14" rx="2"/><path d="M3 11h14M7 5V3M13 5V3"/><path d="M7 4h11a3 3 0 0 1 3 3v10"/></svg>`;

function bindSummary() {
  const u = sumState();

  // 点图标：在「按月」和「按年」之间切换，下次进来还是上次的样子
  $('sumMode').onclick = () => {
    if (u.sumMode === 'month') {
      u.sumMode = 'year';
      u.sumYear = Number(u.sumMonth.slice(0, 4));
    } else {
      u.sumMode = 'month';
      u.sumMonth = u.sumYear + '-' + u.sumMonth.slice(5, 7);
    }
    save();
    render();
  };

  // 点日期：旁边弹出滚轮。按年只有年份；按月左边年份、右边月份
  $('sumDate').onclick = () => {
    const nowY = new Date().getFullYear();
    const firstY = Math.min(nowY - 5, ...S.txs.map(t => Number(t.date.slice(0, 4))).filter(Boolean));
    const years = [];
    for (let y = firstY; y <= nowY + 1; y++) years.push(y);
    const months = Array.from({ length: 12 }, (_, i) => i + 1);

    const cols = u.sumMode === 'year'
      ? [{ items: years, value: u.sumYear, label: y => y + '年' }]
      : [
        { items: years, value: Number(u.sumMonth.slice(0, 4)), label: y => y + '年' },
        { items: months, value: Number(u.sumMonth.slice(5, 7)), label: m => m + '月' },
      ];
    openWheel($('sumDate'), cols, vals => {
      if (u.sumMode === 'year') u.sumYear = vals[0];
      else {
        u.sumMonth = `${vals[0]}-${String(vals[1]).padStart(2, '0')}`;
        u.sumYear = vals[0];
      }
      save();
      render();
    });
  };
}

// ---------- 滚轮气泡 ----------
// anchor: 点的那个元素；cols: [{ items, value, label }]；onChange(各列选中的值)
const WHEEL_ROW = 36;
function openWheel(anchor, cols, onChange) {
  const mask = document.createElement('div');
  mask.className = 'wheel-mask';
  const pop = document.createElement('div');
  pop.className = 'wheel-pop';
  pop.innerHTML = cols.map((c, ci) => `<div class="wheel" data-col="${ci}">
      <div class="wheel-pad"></div>
      ${c.items.map(v => `<div class="wheel-item" data-v="${v}">${c.label(v)}</div>`).join('')}
      <div class="wheel-pad"></div>
    </div>`).join('') + '<div class="wheel-band"></div>';
  mask.appendChild(pop);
  document.body.appendChild(mask);

  // 放在日期正下方，不超出屏幕
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth;
  pop.style.top = (r.bottom + 10) + 'px';
  pop.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + 'px';
  pop.style.setProperty('--arrow-x', (r.left + r.width / 2 - parseFloat(pop.style.left)) + 'px');

  const wheels = [...pop.querySelectorAll('.wheel')];
  const current = cols.map(c => c.value);
  const mark = (wheel, idx) => wheel.querySelectorAll('.wheel-item').forEach((el, i) => el.classList.toggle('on', i === idx));

  wheels.forEach((wheel, ci) => {
    const items = cols[ci].items;
    const start = Math.max(0, items.indexOf(cols[ci].value));
    wheel.scrollTop = start * WHEEL_ROW;
    mark(wheel, start);
    let timer;
    const settle = () => {
      const idx = Math.max(0, Math.min(items.length - 1, Math.round(wheel.scrollTop / WHEEL_ROW)));
      mark(wheel, idx);
      if (items[idx] !== current[ci]) {
        current[ci] = items[idx];
        onChange(current.slice());
      }
    };
    wheel.addEventListener('scroll', () => {
      mark(wheel, Math.round(wheel.scrollTop / WHEEL_ROW));
      clearTimeout(timer);
      timer = setTimeout(settle, 140);
    });
    // 点某一项也能直接选
    wheel.querySelectorAll('.wheel-item').forEach((el, i) => el.onclick = () => wheel.scrollTo({ top: i * WHEEL_ROW, behavior: 'smooth' }));
  });

  mask.addEventListener('click', e => { if (e.target === mask) mask.remove(); });
}
