// ============================================================
// settings.js — 「我的」页：消费标签、消费总结入口、备份与清理
// ============================================================

function viewSettings() {
  const valid = ['tags', 'summary', 'data'];
  if (S.ui.setPanel && !valid.includes(S.ui.setPanel)) S.ui.setPanel = null;
  if (S.ui.setPanel) return viewSetPanel(S.ui.setPanel);
  return `<div class="card">
    <button class="list-btn" type="button" data-panel="tags"><strong>消费标签</strong><span>${S.tags.length} 个 ›</span></button>
    <button class="list-btn" type="button" data-panel="summary"><strong>消费总结</strong><span>›</span></button>
    <button class="list-btn" type="button" data-panel="data"><strong>备份与清理</strong><span>›</span></button>
  </div>`;
}

function viewSetPanel(panel) {
  const back = `<button class="ib" type="button" id="setBack">${svgBack()}</button>`;
  if (panel === 'summary') return viewSummary(back);
  if (panel === 'tags') {
    const rows = S.tags.map(t => `<div class="item row">
      <strong><span class="dot" style="background:${t.color}"></span>${esc(t.name)}</strong>
      <div style="display:flex;gap:6px">
        <button class="btn sm line" type="button" data-edit-tag="${t.id}">编辑</button>
        <button class="btn sm danger" type="button" data-del-tag="${t.id}">删除</button>
      </div>
    </div>`).join('');
    return `<div class="section-title"><h2>消费标签</h2>${back}</div>
    <div class="card">${rows}<button class="btn block line" type="button" id="addTag" style="margin-top:8px">新增标签</button></div>`;
  }
  return `<div class="section-title"><h2>备份与清理</h2>${back}</div>
  <div class="card stack">
    <button class="btn" type="button" id="exportJson">导出完整备份 JSON</button>
    <button class="btn line" type="button" id="exportCsv">导出流水 CSV</button>
    <button class="btn line" type="button" id="importJsonBtn">导入 JSON 备份</button>
    <input type="file" id="importJson" accept="application/json,.json" class="hidden">
  </div>
  <div class="card stack">
    <button class="btn danger" type="button" id="clearTxOnly">清空流水（不影响账户余额）</button>
    <button class="btn danger" type="button" id="resetAll">恢复初始（覆盖全部数据）</button>
  </div>`;
}

function bindSettings() {
  document.querySelectorAll('[data-panel]').forEach(b => b.onclick = () => {
    S.ui.setPanel = b.dataset.panel;
    save();
    render();
  });
  const back = $('setBack');
  if (back) back.onclick = () => { S.ui.setPanel = null; save(); render(); };

  const p = S.ui.setPanel;
  if (p === 'tags') bindTagPanel();
  if (p === 'summary') bindSummary();
  if (p === 'data') bindDataPanel();
}

// ---------- 消费标签 ----------
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

function tagEditor(title, name, color, onSave) {
  openModal(`<div class="row"><h3>${title}</h3>${closeBtn()}</div>
    <label class="field" style="margin-top:8px"><span>名称</span><input id="tg_name" value="${esc(name)}" placeholder="比如：宠物用品"></label>
    <div class="kv"><span>颜色</span><input id="tg_color" type="color" value="${color}"></div>
    <button class="btn block" type="button" id="tg_ok" style="margin-top:10px">保存</button>`);
  $('mc').onclick = closeModal;
  $('tg_ok').onclick = () => {
    const n = $('tg_name').value.trim();
    if (!n) return toast('填写标签名称');
    onSave(n, $('tg_color').value);
    save();
    closeModal();
    render();
  };
}

function bindTagPanel() {
  $('addTag').onclick = () => tagEditor('新增标签', '', nextTagColor(), (name, color) => {
    S.tags.push({ id: uid(), name, color });
  });
  document.querySelectorAll('[data-edit-tag]').forEach(b => b.onclick = () => {
    const t = tag(b.dataset.editTag);
    tagEditor('编辑标签', t.name, t.color, (name, color) => { t.name = name; t.color = color; });
  });
  document.querySelectorAll('[data-del-tag]').forEach(b => b.onclick = () => {
    const id = b.dataset.delTag;
    if (S.tags.length <= 1) return toast('至少保留一个标签');
    if (!confirm('确定删除这个标签吗？相关流水和计划会转到"其他"。')) return;
    const other = S.tags.find(t => t.id === 'other' && t.id !== id) || S.tags.find(t => t.id !== id);
    S.txs.forEach(t => { if (t.tagId === id) t.tagId = other.id; });
    S.plans.forEach(p => { if (p.tagId === id) p.tagId = other.id; });
    S.tags = S.tags.filter(t => t.id !== id);
    save();
    render();
  });
}

// ---------- 备份与清理 ----------
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

function txTypeName(t) {
  if (t.type === 'income') return '收入';
  if (t.type === 'transfer') return '内部转账';
  return isRefund(t) ? '退款' : '支出';
}

function bindDataPanel() {
  $('exportJson').onclick = () => {
    download('清醒消费备份-' + today() + '.json', new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }));
    toast('已导出');
  };

  $('exportCsv').onclick = () => {
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
    download('流水导出-' + today() + '.csv', new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    toast('已导出');
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
