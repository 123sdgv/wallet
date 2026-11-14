// ============================================================
// record.js — 「记一笔」面板（记账 / 消费计划）和「编辑流水」
// 记账和编辑共用同一套表单：txFormHTML + bindTxForm
// ============================================================

const TX_KINDS = [
  ['expense', '支出'],
  ['income', '收入'],
  ['refund', '退款'],
  ['transfer', '转账'],
];

// 流水 → 表单里的类型
function txKind(t) {
  if (t.type === 'transfer') return 'transfer';
  if (t.type === 'income') return 'income';
  return isRefund(t) ? 'refund' : 'expense';
}

// 表单里「备注」框要显示的文字
function txNoteText(t) {
  if (!isGenericItem(t.item) && t.item !== '退款' && t.item !== '转账') return t.item;
  return t.note || '';
}

// 记账 / 编辑共用的表单。t 是要编辑的流水（新建时传默认值）
function txFormHTML(t) {
  const kind = txKind(t);
  const firstOther = (S.accounts.find(a => a.id !== t.accountId) || {}).id;
  return `
    <div class="segmented" style="margin-bottom:12px">
      ${TX_KINDS.map(([k, name]) => `<button type="button" class="qa-type${k === kind ? ' active' : ''}" data-kind="${k}">${name}</button>`).join('')}
    </div>
    <label class="field"><span>金额</span><input id="tx_amt" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00" value="${t.amount ? Math.abs(Number(t.amount)) : ''}"></label>
    <div class="field" data-for="expense refund"><span>标签</span><div class="chips">${chipsHTML('ttg', S.tags, t.tagId, tagLabel)}</div></div>
    <div class="field"><span id="tx_acc_label">账户</span><div class="chips">${chipsHTML('tac', S.accounts, t.accountId, accLabel)}</div></div>
    <div class="field" data-for="transfer"><span>转入账户</span><div class="chips">${chipsHTML('tto', S.accounts, t.toAccountId || firstOther, accLabel)}</div></div>
    <label class="field"><span>日期</span><input id="tx_date" type="date" value="${t.date || today()}"></label>
    <label class="field"><span>备注</span><input id="tx_note" placeholder="可不填" value="${esc(txNoteText(t))}"></label>
    <div class="switch" data-for="expense refund">
      <span>计入本月预算</span>
      <input id="tx_inb" type="checkbox" ${t.noBudget ? '' : 'checked'}>
    </div>`;
}

// 绑定表单；返回 read()：读出表单内容，不合法时提示并返回 null
function bindTxForm(root) {
  let kind = picked(root, 'kind') || 'expense';
  const refresh = () => {
    root.querySelectorAll('[data-for]').forEach(el => {
      el.classList.toggle('hidden', !el.dataset.for.split(' ').includes(kind));
    });
    $('tx_acc_label').textContent = kind === 'transfer' ? '转出账户' : '账户';
  };
  bindChips(root, 'kind', k => { kind = k; refresh(); });
  ['ttg', 'tac', 'tto'].forEach(n => bindChips(root, n));
  refresh();

  return () => {
    const amount = r2($('tx_amt').value);
    if (!(amount > 0)) { toast('金额无效'); return null; }
    const accountId = picked(root, 'tac');
    if (!acc(accountId)) { toast('选一个账户'); return null; }
    const date = $('tx_date').value || today();
    const note = $('tx_note').value.trim();

    if (kind === 'transfer') {
      const to = picked(root, 'tto');
      if (!acc(to)) { toast('选一个转入账户'); return null; }
      if (to === accountId) { toast('转出和转入不能是同一个账户'); return null; }
      return { type: 'transfer', amount, accountId, toAccountId: to, date, note, item: note || '转账' };
    }
    if (kind === 'income') {
      return { type: 'income', amount, accountId, date, note, item: note || '快速收入' };
    }
    const tagId = picked(root, 'ttg');
    if (!tagId) { toast('选一个标签'); return null; }
    const out = {
      type: 'expense',
      amount: kind === 'refund' ? -amount : amount,
      accountId,
      tagId,
      date,
      note,
      item: note || (kind === 'refund' ? '退款' : '快速支出'),
    };
    if (!$('tx_inb').checked) out.noBudget = true;
    return out;
  };
}

