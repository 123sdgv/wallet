// ============================================================
// home.js — 首页：四个数字、本月预算条、消费计划
// ============================================================

function viewHome() {
  const b = budget();
  const left = remain();
  const used = spentTotal();
  const off = offBudgetTotal();
  const tot = Number(b.total || 0);

  // 预算条：按标签分段，只算预算内
  const segs = S.tags
    .map(t => [t, spentByTag(t.id)])
    .filter(x => x[1] > 0.004)
    .sort((a, c) => c[1] - a[1]);
  const denom = Math.max(tot, used, 0.01);
  const bar = b.set ? `
    <div style="display:flex;gap:2px;height:14px;border-radius:99px;overflow:hidden;background:#e5ebea;margin-top:10px">
      ${segs.map(x => `<i style="width:${x[1] / denom * 100}%;background:${x[0].color}"></i>`).join('')}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:8px">
      ${segs.slice(0, 4).map(x => `<span class="muted"><span class="dot" style="background:${x[0].color}"></span>${esc(x[0].name)} ${money(x[1])}</span>`).join('')}
      <span class="muted">已花 ${money(used)} / ${money(tot)}</span>
    </div>` : '';
  const offLine = off > 0.004
    ? `<div class="muted" style="margin-top:6px">另有预算外支出 ${money(off)}，不占预算</div>`
    : '';

  const pending = S.plans.filter(p => ['open', 'cooldown', 'delay'].includes(p.status));

  return `
  <div class="card soft">
    <div class="hero">
      <button type="button" class="metric" data-metric="assets"><span>总资产</span><b>${money(totalAssets())}</b></button>
      <button type="button" class="metric big" data-metric="free"><span>当前可安排</span><b>${money(free())}</b></button>
      <button type="button" class="metric" data-metric="safe"><span>安全余额</span><b>${money(S.settings.safe)}</b></button>
      <button type="button" class="metric" data-metric="savings"><span>专项储蓄</span><b>${money(savings())}</b></button>
    </div>
    <div style="margin-top:16px">
      <div class="row">
        <span class="muted">${periodName(periodKey())}预算</span>
        <button class="btn sm ghost" type="button" id="goBudget">查看</button>
      </div>
      <div style="margin-top:8px;font-size:13px">本月还能花<b style="font-size:22px;margin-left:6px;color:${left != null && left < 0 ? 'var(--danger)' : '#0f766e'}">${b.set ? money(left) : '未设置'}</b></div>
      ${bar}
      ${offLine}
    </div>
  </div>
  <div class="section-title"><h2>消费计划</h2></div>
  <div class="card">${pending.length ? pending.map(planItem).join('') : '<div class="empty">没有消费计划</div>'}</div>`;
}

function planItem(p) {
  const t = tag(p.tagId);
  return `<div class="item"><div class="row">
    <div style="min-width:0">
      <div style="font-weight:600"><span class="dot" style="background:${t.color}"></span>${esc(p.item)}</div>
      <div class="muted">${esc(t.name)} · ${p.date}${p.inBudget === false ? ' · 未纳入预算' : ''}</div>
    </div>
    <div style="display:flex;align-items:center;gap:2px;flex:0 0 auto">
      <b style="margin-right:4px">${money(p.amount)}</b>
      <button class="iconbtn" type="button" data-done-plan="${p.id}" aria-label="买了，入账">${svgCheck()}</button>
      <button class="iconbtn danger" type="button" data-del-plan="${p.id}" aria-label="删除计划">${svgDel()}</button>
    </div>
  </div></div>`;
}

function bindHome() {
  $('goBudget').onclick = () => openBudgetPopup();
  document.querySelectorAll('[data-metric]').forEach(b => b.onclick = () => openMetric(b.dataset.metric));
  document.querySelectorAll('[data-del-plan]').forEach(b => b.onclick = () => {
    const p = S.plans.find(x => x.id === b.dataset.delPlan);
    if (p && !confirm(`删除计划「${p.item}」？`)) return;
    deletePlan(b.dataset.delPlan);
    render();
  });
  document.querySelectorAll('[data-done-plan]').forEach(b => b.onclick = () => completePlan(b.dataset.donePlan));
}

