// ============================================================
// popups.js — 首页点数字弹出来的面板：
// 总资产（账户）、当前可安排、安全余额、本月预算、专项储蓄
// ============================================================

function openMetric(kind) {
  if (kind === 'assets') return openAssetsPopup();
  if (kind === 'free') return openFreePopup();
  if (kind === 'safe') return openSafePopup();
  if (kind === 'savings') return openGoalsPopup();
}

// 账户下面那排小标签：安全 / 专项 / 可安排
function accChips(a) {
  const sf = safeAllocOn(a.id);
  const gs = goalsOn(a.id);
  const fr = accFree(a);
  return (sf > 0 ? chip('安全 ' + money(sf), '#ecfeff', '#0e7490') : '')
    + (gs > 0 ? chip('专项 ' + money(gs), '#f5f3ff', '#6d28d9') : '')
    + chip('可安排 ' + money(fr), fr < 0 ? '#fef2f2' : '#ecfdf5', fr < 0 ? '#b91c1c' : '#047857');
}

// ---------- 总资产：点名称改名，点金额改余额，左滑删除，＋新增 ----------
function openAssetsPopup() {
  const rows = S.accounts.map(a => swipeRow(`
    <div class="row">
      <button class="accn" type="button" data-ren="${a.id}">${esc(a.name)}</button>
      <button class="bal" type="button" data-bal="${a.id}">${money(a.balance)}</button>
    </div>
    <div>${accChips(a)}</div>`, [{ attr: `data-del-acc="${a.id}"` }])).join('');

  openModal(`
    <div class="row">
      <h3>总资产 ${money(totalAssets())}</h3>
      <div style="display:flex;gap:2px">
        <button class="ib" type="button" id="addAccBtn" aria-label="新增账户">${svgPlus()}</button>${closeBtn()}
      </div>
    </div>
    <div id="accList">${rows}</div>`);
  $('mc').onclick = closeModal;
  const guard = bindSwipe($('modal'));
  const redo = () => { save(); render(); openAssetsPopup(); };

  $('addAccBtn').onclick = () => miniForm({
    title: '新增账户',
    fields: [
      { key: 'name', label: '名称', placeholder: '比如：备用金' },
      { key: 'bal', label: '当前余额', type: 'number', value: 0 },
    ],
    onOk: o => {
      const name = o.name.trim();
      if (!name) { toast('填写账户名称'); return false; }
      S.accounts.push({ id: uid(), kind: 'custom', name, balance: r2(o.bal || 0), note: '' });
      redo();
    },
  });

  document.querySelectorAll('[data-bal]').forEach(b => b.onclick = () => {
    if (guard(b)) return;
    const a = acc(b.dataset.bal);
    if (!a) return;
    miniForm({
      title: a.name + ' 余额',
      fields: [{ key: 'v', type: 'number', value: a.balance }],
      onOk: o => {
        const v = Number(o.v);
        if (o.v === '' || isNaN(v)) { toast('金额无效'); return false; }
        a.balance = r2(v);
        redo();
      },
    });
  });

  document.querySelectorAll('[data-ren]').forEach(b => b.onclick = () => {
    if (guard(b)) return;
    const a = acc(b.dataset.ren);
    if (!a) return;
    miniForm({
      title: '账户名称',
      fields: [{ key: 'n', type: 'text', value: a.name }],
      onOk: o => {
        const n = o.n.trim();
        if (!n) { toast('名称不能为空'); return false; }
        a.name = n;
        redo();
      },
    });
  });

  document.querySelectorAll('[data-del-acc]').forEach(b => b.onclick = () => {
    const id = b.dataset.delAcc;
    if (S.accounts.length <= 1) return toast('至少保留一个账户');
    if (!confirm('确定删除这个账户吗？相关流水会显示未知账户，它的安全余额分配和专项存入记录也会清掉。')) return;
    S.accounts = S.accounts.filter(a => a.id !== id);
    if (S.safeAlloc) delete S.safeAlloc[id];
    S.settings.safe = r2(allocSum(S.safeAlloc));
    S.goals.forEach(g => { g.log = (g.log || []).filter(x => x.acc !== id); syncGoal(g); });
    redo();
  });
}

