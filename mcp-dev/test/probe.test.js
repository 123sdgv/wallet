import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import vm from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Miniflare } from 'miniflare';

const issuer = 'https://wallet-mcp-dev.example.workers.dev';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const ownerKey = randomBytes(32).toString('hex');
const file = name => new URL(name, import.meta.url);
let runtime, options, storeDir, clientId, writable;

const fetchTest = (path, options = {}) => runtime.dispatchFetch(new URL(path, issuer).href, { redirect: 'manual', ...options });
function post(path, fields, headers = {}) {
  return fetchTest(path, { method: 'POST', body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers } });
}
function rpc(method, params, token, headers = {}) {
  return fetchTest('/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(token && { Authorization: 'Bearer ' + token }), ...headers,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
const call = (name, args, token) => rpc('tools/call', { name, arguments: args }, token);
async function data(response) {
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.ok(json.result, 'expected a successful RPC envelope');
  return json.result.structuredContent;
}
async function begin(scope, changes = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: callback, response_type: 'code', scope, state: randomUUID(),
    resource: issuer + '/mcp', code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...changes,
  });
  const page = await fetchTest('/authorize?' + query);
  return { page, query, verifier };
}
async function formFor(scope) {
  const { page, query, verifier } = await begin(scope);
  assert.equal(page.status, 200, 'consent form');
  const html = await page.text();
  const cookie = page.headers.get('Set-Cookie').split(';')[0];
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  return { cookie, handle, verifier, query };
}
function decide({ cookie, handle }, fields = {}, headers = {}) {
  return post('/authorize', { handle, owner_key: ownerKey, decision: 'approve', ...fields },
    { Origin: issuer, Cookie: cookie, ...headers });
}
async function codeFor(scope) {
  const form = await formFor(scope);
  const response = await decide(form);
  assert.equal(response.status, 303, 'owner approval must return via GET');
  const redirect = new URL(response.headers.get('Location'));
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('iss'), issuer);
  assert.equal(redirect.searchParams.get('state'), form.query.get('state'));
  return {
    grant_type: 'authorization_code', client_id: clientId, redirect_uri: callback,
    resource: issuer + '/mcp', code_verifier: form.verifier, code: redirect.searchParams.get('code'),
  };
}
async function grant(scope) {
  const response = await post('/oauth/token', await codeFor(scope));
  assert.equal(response.status, 200, 'PKCE token exchange');
  const tokens = await response.json();
  assert.equal(tokens.expires_in, 900);
  assert.ok(!tokens.refresh_token);
  return tokens.access_token;
}

