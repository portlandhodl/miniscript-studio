// Builds dist/index.html: the whole studio as ONE self-contained file.
//   - every ES module under web/js (and the wasm-bindgen glue) bundled into one inline script
//   - web/css/app.css inlined
//   - the WASM module embedded as gzip + base64 (decompressed in the browser by web/js/wasm.js)
// The result works from any static host or straight from disk (file://). og.png is copied
// next to it only for link-preview cards; the app itself never loads it.
//
// Usage (after ./build.sh has produced web/pkg):  npm ci --prefix tools && node tools/build-single.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const out = join(root, 'dist');

const fail = (msg) => {
  console.error(`build-single: ${msg}`);
  process.exit(1);
};

// 1. JavaScript: one ESM bundle (inline module scripts support import.meta and top-level await).
const js = await build({
  entryPoints: [join(web, 'js/main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
// "</script" inside the code would end the inline <script>; "<\/script" is equivalent in JS.
const bundle = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

// 2. CSS and 3. WASM.
const css = readFileSync(join(web, 'css/app.css'), 'utf8');
if (/<\/style/i.test(css)) fail('app.css contains "</style"');
const wasmPath = join(web, 'pkg/miniscript_playground_wasm_bg.wasm');
let wasm;
try {
  wasm = readFileSync(wasmPath);
} catch {
  fail('web/pkg is missing: run ./build.sh first');
}
const wasmB64 = gzipSync(wasm, { level: 9 }).toString('base64');

// 4. HTML: swap every external asset for its inline form.
let html = readFileSync(join(web, 'index.html'), 'utf8');
const swap = (re, to, what) => {
  if (!re.test(html)) fail(`index.html: ${what} not found`);
  html = html.replace(re, () => to);
};
swap(/\s*<link rel="modulepreload"[^>]*>/, '', 'modulepreload link');
swap(/\s*<link rel="preload"[^>]*\.wasm"[^>]*>/, '', 'wasm preload link');
swap(/<link rel="stylesheet" href="css\/app\.css">/, `<style>\n${css}</style>`, 'stylesheet link');
swap(
  /<script type="module" src="js\/main\.js"><\/script>/,
  `<script id="wasm-gz" type="application/octet-stream">${wasmB64}</script>\n  <script type="module">${bundle}</script>`,
  'main.js script',
);

// 5. Guard: nothing may still point at a local file the single artifact doesn't contain.
// Checked on the markup only: the inlined code legitimately builds href="${…}" strings at runtime.
const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');
const local = [...markup.matchAll(/\b(?:src|href)\s*=\s*"(?!data:|https?:|mailto:|#)([^"]+)"/g)].map((m) => m[1]);
if (local.length) fail(`still references local files: ${[...new Set(local)].join(', ')}`);
if (/\bpkg\/|_bg\.wasm|css\/app\.css|js\/main\.js/.test(markup)) fail('a dev-only asset path survived');
if ((html.match(/<script\b/g) ?? []).length !== 2) fail('expected exactly two inline scripts (wasm + app)');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'index.html'), html);
copyFileSync(join(web, 'og.png'), join(out, 'og.png'));
writeFileSync(join(out, '.nojekyll'), '');

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`dist/index.html ${kb(Buffer.byteLength(html))} (wasm ${kb(wasm.length)} → ${kb(wasmB64.length)} gzip+base64, js ${kb(bundle.length)}, css ${kb(css.length)})`);