// ---------- 当前可安排：只看 ----------
function openFreePopup() {
  const rows = S.accounts.map(a => {
    const sf = safeAllocOn(a.id);
    const gs = goalsOn(a.id);
    const fr = accFree(a);
    return `<div class="item">
      <div class="row"><strong>${esc(a.name)}</strong><b style="font-variant-numeric:tabular-nums;${fr < 0 ? 'color:var(--danger)' : ''}">${money(fr)}</b></div>
      <div>
        ${chip('余额 ' + money(a.balance), '#f3f4f6', '#6b7280')}
        ${sf > 0 ? chip('安全 ' + money(sf), '#ecfeff', '#0e7490') : ''}
        ${gs > 0 ? chip('专项 ' + money(gs), '#f5f3ff', '#6d28d9') : ''}
        ${fr < 0 ? chip('占用超过余额', '#fef2f2', '#b91c1c') : ''}
      </div>
    </div>`;
  }).join('');
  openModal(`<div class="row"><h3>当前可安排 ${money(free())}</h3>${closeBtn()}</div><div>${rows}</div>`);
  $('mc').onclick = closeModal;
}

// ---------- 安全余额：直接在各账户上改，总数自动汇总 ----------
function openSafePopup() {
  S.safeAlloc = S.safeAlloc || {};
  const m = S.safeAlloc;
  const rows = S.accounts.map(a => `<div class="item">
    <div class="row"><span class="nm">${esc(a.name)}</span><button class="bal" style="font-size:16px" type="button" data-sa="${a.id}">${money(m[a.id] || 0)} ›</button></div>
    <div class="muted">余额 ${money(a.balance)}</div>
  </div>`).join('');
  openModal(`<div class="row"><h3>安全余额 ${money(allocSum(m))}</h3>${closeBtn()}</div>${rows}`);
  $('mc').onclick = closeModal;
  document.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => {
    const a = acc(b.dataset.sa);
    if (!a) return;
    miniForm({
      title: a.name + ' 安全余额',
      fields: [{ key: 'v', type: 'number', value: m[a.id] || '' }],
      onOk: o => {
        const v = Math.max(0, r2(o.v || 0));
        if (v > 0) m[a.id] = v; else delete m[a.id];
        S.settings.safe = r2(allocSum(m));
        save();
        render();
        openSafePopup();
      },
    });
  });
}

