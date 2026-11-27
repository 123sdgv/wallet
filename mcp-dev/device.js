import { OAuthError } from '@cloudflare/workers-oauth-provider';

export const DEVICE_SECONDS = 30 * 24 * 3600;
const cookieName = full => full ? '__Host-wallet-full-device' : '__Host-wallet-device';
const now = () => Math.floor(Date.now() / 1000);
const primary = env => env.DB.withSession('first-primary');

export function ownerMatches(value, secret) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && typeof secret === 'string' && secret.length === 64
    && crypto.subtle.timingSafeEqual(new TextEncoder().encode(value), new TextEncoder().encode(secret));
}
export async function enroll(env) {
  const device = crypto.randomUUID(), until = now() + DEVICE_SECONDS;
  const db = primary(env);
  await db.batch([db.prepare('DELETE FROM wallet_devices WHERE expires_at <= ?').bind(now()),
    db.prepare('INSERT INTO wallet_devices (id,expires_at) VALUES (?,?)').bind(device, until)]);
  return device;
}
export async function deadline(env, id) {
  return (await primary(env).prepare('SELECT expires_at FROM wallet_devices WHERE id=? AND expires_at>?').bind(id, now()).first())?.expires_at || 0;
}
export async function exchangePolicy({ props, env }, fingerprint) {
  if (!props?.device) return { refreshTokenTTL: 0 };
  const remaining = await deadline(env, props.device) - now();
  if (!['phone','chatgpt'].includes(props.clientSurface) || props.generation !== await fingerprint(env.OWNER_KEY) || remaining < 60) {
    throw new OAuthError('invalid_grant', { description: 'Device authorization ended.' });
  }
  return { accessTokenTTL: Math.min(900, remaining), refreshTokenTTL: remaining };
}
function response(data, status, cookie, full) {
  const headers = { 'Cache-Control':'private, no-store' };
  if (cookie !== undefined) headers['Set-Cookie'] = cookieName(full) + '=' + (cookie?.value || '') +
    '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + (cookie?.age || 0);
  return Response.json(data, { status, headers });
}
function deviceCookie(request, full) {
  const value = (request.headers.get('Cookie') || '').split(/;\s*/).find(pair => pair.startsWith(cookieName(full) + '='))?.slice(cookieName(full).length + 1);
  if (!value || value.length > 3000) return null;
  try {
    const [client, refresh] = JSON.parse(atob(value));
    return typeof client === 'string' && typeof refresh === 'string' ? {client, refresh} : null;
  } catch { return null; }
}

// The preview forwards only these same-origin POSTs. The rotating refresh token belongs to its host-only cookie.
export async function deviceSession(request, env, ctx, server, phoneOrigin, fingerprint) {
  const full = new URL(request.url).pathname.startsWith('/device/full/');
  const reply = (data,status,cookie) => response(data,status,cookie,full);
  if (full && !env.BUSINESS_DB) return reply({},404);
  if (request.method !== 'POST' || request.headers.get('Origin') !== phoneOrigin ||
      request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return reply({},403);
  const path = new URL(request.url).pathname.replace('/device/full/','/device/');
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({},400);
  const saved = deviceCookie(request,full);
  const issue = fields => server.fetch(new Request(env.ISSUER + '/oauth/token', {method:'POST',body:new URLSearchParams(fields)}), env, ctx);
  let fields;
  if (path === '/device/connect') {
    if (['client','code','verifier'].some(key => typeof body[key] !== 'string' || !body[key] || body[key].length>1024)) return reply({},400);
    fields = {client_id:body.client,grant_type:'authorization_code',code:body.code,code_verifier:body.verifier,redirect_uri:phoneOrigin+(full?'/full/connect.html':'/connect.html')};
  } else {
    if (!saved) return reply({}, path === '/device/revoke' ? 200 : 401, null);
    fields = {client_id:saved.client,grant_type:'refresh_token',refresh_token:saved.refresh};
  }
  const result = await issue({...fields, resource:env.ISSUER+'/mcp'});
  if (!result.ok) {
    const {error} = await result.json().catch(()=>({}));
    if (['invalid_grant','invalid_client','unauthorized_client'].includes(error)) return reply({},path === '/device/revoke' ? 200 : 401,null);
    return reply({},503);
  }
  const token = await result.json();
  const auth = await server.validateToken(env.ISSUER+'/mcp',token.access_token,env);
  if (!auth || auth.props?.clientSurface !== 'phone' || Boolean(auth.props.full) !== full || auth.props.generation !== await fingerprint(env.OWNER_KEY)) return reply({},401,null);
  const id = auth.props.device;
  if (path === '/device/revoke') {
    if (id) await primary(env).prepare('DELETE FROM wallet_devices WHERE id=?').bind(id).run();
    await issue({client_id:fields.client_id,token:token.refresh_token || token.access_token,token_type_hint:token.refresh_token ? 'refresh_token' : 'access_token'});
    return reply({},200,null);
  }
  const until = id ? await deadline(env,id) : 0;
  if (id && (!until || !token.refresh_token)) return reply({},401,null);
  const cookie = until ? { value:btoa(JSON.stringify([fields.client_id,token.refresh_token])), age:until-now() } : null;
  return reply({access_token:token.access_token,expires_in:token.expires_in,device_until:until},200,cookie);
}

export async function manageDevices(request, env) {
  const headers = {'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"};
  const page = text => new Response('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wallet 设备授权</title><h1>Wallet 设备授权</h1>'+text+'</html>',{headers});
  if (request.method === 'GET') return page('<form method="post"><label>账本所有者密钥 <input name="owner_key" type="password" required maxlength="64"></label><p>撤销后，所有已记住的设备都需要重新授权。本机账目会保留。</p><button name="action" value="revoke">撤销所有测试设备授权</button></form>');
  if (request.method !== 'POST' || request.headers.get('Origin') !== env.ISSUER || request.headers.get('Content-Type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return new Response(null,{status:403});
  const form = await request.formData();
  if (form.get('action') !== 'revoke' || !ownerMatches(form.get('owner_key'),env.OWNER_KEY)) return new Response(null,{status:403});
  await primary(env).prepare('DELETE FROM wallet_devices').run();
  return page('<p>所有已记住的设备授权均已撤销。</p>');
}
