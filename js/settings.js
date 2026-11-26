// ============================================================
// settings.js — 「我的」页：入口列表、消费标签、备份与清理
// （资金备忘在 memo.js，消费总结在 summary.js）
// ============================================================

const PANELS = ['tags', 'summary', 'data', 'memo'];
if (globalThis.walletSandbox) PANELS.push('sync');

function viewSettings() {
  if (S.ui.setPanel && !PANELS.includes(S.ui.setPanel)) S.ui.setPanel = null;
  if (S.ui.setPanel) return viewSetPanel(S.ui.setPanel);

  // 顶部三个小数字
  const month = periodKey();
  const R = calcSummary('month', new Date().getFullYear(), month);
  const recordDays = new Set(S.txs.map(t => t.date)).size;
  const monthCount = S.txs.filter(t => t.date.startsWith(month)).length;
  const row = (panel, name) => `<button class="list-btn" type="button" data-panel="${panel}"><strong>${name}</strong><span>›</span></button>`;

  return `
  <div class="card soft stats">
    <div><b>${recordDays}</b><span>记账天数</span></div>
    <div><b>${monthCount}</b><span>${periodName(month)}笔数</span></div>
    <div><b>${money(R.dailyTotal / R.days)}</b><span>${periodName(month)}日均</span></div>
  </div>
  <div class="card list-card">
    ${row('memo', '资金备忘')}
    ${row('summary', '消费总结')}
    ${row('tags', '消费标签')}
    ${row('data', '备份与清理')}
    ${globalThis.walletSandbox ? row('sync', '虚拟账本同步') : ''}
  </div>`;
}

function viewSetPanel(panel) {
  const back = `<button class="ib" type="button" id="setBack" aria-label="返回">${svgBack()}</button>`;
  if (panel === 'sync' && globalThis.walletSandbox) return walletSandbox.panel(back);
  if (panel === 'summary') return viewSummary(back);
  if (panel === 'memo') return viewMemo(back);
  if (panel === 'tags') return viewTags(back);
  return viewData(back);
}

function bindSettings() {
  document.querySelectorAll('[data-panel]').forEach(b => b.onclick = () => {
    S.ui.setPanel = b.dataset.panel;
    save();
    render();
    window.scrollTo(0, 0);
  });
  const back = $('setBack');
  if (back) back.onclick = () => { S.ui.setPanel = null; save(); render(); };

  const p = S.ui.setPanel;
  if (p === 'sync' && globalThis.walletSandbox) walletSandbox.bind();
  if (p === 'tags') bindTagPanel();
  if (p === 'summary') bindSummary();
  if (p === 'data') bindDataPanel();
  if (p === 'memo') bindMemo();
}