// ---------- 本月预算：总预算 + 按标签左右滑动的大圆环 ----------
function openBudgetPopup() {
  const p = periodKey();
  const b = budget(p);
  b.tagLimits = b.tagLimits || {};
  const used = spentTotal(p);
  const off = offBudgetTotal(p);
  const tot = Number(b.total || 0);
  const cap = Math.max(0, r2(free() + used));
  const over = b.set && used > tot;

  const pct = Math.min(100, Math.max(0, used / Math.max(tot, 0.01) * 100));
  const barCls = used > tot ? 'danger' : used >= tot * 0.85 ? 'warn' : '';
  const head = `<button type="button" class="list-btn" style="display:block" data-total>
    <div class="row"><strong>本月总预算</strong><b style="color:var(--text);font-size:17px">${b.set ? money(tot) : '未设置'} ›</b></div>
    ${b.set ? `<div class="progress"><i class="${barCls}" style="width:${pct}%"></i></div>` : ''}
    <div class="muted" style="margin-top:6px">已花 ${money(used)}${over ? ' · 超 ' + money(used - tot) : ''} · 上限 ${money(cap)}</div>
    ${off > 0.004 ? `<div class="muted" style="margin-top:2px">预算外 ${money(off)} 不计入</div>` : ''}
  </button>`;

  const C = 2 * Math.PI * 80;
  const ring = t => {
    const sp = spentByTag(t.id, p);
    const l = Number(b.tagLimits[t.id] || 0);
    const isOver = l > 0 && sp > l;
    const col = isOver ? '#ef4444' : t.color;
    const frac = l > 0 ? Math.min(1, Math.max(0, sp / l)) : 0;
    const center = isOver
      ? `<div style="color:#ef4444;font-size:24px;font-weight:800">超 ${money(sp - l)}</div><div class="muted">已花 ${money(sp)} / ${money(l)}</div>`
      : l > 0
        ? `<div style="font-size:24px;font-weight:800">剩 ${money(l - sp)}</div><div class="muted">已花 ${money(sp)} / ${money(l)}</div>`
        : `<div style="font-size:24px;font-weight:800">${money(sp)}</div><div class="muted">未设预算</div>`;
    const arc = frac > 0 || isOver
      ? `<circle cx="100" cy="100" r="80" fill="none" stroke="${col}" stroke-width="16" stroke-linecap="round" stroke-dasharray="${(isOver ? 1 : frac) * C} ${C}" transform="rotate(-90 100 100)"/>`
      : '';
    return `<div class="rpg">
      <button type="button" data-tl="${t.id}" style="border:0;background:transparent;position:relative;width:210px;height:210px;margin:0 auto;display:block;color:inherit;padding:0">
        <svg viewBox="0 0 200 200" width="210" height="210"><circle cx="100" cy="100" r="80" fill="none" stroke="${isOver ? '#fee2e2' : '#eef2f1'}" stroke-width="16"/>${arc}</svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px">${center}</div>
      </button>
      <div style="text-align:center;margin-top:10px;font-weight:700"><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</div>
    </div>`;
  };

  openModal(`<div class="row"><h3>${periodName(p)}预算</h3>${closeBtn()}</div>${head}
    <div class="rpager" id="rpager">${S.tags.map(ring).join('')}</div>
    <div class="pgdots">${S.tags.map((t, i) => `<i class="pgdot${i ? '' : ' on'}"></i>`).join('')}</div>`);
  $('mc').onclick = closeModal;

  const pager = $('rpager');
  const dots = document.querySelectorAll('.pgdot');
  const pageIndex = () => Math.round(pager.scrollLeft / (pager.clientWidth || 1));
  pager.addEventListener('scroll', () => {
    const i = pageIndex();
    dots.forEach((d, k) => d.classList.toggle('on', k === i));
  });
  const reopen = idx => {
    openBudgetPopup();
    const pg = $('rpager');
    if (pg) pg.scrollLeft = idx * pg.clientWidth;
  };

  document.querySelector('[data-total]').onclick = () => {
    const idx = pageIndex();
    miniForm({
      title: '本月总预算',
      note: '不能超过 ' + money(cap),
      fields: [{ key: 'v', type: 'number', value: b.total || '' }],
      onOk: o => {
        const v = Math.max(0, Number(o.v || 0));
        if (v > cap + 0.004) { toast('预算不能超过可安排上限 ' + money(cap)); return false; }
        b.total = v;
        b.set = true;
        save();
        render();
        reopen(idx);
      },
    });
  };

  document.querySelectorAll('[data-tl]').forEach(btn => btn.onclick = () => {
    const tid = btn.dataset.tl;
    const idx = pageIndex();
    miniForm({
      title: '「' + tag(tid).name + '」本月预算',
      note: '留空表示不限',
      fields: [{ key: 'v', type: 'number', value: b.tagLimits[tid] != null ? b.tagLimits[tid] : '' }],
      onOk: o => {
        const v = String(o.v).trim();
        if (v !== '' && b.set && Number(v) > Number(b.total) + 0.004) {
          toast('不能超过本月总预算 ' + money(b.total));
          return false;
        }
        if (v === '') delete b.tagLimits[tid]; else b.tagLimits[tid] = Number(v);
        save();
        render();
        reopen(idx);
      },
    });
  });
}

