// ============================================================
// settings.js — 「我的」页：入口列表、消费标签、备份与清理
// （资金备忘在 memo.js，消费总结在 summary.js）
// ============================================================

const PANELS = ['tags', 'summary', 'data', 'memo'];

function viewSettings() {
  if (S.ui.setPanel && !PANELS.includes(S.ui.setPanel)) S.ui.setPanel = null;
  if (S.ui.setPanel) return viewSetPanel(S.ui.setPanel);

  // 顶部三个小数字
  const month = periodKey();
  const R = calcSummary('month', new Date().getFullYear(), month);
  const recordDays = new Set(S.txs.map(t => t.date)).size;
  const monthCount = S.txs.filter(t => t.date.startsWith(month)).length;

  // 各入口的小字
  const memoSub = memoSummaryText();
  const backup = S.settings.lastBackup;
  const backupOld = !backup || Date.now() - backup > 14 * 86400000;
  const backupSub = backup
    ? `上次备份 ${daysAgo(backup)}${backupOld ? '，该备份一下了' : ''}`
    : '还没备份过，建议导出一份';

  return `
  <div class="card soft stats">
    <div><b>${recordDays}</b><span>记账天数</span></div>
    <div><b>${monthCount}</b><span>${periodName(month)}笔数</span></div>
    <div><b>${money(R.dailyTotal / R.days)}</b><span>${periodName(month)}日均</span></div>
  </div>

  <div class="group-title">记账</div>
  <div class="group">
    ${cell({ attrs: 'data-panel="memo"', icon: 'memo', color: '#f59e0b', title: '资金备忘', sub: memoSub })}
    ${cell({ attrs: 'data-panel="summary"', icon: 'chart', color: '#0d9488', title: '消费总结', sub: '月度 / 年度，每天花多少' })}
    ${cell({ attrs: 'data-panel="tags"', icon: 'tag', color: '#8b5cf6', title: '消费标签', sub: S.tags.slice(0, 5).map(t => esc(t.name)).join('、'), end: S.tags.length + ' 个' })}
  </div>

  <div class="group-title">数据</div>
  <div class="group">
    ${cell({ attrs: 'data-panel="data"', icon: 'data', color: '#3b82f6', title: '备份与清理', sub: `<span style="${backupOld ? 'color:#b45309' : ''}">${backupSub}</span>` })}
  </div>

  <div class="foot-note">清醒消费 · 数据只存在这台设备的浏览器里</div>`;
}

function viewSetPanel(panel) {
  const back = `<button class="ib" type="button" id="setBack" aria-label="返回">${svgBack()}</button>`;
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
  if (p === 'tags') bindTagPanel();
  if (p === 'summary') bindSummary();
  if (p === 'data') bindDataPanel();
  if (p === 'memo') bindMemo();
}

// ============================================================
// 消费标签
// ============================================================
const TAG_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899', '#64748b',
];

// 标签名第一个字，放在彩色圆里
const firstChar = s => esc([...String(s || '?')][0]);

function viewTags(back) {
  const month = periodKey();
  const rows = S.tags.map(t => {
    const list = S.txs.filter(x => isExpense(x) && x.tagId === t.id && x.date.startsWith(month));
    const sub = list.length ? `${periodName(month)} ${money(sumAmount(list))} · ${list.length} 笔` : `${periodName(month)}还没用过`;
    return swipeRow(
      cell({ attrs: `data-edit-tag="${t.id}"`, badge: firstChar(t.name), color: t.color, title: esc(t.name), sub, tag: 'div' }),
      `data-del-tag="${t.id}"`, '删除', 'padding:0');
  }).join('');
  return `<div class="section-title"><h2>消费标签</h2>${back}</div>
  <div class="group">
    ${rows}
    ${cell({ attrs: 'id="addTag"', icon: 'plus', color: '#0d9488', title: '<span style="color:var(--brand)">新增标签</span>', chevron: false })}
  </div>
  <div class="foot-note">点标签修改名称和颜色 · 左滑删除</div>`;
}

function nextTagColor() {
  const used = new Set(S.tags.map(t => t.color.toLowerCase()));
  return TAG_COLORS.find(c => !used.has(c)) || TAG_COLORS[S.tags.length % TAG_COLORS.length];
}

