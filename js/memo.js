// ============================================================
// memo.js — 资金备忘：纯文字的小备忘录
// 列表每条显示第一行；点一下进编辑页，左滑出现删除
// 编辑页右上角：没改动时是圆圈（点了直接退出），改动后变成对勾（点了保存并退出）
// 只是文字，不影响任何金额
// ============================================================

const svgCircle = () => `<svg ${SV}><circle cx="12" cy="12" r="9"/></svg>`;
const svgCircleCheck = () => `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function viewMemo(back) {
  const rows = S.memos.map(m => {
    const first = esc((m.text || '').split('\n')[0]);
    return swipeRow(`<div class="memo-line tappable" style="padding:11px 0" data-edit-memo="${m.id}">${first}</div>`, [
      { attr: `data-del-memo="${m.id}"` },
    ], 'padding:0');
  }).join('');
  return `<div class="section-title"><h2>资金备忘</h2>${back}</div>
  <div class="card list-card">
    ${rows}
    <button class="add-row" type="button" id="addMemo">＋ 新增</button>
  </div>`;
}

function bindMemo() {
  const guard = bindSwipe($('view'));
  $('addMemo').onclick = () => openMemoPage(null);
  // 点一下直接进编辑页（刚滑过 / 已滑开时只收回，不打开）
  document.querySelectorAll('[data-edit-memo]').forEach(b => b.onclick = () => {
    if (guard(b)) return;
    openMemoPage(S.memos.find(m => m.id === b.dataset.editMemo));
  });
  document.querySelectorAll('[data-del-memo]').forEach(b => b.onclick = () => {
    S.memos = S.memos.filter(m => m.id !== b.dataset.delMemo);
    save();
    render();
  });
}

// 编辑页（整页）。m 为空表示新增
function openMemoPage(m) {
  const original = m ? m.text || '' : '';
  const pageEl = document.createElement('div');
  pageEl.className = 'memo-page';
  pageEl.innerHTML = `
    <div class="memo-bar">
      <button class="ib" type="button" id="mpBack" aria-label="返回">${svgBack()}</button>
      <button class="ib done-btn" type="button" id="mpDone" aria-label="完成">${svgCircle()}</button>
    </div>
    <textarea id="mpText"></textarea>`;
  document.body.appendChild(pageEl);

  const text = pageEl.querySelector('#mpText');
  const done = pageEl.querySelector('#mpDone');
  text.value = original;
  const changed = () => text.value !== original;
  const close = () => pageEl.remove();

  text.addEventListener('input', () => {
    done.innerHTML = changed() ? svgCircleCheck() : svgCircle();
    done.classList.toggle('on', changed());
  });

  done.onclick = () => {
    if (changed()) {
      if (m) m.text = text.value;
      else S.memos.push({ id: uid(), ts: Date.now(), text: text.value });
      save();
      render();
    }
    close();
  };
  pageEl.querySelector('#mpBack').onclick = () => {
    if (changed() && !confirm('不保存就退出？')) return;
    close();
  };

  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
}
