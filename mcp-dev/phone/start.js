import { exchange, initial, key, localEdit } from './state.js';
import { connect, credentials, disconnect, finish, phone } from './oauth.js';

function message(text) { const el = document.getElementById('sync-status'); if (el) el.textContent = text; }

if (location.pathname === '/connect.html') {
  finish().catch(() => message('授权未完成。请返回 Wallet，在「我的」里重新连接。'));
} else if (!navigator.locks) {
  message('此浏览器无法保护多个窗口同时写入。请用支持设备锁定的浏览器打开虚拟账本。');
} else {
  navigator.locks.request(key, { ifAvailable: true }, async lock => {
    if (!lock) return message('虚拟账本已在另一个窗口打开，请回到该窗口。');
    let book, active, notice = '', wake = false, stopped = false;
    function status() {
      return notice || (book?.conflict ? '待处理版本冲突' : active ? '同步中' : credentials() ? '已授权' : '待连接');
    }
    function refresh() {
      message('虚拟测试账本 · ' + status() + ' · 待同步 ' + (book?.pending.length || 0) + ' 笔');
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
      if (stopped || !credentials()) { refresh(); return; }
      notice = '';
      active = (async () => {
        do {
          wake = false;
          await exchange({ read: () => book, persist: value => persist(value), pull: rev => phone('?after=' + rev), post: args => phone('', args) });
        } while (wake && !book.conflict && !stopped);
      })().catch(error => { notice = error instanceof TypeError ? '离线，待同步记录已保留' : error.message; })
        .finally(() => { active = null; refresh(); });
      refresh();
      return active;
    }
    globalThis.walletSandbox = {
      load(defaults) {
        const raw = localStorage.getItem(key);
        book = raw ? JSON.parse(raw) : initial(defaults);
        if (book.format !== 1 || !Array.isArray(book.pending) || !Array.isArray(book.ledger?.txs)) throw Error('虚拟账本无法读取，已保留原始内容。');
        return structuredClone(book.ledger);
      },
      save(next) {
        try {
          const updated = localEdit(book, next, () => crypto.randomUUID());
          const added = updated.pending.length > book.pending.length;
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
          '<p>这里使用独立虚拟现金账户，每笔测试支出限 0.01 至 10 元。备注和分类保存在本机。</p>' +
          '<p>云端版本 ' + book.revision + ' · 待同步 ' + book.pending.length + ' 笔</p><p>上次同步 ' + esc(last) + '</p>' +
          (credentials() ? button('sync-now', '立即同步') + button('sync-off', '断开授权') : button('sync-on', '连接虚拟账本')) +
          (book.conflict ? button('sync-retry', '按最新版本提交待同步支出') : '') + '</div></section>';
      },
      bind() {
        const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = () => Promise.resolve().then(fn).catch(e => { notice = e.message; refresh(); }); };
        on('sync-on', connect); on('sync-now', sync);
        on('sync-off', async () => { stopped = true; if (active) await active; try { await disconnect(); } finally { stopped = false; refresh(); } });
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
      addEventListener('online', sync);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
      if ('serviceWorker' in navigator) await navigator.serviceWorker.register('/sw.js').catch(() => {});
      await sync();
      await new Promise(() => {});
    } catch { message('虚拟账本暂时无法打开。请保留浏览器数据后重试。'); }
  });
}
