import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const script = await readFile(new URL('../../sw.js', import.meta.url), 'utf8');
const scope = 'https://wallet.example/wallet/';
const url = path => new URL(path, scope).href;

function browser() {
  const stores = new Map();
  const handlers = {};
  async function open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const data = stores.get(name);
    return {
      async match(key) { return data.get(key)?.clone(); },
      async put(key, response) { data.set(key, response); },
      async keys() { return [...data.keys()].map(key => new Request(key)); },
      async delete(request) { return data.delete(request.url); },
    };
  }
  let network = input => new Response('static ' + input);
  vm.runInNewContext(script, {
    URL, Response, self: { registration: { scope }, clients: { async claim() {} }, async skipWaiting() {},
      addEventListener(name, callback) { handlers[name] = callback; } },
    caches: { open, keys: () => [...stores.keys()], delete: name => stores.delete(name) },
    fetch: (...args) => network(...args),
  });
  async function fire(name, request) {
    const work = [];
    let response;
    handlers[name]({ request, waitUntil: promise => work.push(promise), respondWith: promise => { response = promise; } });
    const result = await response;
    await Promise.all(work);
    return result;
  }
  const get = (path, options = {}) => fire('fetch', {
    url: url(path), method: 'GET', headers: new Headers(), cache: 'default', mode: 'navigate', ...options,
  });
  return { open, stores, fire, get, online: callback => { network = callback; } };
}

test('offline quickadd gets the original app shell and private routes bypass it', async () => {
  const b = browser();
  await b.fire('install');
  b.online(() => { throw Error('offline'); });
  const page = await b.get('index.html?quickadd=expense&amount=1');
  assert.equal(await page.text(), 'static ' + url('index.html'));
  for (const path of ['api/sync', 'api/sync?cursor=1', '../other/index.html', 'https://another.example/index.html']) {
    assert.equal(await b.get(path), undefined);
  }
  assert.equal(await b.get('index.html', { headers: new Headers({ Authorization: 'Bearer fixture' }) }), undefined);
  assert.equal(await b.get('index.html', { cache: 'no-store' }), undefined);
  b.online(() => new Response('private', { headers: { 'Cache-Control': 'private, no-store' } }));
  assert.equal(await (await b.get('index.html')).text(), 'private');
  b.online(() => { throw Error('offline'); });
  assert.equal(await (await b.get('index.html')).text(), 'static ' + url('index.html'));
});

test('an uncacheable install response cannot replace an offline copy', async () => {
  const b = browser();
  b.online(() => new Response('private', { headers: { 'Cache-Control': 'no-store' } }));
  await assert.rejects(b.fire('install'), /Offline asset/);
  assert.equal(b.stores.size, 0);
});

test('updating Wallet preserves caches and entries belonging to other apps', async () => {
  const b = browser();
  await b.fire('install');
  const legacy = await b.open('sober-wallet-v17');
  await legacy.put(url('index.html'), new Response('old'));
  await legacy.put(url('../another/index.html'), new Response('another project'));
  await b.open('other-project-v1');
  await b.open('sober-wallet-shell:' + scope + ':v16');
  await b.fire('activate');
  assert.ok(b.stores.has('other-project-v1'));
  assert.equal(b.stores.has('sober-wallet-shell:' + scope + ':v16'), false);
  assert.equal(await legacy.match(url('index.html')), undefined);
  assert.equal(await (await legacy.match(url('../another/index.html'))).text(), 'another project');
});