before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'wallet-probe-'));
  options = {
    cf: false, outboundService: () => new Response(null, { status: 403 }),
    d1Persist: join(storeDir, 'd1'), kvPersist: join(storeDir, 'kv'),
    modules: true, script: await readFile(file('../dist/worker.mjs'), 'utf8'),
    host: '127.0.0.1', compatibilityDate: '2026-07-01', compatibilityFlags: ['global_fetch_strictly_public'],
    bindings: { ISSUER: issuer, OWNER_KEY: ownerKey }, kvNamespaces: ['OAUTH_KV'], d1Databases: ['DB'],
    ratelimits: { LIMITER: { namespace_id: '1001', simple: { limit: 600, period: 60 } } },
  };
  runtime = new Miniflare(options);
  const db = await runtime.getD1Database('DB');
  const sql = await readFile(file('../schema.sql'), 'utf8');
  for (const statement of sql.split(';').filter(s => s.trim())) await db.prepare(statement).run();
  const register = await fetchTest('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Local test', redirect_uris: [callback], token_endpoint_auth_method: 'none' }) });
  assert.equal(register.status, 201, 'DCR');
  clientId = (await register.json()).client_id;
});
after(async () => {
  await runtime?.dispose();
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

test('discovery, issuer, resource, exact callback, expiry and PKCE policy', async () => {
  const as = await (await fetchTest('/.well-known/oauth-authorization-server')).json();
  assert.equal(as.issuer, issuer);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  const metadata = await (await fetchTest('/.well-known/oauth-protected-resource/mcp')).json();
  assert.equal(metadata.resource, issuer + '/mcp');
  assert.deepEqual(metadata.authorization_servers, [issuer]);
  const invalid = await fetchTest('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['https://unrelated.invalid/callback'] }) });
  assert.equal(invalid.status, 400);
  assert.equal((await begin('wallet:read', { code_challenge_method: 'plain' })).page.status, 400);
  assert.equal((await begin('wallet:read', { resource: issuer + '/other' })).page.status, 400);
  const fields = await codeFor('wallet:read');
  assert.equal((await post('/oauth/token', { ...fields, code_verifier: randomBytes(32).toString('base64url') })).status, 400);
});

test('missing or invalid token, wrong origin and oversized body are denied', async () => {
  for (const token of [undefined, 'invalid-local-test']) {
    const response = await call('get_test_balance', {}, token);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('WWW-Authenticate'), /resource_metadata=/);
    assert.match(response.headers.get('Cache-Control'), /no-store/);
    assert.doesNotMatch(await response.text(), /balance_fen/);
  }
  assert.equal((await rpc('tools/list', {}, null, { Origin: 'https://other.invalid' })).status, 403);
  const tooLarge = await fetchTest('/mcp', { method: 'POST', body: 'x'.repeat(16385) });
  assert.equal(tooLarge.status, 413);
});

test('consent requires the owner, the same browser and an explicit approval', async () => {
  const form = await formFor('wallet:read');
  assert.equal((await decide(form, { owner_key: randomBytes(32).toString('hex') })).status, 403);
  assert.equal((await decide(form, {}, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await decide(form, {}, { Cookie: '' })).status, 400);
  const denied = await decide(await formFor('wallet:read'), { decision: 'deny' });
  assert.equal(denied.status, 303);
  assert.equal(new URL(denied.headers.get('Location')).searchParams.get('error'), 'access_denied');
});

test('browser form retains its origin and failed consent renders an inline message', async () => {
  const { page } = await begin('wallet:read');
  assert.equal(page.headers.get('Referrer-Policy'), 'strict-origin');
  const form = await formFor('wallet:read');
  const opaque = await decide(form, {}, { Origin: 'null' });
  const stale = await decide(form, {}, { Cookie: '' });
  assert.equal(opaque.status, 403);
  assert.equal(stale.status, 400);
  for (const response of [opaque, stale]) {
    assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
    assert.match(response.headers.get('Content-Type'), /^text\/plain; charset=utf-8$/);
    assert.equal(response.headers.get('Content-Disposition'), 'inline');
    assert.match(await response.text(), /Wallet/);
  }
});

test('read-only token cannot change balance; revocation invalidates it', async () => {
  const token = await grant('wallet:read');
  const before = await data(await call('get_test_balance', {}, token));
  assert.equal(before.balance_fen, 10000);
  const response = await call('add_test_expense', { amount_fen: 123, operation_id: randomUUID(), expected_revision: 0 }, token);
  assert.equal(response.status, 403);
  assert.match(response.headers.get('WWW-Authenticate'), /wallet:write/);
  assert.equal((await data(await call('get_test_balance', {}, token))).revision, before.revision);
  assert.equal((await post('/oauth/token', { token, client_id: clientId, token_type_hint: 'access_token' })).status, 200);
  assert.equal((await call('get_test_balance', {}, token)).status, 401);
});

test('official MCP client discovers tools, writes and rereads across a fresh client', async () => {
  writable = await grant('wallet:read wallet:write');
  function newClient() {
    const client = new Client({ name: 'wallet-local-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', issuer), {
      fetch: (url, options) => fetchTest(String(url), options),
      requestInit: { headers: { Authorization: 'Bearer ' + writable } },
    });
    return { client, transport };
  }
  const { client, transport } = newClient();
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => [t.name, t.annotations.readOnlyHint]), [['get_test_balance', true], ['add_test_expense', false]]);
  const expense = { expected_revision: 0, amount_fen: 123, operation_id: randomUUID() };
  const write = await client.callTool({ name: 'add_test_expense', arguments: expense });
  assert.equal(write.structuredContent.after_fen, 9877);
  const replay = await client.callTool({ name: 'add_test_expense', arguments: expense });
  assert.equal(replay.structuredContent.replayed, true);
  const reused = await client.callTool({ name: 'add_test_expense', arguments: { ...expense, amount_fen: 124 } });
  assert.equal(reused.structuredContent.error, 'operation_id_reused');
  await client.close();
  const fresh = newClient();
  await fresh.client.connect(fresh.transport);
  const read = await fresh.client.callTool({ name: 'get_test_balance', arguments: {} });
  assert.equal(read.structuredContent.balance_fen, 9877);
  assert.equal(read.structuredContent.revision, 1);
  await fresh.client.close();

  // Compare the fixture against Wallet's unmodified offline expense calculation.
  const sandbox = vm.createContext({ S: { accounts: [{ id: 'fixture', balance: 100 }] },
    r2: x => Math.round(x * 100) / 100 });
  vm.runInContext(await readFile(file('../../js/calc.js'), 'utf8'), sandbox);
  vm.runInContext("applyTx({ accountId: 'fixture', type: 'expense', amount: 1.23 })", sandbox);
  assert.equal(Math.round(sandbox.S.accounts[0].balance * 100), read.structuredContent.balance_fen);
});

test('concurrent writes at one revision apply once; invalid or private fields are refused', async () => {
  const params = { expected_revision: 1, amount_fen: 77, operation_id: randomUUID() };
  const both = await Promise.all([params, { ...params, operation_id: randomUUID() }].map(async args =>
    data(await call('add_test_expense', args, writable))));
  assert.equal(both.filter(x => x.receipt_revision === 2).length, 1);
  assert.equal(both.filter(x => x.error === 'revision_conflict').length, 1);
  for (const args of [{ ...params, amount_fen: 0 }, { ...params, amount_fen: 1.2 },
    { ...params, amount_fen: 1001 }, { ...params, note: 'unsolicited field' }]) {
    assert.equal((await (await call('add_test_expense', args, writable)).json()).error.code, -32602);
  }
  assert.equal((await data(await call('get_test_balance', {}, writable))).balance_fen, 9800);
});

test('persisted receipt survives a cold restart; rotated or missing owner credentials fail closed', async () => {
  await runtime.dispose();
  runtime = new Miniflare(options);
  const state = await data(await call('get_test_balance', {}, writable));
  assert.equal(state.revision, 2);
  assert.equal(state.balance_fen, 9800);

  const next = { ...options, bindings: { ...options.bindings, OWNER_KEY: randomBytes(32).toString('hex') } };
  await runtime.setOptions(next);
  assert.equal((await call('get_test_balance', {}, writable)).status, 401);
  await runtime.setOptions({ ...options, bindings: { ISSUER: issuer } });
  assert.equal((await call('get_test_balance', {}, writable)).status, 503);
  await runtime.setOptions(options);
});

test('public discovery and challenge work with a malformed key; grants and ledger stay closed', async () => {
  await runtime.setOptions({ ...options, bindings: { ...options.bindings, OWNER_KEY: 'invalid-test-fixture' } });
  try {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await fetchTest(path);
      assert.equal(res.status, 200);
      assert.equal((await res.json()).resource, issuer + '/mcp');
    }
    assert.equal((await (await fetchTest('/.well-known/oauth-authorization-server')).json()).issuer, issuer);
    const res = await call('get_test_balance', {});
    assert.equal(res.status, 401);
    assert.match(res.headers.get('WWW-Authenticate'), /resource_metadata=/);
    assert.equal((await call('get_test_balance', {}, writable)).status, 503);
    assert.equal((await post('/oauth/token', {})).status, 503);
    assert.equal((await fetchTest('/authorize')).status, 503);
    const setup = await fetchTest('/setup-key');
    const html = await setup.text();
    const script = html.match(/<script>([\s\S]+?)<\/script>/)[1];
    const hash = createHash('sha256').update(script).digest('base64');
    assert.ok(setup.headers.get('Content-Security-Policy').includes("'sha256-" + hash + "'"));
    assert.match(setup.headers.get('Content-Security-Policy'), /connect-src 'none'/);
    const input = { focus() {}, select() {} }, button = {};
    vm.runInNewContext(script, { crypto, document: { querySelector: id => id === '#key' ? input : button } });
    button.onclick();
    assert.match(input.value, /^[a-f0-9]{64}$/);
  } finally { await runtime.setOptions(options); }
});

