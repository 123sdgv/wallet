import { OAuthResourceServer, AuthorizationError } from '@cloudflare/workers-oauth-provider';
import { consent, fingerprint, makeAuthorizationServer, OWNER } from './auth.js';
import { READ, serveMcp } from './mcp.js';

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
  if (!devIssuer.test(env.ISSUER) || !/^[a-f0-9]{64}$/.test(env.OWNER_KEY ?? '')
      || !env.DB || !env.OAUTH_KV || !env.LIMITER) return new Response(null, { status: 503 });
  const url = new URL(request.url);
  if (url.origin !== env.ISSUER) return new Response(null, { status: 404 });
  const origin = request.headers.get('Origin');
  if (origin && origin !== env.ISSUER && origin !== 'https://chatgpt.com') return new Response(null, { status: 403 });
  const limit = await env.LIMITER.limit({ key: 'wallet-mcp-dev:' + (request.headers.get('CF-Connecting-IP') || 'local') });
  if (!limit.success) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  request = await bounded(request);
  if (!request) return new Response(null, { status: 413 });

  const issuer = env.ISSUER;
  const authorization = makeAuthorizationServer(issuer);
  if (url.pathname === '/authorize') return consent(request, env, authorization.getOAuthApi(env));
  if (url.pathname === '/mcp' || url.pathname === '/.well-known/oauth-protected-resource/mcp'
      || url.pathname === '/.well-known/oauth-protected-resource') {
    const resource = new OAuthResourceServer({
      resourceMetadata: { resource: issuer + '/mcp', authorization_servers: [issuer] },
      requiredScopes: [READ],
      validateToken: () => async (audience, token) => {
        const verified = await authorization.validateToken(audience, token, env);
        if (verified?.userId !== OWNER || verified.props?.generation !== await fingerprint(env.OWNER_KEY)) return null;
        return verified;
      },
      handler: { fetch: (req, bindings, context) => serveMcp(req, bindings.DB, context.auth) },
    });
    return resource.fetch(request, env, ctx);
  }
  return authorization.fetch(request, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    let response;
    try { response = await route(request, env, ctx); }
    catch (error) { response = new Response(null, { status: error instanceof AuthorizationError ? 400 : 503 }); }
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    return new Response(response.body, { status: response.status, headers });
  },
};
