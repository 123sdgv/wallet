import { openingLedger } from '../opening-ledger.js';

const input = document.querySelector('input'), output = document.getElementById('result');
const currency = new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'});
const amount = fen => currency.format(fen / 100);
const labels = {accounts:'账户',txs:'流水',tags:'标签',plans:'计划',goals:'储蓄目标',memos:'备忘',budgets:'有预算记录的月份'};
input.addEventListener('change', async () => {
  const file = input.files[0];
  output.replaceChildren();
  if (!file) return;
  try {
    if (file.size > 8*1024*1024) throw Error('该文件超过预览容量，请保留原始备份。');
    const {ledger,report} = openingLedger(JSON.parse(await file.text()));
    const bytes = new TextEncoder().encode(JSON.stringify(ledger));
    if (bytes.length > 512*1024) throw Error('账本超过当前迁移容量，请保留原始备份。');
    const add = (tag,text) => { const el=document.createElement(tag); el.textContent=text; output.append(el); };
    add('h2','迁移前核对');
    add('p',Object.entries(labels).map(([k,label])=>label+' '+report.counts[k]).join(' · '));
    for (const [key,label] of [['assets_fen','总资产'],['safe_fen','安全余额'],['savings_fen','专项储蓄'],['free_fen','可安排资金'],['refund_fen','累计退款']]) add('p',label+'　'+amount(report[key]));
    add('h3','账户余额');
    for (const a of report.accounts) add('p',a.name+'　'+amount(a.balance_fen));
    add('h3','逐月预算和退款');
    for (const m of report.months) add('p',m.month+'　预算 '+(m.budget_fen===null?'未设置':amount(m.budget_fen))+'　预算内净支出 '+amount(m.in_budget_fen)+'　预算外 '+amount(m.off_budget_fen)+'　退款 '+amount(m.refund_fen));
    add('p','拟迁移范围包括账户、金额、流水明细与备注、标签、预算、计划、专项储蓄和资金备忘。操作停留在预览。');
  } catch (e) {
    const reasons={opening_needs_review:'账本存在需要核对的金额或关联。',unrecognized_financial_field:'备份包含当前版本尚未识别的字段。'};
    output.textContent = '暂缓迁移。'+(reasons[e.message] || '无法完整核对这份备份，请保留原文件。');
  }
  input.value='';
});
