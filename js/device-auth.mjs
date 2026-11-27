// Public OAuth client. The owner key is entered only at the Worker.
export const issuer='https://wallet-mcp.shun83258.workers.dev';
const callback='https://123sdgv.github.io/wallet/connect.html';
const flowKey='wallet.pages.pkce';
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const nonce=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const api=(path,init)=>fetch(issuer+path,{...init,credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
let dbPromise;
async function session(action,value) {
  dbPromise??=new Promise((resolve,reject)=>{
    const req=indexedDB.open('wallet-device-v1',1);
    req.onupgradeneeded=()=>req.result.createObjectStore('session');
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>resolve(req.result);
  });
  const db=await dbPromise;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction('session',action==='get'?'readonly':'readwrite');
    const store=tx.objectStore('session');
    const req=action==='get'?store.get('device'):action==='delete'?store.delete('device'):store.put(value,'device');
    tx.oncomplete=()=>resolve(req.result);
    tx.onabort=()=>reject(tx.error);
  });
}
export async function connectDevice() {
  const result=await api('/oauth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    client_name:'Wallet 手机',redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'
  })});
  if(!result.ok)throw Error('暂时无法开始授权');
  const {client_id}=await result.json(),state=nonce(),verifier=nonce();
  sessionStorage.setItem(flowKey,JSON.stringify({client_id,state,verifier,at:Date.now()}));
  const challenge=b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  location.assign(issuer+'/authorize?'+new URLSearchParams({client_id,state,response_type:'code',redirect_uri:callback,resource:issuer+'/mcp',scope:'wallet:read wallet:ledger:read wallet:device:sync',code_challenge:challenge,code_challenge_method:'S256'}));
}
async function exchange(fields) {
  const r=await api('/oauth/token',{method:'POST',body:new URLSearchParams({...fields,resource:issuer+'/mcp'})});
  const data=await r.json();
  if(!r.ok) {
    if(data.error==='invalid_grant') throw Error('设备授权已失效，请重新授权');
    throw Error('授权服务暂时不可用');
  }
  if(!data.access_token||!data.refresh_token)throw Error('请重新授权并勾选记住设备 30 天');
  return {access:data.access_token,refresh:data.refresh_token,until:Date.now()+1000*data.expires_in};
}
export async function finishDevice() {
  const params=new URLSearchParams(location.search);
  history.replaceState(null,'',new URL(callback).pathname);
  const flow=JSON.parse(sessionStorage.getItem(flowKey)||'null');
  sessionStorage.removeItem(flowKey);
  if(!flow||Date.now()-flow.at>600000||params.get('state')!==flow.state||params.get('iss')!==issuer||!params.get('code'))throw Error('授权已取消或过期，请返回 Wallet 重新授权');
  const grant=await exchange({client_id:flow.client_id,grant_type:'authorization_code',redirect_uri:callback,code_verifier:flow.verifier,code:params.get('code')});
  await session('put',{...grant,client:flow.client_id,deadline:Date.now()+30*86400000});
  localStorage.setItem('wallet.pages.until',String(Date.now()+30*86400000));
}
async function access() {
  return navigator.locks.request('wallet.pages.token',async()=>{
    const saved=await session('get');
    if(!saved||saved.deadline<=Date.now())throw Error('请重新授权设备');
    if(saved.until>Date.now()+30000)return saved.access;
    const grant=await exchange({client_id:saved.client,grant_type:'refresh_token',refresh_token:saved.refresh});
    await session('put',{...saved,...grant});
    return grant.access;
  });
}
export async function phone(path,body) {
  const token=await access();
  const r=await api('/mcp/phone/'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body&&{'Content-Type':'application/json'})},body:body&&JSON.stringify(body)});
  if(r.status===401)throw Error('设备授权已失效，请重新授权');
  if(!r.ok)throw Error('暂时无法连接 Wallet 服务');
  return r.json();
}
export async function revokeDevice() {
  try { await phone('revoke',{}); }
  catch(e) { if(!/重新授权/.test(e.message))throw e; }
  await session('delete');
  localStorage.removeItem('wallet.pages.until');
}
