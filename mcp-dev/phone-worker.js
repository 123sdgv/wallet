// Independent public application shell. This Worker has no ledger, secret or database bindings.
import assets from './dist/phone-assets.mjs';
const types = { mjs: 'text/javascript; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', html: 'text/html; charset=utf-8',
  json: 'application/json', png: 'image/png' };
export default {
  fetch(request) {
    const url = new URL(request.url);
    if (!/^wallet-sync-dev\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)) return new Response(null, { status: 404 });
    if (!['GET','HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const path = url.pathname === '/index.html' ? '/' : url.pathname;
    if (!Object.hasOwn(assets, path)) return new Response(null, { status: 404 });
    const issuer = url.origin.replace('https://wallet-sync-dev.', 'https://wallet-mcp-dev.');
    const mime = types[path.split('.').at(-1)] || types.html;
    const headers = { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Cache-Control': path === '/connect.html' || url.search ? 'private, no-store' : 'no-cache',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; connect-src 'self' " + issuer + "; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" };
    if (request.method === 'HEAD') return new Response(null, { headers });
    const body = path.endsWith('.png') ? Uint8Array.from(atob(assets[path]), c => c.charCodeAt(0)) : assets[path];
    return new Response(body, { headers });
  },
};