// ---------- 消费计划 ----------
function createPlan(data) {
  const plan = {
    id: uid(),
    status: 'open',
    amount: Number(data.amount),
    tagId: data.tagId,
    accountId: data.accountId,
    item: data.item,
    date: data.date || today(),
    note: data.note || '',
    inBudget: data.inBudget !== false,
    createdAt: Date.now(),
  };
  S.plans.unshift(plan);
  save();
  return plan;
}

function deletePlan(id) {
  S.plans = S.plans.filter(x => x.id !== id);
  save();
}

// 买了：按实际金额记一笔支出，并把计划移除。
// 计划「未纳入预算」的，入账后也是预算外，不会占本月预算。
function completePlan(id) {
  const p = S.plans.find(x => x.id === id);
  if (!p) return;
  const def = acc(p.accountId) || S.accounts[0];
  miniForm({
    title: '买了「' + p.item + '」',
    note: '记一笔支出，并从消费计划里移除',
    okText: '入账',
    fields: [
      { key: 'v', label: '实际金额', type: 'number', value: p.amount },
      { key: 'acc', label: '付款账户', type: 'select', value: def?.id, options: S.accounts.map(a => [a.id, a.name]) },
      { key: 'date', label: '日期', type: 'date', value: today() },
      { key: 'budget', label: '预算', type: 'select', value: p.inBudget === false ? '0' : '1', options: [['1', '计入本月预算'], ['0', '预算外（不占预算）']] },
    ],
    onOk: o => {
      const amount = r2(o.v || 0);
      if (!(amount > 0)) { toast('金额无效'); return false; }
      const a = acc(o.acc);
      if (!a) { toast('账户不存在'); return false; }
      const tx = {
        id: uid(),
        ts: Date.now(),
        type: 'expense',
        amount,
        accountId: a.id,
        tagId: p.tagId,
        item: p.item,
        date: o.date || today(),
        note: p.note || '',
        refunded: false,
      };
      if (o.budget === '0') tx.noBudget = true;
      applyTx(tx, 1);
      S.txs.unshift(tx);
      S.plans = S.plans.filter(x => x.id !== id);
      save();
      toast(tx.noBudget ? '已入账（预算外）' : '已入账');
      render();
    },
  });
}

// 生成计划时的提醒：安全余额、标签上限、总预算都看一遍
function planWarnHTML(amount, tagId, countIn) {
  if (!amount) return '';
  const msgs = [];
  let level = 'ok';
  const raise = l => { if (level !== 'danger') level = l; };

  if (totalAssets() - amount < S.settings.safe) {
    msgs.push('花后资产可能低于安全余额 ' + money(S.settings.safe) + '。');
    level = 'danger';
  }

  const b = budget();
  if (!countIn) {
    msgs.push('这笔是预算外，不占本月预算，但会扣账户余额。');
    raise('warn');
  } else if (!b.set) {
    msgs.push('本月预算还没设置。');
    raise('warn');
  } else {
    const tagLimit = b.tagLimits?.[tagId];
    if (tagLimit) {
      const leftTag = Number(tagLimit) - spentByTag(tagId) - amount;
      if (leftTag < 0) { msgs.push(`「${tag(tagId).name}」本月上限会超出 ${money(-leftTag)}。`); raise('warn'); }
      else if (leftTag <= 30) { msgs.push(`买完「${tag(tagId).name}」只剩 ${money(leftTag)}。`); raise('warn'); }
    }
    const leftAll = remain() - amount;
    if (leftAll < 0) { msgs.push('本月总预算会超出 ' + money(-leftAll) + '。'); raise('warn'); }
    else if (leftAll <= 30) { msgs.push('买完本月只剩 ' + money(leftAll) + '。'); raise('warn'); }
  }

  const bg = level === 'danger' ? '#fef2f2' : level === 'warn' ? '#fffbeb' : '#ecfdf5';
  const col = level === 'danger' ? '#b91c1c' : level === 'warn' ? '#b45309' : '#047857';
  return `<div style="margin-top:4px;padding:10px 12px;border-radius:12px;background:${bg};color:${col};font-size:12.5px;line-height:1.6">${msgs.join(' ') || '在预算范围内。'}</div>`;
}
