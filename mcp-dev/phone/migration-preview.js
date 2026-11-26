import { reconcileWallet } from '../../js/reconcile.mjs';
import { openingLedger } from '../opening-ledger.js';

const input = document.querySelector('input'), output = document.getElementById('result');
const currency = new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'});
const amount = fen => currency.format(fen / 100);
const labels = {accounts:'账户',txs:'流水',tags:'标签',plans:'计划',goals:'储蓄目标',memos:'备忘',budgets:'有预算记录的月份'};
const diagnostic = {
  invalid_record:'记录结构异常', unrecognized_financial_field:'包含尚未支持的字段',
  invalid_financial_field:'字段格式异常', invalid_identifier:'记录或关联编号格式不受支持',
  invalid_color:'标签颜色格式不受支持', invalid_allocations:'分配表结构异常', invalid_allocation:'分配项格式异常',
};
let selection=0;
input.addEventListener('change', async () => {
  const version=++selection, file=input.files[0];
  output.replaceChildren();
  if (!file) return;
  const stop=(code,message)=>{output.textContent='暂缓迁移。'+message+'（'+code+'）';};
  if (file.size>8*1024*1024) return stop('FILE-SIZE','文件超过 8 MiB 的本机预览上限。');
  let raw;
  try { raw=await file.text(); } catch { if(version===selection) stop('FILE-READ','手机未能读取文件。请先在「文件」中下载到本机，再重新选择。'); return; }
  if(version!==selection) return;
  let source;
  try { source=JSON.parse(raw.replace(/^\uFEFF/,'')); } catch { return stop('FILE-JSON','文件为空或 JSON 格式不完整。请从 Wallet 的「我的 → 备份与清理 → 导出完整备份」另存一份 JSON。'); }
  if (!source || typeof source!=='object' || Array.isArray(source)) return stop('FILE-ROOT','请选择 Wallet 导出的完整账本 JSON。');
  for (const [key,label] of Object.entries({...labels,settings:'设置',safeAlloc:'安全余额分配'})) {
    const map=['budgets','settings','safeAlloc'].includes(key);
    const ok=map ? source[key] && typeof source[key]==='object' && !Array.isArray(source[key]) : Array.isArray(source[key]);
    if(!ok) return stop('STRUCT-'+key,'备份中的「'+label+'」缺失或结构不兼容，请保留原文件。');
  }
  try {
    const report=reconcileWallet(source);
    if(report.issues.length) return stop('CHECK-REVIEW',report.issues.join('；')+'。');
    const {ledger}=openingLedger(source);
    const bytes=new TextEncoder().encode(JSON.stringify(ledger));
    if(bytes.length>512*1024) return stop('LEDGER-SIZE','账本超过当前迁移容量 512 KiB，请保留完整备份。');
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
    // Only display validator-owned messages. Parser and browser errors may contain input or file names.
    const reason=Object.hasOwn(diagnostic,e.message) && diagnostic[e.message];
    if(reason) return stop('FIELD-'+e.message,reason+'。');
    const checks=['记录编号缺失或重复，无法逐笔核对。','合计金额超出可核对范围。','预算月份或流水日期无效。','月预算结构无效。','流水存在无法识别的类型。','流水日期无效。'];
    if(checks.includes(e.message) || /^(账户|安全余额|安全余额分配|专项储蓄|专项存取|分类预算|月预算|流水)存在(无效金额|超出范围或精度超过分的金额)。$/.test(e.message)) return stop('CHECK-DATA',e.message);
    stop('CHECK-RECORD','一条记录的内部结构暂时无法读取，请保留原文件。');
  }
});
