// This script runs only in the owner's browser. No form, storage or network requests.
export const keyScript = `const output = document.querySelector('#key');
document.querySelector('#generate').onclick = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  output.value = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  output.focus();
  output.select();
};`;

export async function ownerSetup(formal = false) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(keyScript)));
  const hash = btoa(String.fromCharCode(...digest));
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wallet 所有者密钥</title><main><h1>生成${formal?"正式":"测试"}账本密钥</h1>
<p>密钥仅在本机生成。将它保存在密码管理器中，再把同一个值填入 Cloudflare 的 OWNER_KEY 和 Wallet 授权页。</p>
<button id="generate">生成并选中密钥</button>
<p><label>长按复制 <input id="key" readonly autocomplete="off" spellcheck="false"></label></p>
</main><script>${keyScript}</script></html>`, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': `default-src 'none'; script-src 'sha256-${hash}'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`,
  } });
}
