const host = location.hostname;
if (!/^wallet-sync-dev\.[a-z0-9-]+\.workers\.dev$/.test(host)) throw Error('Unknown preview origin');
export const issuer = location.origin.replace('https://wallet-sync-dev.', 'https://wallet-mcp-dev.');
const callback = location.origin + '/connect.html';
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const nonce = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const flowKey = 'wallet.phone.pkce';
const authKey = 'wallet.phone.access';
export function credentials() {
  const auth = JSON.parse(sessionStorage.getItem(authKey) || 'null');
  if (auth && auth.until > Date.now()) return auth;
  sessionStorage.removeItem(authKey);
  return null;
}
function api(path, init) {
  return fetch(issuer + path, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
}
export async function connect() {
  const registration = await api('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Wallet 手机虚拟账本', redirect_uris: [callback], token_endpoint_auth_method: 'none' }) });
  if (!registration.ok) throw Error('暂时无法开始授权，请稍后重试。');
  const { client_id } = await registration.json();
  const state = nonce(), verifier = nonce();
  const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(flowKey, JSON.stringify({ client_id, state, verifier, at: Date.now() }));
  const query = new URLSearchParams({ client_id, state, response_type: 'code', redirect_uri: callback, resource: issuer + '/mcp',
    scope: 'wallet:read wallet:write', code_challenge: challenge, code_challenge_method: 'S256' });
  location.assign(issuer + '/authorize?' + query);
}
export async function finish() {
  const params = new URLSearchParams(location.search);
  history.replaceState(null, '', '/connect.html');
  const flow = JSON.parse(sessionStorage.getItem(flowKey) || 'null');
  sessionStorage.removeItem(flowKey);
  if (!flow || Date.now() - flow.at > 600000 || params.get('iss') !== issuer || params.get('state') !== flow.state
      || !params.get('code') || params.has('error')) throw Error('授权未完成，请返回 Wallet 重新连接。');
  const res = await api('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code',
    code: params.get('code'), code_verifier: flow.verifier, client_id: flow.client_id, redirect_uri: callback, resource: issuer + '/mcp' }) });
  if (!res.ok) throw Error('授权已过期，请返回 Wallet 重新连接。');
  const token = await res.json();
  if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in)) throw Error('凭证无效。');
  sessionStorage.setItem(authKey, JSON.stringify({ client: flow.client_id, token: token.access_token, until: Date.now() + token.expires_in * 1000 }));
  location.replace('/');
}
export async function disconnect() {
  const auth = credentials();
  sessionStorage.removeItem(authKey);
  sessionStorage.removeItem(flowKey);
  if (auth) {
    const res = await api('/oauth/token', { method: 'POST', body: new URLSearchParams({ client_id: auth.client, token: auth.token, token_type_hint: 'access_token' }) });
    if (!res.ok) throw Error('本机已断开。服务端撤销未确认，旧凭证会到期。');
  }
}
export async function phone(path, args) {
  const auth = credentials();
  if (!auth) throw Error('请在「我的 → 虚拟账本同步」重新授权。');
  const headers = { Authorization: 'Bearer ' + auth.token };
  if (args) headers['Content-Type'] = 'application/json';
  const res = await api('/mcp/phone' + path, { method: args ? 'POST' : 'GET', headers, body: args && JSON.stringify(args) });
  if (res.status === 401) { sessionStorage.removeItem(authKey); throw Error('授权已到期，待同步记录保留在本机。'); }
  if (!res.ok) throw Error('暂时无法连接测试账本，稍后可重试。');
  return res.json();
}
