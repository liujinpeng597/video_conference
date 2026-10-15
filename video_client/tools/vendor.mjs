// 拉第三方文件到本地, 顺便把图标 sprite 塞进 index.html 的标记里。
//   用法: node tools/vendor.mjs        (在 video_client 下跑, 需要能上网)
//
// 为什么要存一份在本地: 页面要能在没有外网的机器上打开, 也不想为了 13 个图标
// 装一整套构建工具。Vue 用的是完整版 (带模板编译器), 所以不需要打包步骤。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VUE_URL = 'https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js';
const ICON_BASE = 'https://unpkg.com/@tabler/icons@3.31.0/icons/outline';

// 和 index.html 里的 #ic-xxx 一一对应
const ICONS = [
  'alert-triangle', 'check', 'eye', 'eye-off', 'link', 'logout',
  'microphone', 'microphone-off', 'phone-off', 'refresh', 'screen-share', 'screen-share-off',
  'user', 'video', 'video-off',
  'message', 'send', 'x', 'hand-stop', 'mood-smile', 'user-off', 'photo',
  'plus', 'bolt', 'chevron-right', 'calendar',
];

const SYMBOL_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

async function grab(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// Tabler 给的是完整 <svg ...>...</svg>, 只要里面那层, 外面套成 <symbol>
function toSymbol(name, svg) {
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .trim();
  if (!inner) throw new Error(`图标 ${name} 解析出来是空的`);
  return `  <symbol id="ic-${name}" ${SYMBOL_ATTRS}>${inner}</symbol>`;
}

await mkdir(join(ROOT, 'vendor'), { recursive: true });
const vue = await grab(VUE_URL);
if (!/var Vue\s*=/.test(vue)) throw new Error('拿到的不是 Vue 全局构建');
await writeFile(join(ROOT, 'vendor', 'vue.global.prod.js'), vue, 'utf8');

const symbols = [];
for (const name of ICONS) symbols.push(toSymbol(name, await grab(`${ICON_BASE}/${name}.svg`)));
const sprite = [
  '<!-- 图标来自 Tabler Icons (MIT), https://tabler.io/icons 。本块由 tools/vendor.mjs 生成, 不要手改。 -->',
  '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">',
  ...symbols,
  '</svg>',
].join('\n');

const file = join(ROOT, 'index.html');
const html = await readFile(file, 'utf8');
const re = /<!--ICONS:START-->[\s\S]*?<!--ICONS:END-->/;
if (!re.test(html)) throw new Error('index.html 里找不到 <!--ICONS:START--> ... <!--ICONS:END--> 标记');
await writeFile(file, html.replace(re, `<!--ICONS:START-->\n${sprite}\n<!--ICONS:END-->`), 'utf8');

console.log(`vue.global.prod.js ${(vue.length / 1024).toFixed(0)} KB, ${ICONS.length} 个图标 -> index.html`);
