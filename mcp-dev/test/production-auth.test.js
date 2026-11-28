import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Miniflare } from 'miniflare';
const issuer='https://wallet-mcp.shun83258.workers.dev', pagesOrigin='https://123sdgv.github.io';

test('production grants survive refresh, retain scopes and stop on revocation', async t => {
  const ownerKey = randomBytes(32).toString('hex');
  const mf = new Miniflare({ modules:true, cf:false, script:await readFile(new URL('../dist/worker.mjs',import.meta.url),'utf8'),
    compatibilityDate:'2026-07-01', compatibilityFlags:['global_fetch_strictly_public'],
    bindings:{ ISSUER:issuer, OWNER_KEY:ownerKey }, kvNamespaces:['OAUTH_KV'], d1Databases:['DB','BUSINESS_DB'],
    outboundService:()=>new Response(null,{status:403}), ratelimits:{ LIMITER:{namespace_id:'1001',simple:{limit:600,period:60}} } });
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'), kv=await mf.getKVNamespace('OAUTH_KV');
  await db.prepare('CREATE TABLE wallet_devices(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)').run();
  const req=async(path,init)=>{const r=await mf.dispatchFetch(issuer+path,{redirect:'manual',...init}); assert.ok(r.status<500,path.split('?')[0]+' '+r.status); return r;};
  const post=(path,fields,headers={})=>req(path,{method:'POST',body:new URLSearchParams(fields).toString(),headers:{'Content-Type':'application/x-www-form-urlencoded',...headers}});
  const metadata=await (await req('/.well-known/oauth-authorization-server')).json();
  assert.ok(metadata.scopes_supported.includes('offline_access'));
  assert.ok(metadata.grant_types_supported.includes('refresh_token'));
  const resource=await (await req('/.well-known/oauth-protected-resource/mcp')).json();
  assert.ok(resource.scopes_supported.includes('wallet:ledger:write'));
  for (const phone of [true,false]) {
    const callback=phone?pagesOrigin+'/wallet/connect.html':'https://chatgpt.com/connector_platform_oauth_redirect';
    const scope=phone?'wallet:read wallet:ledger:read wallet:device:sync':'wallet:read wallet:ledger:read offline_access';
    const reg=await req('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'})});
    assert.equal(reg.status,201);
    const {client_id}=await reg.json(), verifier=randomBytes(32).toString('base64url');
    const form=await req('/authorize?'+new URLSearchParams({client_id, scope, redirect_uri:callback,state:randomUUID(),
      response_type:'code',resource:issuer+'/mcp',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}));
    assert.equal(form.status,200);
    const html=await form.text();
    assert.match(html,/长期有效/);
    const approval=await post('/authorize',{owner_key:ownerKey,remember:'long',decision:'approve',handle:html.match(/name="handle" value="([^"]+)"/)[1]},
      {Origin:issuer,Cookie:form.headers.get('set-cookie').split(';')[0]});
    assert.equal(approval.status,303);
    const exchange=fields=>post('/oauth/token',{client_id,resource:issuer+'/mcp',...fields});
    const token=await (await exchange({grant_type:'authorization_code',code_verifier:verifier,redirect_uri:callback,
      code:new URL(approval.headers.get('location')).searchParams.get('code')})).json();
    assert.ok(token.refresh_token);
    const [user,grant]=token.refresh_token.split(':');
    const stored=await kv.get('grant:'+user+':'+grant,{type:'json'});
    assert.equal(stored.expiresAt,undefined);
    const refresh=refresh_token=>exchange({grant_type:'refresh_token',refresh_token});
    const renewed=await (await refresh(token.refresh_token)).json();
    assert.equal(renewed.expires_in,900);
    assert.deepEqual(renewed.scope.split(' ').sort(),scope.split(' ').sort());
    assert.ok(renewed.refresh_token && renewed.refresh_token!==token.refresh_token);
    const revoke=()=>req('/mcp/phone/revoke',{method:'POST',headers:{Origin:pagesOrigin,Authorization:'Bearer '+renewed.access_token}});
    if(phone) {
      assert.equal((await revoke()).status,200);
      assert.equal((await revoke()).status,401);
    } else {
      assert.equal((await post('/devices',{action:'revoke',owner_key:ownerKey},{Origin:issuer})).status,200);
      assert.equal((await req('/mcp',{headers:{Authorization:'Bearer '+renewed.access_token}})).status,401);
    }
    assert.equal((await (await refresh(renewed.refresh_token)).json()).error,'invalid_grant');
  }
});
