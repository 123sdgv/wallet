// ============================================================
// ui.js — 通用界面零件：图标、底部弹窗、提示、小输入框、选择药丸、左滑删除
// ============================================================

const $ = id => document.getElementById(id);

// ---------- 提示 ----------
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1800);
}

// ---------- 底部弹窗 ----------
function openModal(html) {
  const m = $('modal');
  m.onclick = null;
  m.className = 'modal';
  m.innerHTML = html;
  $('mask').classList.remove('hidden');
}
function closeModal() {
  const m = $('modal');
  $('mask').classList.add('hidden');
  m.onclick = null;
  m.innerHTML = '';
  m.className = 'modal';
}
$('mask').addEventListener('click', e => { if (e.target.id === 'mask') closeModal(); });

// ---------- 图标 ----------
const SV = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const svgDel = () => `<svg ${SV}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;
const svgCheck = () => `<svg ${SV}><path d="M20 6L9 17l-5-5"/></svg>`;
const svgPlus = () => `<svg ${SV}><path d="M12 5v14M5 12h14"/></svg>`;
const svgX = () => `<svg ${SV}><path d="M18 6L6 18M6 6l12 12"/></svg>`;
const svgBack = () => `<svg ${SV}><path d="M15 18l-6-6 6-6"/></svg>`;
const svgNext = () => `<svg ${SV}><path d="M9 18l6-6-6-6"/></svg>`;
const svgChartIcon = () => `<svg ${SV} style="width:14px;height:14px"><path d="M3 3v18h18"/><path d="M18 9l-5 5-3-3-4 4"/></svg>`;
const closeBtn = () => `<button class="ib" type="button" id="mc" aria-label="关闭">${svgX()}</button>`;

// 彩色小标签
function chip(text, bg, color) {
  return `<span class="chip" style="background:${bg};color:${color}">${text}</span>`;
}
// 流水上的「预算外」小标记
const offTag = () => '<span class="tag-off">预算外</span>';

// ---------- 选择药丸（标签 / 账户） ----------
// chipsHTML('tg', 列表, 当前选中id, 每项怎么显示)
function chipsHTML(name, items, activeId, label) {
  return items.map(x => `<button type="button" class="quiz-opt${x.id === activeId ? ' active' : ''}" data-${name}="${esc(x.id)}">${label(x)}</button>`).join('');
}
const tagLabel = t => `<span class="dot" style="background:${t.color}"></span>${esc(t.name)}`;
const accLabel = a => esc(a.name);

// 点哪个哪个变成选中
function bindChips(root, name, onChange) {
  const btns = root.querySelectorAll(`[data-${name}]`);
  btns.forEach(b => b.onclick = () => {
    btns.forEach(x => x.classList.toggle('active', x === b));
    if (onChange) onChange(b.dataset[name]);
  });
}
// 读出当前选中的 id，没选返回 null
function picked(root, name) {
  const b = root.querySelector(`[data-${name}].active`);
  return b ? b.dataset[name] : null;
}

// ---------- 居中小输入框 ----------
// fields: [{ key, label, type: text|number|date|select|textarea, value, options, placeholder }]
function miniForm({ title, note, fields, okText = '确定', onOk }) {
  const m = document.createElement('div');
  m.className = 'mini-mask';
  const fieldHTML = fields.map((f, i) => {
    const lab = f.label ? `<span>${esc(f.label)}</span>` : '';
    const val = esc(f.value ?? '');
    const ph = esc(f.placeholder || '');
    let input;
    if (f.type === 'textarea') {
      input = `<textarea data-f="${i}" placeholder="${ph}">${val}</textarea>`;
    } else if (f.type === 'select') {
      const opts = (f.options || []).map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(f.value) ? 'selected' : ''}>${esc(o[1])}</option>`).join('');
      input = `<select data-f="${i}">${opts}</select>`;
    } else if (f.type === 'number') {
      input = `<input data-f="${i}" type="number" step="0.01" inputmode="decimal" value="${val}" placeholder="${ph || '0'}">`;
    } else if (f.type === 'date') {
      input = `<input data-f="${i}" type="date" value="${val}">`;
    } else {
      input = `<input data-f="${i}" type="text" value="${val}" placeholder="${ph}">`;
    }
    return `<label class="field">${lab}${input}</label>`;
  }).join('');

  m.innerHTML = `<div class="mini">
    <h4>${esc(title)}</h4>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    ${fieldHTML}
    <div class="btns">
      <button type="button" class="btn line" data-x>取消</button>
      <button type="button" class="btn" data-ok>${esc(okText)}</button>
    </div>
  </div>`;
  document.body.appendChild(m);

  const close = () => m.remove();
  const submit = () => {
    const v = {};
    fields.forEach((f, i) => { v[f.key] = m.querySelector(`[data-f="${i}"]`).value; });
    if (onOk(v) !== false) close();
  };
  m.addEventListener('click', e => { if (e.target === m) close(); });
  m.querySelector('[data-x]').onclick = close;
  m.querySelector('[data-ok]').onclick = submit;
  m.querySelectorAll('input').forEach(i => i.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
  }));
  const first = m.querySelector('input:not([type=date]),textarea,select');
  setTimeout(() => {
    if (!first) return;
    first.focus();
    if (first.select && first.type !== 'number') try { first.select(); } catch {}
  }, 60);
}

