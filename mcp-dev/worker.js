import { OAuthResourceServer, AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { consent, fingerprint, makeAuthorizationServer, phoneOrigin, OWNER } from './auth.js';
import { READ, WRITE, validExpense, serveMcp } from './mcp.js';
import { addExpense, readChanges } from './ledger.js';
import { ownerSetup } from './owner-setup.js';

const MAX_BYTES = 16 * 1024;
const devIssuer = /^https:\/\/wallet-mcp-dev\.[a-z0-9-]+\.workers\.dev$/;

// Bound chunked and fixed-length requests before any library reads a body.
async function bounded(request) {
  if (!request.body) return request;
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BYTES);
  let offset = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value.length > MAX_BYTES - offset) { await reader.cancel(); return null; }
    bytes.set(value, offset);
    offset += value.length;
  }
  return new Request(request, { body: bytes.subarray(0, offset) });
}

async function route(request, env, ctx) {
  if (!devIssuer.test(env.ISSUER) || !env.DB || !env.OAUTH_KV || !env.LIMITER) return new Response(null, { status: 503 });
  const url = new URL(request.url);
  if (url.origin !== env.ISSUER) return new Response(null, { status: 404 });
  const origin = request.headers.get('Origin');
  const phoneRequest = origin === phoneOrigin(env.ISSUER) && phonePath(url.pathname);
  if (origin && origin !== env.ISSUER && origin !== 'https://chatgpt.com' && !phoneRequest) return new Response(null, { status: 403 });
  const limit = await env.LIMITER.limit({ key: 'wallet-mcp-dev:' + (request.headers.get('CF-Connecting-IP') || 'local') });
  if (!limit.success) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  if (phoneRequest && request.method === 'OPTIONS') return new Response(null, { status: 204 });
  request = await bounded(request);
  if (!request) return new Response(null, { status: 413 });

  const issuer = env.ISSUER;
  if (url.pathname === '/setup-key' && request.method === 'GET') return ownerSetup();
  const resourceMetadata = '/.well-known/oauth-protected-resource';
  const publicMetadata = [resourceMetadata, resourceMetadata + '/mcp', '/.well-known/oauth-authorization-server'].includes(url.pathname)
    && ['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const needsChallenge = url.pathname === '/mcp' && !request.headers.has('Authorization');
  const ready = typeof env.OWNER_KEY === 'string' && /^[a-f0-9]{64}$/.test(env.OWNER_KEY);
  if (!ready && !publicMetadata && !needsChallenge && url.pathname !== '/oauth/register') {
    return new Response('Wallet 测试服务待配置：请将 OWNER_KEY 设为 64 位小写十六进制随机密钥。', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const authorization = makeAuthorizationServer(issuer, Boolean(env.BUSINESS_DB));
  if (url.pathname === '/mcp/phone') {
    if (!phoneRequest) return new Response(null, { status: 403 });
    const match = /^Bearer (\S+)$/.exec(request.headers.get('Authorization') || '');
    const auth = match && await authorization.validateToken(issuer + '/mcp', match[1], env);
    if (!auth || auth.userId !== OWNER || auth.props?.clientSurface !== 'phone'
        || auth.props.generation !== await fingerprint(env.OWNER_KEY)) return new Response(null, { status: 401 });
    if (!auth.scope.includes(READ)) return new Response(null, { status: 403 });
    if (request.method === 'GET') {
      const after = url.searchParams.get('after') ?? '0';
      if (!/^(0|[1-9][0-9]{0,4})$/.test(after)) return new Response(null, { status: 400 });
      return Response.json(await readChanges(env.DB, Number(after)));
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    if (!auth.scope.includes(WRITE)) return new Response(null, { status: 403 });
    if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return new Response(null, { status: 415 });
    const args = await request.json().catch(() => null);
    if (!validExpense(args)) return new Response(null, { status: 400 });
    return Response.json(await addExpense(env.DB, args));
  }
  if (url.pathname === '/authorize') return consent(request, env, authorization.getOAuthApi(env));
  if (url.pathname === '/mcp' || url.pathname === '/.well-known/oauth-protected-resource/mcp'
      || url.pathname === '/.well-known/oauth-protected-resource') {
    const resource = new OAuthResourceServer({
      resourceMetadata: { resource: issuer + '/mcp', authorization_servers: [issuer] },
      requiredScopes: [READ],
      validateToken: () => async (audience, token) => {
        const verified = await authorization.validateToken(audience, token, env);
        if (verified?.userId !== OWNER || verified.props?.clientSurface === 'phone' || verified.props?.generation !== await fingerprint(env.OWNER_KEY)) return null;
        return verified;
      },
      handler: { fetch: (req, bindings, context) => serveMcp(req, bindings.DB, context.auth, bindings.BUSINESS_DB) },
    });
    // Some clients try the origin-level discovery URL before the path-specific URL.
    if (url.pathname === resourceMetadata && publicMetadata) {
      const canonical = new URL(resourceMetadata + '/mcp', issuer);
      return resource.fetch(new Request(canonical, { method: request.method, headers: request.headers }), env, ctx);
    }
    return resource.fetch(request, env, ctx);
  }
  return authorization.fetch(request, env, ctx);
}

function phonePath(path) {
  return ['/oauth/register', '/oauth/token', '/oauth/revoke', '/mcp/phone'].includes(path);
}

export default {
  async fetch(request, env, ctx) {
    let response;
    try { response = await route(request, env, ctx); }
    catch (error) { response = new Response(null, { status: error instanceof AuthorizationError ? 400 : 503 }); }
    const headers = new Headers(response.headers);
    if (request.headers.get('Origin') === phoneOrigin(env.ISSUER || '') && phonePath(new URL(request.url).pathname)) {
      headers.set('Access-Control-Allow-Origin', phoneOrigin(env.ISSUER));
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.append('Vary', 'Origin');
    }
    const isConsent = new URL(request.url).pathname === '/authorize';
    const isForm = isConsent && request.method === 'GET' && response.ok && headers.get('Content-Type')?.startsWith('text/html');
    headers.set('Cache-Control', 'private, no-store');
    // The browser needs the page origin for a same-origin form POST. Keep OAuth query parameters private.
    headers.set('Referrer-Policy', isForm ? 'strict-origin' : 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    let body = response.body;
    if (isConsent && response.status >= 400) {
      headers.set('Content-Type', 'text/plain; charset=utf-8');
      headers.set('Content-Disposition', 'inline');
      if (!body && request.method !== 'HEAD') {
        const messages = {
          400: '授权请求无效或已过期。请回到 ChatGPT，从 Wallet 插件重新开始连接。',
          403: '无法验证授权页面的来源。请回到 ChatGPT，从 Wallet 插件重新打开授权页。',
          429: '授权请求过于频繁。请等一分钟，再从 Wallet 插件重试。',
        };
        body = messages[response.status] ?? '暂时无法完成授权。请稍后从 ChatGPT 的 Wallet 插件重试。';
      }
    }
    return new Response(body, { status: response.status, headers });
  },
};