// ---------- 专项储蓄 ----------
function openGoalsPopup() {
  const head = `<div class="row">
    <h3>专项储蓄 ${money(savings())}</h3>
    <div style="display:flex;gap:2px;flex:0 0 auto"><button class="ib" type="button" id="addGoalBtn" aria-label="新建专项">${svgPlus()}</button>${closeBtn()}</div>
  </div>`;
  const rows = S.goals.map(g => {
    const pct = g.target > 0 ? Math.min(100, g.saved / g.target * 100) : 0;
    return swipeRow(`<button class="list-btn" type="button" style="display:block;border-bottom:0;background:#fff" data-goal="${g.id}">
        <div class="row"><strong style="color:var(--text)">${esc(g.name)}</strong><span>${money(g.saved)} / ${money(g.target)} ›</span></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
      </button>`, [{ attr: `data-del-goal="${g.id}"` }], 'padding:0');
  }).join('');
  openModal(head + (S.goals.length ? `<div>${rows}</div>` : '<div class="empty">还没有专项项目</div>'));
  $('mc').onclick = closeModal;
  const guard = bindSwipe($('modal'));

  $('addGoalBtn').onclick = () => miniForm({
    title: '新建专项',
    fields: [
      { key: 'name', label: '专项名称', placeholder: '比如：新手机' },
      { key: 'target', label: '目标金额', type: 'number', value: 1000 },
    ],
    onOk: o => {
      const name = o.name.trim();
      if (!name) { toast('填写专项名称'); return false; }
      S.goals.push({ id: uid(), name, target: Math.max(0, Number(o.target || 0)), saved: 0, log: [] });
      save();
      render();
      openGoalsPopup();
    },
  });
  document.querySelectorAll('[data-goal]').forEach(b => b.onclick = () => {
    if (guard(b)) return;
    openGoalDetail(b.dataset.goal);
  });
  document.querySelectorAll('[data-del-goal]').forEach(b => b.onclick = () => {
    const g = S.goals.find(x => x.id === b.dataset.delGoal);
    if (g && g.saved > 0 && !confirm(`删除「${g.name}」？里面的 ${money(g.saved)} 会回到可安排。`)) return;
    S.goals = S.goals.filter(x => x.id !== b.dataset.delGoal);
    save();
    render();
    openGoalsPopup();
  });
}

// 专项详情：进度 + 存入一笔 + 存入记录（左滑取出）
function openGoalDetail(id) {
  const g = S.goals.find(x => x.id === id);
  if (!g) return openGoalsPopup();
  syncGoal(g);
  const pct = g.target > 0 ? Math.min(100, g.saved / g.target * 100) : 0;
  const rows = g.log.slice().sort((a, b) => b.ts - a.ts).map(x => swipeRow(`<div class="row">
      <div><div class="nm">${esc(acc(x.acc)?.name || '未知账户')}</div><div class="muted">${today(new Date(x.ts))}</div></div>
      <b style="color:#047857">+${money(x.amt)}</b>
    </div>`, [{ attr: `data-del-log="${x.id}"`, text: '取出' }])).join('');

  openModal(`<div class="row"><button class="ib" type="button" id="goBack">${svgBack()}</button>${closeBtn()}</div>
    <h3 style="margin-top:4px">${esc(g.name)}</h3>
    <div class="row"><b style="font-size:24px">${money(g.saved)}</b><button type="button" class="tap" data-g-target>目标 ${money(g.target)} ›</button></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    <button class="btn block" type="button" id="gDep" style="margin:14px 0 6px">＋ 存入一笔</button>
    ${rows || '<div class="empty">还没有存入记录</div>'}`);
  $('mc').onclick = closeModal;
  $('goBack').onclick = () => { render(); openGoalsPopup(); };
  bindSwipe($('modal'));

  $('gDep').onclick = () => miniForm({
    title: '存入一笔',
    fields: [
      {
        key: 'acc',
        label: '从哪个账户',
        type: 'select',
        value: (S.accounts.find(a => accFree(a) > 0) || S.accounts[0]).id,
        options: S.accounts.map(a => [a.id, a.name + ' 可安排 ' + money(accFree(a))]),
      },
      { key: 'v', label: '金额', type: 'number' },
    ],
    onOk: o => {
      const v = r2(o.v || 0);
      if (!(v > 0)) { toast('金额无效'); return false; }
      const a = acc(o.acc);
      if (!a) return false;
      if (v > accFree(a) + 0.004) { toast('该账户可安排不足'); return false; }
      g.log.push({ id: uid(), acc: a.id, amt: v, ts: Date.now() });
      syncGoal(g);
      save();
      render();
      openGoalDetail(id);
    },
  });
  document.querySelector('[data-g-target]').onclick = () => miniForm({
    title: '目标金额',
    fields: [{ key: 'v', type: 'number', value: g.target || '' }],
    onOk: o => {
      g.target = Math.max(0, r2(o.v || 0));
      save();
      render();
      openGoalDetail(id);
    },
  });
  document.querySelectorAll('[data-del-log]').forEach(b => b.onclick = () => {
    g.log = g.log.filter(x => x.id !== b.dataset.delLog);
    syncGoal(g);
    save();
    render();
    openGoalDetail(id);
  });
}
