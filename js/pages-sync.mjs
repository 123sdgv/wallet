import {prepareOpening} from '../mcp-dev/opening-ledger.js';
import {initialFull,editFull,exchangeFull,resolveFull} from '../mcp-dev/phone/full-state.js';
import {connectDevice,revokeDevice,phone} from './device-auth.mjs';

if (location.origin==='https://123sdgv.github.io' && location.pathname.startsWith('/wallet/') && !globalThis.walletSandbox) install();
function install() {
  const metaKey='wallet.pages.sync.v1', backupKey='wallet.pages.before-sync', revokeKey='wallet.pages.revoking';
  let message='', running=false, queued=false, retry, lastRaw=localStorage.getItem(KEY);
  const meta=()=>JSON.parse(localStorage.getItem(metaKey)||'null');
  const update=value=>localStorage.setItem(metaKey,JSON.stringify(value));
  function refresh(){if (document.getElementById('view') && S.ui.setPanel==='sync' && $('mask').classList.contains('hidden')) render();}
  function read(){
    const m=meta(); if(!m)throw Error('本机尚未确认迁移');
    return editFull(m,JSON.parse(localStorage.getItem(KEY)));
  }
  function persist(book) {
    const {ledger,...m}=book;
    const raw=JSON.stringify(ledger);
    if(raw!==lastRaw){localStorage.setItem(KEY,raw);lastRaw=raw;S=structuredClone(ledger);if($('view')&&$('mask').classList.contains('hidden'))render();}
    update(m);
  }
  function reconcileTabs(){
    const raw=localStorage.getItem(KEY);
    if(raw!==lastRaw && raw){lastRaw=raw;S=JSON.parse(raw);if($('view')&&$('mask').classList.contains('hidden'))render();}
  }
  async function run(){
    if(running){queued=true;return;}
    if(!meta()&&!localStorage.getItem(revokeKey))return;
    if(!navigator.onLine||!navigator.locks){refresh();return;}
    running=true;
    try {
      await navigator.locks.request('wallet.pages.sync',async()=>{
        reconcileTabs();
        if(localStorage.getItem(revokeKey)){await revokeDevice();localStorage.removeItem(revokeKey);return;}
        if(!localStorage.getItem('wallet.pages.until'))return;
        let m=meta();
        if(!m||m.bulkReview||m.conflict)return;
        if(m.opening){
          const result=await phone('opening',{confirmation:'import-reviewed-ledger',digest:m.opening.digest,ledger:m.base});
          if(result.error||result.digest!==m.opening.digest)throw Error('期初账本未写入，请核对云端版本');
          m=meta();delete m.opening;m.revision=0;update(m);
        }
        await exchangeFull({read:()=>{reconcileTabs();return read();},persist,pull:r=>phone('ledger'+(r===null?'':'?revision='+r)),post:op=>phone('ledger',op)});
      });
      message='';
    } catch(e){message=e instanceof TypeError?'离线或连接中断，待同步修改已保留':e.message;}
    finally {running=false;refresh();if(queued){queued=false;schedule();}}
  }
  function schedule(){clearTimeout(retry);retry=setTimeout(run,200);}
  async function activate(){
    if(!navigator.locks)throw Error('请使用支持设备同步的浏览器');
    if(!localStorage.getItem('wallet.pages.until'))throw Error('请先授权本机');
    if(!navigator.onLine)throw Error('请联网后核对');
    await navigator.locks.request('wallet.pages.sync',async()=>{
      if(meta())return;
      reconcileTabs();const before=localStorage.getItem(KEY);
      const local=await prepareOpening(JSON.parse(before));
      const cloud=await phone('ledger');
      if(cloud.error && cloud.error!=='ledger_not_initialized')throw Error('云端暂时无法核对');
      if(!cloud.ledger && cloud.error!=='ledger_not_initialized')throw Error('云端状态未知');
      if(before!==localStorage.getItem(KEY))throw Error('账本已有更新，请重新核对');
      const r=local.report;
      const balances=r.accounts.map(a=>a.name+' '+money(a.balance_fen/100)).join('、');
      const months=r.months.map(m=>m.month+' '+(m.budget_fen===null?'未设置':money(m.budget_fen/100))).join('、');
      const text=cloud.ledger?'正式云端已有账本。确认将云端账本同步到此设备？当前本机账本会保留副本。':
        '确认将这台设备的最新账本上传到你的 Cloudflare 正式数据库，并开启与 ChatGPT 的双向同步？\n'+r.counts.accounts+' 个账户，'+r.counts.txs+' 笔流水，总资产 '+money(r.assets_fen/100)+'。\n账户余额：'+balances+'\n安全余额 '+money(r.safe_fen/100)+'，专项储蓄 '+money(r.savings_fen/100)+'，可安排 '+money(r.free_fen/100)+'，累计退款 '+money(r.refund_fen/100)+'。\n月预算：'+months+'。包括备注、计划、储蓄和资金备忘，排除旧问答。';
      if(!confirm(text)||before!==localStorage.getItem(KEY))return;
      localStorage.setItem(backupKey,before);
      const book=initialFull(()=>JSON.parse(before));
      if(cloud.ledger){book.ledger={...cloud.ledger,ui:S.ui};book.base=cloud.ledger;book.revision=cloud.revision;}
      else book.opening={digest:local.digest};
      persist(book);
    });
    await run();
  }
  function bulk(){const m=meta();if(m){localStorage.setItem(backupKey,localStorage.getItem(KEY));update({...m,bulkReview:true});}}
  globalThis.walletPages={
    beforeLocalClear:bulk,
    beforeSave(){
      if(localStorage.getItem(KEY)!==lastRaw){reconcileTabs();throw Error('另一个窗口已更新账本，请重新输入本次修改');}
    },
    saved(){lastRaw=localStorage.getItem(KEY);if(meta()&&!running)schedule();else if(running)queued=true;},
    panel(back){
      const m=meta(),until=Number(localStorage.getItem('wallet.pages.until')),pending=!!localStorage.getItem(revokeKey);
      const button=(id,label)=>'<button type="button" class="list-btn" id="'+id+'">'+label+'</button>';
      return '<section id="sync-panel"><div class="section-title"><h2>账本同步</h2>'+back+'</div><div class="card"><p>'+esc(message||(pending?'已暂停，待联网撤销':until<=Date.now()?'尚未授权或授权已到期':!m?'设备已授权，等待核对账本':m.bulkReview?'本机恢复或清理等待确认':m.conflict?'本机与云端均有修改':m.opening?'等待确认写入结果':read().dirty?'本机修改待同步':'已连接 · 版本 '+m.revision))+'</p>'+
        (until>Date.now()?'<p>授权到期 '+esc(new Date(until).toLocaleDateString())+'</p>':'')+
        button('pair',until?'重新授权':'授权本机 30 天')+(until?button('off','撤销本机授权'):'')+
        (until&&!pending&&!m?button('import-ledger','核对并连接正式账本'):'')+(m&&until?button('resync','立即同步'):'')+
        (m?.bulkReview?button('allow-bulk','确认同步本机恢复或清理结果'):'')+
        (m?.conflict?button('use-local','保留本机版本')+button('use-cloud','采用云端版本'):'')+
        (localStorage.getItem(backupKey)?button('recovery','导出保留的本机副本'):'')+'</div></section>';
    },
    bind(){
      const on=(id,fn)=>{if($(id))$(id).onclick=()=>Promise.resolve().then(fn).catch(e=>{message=e.message;refresh();});};
      on('pair',async()=>{if(localStorage.getItem(revokeKey)){await run();if(localStorage.getItem(revokeKey))throw Error('请先联网完成撤销');}await connectDevice();});on('off',()=>{localStorage.setItem(revokeKey,'1');return run();});
      on('import-ledger',activate);on('resync',run);
      on('allow-bulk',()=>{if(confirm('确认将本机清理或恢复后的账本同步到云端？')){update({...meta(),bulkReview:false});schedule();}refresh();});
      for(const [id,useLocal] of [['use-local',true],['use-cloud',false]])on(id,()=>{if(confirm('确认使用所选版本？将保留被替换版本的副本。')){const next=resolveFull(read(),useLocal);localStorage.setItem(backupKey,JSON.stringify(next.recovery.ledger));persist(next);schedule();}refresh();});
      on('recovery',()=>saveFile('Wallet-同步前备份.json',new Blob([localStorage.getItem(backupKey)],{type:'application/json'})));
    }
  };
  addEventListener('storage',e=>{if(e.key===KEY)reconcileTabs();});
  addEventListener('online',schedule);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)schedule();});
  setInterval(()=>{if(!document.hidden)schedule();},60000);
  refresh();schedule();
}
