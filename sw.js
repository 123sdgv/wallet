// 网络优先：有网时总是拿最新版本并顺手更新缓存；没网时用缓存兜底
const CACHE = 'sober-wallet-v16';
const ASSETS = [
  './', './index.html', './manifest.json', './icon-192.png',
  './css/style.css',
  './js/store.js', './js/calc.js', './js/ui.js', './js/home.js', './js/record.js',
  './js/calendar.js', './js/popups.js', './js/summary.js', './js/memo.js', './js/settings.js', './js/app.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(req, { cache: 'no-store' }).then(res => {
      // 带参数的地址（如快捷指令 ?quickadd=）不进缓存，免得越存越多
      if (res && res.status === 200 && !new URL(req.url).search) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() =>
      caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))
    )
  );
});
