import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import { DEVICE_SECONDS, enroll, exchangePolicy, ownerMatches } from './device.js';
import { FULL_WRITE } from './financial-write.js';
import { FULL_READ } from './financial-read.js';
import { READ, WRITE } from './mcp.js';

export const OWNER = 'wallet-probe-owner';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const phoneOrigin = issuer => issuer.replace('https://wallet-mcp-dev.', 'https://wallet-sync-dev.');
const phoneRedirect = issuer => phoneOrigin(issuer) + '/connect.html';
export const DEVICE_SYNC = 'wallet:device:sync';
const scopes = [READ, WRITE];
const labels = { [DEVICE_SYNC]: '双向同步完整虚拟账本（含流水备注、账户、预算、计划、储蓄与备忘）', [FULL_WRITE]: '新增完整账本流水（支出、收入、退款、转账记录）', [FULL_READ]: '查询完整账本、流水、备注与资金备忘', [READ]: '查询虚拟余额', [WRITE]: '新增虚拟支出' };

export function makeAuthorizationServer(issuer, businessEnabled = false) {
  return new OAuthAuthorizationServer({
    issuer, resources: [issuer + '/mcp'], scopesSupported: businessEnabled ? [...scopes, FULL_READ, FULL_WRITE, DEVICE_SYNC] : scopes,
    clientRegistrationEndpoint: '/oauth/register', clientRegistrationTTL: DEVICE_SECONDS + 86400,
    accessTokenTTL: 900, refreshTokenTTL: 0,
    tokenExchangeCallback: options => exchangePolicy(options, fingerprint),
    clientRegistrationCallback({ clientMetadata: client }) {
      if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length !== 1
          || ![redirectUri, phoneRedirect(issuer), ...(businessEnabled ? [phoneOrigin(issuer)+'/full/connect.html'] : [])].includes(client.redirect_uris[0])) {
        return { description: 'Unknown Wallet test callback.' };
      }
    },
    onError() {}, // Keep requests, codes and identifiers out of application logs.
  });
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';');
}

export async function fingerprint(key) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))).toHex();
}

export async function consent(request, env, oauth) {
  if (request.method === 'GET') {
    const auth = await oauth.parseAuthRequest(request);
    const full = Boolean(env.BUSINESS_DB) && auth.redirectUri === phoneOrigin(env.ISSUER)+'/full/connect.html';
    const phone = full || auth.redirectUri === phoneRedirect(env.ISSUER);
    const allowedScopes = full ? [READ, FULL_READ, DEVICE_SYNC] : !phone && env.BUSINESS_DB ? [...scopes, FULL_READ, FULL_WRITE] : scopes;
    if ((!phone && auth.redirectUri !== redirectUri) || auth.codeChallengeMethod !== 'S256' || !auth.codeChallenge
        || !auth.scope.includes(READ) || (auth.scope.includes(FULL_WRITE) && !auth.scope.includes(FULL_READ)) || auth.scope.some(s => !allowedScopes.includes(s))) {
      return new Response('授权请求无效。请回到 ChatGPT，从 Wallet 插件重新开始连接。', { status: 400 });
    }
    const details = await oauth.describeConsent(auth);
    const { handle, headers } = await oauth.beginConsent(auth);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    const destination = phone ? phoneOrigin(env.ISSUER) : 'https://chatgpt.com';
    headers.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' " + destination);
    const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 Wallet 虚拟账本</title><h1>授权 Wallet 虚拟账本</h1>
<p>应用自报名称：${escapeHtml(details.clientName)}。授权结果将返回 ${escapeHtml(new URL(destination).host)}。</p>
<p>请求权限：${auth.scope.map(s => labels[s]).join('、')}。单次访问凭证有效期 15 分钟。</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>测试账本所有者密钥 <input type="password" name="owner_key" autocomplete="off" maxlength="64" required></label>
${phone ? '<p><label><input type="checkbox" name="remember" value="30" checked>记住这台设备 30 天</label>，可在 Wallet 的「我的」里撤销。</p>' : ''}
<p><button name="decision" value="approve">允许本次权限</button> <button name="decision" value="deny" formnovalidate>拒绝</button></p></form></html>`;
    return new Response(page, { headers });
  }
  if (request.method !== 'POST') return new Response(null, { status: 405 });
  if (request.headers.get('Origin') !== env.ISSUER || request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    return new Response(null, { status: 403 });
  }
  const form = await request.formData();
  const handle = String(form.get('handle') ?? '');
  if (form.get('decision') === 'deny') {
    const denied = await oauth.denyConsent(request, handle);
    denied.headers.set('Location', denied.redirectTo);
    return new Response(null, { status: 303, headers: denied.headers });
  }
  const key = form.get('owner_key');
  if (form.get('decision') !== 'approve' || !ownerMatches(key, env.OWNER_KEY)) {
    return new Response('测试账本所有者密钥不匹配。请返回上一页，重新输入此测试账本的密钥。', { status: 403 });
  }
  const approved = await oauth.approveConsent(request, handle);
  const full = approved.request.redirectUri === phoneOrigin(env.ISSUER)+'/full/connect.html';
  const phone = full || approved.request.redirectUri === phoneRedirect(env.ISSUER);
  const device = phone && form.get('remember') === '30' ? await enroll(env) : null;
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request, userId: OWNER, scope: approved.request.scope,
    metadata: {}, props: { generation: await fingerprint(env.OWNER_KEY), clientSurface: phone ? 'phone' : 'chatgpt', ...(full && {full:true}), ...(device && {device}) },
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 303, headers: approved.headers });
}
