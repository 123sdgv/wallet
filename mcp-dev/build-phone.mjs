import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const source = path => readFile(new URL(path, root), 'utf8');
const base = await source('index.html');
const tags = [...base.matchAll(/<script src="(js\/[\w-]+\.js)"><\/script>/g)];
if (!tags.length) throw Error('Missing Wallet scripts');
const scripts = tags.map(m => m[1]);
const entry = '<script type="module" id="wallet-boot" data-scripts="' + scripts.join(' ') + '" src="phone.js"></script>';
const index = base.replace(tags[0][0], entry).replace(/<script src="js\/[\w-]+\.js"><\/script>/g, '')
  .replace('<body>', '<body><p id="sync-status" role="status">虚拟测试账本 · 正在打开</p>')
  .replace('<title>清醒消费</title>', '<title>Wallet 虚拟测试账本</title>');
const compiled = await build({ entryPoints: ['phone/start.js'], bundle: true, format: 'esm', write: false });
const assets = { '/': index, '/phone.js': compiled.outputFiles[0].text,
  '/connect.html': '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wallet 授权</title><p id="sync-status">正在返回虚拟账本</p><a href="./">返回 Wallet</a><script type="module" src="phone.js"></script></html>' };
const preview = (await build({entryPoints:['phone/migration-preview.js'],bundle:true,format:'iife',write:false})).outputFiles[0].text;
const scriptHash = createHash('sha256').update(preview).digest('base64');
assets['/migration-preview.html'] = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Wallet 迁移预览</title>
<h1>Wallet 迁移预览</h1><p>选择 Wallet 导出的 JSON 备份，在这台设备上核对。你可以先断网，再选择文件。此页没有上传或迁移按钮。</p>
<label>选择 Wallet 备份 <input type="file" accept=".json,application/json"></label><section id="result" aria-live="polite"></section>
<script>${preview}</script></html>`;
for (const path of [...scripts, 'js/reconcile.mjs', 'css/style.css', 'sw.js']) assets['/' + path] = await source(path);
assets['/css/style.css'] += '\n#sync-status{margin:0;padding:.45rem .8rem;text-align:center;color:#134e4a;background:#f0fdfa;font-size:.82rem}';
assets['/sw.js'] = assets['/sw.js'].replace("cachePrefix + 'v19'", "cachePrefix + 'dev-device-v1'").replace("  './', './index.html'", "  './phone.js', './', './index.html'");
const manifest = JSON.parse(await source('manifest.json'));
assets['/manifest.json'] = JSON.stringify({ ...manifest, name: 'Wallet 虚拟测试账本', short_name: '虚拟 Wallet' });
assets['/icon-192.png'] = (await readFile(new URL('icon-192.png', root))).toString('base64');
await mkdir('dist', { recursive: true });
await writeFile('dist/phone-assets.mjs', 'export default ' + JSON.stringify(assets));
await build({ entryPoints: ['phone-worker.js'], bundle: true, format: 'esm', outfile: 'dist/phone-worker.mjs' });