// ---------- 记一笔 ----------
function openAddSheet(tab = 'rec', day = null) {
  const firstTag = S.tags[0]?.id;
  const firstAcc = S.accounts[0]?.id;
  const draft = { type: 'expense', amount: 0, tagId: firstTag, accountId: firstAcc, date: day || today() };

  openModal(`
  <div class="row">
    <div class="segmented" style="flex:1;margin-right:8px">
      <button type="button" class="qa-type ${tab === 'rec' ? 'active' : ''}" data-tab="rec">记账</button>
      <button type="button" class="qa-type ${tab === 'plan' ? 'active' : ''}" data-tab="plan">消费计划</button>
    </div>
    ${closeBtn()}
  </div>
  <div id="recP" class="${tab === 'rec' ? '' : 'hidden'}" style="margin-top:12px">
    ${txFormHTML(draft)}
    <button class="btn block" type="button" id="tx_ok" style="margin-top:6px">保存</button>
  </div>
  <div id="planP" class="${tab === 'plan' ? '' : 'hidden'}" style="margin-top:12px">
    <label class="field"><span>预计金额</span><input id="a_amount" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00"></label>
    <label class="field"><span>买什么</span><input id="a_item" type="text" placeholder="一句话写清"></label>
    <div class="field"><span>标签</span><div class="chips">${chipsHTML('ptg', S.tags, firstTag, tagLabel)}</div></div>
    <div class="field"><span>付款账户</span><div class="chips">${chipsHTML('pac', S.accounts, firstAcc, accLabel)}</div></div>
    <label class="field"><span>日期</span><input id="a_date" type="date" value="${today()}"></label>
    <div class="switch"><span>纳入本月预算</span><input id="a_inbudget" type="checkbox" checked></div>
    <label class="field"><span>备注（可选）</span><textarea id="a_note" style="min-height:60px" placeholder="为什么想买"></textarea></label>
    <div id="a_warn" style="margin-bottom:10px"></div>
    <button class="btn block" type="button" id="btnPlan">生成计划</button>
  </div>`);

  const root = $('modal');
  $('mc').onclick = closeModal;

  // 记账 / 消费计划 切换
  root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    root.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === b));
    $('recP').classList.toggle('hidden', b.dataset.tab !== 'rec');
    $('planP').classList.toggle('hidden', b.dataset.tab !== 'plan');
  });

  // 记账
  const readTx = bindTxForm($('recP'));
  $('tx_ok').onclick = () => {
    const data = readTx();
    if (!data) return;
    const tx = { id: uid(), ts: Date.now(), refunded: false, ...data };
    applyTx(tx, 1);
    S.txs.unshift(tx);
    save();
    closeModal();
    toast(tx.noBudget ? '已记录（预算外）' : '已记录');
    render();
  };

  // 消费计划
  const planRoot = $('planP');
  const updateWarn = () => {
    const amt = Number($('a_amount').value || 0);
    $('a_warn').innerHTML = planWarnHTML(amt, picked(planRoot, 'ptg'), $('a_inbudget').checked);
  };
  bindChips(planRoot, 'ptg', updateWarn);
  bindChips(planRoot, 'pac');
  $('a_amount').addEventListener('input', updateWarn);
  $('a_inbudget').addEventListener('change', updateWarn);
  $('btnPlan').onclick = () => {
    const amount = Number($('a_amount').value || 0);
    const item = $('a_item').value.trim();
    if (!(amount > 0) || !item) return toast('填写金额和内容');
    createPlan({
      amount,
      item,
      tagId: picked(planRoot, 'ptg'),
      accountId: picked(planRoot, 'pac'),
      date: $('a_date').value || today(),
      note: $('a_note').value.trim(),
      inBudget: $('a_inbudget').checked,
    });
    closeModal();
    toast('计划已生成');
    page = 'home';
    render();
  };
}

// ---------- 编辑流水 ----------
// 点日历里的任意一条流水打开。保存时先撤销旧的余额影响，再按新内容记上。
function openTxEditor(id) {
  const old = S.txs.find(x => x.id === id);
  if (!old) return;
  openModal(`
  <div class="row"><h3>编辑流水</h3>${closeBtn()}</div>
  <div id="editP" style="margin-top:8px">
    ${txFormHTML(old)}
    <div style="display:flex;gap:8px;margin-top:6px">
      <button class="btn danger" type="button" id="tx_del" style="flex:0 0 auto">删除</button>
      <button class="btn" type="button" id="tx_save" style="flex:1">保存修改</button>
    </div>
  </div>`);
  $('mc').onclick = closeModal;
  const readTx = bindTxForm($('editP'));

  $('tx_save').onclick = () => {
    const data = readTx();
    if (!data) return;
    // 计划带来的「购买理由」备注单独保留
    const keepNote = old.note && old.note !== old.item && txNoteText(old) !== old.note;
    const next = { id: old.id, ts: old.ts, refunded: false, ...data };
    if (keepNote) next.note = old.note;
    applyTx(old, -1);
    applyTx(next, 1);
    S.txs[S.txs.indexOf(old)] = next;
    save();
    closeModal();
    toast('已保存');
    render();
  };
  $('tx_del').onclick = () => {
    if (deleteTx(id)) closeModal();
  };
}

// 删除一条流水，账户余额自动改回去
function deleteTx(id) {
  const t = S.txs.find(x => x.id === id);
  if (!t) return false;
  if (!confirm('确定删除这条流水吗？账户余额会自动改回去。')) return false;
  applyTx(t, -1);
  S.txs = S.txs.filter(x => x.id !== id);
  save();
  render();
  return true;
}
