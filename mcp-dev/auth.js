import { OAuthAuthorizationServer } from '@cloudflare/workers-oauth-provider';
import { READ, WRITE } from './mcp.js';

export const OWNER = 'wallet-probe-owner';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
export const phoneOrigin = issuer => issuer.replace('https://wallet-mcp-dev.', 'https://wallet-sync-dev.');
const phoneRedirect = issuer => phoneOrigin(issuer) + '/connect.html';
const scopes = [READ, WRITE];
const labels = { [READ]: '查询虚拟余额', [WRITE]: '新增虚拟支出' };

export function makeAuthorizationServer(issuer) {
  return new OAuthAuthorizationServer({
    issuer, resources: [issuer + '/mcp'], scopesSupported: scopes,
    clientRegistrationEndpoint: '/oauth/register', clientRegistrationTTL: 86400,
    accessTokenTTL: 900, refreshTokenTTL: 0,
    clientRegistrationCallback({ clientMetadata: client }) {
      if (!Array.isArray(client.redirect_uris) || client.redirect_uris.length !== 1
          || ![redirectUri, phoneRedirect(issuer)].includes(client.redirect_uris[0])) {
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
    const phone = auth.redirectUri === phoneRedirect(env.ISSUER);
    if ((!phone && auth.redirectUri !== redirectUri) || auth.codeChallengeMethod !== 'S256' || !auth.codeChallenge
        || !auth.scope.includes(READ) || auth.scope.some(s => !scopes.includes(s))) {
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
<p>请求权限：${auth.scope.map(s => labels[s]).join('、')}。授权有效期 15 分钟。</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<label>测试账本所有者密钥 <input type="password" name="owner_key" autocomplete="off" maxlength="64" required></label>
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
  if (form.get('decision') !== 'approve' || typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)
      || !crypto.subtle.timingSafeEqual(new TextEncoder().encode(key), new TextEncoder().encode(env.OWNER_KEY))) {
    return new Response('测试账本所有者密钥不匹配。请返回上一页，重新输入此测试账本的密钥。', { status: 403 });
  }
  const approved = await oauth.approveConsent(request, handle);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request, userId: OWNER, scope: approved.request.scope,
    metadata: {}, props: { generation: await fingerprint(env.OWNER_KEY), clientSurface: approved.request.redirectUri === phoneRedirect(env.ISSUER) ? 'phone' : 'chatgpt' },
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 303, headers: approved.headers });
}