// 新增 / 编辑标签的弹窗。t 为空表示新增
function openTagEditor(t) {
  let color = t ? t.color : nextTagColor();
  const isPreset = c => TAG_COLORS.includes(c.toLowerCase());
  openModal(`<div class="row"><h3>${t ? '编辑标签' : '新增标签'}</h3>${closeBtn()}</div>
    <div class="tag-preview">
      <span class="big-dot" id="tg_dot" style="background:${color}">${t ? firstChar(t.name) : '新'}</span>
      <span class="quiz-opt active" id="tg_chip" style="background:${color};border-color:${color}">${t ? esc(t.name) : '标签名'}</span>
    </div>
    <label class="field"><span>名称</span><input id="tg_name" value="${t ? esc(t.name) : ''}" placeholder="比如：宠物用品" maxlength="8"></label>
    <div class="field"><span>颜色</span>
      <div class="swatches">
        ${TAG_COLORS.map(c => `<button type="button" class="sw${c === color.toLowerCase() ? ' on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}
        <label class="sw custom${isPreset(color) ? '' : ' on'}" aria-label="自定义颜色"><input id="tg_color" type="color" value="${color}"></label>
      </div>
    </div>
    <div class="sheet-btns">
      ${t ? '<button class="btn danger" type="button" id="tg_del">删除</button>' : ''}
      <button class="btn" type="button" id="tg_ok">保存</button>
    </div>`);
  $('mc').onclick = closeModal;

  const paint = () => {
    const name = $('tg_name').value.trim();
    $('tg_dot').style.background = color;
    $('tg_dot').textContent = name ? [...name][0] : (t ? [...t.name][0] : '新');
    $('tg_chip').style.background = color;
    $('tg_chip').style.borderColor = color;
    $('tg_chip').textContent = name || '标签名';
    document.querySelectorAll('.sw[data-c]').forEach(b => b.classList.toggle('on', b.dataset.c === color));
    document.querySelector('.sw.custom').classList.toggle('on', !isPreset(color));
  };
  $('tg_name').addEventListener('input', paint);
  document.querySelectorAll('.sw[data-c]').forEach(b => b.onclick = () => { color = b.dataset.c; paint(); });
  $('tg_color').addEventListener('input', e => { color = e.target.value; paint(); });

  $('tg_ok').onclick = () => {
    const name = $('tg_name').value.trim();
    if (!name) return toast('填写标签名称');
    if (S.tags.some(x => x.name === name && x !== t)) return toast('已经有同名标签了');
    if (t) { t.name = name; t.color = color; }
    else S.tags.push({ id: uid(), name, color });
    save();
    closeModal();
    render();
  };
  if (t) $('tg_del').onclick = () => { if (deleteTag(t.id)) closeModal(); };
}

function deleteTag(id) {
  if (S.tags.length <= 1) { toast('至少保留一个标签'); return false; }
  const t = tag(id);
  const used = S.txs.filter(x => x.tagId === id).length;
  const other = S.tags.find(x => x.id === 'other' && x.id !== id) || S.tags.find(x => x.id !== id);
  const msg = used
    ? `删除「${t.name}」？它的 ${used} 条流水会转到「${other.name}」。`
    : `删除「${t.name}」？`;
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
  $('addTag').onclick = () => openTagEditor(null);
  document.querySelectorAll('[data-edit-tag]').forEach(el => el.onclick = () => {
    if (guard(el)) return;
    openTagEditor(S.tags.find(t => t.id === el.dataset.editTag));
  });
  document.querySelectorAll('[data-del-tag]').forEach(b => b.onclick = () => deleteTag(b.dataset.delTag));
}

// ============================================================
// 备份与清理
// ============================================================
function viewData(back) {
  const backup = S.settings.lastBackup;
  const backupText = backup ? `${today(new Date(backup))}（${daysAgo(backup)}）` : '还没有备份过';
  return `<div class="section-title"><h2>备份与清理</h2>${back}</div>
  <div class="card soft info-card">
    <div class="row" style="justify-content:flex-start;gap:12px">
      <span class="ico" style="background:#0d9488">${icon('shield')}</span>
      <div style="min-width:0">
        <b>数据只存在这台手机里</b>
        <div class="muted" style="line-height:1.5;margin-top:2px">清理 Safari 网站数据或换手机都会丢，定期导出一份备份最安心。</div>
      </div>
    </div>
    <div class="mini-stats">
      <span><b>${S.txs.length}</b> 条流水</span>
      <span><b>${S.accounts.length}</b> 个账户</span>
      <span><b>${S.memos.length}</b> 条备忘</span>
    </div>
    <div class="muted">上次备份：${backupText}</div>
  </div>

  <div class="group-title">备份</div>
  <div class="group">
    ${cell({ attrs: 'id="exportJson"', icon: 'download', color: '#0d9488', title: '导出完整备份', sub: 'JSON 文件，换手机或清缓存后用它恢复' })}
    ${cell({ attrs: 'id="exportCsv"', icon: 'table', color: '#22c55e', title: '导出流水表格', sub: 'CSV 文件，可以用 Numbers / Excel 打开' })}
    ${cell({ attrs: 'id="importJsonBtn"', icon: 'upload', color: '#3b82f6', title: '从备份恢复', sub: '选一个 JSON 备份，会覆盖现在的数据' })}
  </div>
  <input type="file" id="importJson" accept="application/json,.json" class="hidden">

  <div class="group-title">危险操作</div>
  <div class="group">
    ${cell({ attrs: 'id="clearTxOnly"', icon: 'trash', color: '#f87171', title: '清空流水', sub: '只删流水，账户余额不变', danger: true, chevron: false })}
    ${cell({ attrs: 'id="resetAll"', icon: 'reset', color: '#ef4444', title: '恢复初始', sub: '全部数据清零，回到第一次打开的样子', danger: true, chevron: false })}
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

function bindDataPanel() {
  $('exportJson').onclick = async () => {
    const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    if (!(await saveFile('清醒消费备份-' + today() + '.json', blob))) return;
    S.settings.lastBackup = Date.now();
    save();
    toast('已导出');
    render();
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
