// 缓存当前 Wallet 的离线页面、图标和脚本。
const scope = self.registration.scope;
const cachePrefix = 'sober-wallet-shell:' + scope + ':';
const CACHE = cachePrefix + 'v19';
const ASSETS = [
  './', './index.html', './manifest.json', './icon-192.png',
  './css/style.css',
  './js/reconcile.mjs', './js/store.js', './js/calc.js', './js/ui.js', './js/home.js', './js/record.js',
  './js/calendar.js', './js/popups.js', './js/summary.js', './js/memo.js', './js/settings.js', './js/app.js',
];
const assets = new Set(ASSETS.map(path => new URL(path, scope).href));
const entries = new Set([scope, new URL('index.html', scope).href]);

function cacheable(response) {
  const policy = response.headers.get('Cache-Control') || '';
  return response.status === 200 && !response.redirected && !/\b(no-store|private)\b/i.test(policy);
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const files = await Promise.all([...assets].map(async url => {
      const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'reload' });
      if (!cacheable(response)) throw new Error('Offline asset unavailable');
      return [url, response];
    }));
    const cache = await caches.open(CACHE);
    await Promise.all(files.map(([url, response]) => cache.put(url, response)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(cachePrefix) && name !== CACHE) await caches.delete(name);
      // Older builds shared a cache name across scopes. Remove only this app's known assets.
      if (/^sober-wallet-v\d+$/.test(name)) {
        const legacy = await caches.open(name);
        for (const request of await legacy.keys()) {
          if (assets.has(request.url)) await legacy.delete(request);
        }
      }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('Authorization') || req.cache === 'no-store') return;
  const url = new URL(req.url);
  const hasQuery = Boolean(url.search);
  url.search = '';
  if (!assets.has(url.href) || (hasQuery && !(req.mode === 'navigate' && entries.has(url.href)))) return;

  event.respondWith((async () => {
    let response;
    try { response = await fetch(req, { cache: 'no-store' }); }
    catch {
      const cache = await caches.open(CACHE);
      return await cache.match(url.href) || Response.error();
    }
    if (!hasQuery && cacheable(response)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.href, copy)).catch(() => {}));
    }
    return response;
  })());
});
