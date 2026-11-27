import { exchange, initial, key as probeKey, localEdit } from './state.js';
import { connect, credentials, disconnect, finish, phone, restore, deviceUntil, revoking, wasAuthorized, full, appPath } from './oauth.js';

import { initialFull, editFull, exchangeFull, resolveFull } from './full-state.js';
const key=full ? 'wallet.synthetic.full.v1' : probeKey;
const pending=book=>full ? Number(Boolean(book?.dirty || book?.flight)) : book?.pending.length || 0;
function message(text) { const el = document.getElementById('sync-status'); if (el) el.textContent = text; }

if (location.pathname === appPath+'connect.html') {
  finish().catch(() => message('授权未完成。请返回 Wallet，在「我的」里重新连接。'));
} else if (!navigator.locks) {
  message('此浏览器无法保护多个窗口同时写入。请用支持设备锁定的浏览器打开虚拟账本。');
} else {
  navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock) return message('虚拟账本已在另一个窗口打开，请回到该窗口。');
    let book, active, notice = '', wake = false, stopped = false;
    let retry, attempts=0;
    function retryLater() {
      if (attempts>=3 || document.hidden || stopped || book?.conflict) return;
      clearTimeout(retry);
      retry=setTimeout(sync, 1500 * 2**attempts++);
    }
    function resume() { clearTimeout(retry); attempts=0; return sync(); }
    function status() {
      return notice || (revoking() ? '待联网撤销授权' : book?.bulkReview ? '本机清理已保存，等待确认同步' : book?.conflict ? '待处理版本冲突' : active ? '同步中' : credentials() ? '已授权' : wasAuthorized() && deviceUntil() <= Date.now() ? '需重新授权' : '待连接');
    }
    function refresh() {
      message('虚拟测试账本 · ' + status() + ' · 待同步 ' + pending(book) + (full ? ' 组更改' : ' 笔'));
      if (document.getElementById('sync-panel')) globalThis.render();
    }
    function persist(value, cloud = true) {
      localStorage.setItem(key, JSON.stringify(value));
      book = value;
      if (cloud) {
        S = structuredClone(book.ledger);
        if (!document.querySelector('.modal-mask:not(.hidden)') && document.getElementById('view')) render();
      }
    }
    async function sync() {
      if (active) { wake = true; return active; }
      if (stopped) { refresh(); return; }
      notice = '';
      active = (async () => {
        if (!await restore() || stopped) return;
        do {
          wake = false;
          if (full) await exchangeFull({read:()=>book,persist:value=>persist(value),pull:revision=>phone(revision===null?'':'?revision='+revision),post:args=>phone('',args)});
          else await exchange({ read: () => book, persist: value => persist(value), pull: rev => phone('?after=' + rev), post: args => phone('', args) });
        } while (wake && !book.conflict && !stopped);
        attempts=0;
      })().catch(error => { notice = error instanceof TypeError ? '离线，待同步记录已保留' : error.message; if (navigator.onLine && (pending(book) || revoking()) && (error instanceof TypeError || /暂时无法|联网后/.test(error.message))) retryLater(); })
        .finally(() => { active = null; refresh(); });
      refresh();
      return active;
    }
    globalThis.walletSandbox = {
      allowLocalClear:full,
      beforeLocalClear() {
        if (full) persist({...book,bulkReview:true,recovery:{at:Date.now(),ledger:structuredClone(book.ledger)}},false);
      },
      load(defaults) {
        const raw = localStorage.getItem(key);
        book = raw ? JSON.parse(raw) : (full ? initialFull(defaults) : initial(defaults));
        if (book.format !== 1 || (!full && !Array.isArray(book.pending)) || !Array.isArray(book.ledger?.txs)) throw Error('虚拟账本无法读取，已保留原始内容。');
        return structuredClone(book.ledger);
      },
      save(next) {
        try {
          const updated = full ? editFull(book,next) : localEdit(book, next, () => crypto.randomUUID());
          const added = full ? updated.dirty && !book.conflict : updated.pending.length > book.pending.length;
          persist(updated, false);
          if (added) queueMicrotask(sync);
        } catch (e) {
          S = structuredClone(book.ledger);
          queueMicrotask(() => { render(); toast(e.message); });
          throw e;
        }
      },
      panel(back) {
        const last = book.lastSync ? new Date(book.lastSync).toLocaleString('zh-CN') : '尚未同步';
        const button = (id, label) => '<button type="button" class="list-btn" id="' + id + '">' + label + '</button>';
        return '<section id="sync-panel"><div class="section-title"><h2>虚拟账本同步</h2>' + back + '</div><div class="card">' +
          (full ? '<p>完整虚拟账本会同步账户、流水和备注、标签、预算、计划、储蓄与备忘。仅填写虚拟数据。</p>' :
          '<p>这里使用独立虚拟现金账户，每笔测试支出限 0.01 至 10 元。备注和分类保存在本机。</p>') +
          '<p>云端版本 ' + (book.revision ?? '尚未连接') + ' · 待同步 ' + pending(book) + (full ? ' 组更改' : ' 笔') + '</p><p>上次同步 ' + esc(last) + '</p>' +
          (deviceUntil() > Date.now() ? '<p>设备授权到期日 ' + esc(new Date(deviceUntil()).toLocaleDateString('zh-CN')) + '</p>' : '') +
          (revoking() ? button('sync-off','重试撤销授权') : credentials() || deviceUntil() > Date.now() ?
            button('sync-now', '立即同步') + button('sync-off', '撤销本机授权') :
            button('sync-on', wasAuthorized() ? '重新授权' : '连接虚拟账本')) +
          (book.conflict ? full ? '<p>本机与云端都有改动。云端版本 '+book.conflict.revision+'。选择前可导出两份备份核对。</p>'+button('sync-backups','导出冲突的两个版本')+button('sync-local','保留本机版本')+button('sync-remote','采用云端版本') : button('sync-retry', '按最新版本提交待同步支出') : '') +
          (full && book.bulkReview ? button('sync-bulk','核对后同步本机清理结果') : '') +
          (full && book.recovery ? button('sync-recover','导出保留的账本副本') : '') + '</div></section>';
      },
      bind() {
        const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = () => Promise.resolve().then(fn).catch(e => { notice = e.message; refresh(); }); };
        on('sync-on', connect); on('sync-now', sync);
        on('sync-off', async () => { stopped = true; if (active) await active; try { await disconnect(); notice = '已撤销授权，本机账目已保留'; } finally { stopped = false; refresh(); } });
        on('sync-bulk',()=>{
          if (confirm('确认把本机清理后的虚拟账本同步到云端？同步前的本机副本仍可导出。')) {
            persist({...book,bulkReview:false}); return sync();
          }
        });
        on('sync-backups',()=>saveFile('wallet-虚拟冲突核对.json',new Blob([JSON.stringify({local:book.ledger,cloud:book.conflict.ledger})],{type:'application/json'})));
        on('sync-recover',()=>saveFile('wallet-虚拟冲突副本.json',new Blob([JSON.stringify(book.recovery.ledger)],{type:'application/json'})));
        for (const [id,local] of [['sync-local',true],['sync-remote',false]]) on(id,()=>{
          if (!book.conflict || !confirm(local ? '确认用本机版本覆盖刚才核对的云端版本？' : '确认采用刚才核对的云端版本？本机旧版本会保留一份。')) return;
          persist(resolveFull(book,local)); return sync();
        });
        on('sync-retry', () => {
          if (!book.pending.length || !book.conflict) return;
          const updated = structuredClone(book);
          updated.pending[0].expected = null; updated.conflict = false;
          persist(updated); return sync();
        });
      },
    };
    try {
      // Load the original Wallet scripts in their usual order after obtaining the single-editor lock.
      for (const src of document.getElementById('wallet-boot').dataset.scripts.split(' ')) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script'); script.src = src;
          script.onload = resolve; script.onerror = reject; document.head.append(script);
        });
      }
      if (!book) throw Error();
      refresh();
      addEventListener('online', resume);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
      if ('serviceWorker' in navigator) await navigator.serviceWorker.register(appPath+'sw.js').catch(() => {});
      await sync();
      await new Promise(() => {});
    } catch { message('虚拟账本暂时无法打开。请保留浏览器数据后重试。'); }
  });
}