test('an expired local token record cannot read or write', async () => {
  const token = await grant('wallet:read wallet:write');
  const kv = await runtime.getKVNamespace('OAUTH_KV');
  const keys = await kv.list({ prefix: 'token:' + token.split(':').slice(0, 2).join(':') + ':' });
  assert.equal(keys.keys.length, 1);
  const { name } = keys.keys[0];
  const record = await kv.get(name, 'json');
  await kv.put(name, JSON.stringify({ ...record, expiresAt: Math.floor(Date.now() / 1000) - 30 }));
  assert.equal((await call('get_test_balance', {}, token)).status, 401);
  assert.equal((await call('add_test_expense', { amount_fen: 1, expected_revision: 2, operation_id: randomUUID() }, token)).status, 401);
  const valid = await grant('wallet:read');
  assert.equal((await data(await call('get_test_balance', {}, valid))).revision, 2);
});

test('phone OAuth grant is isolated from ChatGPT; both clients see the same virtual receipts', async () => {
  const phoneOrigin = issuer.replace('wallet-mcp-dev.', 'wallet-sync-dev.');
  const redirect = phoneOrigin + '/connect.html';
  const registration = await fetchTest('/oauth/register', { method: 'POST', headers: { Origin: phoneOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Phone fixture', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201);
  const client = (await registration.json()).client_id;
  async function phoneGrant(scope) {
    const req = await begin(scope, { client_id: client, redirect_uri: redirect });
    assert.equal(req.page.status, 200);
    const cookie = req.page.headers.get('set-cookie').split(';')[0];
    const handle = (await req.page.text()).match(/name="handle" value="([^"]+)"/)[1];
    const response = await decide({ cookie, handle });
    const location = new URL(response.headers.get('location'));
    assert.equal(location.origin + location.pathname, redirect);
    const token = await post('/oauth/token', { grant_type: 'authorization_code', client_id: client, resource: issuer + '/mcp',
      redirect_uri: redirect, code_verifier: req.verifier, code: location.searchParams.get('code') }, { Origin: phoneOrigin });
    assert.equal(token.status, 200);
    return (await token.json()).access_token;
  }
  const phoneRead = await phoneGrant('wallet:read');
  const chat = await grant('wallet:read wallet:write');
  const request = (token, op, origin = phoneOrigin, cursor = 0) => fetchTest('/mcp/phone?after=' + cursor, {
    method: op ? 'POST' : 'GET', headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: op && JSON.stringify(op) });
  const before = await data(await call('get_test_balance', {}, chat));
  const op = { operation_id: randomUUID(), expected_revision: before.revision, amount_fen: 77 };
  assert.equal((await request(phoneRead)).status, 200);
  assert.equal((await request(phoneRead, op)).status, 403);
  const phoneWrite = await phoneGrant('wallet:read wallet:write');
  assert.equal((await request(chat)).status, 401);
  assert.equal((await request(phoneWrite, op, 'https://unrelated.invalid')).status, 403);
  assert.equal((await call('get_test_balance', {}, phoneWrite)).status, 401);
  assert.equal((await request(phoneWrite, { ...op, note: 'must remain local' })).status, 400);
  const receipt = await request(phoneWrite, op);
  assert.equal(receipt.headers.get('Access-Control-Allow-Origin'), phoneOrigin);
  assert.equal((await receipt.json()).receipt_revision, before.revision + 1);
  const state = await data(await call('get_test_balance', {}, chat));
  assert.equal(state.balance_fen, before.balance_fen - 77);
  const other = { operation_id: randomUUID(), expected_revision: state.revision, amount_fen: 1 };
  await data(await call('add_test_expense', other, chat));
  const page = await (await request(phoneWrite, null, phoneOrigin, before.revision)).json();
  assert.deepEqual(page.changes.map(r => r.operation_id), [op.operation_id, other.operation_id]);
  assert.equal(page.balance_fen, before.balance_fen - 78);
});

test('complete ledger reads require a separate scope and return only the requested synthetic data', async () => {
  const { initializeOpeningLedger, prepareOpening } = await import('../opening-ledger.js');
  await runtime.setOptions({ ...options, d1Databases: ['DB','BUSINESS_DB'] });
  try {
    const db = await runtime.getD1Database('BUSINESS_DB');
    const schema = await readFile(file('../business-schema.sql'), 'utf8');
    for (const statement of schema.replace(/^--.*$/gm,'').trim().split(/\n\s*\n/)) await db.prepare(statement).run();
    const source = {settings:{safe:10},safeAlloc:{cash:10},accounts:[{id:'cash',name:'虚拟',balance:100}],
      tags:[{id:'daily',name:'测试'}],goals:[],plans:[],memos:[{id:'m',text:'fixture memo'}],budgets:{'2026-11':{total:20,set:true,tagLimits:{daily:20}}},
      txs:[{id:'prior',date:'2026-11-01',type:'expense',accountId:'cash',amount:2,tagId:'daily',note:'fixture note'}]};
    await initializeOpeningLedger(db,source,(await prepareOpening(source)).digest);
    const limited = await grant('wallet:read');
    const denied = await call('get_financial_records',{collection:'memos'},limited);
    assert.equal(denied.status,403);
    assert.match(denied.headers.get('WWW-Authenticate'),/wallet:ledger:read/);
    let full = await grant('wallet:read wallet:ledger:read');
    const ledger = async (name,args) => data(await call(name,args,full));
    const overview = await ledger('get_financial_overview',{month:'2026-11'});
    assert.equal(overview.assets_fen,10000);
    assert.equal(overview.free_fen,9000);
    assert.equal(overview.remaining_fen,1800);
    assert.doesNotMatch(JSON.stringify(overview),/fixture note|fixture memo/);
    const first=await ledger('get_financial_records',{collection:'txs',limit:1});
    assert.equal(first.records[0].id,'prior');
    const fields = {kind:'refund',amount_fen:55,operation_id:randomUUID(),expected_revision:0,account_id:'cash',local_date:'2026-11-26',tag_id:'daily'};
    assert.equal((await call('add_ledger_transaction',fields,full)).status,403);
    assert.equal((await begin('wallet:read wallet:ledger:write')).page.status,400);
    const writer=await grant('wallet:read wallet:ledger:read wallet:ledger:write');
    const receipt=await data(await call('add_ledger_transaction',fields,writer));
    assert.equal(receipt.revision,1);
    assert.deepEqual(receipt.account_changes,[{id:'cash',before_fen:10000,after_fen:10055}]);
    const updatedRead = await grant('wallet:read wallet:ledger:read');
    full = updatedRead;
    const now=await ledger('get_financial_overview',{month:'2026-11'});
    assert.equal(now.assets_fen,10055);assert.equal(now.refund_fen,55);assert.equal(now.remaining_fen,1855);
    const changed=await ledger('get_financial_records',{collection:'txs',revision:0});
    assert.equal(changed.error,'revision_conflict');
    const txs=await ledger('get_financial_records',{collection:'txs',account_id:'cash',tag_id:'daily',month:'2026-11',limit:1});
    assert.equal(txs.records[0].amount,-0.55);assert.equal(txs.next_offset,1);
    const next=await ledger('get_financial_records',{collection:'txs',offset:1,revision:1,limit:1});
    assert.equal(next.records[0].id,'prior');assert.equal(next.next_offset,null);
    assert.equal((await ledger('get_financial_records',{collection:'accounts'})).records[0].balance,100.55);
    assert.equal((await ledger('get_financial_records',{collection:'memos'})).records[0].text,'fixture memo');
    assert.equal((await call('add_test_expense',{operation_id:randomUUID(),expected_revision:0,amount_fen:1},full)).status,403);

    const origin=issuer.replace('wallet-mcp-dev.','wallet-sync-dev.'), redirect=origin+'/full/connect.html';
    const reg=await fetchTest('/oauth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'})});
    assert.equal(reg.status,201);
    const phoneClient=(await reg.json()).client_id;
    const start=await begin('wallet:read wallet:ledger:read wallet:device:sync',{client_id:phoneClient,redirect_uri:redirect});
    const markup=await start.page.text();
    const allowed=await decide({cookie:start.page.headers.get('Set-Cookie').split(';')[0],handle:markup.match(/name="handle" value="([^"]+)"/)[1]},{remember:'30'});
    const args={client:phoneClient,verifier:start.verifier,code:new URL(allowed.headers.get('Location')).searchParams.get('code')};
    const device=await fetchTest('/device/full/connect',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(args)});
    assert.equal(device.status,200); assert.match(device.headers.get('set-cookie'),/^__Host-wallet-full-device=/);
    const token=(await device.json()).access_token, phoneHeaders={Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json'};
    assert.equal((await fetchTest('/mcp/phone',{headers:phoneHeaders})).status,403);
    assert.equal((await fetchTest('/mcp/phone/ledger',{headers:{...phoneHeaders,Authorization:'Bearer '+full}})).status,401);
    const snapshot=await (await fetchTest('/mcp/phone/ledger',{headers:phoneHeaders})).json();
    assert.equal(snapshot.revision,1);assert.equal(snapshot.ledger.txs[0].amount,-0.55);
    snapshot.ledger.memos.push({id:'from-phone',text:'device fixture',ts:2});
    const posted=await fetchTest('/mcp/phone/ledger',{method:'POST',headers:phoneHeaders,body:JSON.stringify({
      expected_revision:1,operation_id:randomUUID(),ledger:snapshot.ledger})});
    assert.equal((await posted.json()).receipt_revision,2);
    const memos=await ledger('get_financial_records',{collection:'memos'});
    assert.ok(memos.records.some(m=>m.id==='from-phone'));assert.equal(memos.revision,2);
  } finally { await runtime.setOptions(options); }
});