// ---------- 左滑删除 ----------
// 生成一行：swipeRow(内容HTML, 'data-del-tx="xxx"', '删除')
// 删除按钮放在内容层里面、贴在右边外侧，跟内容一起移动；没滑开时隐藏。
const SWIPE_W = 72;
function swipeRow(inner, delAttr, delText = '删除', innerStyle = '') {
  return `<div class="swipe"><div class="swipe-in"${innerStyle ? ` style="${innerStyle}"` : ''}>${inner}<button class="swipe-del" type="button" ${delAttr}>${delText}</button></div></div>`;
}

// 给 root 里所有 .swipe 行绑定手势；返回 guard(el)：
// 刚滑过或者已经滑开时返回 true（并收回），用来挡掉误触的点击
function bindSwipe(root) {
  const rows = [...root.querySelectorAll('.swipe')];

  const setX = (r, x, animate = true) => {
    const inner = r.querySelector('.swipe-in');
    inner.style.transition = animate ? 'transform .2s' : 'none';
    inner.style.transform = x ? `translateX(${x}px)` : '';
    r._x = x;
    clearTimeout(r._t);
    if (x) {
      r.classList.add('show');
    } else if (!animate) {
      r.classList.remove('show');
    } else {
      // 等收回动画结束再把红色按钮藏起来
      r._t = setTimeout(() => { if (!r._x) r.classList.remove('show'); }, 220);
    }
  };
  const closeAll = except => rows.forEach(r => { if (r !== except && r._x) setX(r, 0); });

  rows.forEach(r => {
    let sx = 0, sy = 0, base = 0, dir = null;
    r._x = 0;
    r.addEventListener('touchstart', e => {
      const t = e.touches[0];
      sx = t.clientX;
      sy = t.clientY;
      base = r._x || 0;
      dir = null;
      closeAll(r);
    }, { passive: true });
    r.addEventListener('touchmove', e => {
      const t = e.touches[0];
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (!dir) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      }
      if (dir !== 'h') return;
      setX(r, Math.max(-SWIPE_W, Math.min(0, base + dx)), false);
    }, { passive: true });
    const end = () => {
      if (dir !== 'h') return;
      setX(r, (r._x || 0) < -SWIPE_W / 2 ? -SWIPE_W : 0);
      r._swiped = Date.now();
    };
    r.addEventListener('touchend', end);
    r.addEventListener('touchcancel', end);
  });

  root.onclick = e => { if (!e.target.closest('.swipe')) closeAll(null); };

  return el => {
    const r = el.closest('.swipe');
    if (!r) return false;
    if (Date.now() - (r._swiped || 0) < 300) return true;
    if (r._x) { setX(r, 0); return true; }
    return false;
  };
}