// ============================================================
// 消费标签
// 点圆点：弹出系统色轮改颜色；点名字：原地改名；左滑：删除
// ============================================================
function nextTagColor() {
  const hue = (S.tags.length * 137.508) % 360;
  return hslToHex(hue, 62, 46);
}
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = x => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`;
}

function tagRowInner(id, name, color) {
  return `<div class="tag-row">
    <label class="tag-dot" style="background:${color}"><input type="color" value="${color}" data-color-tag="${id}" aria-label="颜色"></label>
    <span class="tag-name" data-ren-tag="${id}">${esc(name)}</span>
  </div>`;
}

function viewTags(back) {
  const rows = S.tags.map(t => swipeRow(tagRowInner(t.id, t.name, t.color), [{ attr: `data-del-tag="${t.id}"` }])).join('');
  return `<div class="section-title"><h2>消费标签</h2>${back}</div>
  <div class="card list-card" id="tagList">
    ${rows}
    <button class="add-row" type="button" id="addTag">＋ 新增标签</button>
  </div>`;
}

// 把名字变成输入框；done(新名字) 返回 false 表示不接受，恢复原样
function inlineEdit(span, value, done) {
  const input = document.createElement('input');
  input.className = 'inline-input';
  input.value = value;
  input.maxLength = 8;
  span.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = ok => {
    if (finished) return;
    finished = true;
    if (!ok || done(input.value.trim()) === false) render();
  };
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') finish(false);
  });
}

function tagNameOk(name, self) {
  if (!name) return false;
  if (S.tags.some(x => x.name === name && x !== self)) { toast('已经有同名标签了'); return false; }
  return true;
}

function deleteTag(id) {
  if (S.tags.length <= 1) { toast('至少保留一个标签'); return false; }
  const t = tag(id);
  const used = S.txs.filter(x => x.tagId === id).length;
  const other = S.tags.find(x => x.id === 'other' && x.id !== id) || S.tags.find(x => x.id !== id);
  const msg = used ? `删除「${t.name}」？它的 ${used} 条流水会转到「${other.name}」。` : `删除「${t.name}」？`;
  if (!confirm(msg)) return false;
  S.txs.forEach(x => { if (x.tagId === id) x.tagId = other.id; });
  S.plans.forEach(p => { if (p.tagId === id) p.tagId = other.id; });
  Object.values(S.budgets).forEach(b => { if (b.tagLimits) delete b.tagLimits[id]; });
  S.tags = S.tags.filter(x => x.id !== id);
  save();
  render();
  return true;
}

function bindTagPanel() {
  const guard = bindSwipe($('view'));

  // 改名
  document.querySelectorAll('[data-ren-tag]').forEach(span => span.onclick = () => {
    if (guard(span)) return;
    const t = S.tags.find(x => x.id === span.dataset.renTag);
    if (!t) return;
    inlineEdit(span, t.name, name => {
      if (name === t.name) return false;
      if (!tagNameOk(name, t)) return false;
      t.name = name;
      save();
      render();
    });
  });

  // 改颜色：色轮开着时随便点，圆点跟着变、颜色随时存下；
  // 这里不重新渲染页面——重新渲染会把色轮顶掉（以前点一下颜色色轮就关了就是这个原因）。
  // 关掉色轮后，最后选的那个颜色就是这个标签的颜色。
  document.querySelectorAll('[data-color-tag]').forEach(input => {
    const t = S.tags.find(x => x.id === input.dataset.colorTag);
    input.onclick = e => { if (guard(input)) e.preventDefault(); };
    const apply = () => {
      input.parentElement.style.background = input.value;
      t.color = input.value;
      save();
    };
    input.addEventListener('input', apply);
    input.addEventListener('change', apply);
  });

  document.querySelectorAll('[data-del-tag]').forEach(b => b.onclick = () => deleteTag(b.dataset.delTag));

  // 新增：在列表最后多一行，直接输入名字
  $('addTag').onclick = () => {
    const color = nextTagColor();
    const row = document.createElement('div');
    row.className = 'swipe';
    row.innerHTML = `<div class="swipe-in">${tagRowInner('new', '', color)}</div>`;
    $('addTag').before(row);
    inlineEdit(row.querySelector('.tag-name'), '', name => {
      if (!tagNameOk(name, null)) return false;
      S.tags.push({ id: uid(), name, color });
      save();
      render();
    });
  };
}

// ============================================================
// 备份与清理
// ============================================================
function viewData(back) {
  const row = (id, name, danger) => `<button class="list-btn${danger ? ' danger' : ''}" type="button" id="${id}"><strong>${name}</strong>${danger ? '' : '<span>›</span>'}</button>`;
  return `<div class="section-title"><h2>备份与清理</h2>${back}</div>
  <div class="card list-card">
    ${row('exportJson', '导出完整备份')}
    ${row('checkLedger', '本机核对账本')}
    ${row('exportCsv', '导出流水表格')}
    ${globalThis.walletSandbox ? '' : row('importJsonBtn', '从备份恢复')}
  </div>
  <input type="file" id="importJson" accept="application/json,.json" class="hidden">
  <div class="card list-card">
    ${globalThis.walletSandbox ? '' : row('clearTxOnly', '清空流水', true)}
    ${globalThis.walletSandbox ? '' : row('resetAll', '恢复初始', true)}
  </div>`;
}

// 手机上优先弹出系统分享面板（可以「存储到文件」），不支持时直接下载
async function saveFile(name, blob) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false; // 自己取消了
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  return true;
}

function txTypeName(t) {
  if (t.type === 'income') return '收入';
  if (t.type === 'transfer') return '内部转账';
  return isRefund(t) ? '退款' : '支出';
}

async function showReconciliation() {
  try {
    const { reconcileWallet } = await import('./reconcile.mjs');
    const report = reconcileWallet(S);
    const line = (title, value) => '<p>' + esc(title) + '　' + esc(value) + '</p>';
    const amount = n => money(n / 100);
    const months = report.months.map(m => line(m.month, '预算 ' + (m.budget_fen === null ? '未设置' : amount(m.budget_fen)) +
      '，预算内净支出 ' + amount(m.in_budget_fen) + '，预算外 ' + amount(m.off_budget_fen) + '，退款 ' + amount(m.refund_fen))).join('');
    openModal('<h2>本机账本核对</h2><p>核对结果只在本机显示。</p>' +
      line('记录数量', report.counts.accounts + ' 个账户，' + report.counts.txs + ' 笔流水，' + report.counts.goals + ' 个专项') +
      line('其他记录', report.counts.tags + ' 个标签，' + report.counts.budgets + ' 个月预算记录，' + report.counts.plans + ' 个计划，' + report.counts.memos + ' 条备忘') +
      line('总资产', amount(report.assets_fen)) + line('安全余额', amount(report.safe_fen)) +
      line('专项储蓄', amount(report.savings_fen)) + line('可安排资金', amount(report.free_fen)) +
      line('累计退款', amount(report.refund_fen)) +
      '<details><summary>各账户余额</summary>' + report.accounts.map(a => line(a.name, amount(a.balance_fen))).join('') + '</details>' +
      '<details><summary>逐月核对</summary>' + months + '</details>' +
      report.issues.map(text => line('需核对', text)).join(''));
  } catch (error) { toast(error.message || '暂时无法核对此账本。'); }
}

function bindDataPanel() {
  $('checkLedger').onclick = showReconciliation;
  $('exportJson').onclick = async () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    if (await saveFile('清醒消费备份-' + today() + '.json', blob)) toast('已导出');
  };

  $('exportCsv').onclick = async () => {
    const header = ['日期', '类型', '金额', '账户', '转入账户', '标签', '用途', '备注', '预算'];
    const rows = S.txs.slice().sort(cmpTx).map(t => [
      t.date,
      txTypeName(t),
      Math.abs(t.amount),
      acc(t.accountId)?.name || '',
      t.type === 'transfer' ? (acc(t.toAccountId)?.name || '') : '',
      t.tagId ? tag(t.tagId).name : '',
      t.item || '',
      t.note || '',
      t.type === 'expense' ? (t.noBudget ? '预算外' : '预算内') : '',
    ]);
    const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
    if (await saveFile('流水导出-' + today() + '.csv', new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))) toast('已导出');
  };

  if (globalThis.walletSandbox) return;
  $('importJsonBtn').onclick = () => $('importJson').click();
  $('importJson').onchange = async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const accCount = (data.accounts || []).length;
      const txCount = (data.txs || []).length;
      if (!confirm(`文件包含 ${accCount} 个账户，${txCount} 条流水。导入将覆盖当前全部数据，继续？`)) {
        e.target.value = '';
        return;
      }
      S = normalize(data);
      S.ui.setPanel = null;
      save();
      page = 'home';
      e.target.value = '';
      toast('导入完成');
      render();
    } catch {
      e.target.value = '';
      toast('导入失败：文件格式不对');
    }
  };

  $('clearTxOnly').onclick = () => {
    if (!confirm('确定清空所有流水吗？这不会自动恢复账户余额，建议先导出备份。')) return;
    S.txs = [];
    save();
    toast('流水已清空');
    render();
  };

  $('resetAll').onclick = () => {
    if (!confirm('确定恢复初始吗？当前全部数据会被覆盖，建议先导出备份。')) return;
    S = DEFAULT();
    save();
    page = 'home';
    toast('已恢复');
    render();
  };
}
