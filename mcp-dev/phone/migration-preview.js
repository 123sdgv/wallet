import { reconcileWallet, WalletDateError } from '../../js/reconcile.mjs';
import { openingLedger } from '../opening-ledger.js';

const input = document.querySelector('input'), output = document.getElementById('result');
const currency = new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'});
const amount = fen => currency.format(fen / 100);
const labels = {accounts:'账户',txs:'流水',tags:'标签',plans:'计划',goals:'储蓄目标',memos:'备忘',budgets:'预算周期记录'};
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
    const add = (tag,text) => { const el=document.createElement(tag); el.textContent=text; output.append(el); };
    add('h2','迁移前核对');
    if (report.issues.length) {
      add('h3','暂缓迁移 · 以下是本机核对结果');
      for (const issue of report.issues) add('p',issue);
      const accounts=new Set(source.accounts.map(a=>a.id));
      const missing=new Set();
      let affected=0;
      for (const tx of source.txs) {
        const refs=tx.type==='transfer' ? [tx.accountId,tx.toAccountId] : [tx.accountId];
        const absent=refs.filter(id=>!accounts.has(id));
        if (absent.length) {
          affected++;
          for (const id of absent) missing.add(id);
        }
      }
      if (affected) add('p',affected+' 笔历史流水引用了当前账户列表以外的 '+missing.size+' 个账户编号。总资产取自现有账户余额；历史流水仍按原日期参与收支统计。');
      for (const m of report.months) {
        const b=source.budgets[m.month];
        if (!b || b.total===undefined) continue;
        const stored=Math.round(Number(b.total)*100);
        const category=Object.values(b.tagLimits??{}).reduce((sum,v)=>sum+Math.round(Number(v)*100),0);
        if (stored!==category) add('p',m.month+'　备份总预算 '+amount(stored)+'　分类额度合计 '+amount(category)+'。下方月预算按当前 Wallet 的分类额度计算。');
      }
    }
    const legacy=[];
    if (source.txs.some(t=>Object.hasOwn(t,'planId'))) legacy.push('流水与消费计划的关联');
    if (source.plans.some(p=>['quiz','quizDone','quizAnswers'].some(k=>Object.hasOwn(p,k)))) legacy.push('旧版计划自查设置与答复');
    if (source.tags.some(t=>['over','cool','quiz'].some(k=>Object.hasOwn(t,k)))) legacy.push('旧版标签规则');
    if (Array.isArray(source.longTags) && source.longTags.length) legacy.push('旧版长期标签');
    if (legacy.length) add('p','需确认如何保留的历史字段：'+legacy.join('、')+'。原备份完整保留。');
    add('p',Object.entries(labels).map(([k,label])=>label+' '+report.counts[k]).join(' · '));
    for (const [key,label] of [['assets_fen','总资产'],['safe_fen','安全余额'],['savings_fen','专项储蓄'],['free_fen','可安排资金'],['refund_fen','累计退款']]) add('p',label+'　'+amount(report[key]));
    add('h3','账户余额');
    for (const a of report.accounts) add('p',a.name+'　'+amount(a.balance_fen));
    add('h3','逐月预算和退款');
    for (const m of report.months) add('p',m.month+'　预算 '+(m.budget_fen===null?'未设置':amount(m.budget_fen))+'　预算内净支出 '+amount(m.in_budget_fen)+'　预算外 '+amount(m.off_budget_fen)+'　退款 '+amount(m.refund_fen));
    if (report.halfMonths.length) {
      add('h3','旧版半月预算');
      for (const h of report.halfMonths) add('p',h.month+(h.half==='A'?' 上半月':' 下半月')+'　总预算 '+(h.budget_fen===null?'未设置':amount(h.budget_fen))+'　分类额度合计 '+amount(h.category_caps_fen));
    }
    if (report.issues.length || legacy.length) {
      add('p','本次只展示预览，正式迁移仍待处理和单独确认。');
      return;
    }
    const {ledger}=openingLedger(source);
    if(new TextEncoder().encode(JSON.stringify(ledger)).length>512*1024) return stop('LEDGER-SIZE','账本超过当前迁移容量 512 KiB，请保留完整备份。');
    add('p','拟迁移范围包括账户、金额、流水明细与备注、标签、预算、计划、专项储蓄和资金备忘。操作停留在预览。');
  } catch (e) {
    // Only display validator-owned messages. Parser and browser errors may contain input or file names.
    if(e instanceof WalletDateError) return stop(e.code,e.message);
    const reason=Object.hasOwn(diagnostic,e.message) && diagnostic[e.message];
    if(reason) return stop('FIELD-'+e.message,reason+'。');
    const checks=['记录编号缺失或重复，无法逐笔核对。','合计金额超出可核对范围。','预算月份或流水日期无效。','月预算结构无效。','流水存在无法识别的类型。','流水日期无效。'];
    if(checks.includes(e.message) || /^(账户|安全余额|安全余额分配|专项储蓄|专项存取|分类预算|半月预算|月预算|流水)存在(无效金额|超出范围或精度超过分的金额)。$/.test(e.message)) return stop('CHECK-DATA',e.message);
    stop('CHECK-RECORD','一条记录的内部结构暂时无法读取，请保留原文件。');
  }
});
