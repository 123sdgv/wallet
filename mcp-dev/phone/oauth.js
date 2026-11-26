const host = location.hostname;
if (!/^wallet-sync-dev\.[a-z0-9-]+\.workers\.dev$/.test(host)) throw Error('Unknown preview origin');
export const issuer = location.origin.replace('https://wallet-sync-dev.', 'https://wallet-mcp-dev.');
export const full = location.pathname.startsWith('/full/');
export const appPath = full ? '/full/' : '/';
const callback = location.origin + appPath + 'connect.html';
const prefix = full ? 'wallet.full.' : 'wallet.phone.';
const base64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
const nonce = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const flowKey = prefix + 'pkce';
const authKey = prefix + 'access';
const deviceKey = prefix + 'device-deadline';
const revokeKey = prefix + 'pending-revocation';
export const deviceUntil = () => Number(localStorage.getItem(deviceKey) || 0);
export const revoking = () => localStorage.getItem(revokeKey) === 'yes';
export const wasAuthorized = () => localStorage.getItem(deviceKey) !== null;
let renewing;
async function device(action, body) {
  return fetch((full ? '/device/full/' : '/device/') + action, {method:'POST', credentials:'same-origin', cache:'no-store', redirect:'error',
    headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
}
function keep(token, client) {
  if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in)) throw Error('凭证无效。');
  localStorage.setItem(deviceKey, String((token.device_until || 0) * 1000));
  sessionStorage.setItem(authKey,JSON.stringify({client, token:token.access_token, until:Date.now()+token.expires_in*1000}));
}
export async function restore() {
  if (revoking()) { await disconnect(); return null; }
  if (credentials()) return credentials();
  if (deviceUntil() <= Date.now()) return null;
  if (!renewing) renewing = (async () => {
    const res = await device('resume',{});
    if (res.status === 401) { localStorage.setItem(deviceKey,'0'); return null; }
    if (!res.ok) throw Error('暂时无法续接，待同步记录保留在本机。');
    keep(await res.json(),null);
    return credentials();
  })().finally(()=>{ renewing = null; });
  return renewing;
}
export function credentials() {
  const auth = JSON.parse(sessionStorage.getItem(authKey) || 'null');
  if (!revoking() && auth && auth.until > Date.now() && (!deviceUntil() || deviceUntil() > Date.now())) return auth;
  sessionStorage.removeItem(authKey);
  return null;
}
function api(path, init) {
  return fetch(issuer + path, { ...init, credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
}
export async function connect() {
  if (revoking()) await disconnect();
  const registration = await api('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Wallet 手机虚拟账本', redirect_uris: [callback], grant_types:['authorization_code','refresh_token'], token_endpoint_auth_method: 'none' }) });
  if (!registration.ok) throw Error('暂时无法开始授权，请稍后重试。');
  const { client_id } = await registration.json();
  const state = nonce(), verifier = nonce();
  const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(flowKey, JSON.stringify({ client_id, state, verifier, at: Date.now() }));
  const query = new URLSearchParams({ client_id, state, response_type: 'code', redirect_uri: callback, resource: issuer + '/mcp',
    scope: full ? 'wallet:read wallet:ledger:read wallet:device:sync' : 'wallet:read wallet:write', code_challenge: challenge, code_challenge_method: 'S256' });
  location.assign(issuer + '/authorize?' + query);
}
export async function finish() {
  const params = new URLSearchParams(location.search);
  history.replaceState(null, '', appPath+'connect.html');
  const flow = JSON.parse(sessionStorage.getItem(flowKey) || 'null');
  sessionStorage.removeItem(flowKey);
  if (!flow || Date.now() - flow.at > 600000 || params.get('iss') !== issuer || params.get('state') !== flow.state
      || !params.get('code') || params.has('error')) throw Error('授权未完成，请返回 Wallet 重新连接。');
  const res = await device('connect',{client:flow.client_id,code:params.get('code'),verifier:flow.verifier});
  if (!res.ok) throw Error('授权未完成，请重新连接。');
  keep(await res.json(),flow.client_id);
  location.replace(appPath);
}
export async function disconnect() {
  const auth = JSON.parse(sessionStorage.getItem(authKey) || 'null');
  localStorage.setItem(revokeKey,'yes');
  try {
    const res = await device('revoke',{});
    if (!res.ok) throw Error();
    if (!deviceUntil() && auth?.client && auth.until > Date.now()) {
      const revoked = await api('/oauth/token',{method:'POST',body:new URLSearchParams({client_id:auth.client,token:auth.token,token_type_hint:'access_token'})});
      if (!revoked.ok) throw Error();
    }
  } catch { throw Error('本机同步已暂停，联网后会重试撤销。'); }
  sessionStorage.removeItem(authKey);
  sessionStorage.removeItem(flowKey);
  localStorage.setItem(deviceKey,'0');
  localStorage.removeItem(revokeKey);
}
export async function phone(path, args) {
  const auth = await restore();
  if (!auth) throw Error('请在「我的 → 虚拟账本同步」重新授权。');
  const headers = { Authorization: 'Bearer ' + auth.token };
  if (args) headers['Content-Type'] = 'application/json';
  const res = await api((full ? '/mcp/phone/ledger' : '/mcp/phone') + path, { method: args ? 'POST' : 'GET', headers, body: args && JSON.stringify(args) });
  if (res.status === 401) { sessionStorage.removeItem(authKey); throw Error('授权已到期，待同步记录保留在本机。'); }
  if (!res.ok) throw Error('暂时无法连接测试账本，稍后可重试。');
  return res.json();
}
