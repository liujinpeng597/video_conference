#!/usr/bin/env node
// 浏览器 E2E: 无头 Chromium (Chrome / Edge) 开 3 个标签页进同一房间,
// 断言音视频真的互通 —— 对端画面解码出了帧 (videoWidth>0), 且收发两个方向的
// RTP 字节数都大于 0。这是"媒体链路真的能用"的自动化证据, 进 CI。
//
// 手动跑:
//   docker compose up -d --build      # 开发形态起在 127.0.0.1:9000
//   node ops/e2e-media.mjs
//
// 环境变量:
//   CHROME_BIN    浏览器可执行文件路径 (默认自动找 Chrome / Edge)
//   E2E_BASE_URL  站点地址 (默认 http://127.0.0.1:9000)
//
// 原理: 用 CDP (Chrome DevTools Protocol) 驱动浏览器 —— 不需要任何 npm 依赖,
// Node 20+ 自带 fetch 和 WebSocket。三个标签页各注册一个账号 (Node 侧直接调
// /api/register, 不经过页面表单), 把会话令牌写进 sessionStorage 后加载应用,
// 再用页面的调试句柄 window.tongpin 和 Vue 实例读真实状态。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:9000').replace(/\/+$/, '');
const SUFFIX = Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 1000);

function findBrowser() {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';
  const candidates = process.platform === 'win32'
    ? [
        process.env.CHROME_BIN,
        join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
        join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
        join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
        local ? join(local, 'Google\\Chrome\\Application\\chrome.exe') : null,
      ]
    : [
        process.env.CHROME_BIN,
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/microsoft-edge',
      ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  throw new Error('找不到 Chrome/Edge。装一个, 或设置 CHROME_BIN 指向浏览器可执行文件。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP 客户端
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} (${m.error.code})`));
        else resolve(m.result);
        return;
      }
      for (const fn of this.listeners.get(m.method) ?? []) fn(m);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
}

// 在页面里跑一段 JS, 返回它的值 (awaitPromise: 表达式可以是 async IIFE)
async function evalIn(cdp, sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
    throw new Error(`页面里执行出错: ${d}`);
  }
  return r.result?.value;
}

// 页面里拿 Vue 根组件实例的稳健写法: __vue_app__ 拿不到时退回 _vnode.component.proxy
const VM = `(() => {
  const el = document.querySelector('#app');
  if (!el) return null;
  return (el.__vue_app__?._instance?.proxy) ?? (el._vnode?.component?.proxy) ?? null;
})()`;

// 轮询直到页面里表达式返回真值 (超时抛错; debugExpr 给现场诊断用)
async function waitIn(cdp, sessionId, expression, timeoutMs, what, debugExpr) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await evalIn(cdp, sessionId, expression).catch(() => false);
    if (v) return v;
    if (Date.now() > deadline) {
      let dbg = '';
      if (debugExpr) {
        try {
          dbg = ' | 现场: ' + JSON.stringify(await evalIn(cdp, sessionId, debugExpr));
        } catch {}
      }
      throw new Error(`等待超时 (${timeoutMs / 1000}s): ${what}${dbg}`);
    }
    await sleep(500);
  }
}

async function registerUser(name) {
  const res = await fetch(`${BASE}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'e2e-pass-123' }),
  });
  if (!res.ok) throw new Error(`注册 ${name} 失败: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// 把某个标签页"切到前台"并保持 active —— 让它的 rAF 恢复, 卡住的视图切换动画能走完。
// (无头模式没有真正的窗口, 但这两个 CDP 调用决定了页面会不会被当成隐藏页。)
async function activate(cdp, sessionId) {
  try { await cdp.send('Page.bringToFront', {}, sessionId); } catch {}
  try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }, sessionId); } catch {}
}

// ------------------------------------------------------------------ 主流程
const browser = findBrowser();
console.log(`浏览器: ${browser}`);
console.log(`站点:   ${BASE}`);

const userDir = mkdtempSync(join(tmpdir(), 'vc-e2e-'));
const pages = [];
const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // 无头多标签页里非前台标签会被冻结/节流; 而应用的视图切换动画 (mode="out-in")
    // 需要一帧 rAF 才能完成, 否则新视图不挂载。这几个开关 + 每步的
    // activate() (bringToFront / setWebLifecycleState) 让每个标签页的动画都能往前走。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-sandbox',
    '--disable-gpu',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

function cleanup() {
  try { chrome.kill(); } catch {}
  try { rmSync(userDir, { recursive: true, force: true }); } catch {}
}

try {
  // 从 stderr 里等 "DevTools listening on ws://..."
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('浏览器 20 秒内没有报出调试端口')), 20000);
    chrome.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    chrome.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`浏览器提前退出, code=${code}`));
    });
  });

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连不上浏览器的调试端口')), { once: true });
  });
  const cdp = new Cdp(ws);

  // 3 个标签页: 每个页面的控制台错误都收集起来, 失败时打印
  for (let i = 0; i < 3; i++) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const consoleErrors = [];
    cdp.on('Runtime.consoleAPICalled', (m) => {
      if (m.sessionId === sessionId && m.params?.type === 'error') {
        consoleErrors.push(m.params.args?.map((a) => a.value ?? a.description).join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (m) => {
      if (m.sessionId === sessionId) {
        consoleErrors.push(m.params?.exceptionDetails?.exception?.description ?? '异常');
      }
    });
    pages.push({ sessionId, consoleErrors });
  }

  // 账号 + 会话: 每个标签页一个用户 (Node 侧注册, 令牌写进 sessionStorage)
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const user = await registerUser(`e2e${SUFFIX}${i}`);
    await cdp.send('Page.navigate', { url: `${BASE}/` }, p.sessionId);
    await waitIn(cdp, p.sessionId, `document.readyState === 'complete' && !!document.querySelector('#app')`, 20000, `标签页 ${i} 加载页面`);
    await evalIn(
      cdp,
      p.sessionId,
      `sessionStorage.setItem('tp_token', ${JSON.stringify(user.token)});
       sessionStorage.setItem('tp_user', ${JSON.stringify(user.user)});
       'ok'`,
    );
    await cdp.send('Page.reload', {}, p.sessionId);
    await activate(cdp, p.sessionId);
    // restoreSession -> goLobby
    await waitIn(
      cdp,
      p.sessionId,
      `(() => { const vm = ${VM}; return !!vm && vm.view === 'lobby'; })()`,
      20000,
      `标签页 ${i} 进入大厅`,
      `({ vue: typeof Vue, app: !!document.querySelector('#app'), hasAppKey: !!document.querySelector('#app')?.__vue_app__, hasVnode: !!document.querySelector('#app')?._vnode, vm: !!(${VM}), view: (${VM})?.view, booting: (${VM})?.booting })`,
    );
  }

  // 第 1 个标签页开一个新房间, 读出房间号; 另外两个用同一个房间号进房
  const enter = (room) =>
    `(async () => {
       const vm = ${VM};
       vm.roomInput = ${JSON.stringify(room)};
       await vm.enterRoom();
       return vm.room;
     })()`;
  await activate(cdp, pages[0].sessionId);
  const room = await evalIn(cdp, pages[0].sessionId, enter(''));
  console.log(`房间号: ${room}`);
  if (!room) throw new Error('第一个标签页没有拿到房间号');
  for (let i = 1; i < pages.length; i++) {
    await activate(cdp, pages[i].sessionId);
    const got = await evalIn(cdp, pages[i].sessionId, enter(room));
    if (got !== room) throw new Error(`标签页 ${i} 进的房间不对: ${got}`);
  }

  // 等每个标签页都看到 2 个远端, 并且对端画面解码出帧 (videoWidth>0)
  for (let i = 0; i < pages.length; i++) {
    await activate(cdp, pages[i].sessionId);
    await waitIn(
      cdp,
      pages[i].sessionId,
      `(() => {
         const vm = ${VM};
         const vids = [...document.querySelectorAll('video.tile__video--remote')];
         return vm.remotes.length === 2 && vids.length >= 2 && vids.filter(v => v.videoWidth > 0).length >= 2;
       })()`,
      90000,
      `标签页 ${i}: 2 路远端画面解码出帧`,
      `(() => {
         const vm = ${VM};
         const vids = [...document.querySelectorAll('video')];
         return {
           url: location.href, view: vm.view, remotes: vm.remotes.map(p => p.id),
           videos: vids.map(v => v.className + '#' + v.videoWidth),
           tiles: document.querySelectorAll('.tile').length,
           videoElsKeys: [...window.tongpin.videoEls.keys()],
           peerState: JSON.stringify(vm.peerState),
           calls: [...window.tongpin.calls.entries()].map(([k, s]) => k + ':' + s.pc.connectionState),
           htmlLen: document.querySelector('#app').innerHTML.length,
         };
       })()`,
    );
  }

  // 汇总每个标签页的收 / 发 RTP 字节
  const statsExpr = `(async () => {
    const vids = [...document.querySelectorAll('video.tile__video--remote')];
    let inBytes = 0, outBytes = 0;
    for (const { pc } of window.tongpin.calls.values()) {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'inbound-rtp' && !r.isRemote) inBytes += r.bytesReceived || 0;
        if (r.type === 'outbound-rtp' && !r.isRemote) outBytes += r.bytesSent || 0;
      });
    }
    return { decoded: vids.filter(v => v.videoWidth > 0).length, inBytes, outBytes };
  })()`;

  let totalOut = 0;
  let failed = false;
  for (let i = 0; i < pages.length; i++) {
    await activate(cdp, pages[i].sessionId);
    const s = await evalIn(cdp, pages[i].sessionId, statsExpr);
    totalOut += s.outBytes;
    const ok = s.decoded >= 2 && s.inBytes > 0;
    if (!ok) failed = true;
    console.log(
      `标签页 ${i}: 已解码 ${s.decoded} 路画面, 收 ${s.inBytes} 字节, 发 ${s.outBytes} 字节 ${ok ? '' : ' <- FAIL'}`,
    );
  }
  console.log(`三个标签页合计发出 ${totalOut} 字节`);
  if (totalOut <= 0) failed = true;

  if (failed) {
    for (let i = 0; i < pages.length; i++) {
      const errs = pages[i].consoleErrors.slice(-3);
      if (errs.length) console.error(`标签页 ${i} 最后的控制台错误:\n  ${errs.join('\n  ')}`);
    }
    throw new Error('音视频通路断言失败');
  }

  console.log('==== 浏览器 E2E 全部通过 ====');
  cleanup();
  process.exit(0);
} catch (err) {
  console.error(`FAIL - ${err.message}`);
  for (let i = 0; i < pages.length; i++) {
    const errs = pages[i].consoleErrors.slice(-4);
    if (errs.length) console.error(`标签页 ${i} 控制台错误:\n  ${errs.join('\n  ')}`);
  }
  cleanup();
  process.exit(1);
}
