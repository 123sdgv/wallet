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
  assert.equal(response.status, 302, 'owner approval');
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
  assert.equal(new URL(denied.headers.get('Location')).searchParams.get('error'), 'access_denied');
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