test('remembered phone rotates its HttpOnly cookie with a fixed deadline and can be revoked locally or remotely', async () => {
  const origin=issuer.replace('wallet-mcp-dev.','wallet-sync-dev.'), redirect=origin+'/connect.html';
  const browser=(path,body,cookie,source=origin)=>fetchTest('/device/'+path,{method:'POST',
    headers:{Origin:source,'Content-Type':'application/json',...(cookie && {Cookie:cookie})},body:JSON.stringify(body)});
  const access=token=>fetchTest('/mcp/phone',{headers:{Origin:origin,Authorization:'Bearer '+token}});
  async function enrollBrowser() {
    const registration=await fetchTest('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'})});
    const client=(await registration.json()).client_id;
    const req=await begin('wallet:read wallet:write',{client_id:client,redirect_uri:redirect});
    const html=await req.page.text();
    assert.match(html,/记住这台设备 30 天/);
    const handle=html.match(/name="handle" value="([^"]+)"/)[1];
    const approval=await decide({handle,cookie:req.page.headers.get('set-cookie').split(';')[0]},{remember:'30'});
    const code=new URL(approval.headers.get('Location')).searchParams.get('code');
    const response=await browser('connect',{code,client,verifier:req.verifier});
    assert.equal(response.status,200);
    const cookie=response.headers.get('Set-Cookie');
    assert.match(cookie,/__Host-wallet-device=/);
    assert.match(cookie,/HttpOnly; SameSite=Strict/);
    const data=await response.json();
    assert.ok(!data.refresh_token && data.expires_in<=900);
    assert.ok(Math.abs(data.device_until-Math.floor(Date.now()/1000)-30*86400)<5);
    return {cookie:cookie.split(';')[0],...data};
  }
  const first=await enrollBrowser();
  assert.equal((await browser('resume',{},first.cookie,'https://other.invalid')).status,403);
  const rotated=await browser('resume',{},first.cookie);
  assert.equal(rotated.status,200);
  const next=await rotated.json();
  assert.equal(next.device_until,first.device_until);
  const newCookie=rotated.headers.get('Set-Cookie').split(';')[0];
  assert.notEqual(newCookie,first.cookie);
  assert.equal((await access(next.access_token)).status,200);
  assert.equal((await browser('revoke',{},newCookie)).status,200);
  assert.equal((await access(next.access_token)).status,401);
  assert.equal((await browser('resume',{},newCookie)).status,401);
  const second=await enrollBrowser(), db=await runtime.getD1Database('DB');
  await db.prepare('UPDATE wallet_devices SET expires_at=0').run();
  assert.equal((await access(second.access_token)).status,401);
  assert.equal((await browser('resume',{},second.cookie)).status,401);
  const third=await enrollBrowser();
  assert.equal((await post('/devices',{action:'revoke',owner_key:'bad'},{Origin:issuer})).status,403);
  assert.equal((await access(third.access_token)).status,200);
  assert.equal((await post('/devices',{action:'revoke',owner_key:ownerKey},{Origin:issuer})).status,200);
  assert.equal((await access(third.access_token)).status,401);
  assert.equal((await browser('resume',{},third.cookie)).status,401);
});
