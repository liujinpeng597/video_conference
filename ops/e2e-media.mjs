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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    // 屏幕共享阶段用: 无头环境没有取源弹窗, 让它自动选“整个屏幕”(选不到会走跳过分支)
    '--auto-select-desktop-capture-source=Entire screen',
    '--no-sandbox',
    '--disable-gpu',
    ...(process.env.E2E_WINDOW ? [`--window-size=${process.env.E2E_WINDOW}`] : []),
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

function cleanup() {
  try { chrome.kill(); } catch {}
  try { rmSync(userDir, { recursive: true, force: true }); } catch {}
}

try {
  let failed = false;   // 放在最前面: 后面有些阶段 (比如界面切换) 在这之前就可能判失败
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
    // restoreSession -> goHome
    await waitIn(
      cdp,
      p.sessionId,
      `(() => { const vm = ${VM}; return !!vm && vm.view === 'home'; })()`,
      20000,
      `标签页 ${i} 进入大厅`,
      `({ vue: typeof Vue, app: !!document.querySelector('#app'), hasAppKey: !!document.querySelector('#app')?.__vue_app__, hasVnode: !!document.querySelector('#app')?._vnode, vm: !!(${VM}), view: (${VM})?.view, booting: (${VM})?.booting })`,
    );
  }

  // 第 1 个标签页开一个新房间, 读出房间号; 另外两个用同一个房间号进房
  // 三个界面: 会议首页 / 个人中心 / 会议中 —— 顶栏两个 tab 能来回切, 个人中心有昵称和改密码
  await activate(cdp, pages[0].sessionId);
  // 首页的试麦电平条要跟着摄像头/麦克风一起出来 (媒体是异步拿到的, 等它挂上)
  await waitIn(cdp, pages[0].sessionId, `!!document.querySelector('.meter__bar')`, 15000, '首页试麦电平条');
  console.log('首页: 试麦电平条在');

  await evalIn(cdp, pages[0].sessionId, `(() => { (${VM}).goProfile(); return true; })()`);
  // 视图切换是 <transition mode="out-in">, 得等新视图真的挂上 (一次 $nextTick 不够)
  await waitIn(cdp, pages[0].sessionId,
               `!!document.querySelector('#f-nick') && !!document.querySelector('#f-op')`,
               10000, '切到个人中心 (昵称 + 修改密码都在)');
  const tabs = await evalIn(cdp, pages[0].sessionId, `document.querySelectorAll('.rail__btn').length`);
  if (process.env.E2E_SHOT_PROFILE) {
    await sleep(400);
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[0].sessionId);
    writeFileSync(process.env.E2E_SHOT_PROFILE, Buffer.from(s.data, 'base64'));
    console.log(`截图(个人中心): ${process.env.E2E_SHOT_PROFILE}`);
  }
  await evalIn(cdp, pages[0].sessionId, `(() => { (${VM}).goHome(); return true; })()`);
  await waitIn(cdp, pages[0].sessionId, `!!document.querySelector('.preview')`, 10000, '切回会议首页');
  if (tabs === 2) console.log('三个界面: 个人中心有昵称 + 修改密码, 左侧栏两个入口, 能切回会议页');
  else { failed = true; console.error(`左侧栏入口数不对: ${tabs}`); }

  // 回归: 宽屏 + 摄像头关着时, 预览不能塌成一小条。曾经 .join 用 margin-inline:auto
  // 变成"按内容收缩", 关摄像头后预览里没有 in-flow 内容 (遮罩是 absolute), 预览缩成 48px。
  await activate(cdp, pages[0].sessionId);
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    pages[0].sessionId,
  );
  const wide = await evalIn(
    cdp,
    pages[0].sessionId,
    `(async () => {
       const vm = ${VM};
       if (vm.camOn) vm.toggleCam();            // 关掉摄像头, 复现出问题的状态
       await vm.$nextTick();
       const preview = Math.round(document.querySelector('.preview').getBoundingClientRect().width);
       const frame = Math.round(document.querySelector('.preview__frame').getBoundingClientRect().width);
       if (!vm.camOn) vm.toggleCam();           // 还原, 别影响后面的媒体断言
       await vm.$nextTick();
       return { preview, frame, camBack: vm.camOn };
     })()`,
  );
  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, pages[0].sessionId);
  // 不变量是"预览帧铺满它那一列" (塌成一小条时 frame 会远小于 preview), 不是某个绝对像素
  if (wide.camBack && wide.frame > 200 && wide.frame >= wide.preview * 0.95) {
    console.log(`宽屏 + 摄像头关着: 预览 ${wide.frame}px (容器 ${wide.preview}px), 没塌`);
  } else {
    failed = true;
    console.error(`宽屏预览回归: ${JSON.stringify(wide)}`);
  }

  // 回归: 大厅里的会话心跳 —— 账号在别处登录后, 停在大厅的那个标签页要自己回登录页。
  // 用一个额外的临时标签页 (不进 pages), 免得把后面房间阶段的三个标签页搞乱。
  {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    const u = await registerUser(`e2eb${SUFFIX}`);
    await cdp.send('Page.navigate', { url: `${BASE}/` }, sessionId);
    await waitIn(cdp, sessionId, `document.readyState === 'complete' && !!document.querySelector('#app')`,
                 20000, '大厅心跳标签页加载');
    await evalIn(cdp, sessionId,
      `sessionStorage.setItem('tp_token', ${JSON.stringify(u.token)});
       sessionStorage.setItem('tp_user', ${JSON.stringify(u.user)}); 'ok'`);
    await cdp.send('Page.reload', {}, sessionId);
    await activate(cdp, sessionId);
    await waitIn(cdp, sessionId, `(() => { const vm = ${VM}; return !!vm && vm.view === 'home'; })()`,
                 20000, '大厅心跳标签页进入大厅');

    const relogin = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.user, password: 'e2e-pass-123' }),
    });
    let bounced = null;
    for (let i = 0; i < 24; i++) {   // 心跳 5 秒一次, 给足两个周期
      await activate(cdp, sessionId);
      bounced = await evalIn(cdp, sessionId, `({ view: (${VM})?.view, err: (${VM})?.errors?.form || '' })`);
      if (bounced.view === 'auth') break;
      await sleep(500);
    }
    if (relogin.ok && bounced && bounced.view === 'auth' && /登录/.test(bounced.err)) {
      console.log(`大厅心跳: 被顶掉的标签页从大厅自动回到登录页 (提示: ${bounced.err})`);
    } else {
      failed = true;
      console.error(`大厅心跳断言失败: ${JSON.stringify({ ok: relogin.ok, bounced })}`);
    }
    if (process.env.E2E_SHOT_KICKED) {
      await sleep(600);  // 等视图切换的淡入放完, 不然截到半透明的一帧
      const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(process.env.E2E_SHOT_KICKED, Buffer.from(s.data, 'base64'));
      console.log(`截图(被顶掉): ${process.env.E2E_SHOT_KICKED}`);
    }
    await cdp.send('Target.closeTarget', { targetId });
  }

  if (process.env.E2E_SHOT_LOBBY) {
    await activate(cdp, pages[0].sessionId);
    if (process.env.E2E_LOBBY_CAMOFF) {
      // 复现"宽屏 + 摄像头关着"的布局: 关掉媒体, 再看 .preview 的实际尺寸
      const how = process.env.E2E_LOBBY_CAMOFF === 'toggle' ? 'toggleCam' : 'stopMedia';
      await evalIn(cdp, pages[0].sessionId, `(() => { (${VM}).${how}(); return true; })()`);
      await sleep(400);
    }
    const geo = await evalIn(
      cdp,
      pages[0].sessionId,
      `(() => {
         const g = (sel) => { const e = document.querySelector(sel); if (!e) return null;
           const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
           return { w: Math.round(r.width), h: Math.round(r.height), ar: s.aspectRatio, align: s.alignItems }; };
         return { vw: innerWidth, join: g('.join'), side: g('.join__side'), preview: g('.preview'),
                  frame: g('.preview__frame'), off: g('.preview__off') };
       })()`,
    );
    console.log('lobby geo:', JSON.stringify(geo));
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[0].sessionId);
    writeFileSync(process.env.E2E_SHOT_LOBBY, Buffer.from(s.data, 'base64'));
    console.log(`截图(大厅): ${process.env.E2E_SHOT_LOBBY}`);
  }

  const enter = (room) =>
    `(async () => {
       const vm = ${VM};
       vm.roomInput = ${JSON.stringify(room)};
       await (${JSON.stringify(room)} ? vm.joinRoom() : vm.createRoom());
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

  // 会议室的壳别被首页那套两列网格带偏 (曾经把 grid-template-columns 加到 .app 上,
  // 会议室也是 .app, 于是顶栏挤进窄列、舞台跑到右上、控制条掉到左下 —— 整屏散架)
  const roomBox = await evalIn(
    cdp,
    pages[0].sessionId,
    `(() => {
       const st = document.querySelector('.stage').getBoundingClientRect();
       const ct = document.querySelector('.controls').getBoundingClientRect();
       return { w: innerWidth, vh: innerHeight,
                stage: Math.round(st.width), ctlTop: Math.round(ct.top) };
     })()`,
  );
  // 成员面板 + 布局切换 (会中的新东西)
  await activate(cdp, pages[0].sessionId);
  const ui = await evalIn(cdp, pages[0].sessionId, `(async () => {
      const vm = ${VM};
      vm.toggleMembers();
      await vm.$nextTick();
      const rows = document.querySelectorAll('.prow').length;
      const acts = document.querySelectorAll('.prow__act .btn').length;
      vm.toggleMembers();
      await vm.$nextTick();
      const seq = [];
      for (let i = 0; i < 3; i++) { vm.cycleLayout(); seq.push(vm.focusPid); }
      vm.focusPid = '';
      return { rows, acts, seq, mine: vm.myPid, host: vm.host, closed: !vm.membersOpen };
    })()`);
  {   // 会中改名: 走真实 UI 路径 (点"改名" -> 填 -> 提交), 房间里要立刻变
    const rn = await evalIn(cdp, pages[0].sessionId, `(async () => {
        const vm = ${VM};
        if (!vm.membersOpen) vm.toggleMembers();
        await vm.$nextTick();
        const btns = [...document.querySelectorAll('#room-members .prow__act .btn')].map((b) => b.textContent.trim());
        const btn = [...document.querySelectorAll('#room-members .prow__act .btn')].find((b) => b.textContent.trim() === '改名');
        if (btn) btn.click();
        await vm.$nextTick();
        const form = document.querySelector('#room-members form');
        const out = { btns, renaming: vm.renaming, hasForm: !!form };
        if (form) {
          const input = form.querySelector('input');
          input.value = 'E2E新名';
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await vm.$nextTick();
          out.inputVal = vm.renameInput;
          if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 600));
          out.displayName = vm.displayName;
          out.selfName = (vm.participants.find((p) => p.me) || {}).name;
          out.renamingAfter = vm.renaming;
        }
        vm.membersOpen = false;
        return out;
      })()`);
    if (rn.hasForm && rn.inputVal === 'E2E新名' && rn.selfName === 'E2E新名') {
      console.log('会中改名: 点改名 -> 填 -> 提交, 房间里立刻就是新名字');
    } else {
      failed = true;
      console.error(`会中改名断言失败: ${JSON.stringify(rn)}`);
    }
  }

  // 布局: 切到"我最大"之后, 自己那一格必须真的变大 (宽度铺满舞台、高度过半屏)
  const big = await evalIn(cdp, pages[0].sessionId, `(async () => {
      const vm = ${VM};
      vm.focusPid = '';
      const gridTiles = [...document.querySelectorAll('.grid .tile')].map((e) => {
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
      vm.cycleLayout();                       // 宫格 -> 我最大
      await vm.$nextTick();
      const tile = document.querySelector('.tile--focus');
      const stage = document.querySelector('.stage');
      const t = tile && tile.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      const others = [...document.querySelectorAll('.tile:not(.tile--focus)')]
        .map((e) => Math.round(e.getBoundingClientRect().width));
      const out = { focus: vm.focusPid, mine: vm.myPid, tw: t ? Math.round(t.width) : 0,
                    th: t ? Math.round(t.height) : 0, sw: Math.round(s.width), vh: innerHeight, others, gridTiles };
      vm.focusPid = '';
      return out;
    })()`);
  // 1) 宫格里每格都是 16:9 的固定比例 (浏览器缩放/窗口变化不再把画面拉变形)
  const sameW = big.gridTiles.length >= 2 && big.gridTiles.every((t) => Math.abs(t.w - big.gridTiles[0].w) <= 2);
  const ratioOk = big.gridTiles.every((t) => Math.abs(t.h - t.w * 9 / 16) <= 10);
  if (sameW && ratioOk) {
    console.log(`宫格比例: ${big.gridTiles.map((t) => `${t.w}x${t.h}`).join(', ')} (都是 16:9)`);
  } else {
    failed = true;
    console.error(`宫格比例断言失败 (应保持 16:9): ${JSON.stringify(big.gridTiles)}`);
  }
  // 2) "我最大": 大格明显压过别人, 别人还是完整小格 (没有被压成一条)
  const bigMaxOther = Math.max(0, ...big.others);
  const othersSmall = big.others.length > 0 && big.others.every((w) => w >= 150 && w <= 260);
  if (big.focus === big.mine && big.tw > big.sw * 0.55 && big.th > big.vh * 0.4 &&
      big.tw > bigMaxOther * 3 && othersSmall) {
    console.log(`布局: 我最大 -> ${big.tw}x${big.th} (舞台宽 ${big.sw}, 屏高 ${big.vh}), 其余 ${big.others.join('/')}px`);
  } else {
    failed = true;
    console.error(`布局放大断言失败: ${JSON.stringify(big)}`);
  }

  if (process.env.E2E_SHOT_MEMBERS) {
    await evalIn(cdp, pages[0].sessionId, `(async () => { const vm = ${VM}; if (!vm.membersOpen) vm.toggleMembers(); await vm.$nextTick(); return true; })()`);
    await sleep(400);
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[0].sessionId);
    writeFileSync(process.env.E2E_SHOT_MEMBERS, Buffer.from(s.data, 'base64'));
    console.log(`截图(成员面板): ${process.env.E2E_SHOT_MEMBERS}`);
    await evalIn(cdp, pages[0].sessionId, `(() => { (${VM}).membersOpen = false; return true; })()`);
  }
  // 自己是主持人时"我/主持人"是同一档, 所以这里只要求"能在大格和宫格之间来回切";
  // 非主持人的主持人档在下面 (tab1) 单独验证。
  await activate(cdp, pages[1].sessionId);
  const ui2 = await evalIn(cdp, pages[1].sessionId, `(() => {
      const vm = ${VM};
      const seq = [];
      for (let i = 0; i < 3; i++) { vm.cycleLayout(); seq.push(vm.focusPid); }
      vm.focusPid = '';
      return { seq, mine: vm.myPid, host: vm.host };
    })()`);
  const cycles = ui.seq.some((x) => x === '') && ui.seq.some((x) => x !== '');
  const hostMode = ui2.seq[0] === ui2.mine && ui2.seq[1] === ui2.host && ui2.seq[2] === '' && !!ui2.host;
  if (ui.rows === 3 && ui.acts >= 1 && cycles && hostMode) {
    console.log(`成员面板: ${ui.rows} 行, 主持人有 ${ui.acts} 个操作按钮; 布局 宫格/我/主持人 正常`);
  } else {
    failed = true;
    console.error(`成员面板 / 布局断言失败: ${JSON.stringify({ ui, ui2, cycles, hostMode })}`);
  }

  if (roomBox.stage > roomBox.w * 0.7 && roomBox.ctlTop > roomBox.vh * 0.7) {
    console.log(`会议中布局: 舞台铺满 ${roomBox.stage}/${roomBox.w}px, 控制条贴在底部`);
  } else {
    failed = true;
    console.error(`会议中布局散架: ${JSON.stringify(roomBox)}`);
  }

  // 画面方向: 不能是镜像的 —— 自己的那格也用来放"共享屏幕", 一旦镜像, 共享出去的
  // 文字就全反了。这里锁死"没有任何 video 带 scaleX(-1)"。
  await activate(cdp, pages[0].sessionId);
  const dirs = await evalIn(
    cdp,
    pages[0].sessionId,
    `(() => {
       const self = document.querySelector('.tile__video:not(.tile__video--remote)');
       const remote = document.querySelector('.tile__video--remote');
       return { self: self ? getComputedStyle(self).transform : '?',
                remote: remote ? getComputedStyle(remote).transform : '?' };
     })()`,
  );
  if (dirs.self === 'none' && dirs.remote === 'none') {
    console.log('画面方向: 自己与远端都不是镜像');
  } else {
    failed = true;
    console.error(`画面方向断言失败 (不该有镜像): ${JSON.stringify(dirs)}`);
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

  // 通话质量指示: getStats 采出来的码率应该 > 0 (说明采样链路真的在工作)
  let qSeen = null;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[0].sessionId);
    qSeen = await evalIn(
      cdp,
      pages[0].sessionId,
      `(() => {
         const s = (${VM})?.peerStats || {};
         const ks = Object.values(s).filter((x) => x.inKbps > 0);
         return { total: Object.keys(s).length, withRate: ks.length, sample: ks[0] ? { ...ks[0] } : null };
       })()`,
    );
    if (qSeen.withRate >= 2) break;
    await sleep(600);
  }
  if (qSeen && qSeen.withRate >= 2) {
    console.log(`通话质量: ${qSeen.withRate} 路有码率 (例: ${JSON.stringify(qSeen.sample)})`);
  } else {
    failed = true;
    console.error(`通话质量断言失败: ${JSON.stringify(qSeen)}`);
  }

  // 阶段 2: 屏幕共享 —— 无头里起不起得来取决浏览器, 起不来就跳过 (不判失败);
  // 起来了就断言: 连接不断、tab0 继续发、另外两页继续在收, 停止后能切回且不断线。
  await activate(cdp, pages[0].sessionId);
  const canShare = await evalIn(
    cdp,
    pages[0].sessionId,
    `typeof (${VM})?.toggleShare === 'function'`,
  );
  if (!canShare) {
    console.log('提示: 页面没有屏幕共享能力, 跳过共享断言');
  } else {
    const before = [];
    for (let i = 0; i < pages.length; i++) {
      await activate(cdp, pages[i].sessionId);
      before.push(await evalIn(cdp, pages[i].sessionId, statsExpr));
    }
    const sharing = await evalIn(
      cdp,
      pages[0].sessionId,
      `(async () => { const vm = ${VM}; await vm.toggleShare(); return vm.sharing; })()`,
    );
    if (!sharing) {
      console.log('提示: 无头环境起不了屏幕共享 (getDisplayMedia 不可用或被拒), 跳过共享断言');
    } else {
      console.log('屏幕共享已启动, 等 4 秒看媒体是否继续流动...');
      await sleep(4000);
      const after = [];
      const shareStates = [];
      for (let i = 0; i < pages.length; i++) {
        await activate(cdp, pages[i].sessionId);
        after.push(await evalIn(cdp, pages[i].sessionId, statsExpr));
        shareStates.push(
          await evalIn(
            cdp,
            pages[i].sessionId,
            `[...window.tongpin.calls.values()].map((s) => s.pc.connectionState)`,
          ),
        );
      }
      const okStates = shareStates.every(
        (ss) => ss.length === 2 && ss.every((s) => s === 'connected'),
      );
      const tab0Flow = after[0].outBytes > before[0].outBytes;
      const othersFlow =
        after[1].inBytes > before[1].inBytes && after[2].inBytes > before[2].inBytes;
      if (okStates && tab0Flow && othersFlow) {
        console.log(
          `共享中: 连接保持, tab0 发 +${after[0].outBytes - before[0].outBytes} 字节, ` +
            `对端收 +${after[1].inBytes - before[1].inBytes} / +${after[2].inBytes - before[2].inBytes} 字节`,
        );
        // 共享状态同步: 对端要看得见"是 tab0 在共享"
        await activate(cdp, pages[1].sessionId);
        const shareSeen = await evalIn(cdp, pages[1].sessionId,
          `(${VM})?.remotes?.some((p) => p.share === true)`);
        if (shareSeen) console.log('共享状态同步: 对端看到 share=true');
        else { failed = true; console.error('共享状态同步断言失败: 对端没看到谁在共享'); }
      } else {
        failed = true;
        console.error(
          `共享断言失败: states=${JSON.stringify(shareStates)} ` +
            `发 +${after[0].outBytes - before[0].outBytes} 收 +${after[1].inBytes - before[1].inBytes}/+${after[2].inBytes - before[2].inBytes}`,
        );
      }
      const stillSharing = await evalIn(
        cdp,
        pages[0].sessionId,
        `(async () => { const vm = ${VM}; vm.stopShare(); return vm.sharing; })()`,
      );
      if (stillSharing) {
        failed = true;
        console.error('停止共享后 sharing 仍为 true');
      }
      await sleep(1200);
      const backStates = await evalIn(
        cdp,
        pages[0].sessionId,
        `[...window.tongpin.calls.values()].map((s) => s.pc.connectionState)`,
      );
      if (backStates.some((s) => s !== 'connected')) {
        failed = true;
        console.error(`停共享后连接异常: ${JSON.stringify(backStates)}`);
      } else {
        console.log('屏幕共享停止: 已切回摄像头, 连接保持');
      }
    }
  }

  // 可选诊断 (E2E_PROBE=1): 统计视频元素被重建 / srcObject 被重设 / play() 被调的次数。
  // 画面"一闪一闪"基本就是这几个在轮询里反复发生 —— 用数字定位, 别靠猜。
  const PROBE_INSTALL = `(() => {
    window.__probe = window.__probe || { added: 0, removed: 0, plays: 0, srcSets: 0, byClass: {} };
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (d && d.set && !HTMLMediaElement.prototype.__probed) {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
        configurable: true, get: d.get,
        set(v) {
          window.__probe.srcSets++;
          const k = (this.className || this.tagName);
          window.__probe.byClass[k] = (window.__probe.byClass[k] || 0) + 1;
          d.set.call(this, v);
        },
      });
      HTMLMediaElement.prototype.__probed = true;
    }
    const P = HTMLMediaElement.prototype.play;
    if (!P.__probed) {
      const wrap = function () { window.__probe.plays++; return P.apply(this, arguments); };
      wrap.__probed = true;
      HTMLMediaElement.prototype.play = wrap;
    }
    if (!window.__probeObs) {
      for (const t of ['loadstart', 'emptied', 'loadeddata', 'playing', 'waiting']) {
        document.addEventListener(t, (e) => {
          if (e.target && e.target.nodeName === 'VIDEO') {
            window.__probe.events = window.__probe.events || {};
            const k = t + ':' + (e.target.className || '');
            window.__probe.events[k] = (window.__probe.events[k] || 0) + 1;
          }
        }, true);
      }
      window.__probeObs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) if (n.nodeName === 'VIDEO') window.__probe.added++;
          for (const n of m.removedNodes) if (n.nodeName === 'VIDEO') window.__probe.removed++;
        }
      });
      window.__probeObs.observe(document.querySelector('#app'), { childList: true, subtree: true });
    }
    return true;
  })()`;
  if (process.env.E2E_PROBE) {
    for (const pg of pages) {
      await activate(cdp, pg.sessionId);
      await evalIn(cdp, pg.sessionId, PROBE_INSTALL);
    }
    console.log('probe: 已装统计器');
    await sleep(6000);  // 静默 6 秒 (只有轮询, 没有任何操作), 量稳态速率
    for (let i = 0; i < pages.length; i++) {
      await activate(cdp, pages[i].sessionId);
      const p = await evalIn(cdp, pages[i].sessionId, `JSON.stringify(window.__probe)`);
      console.log(`probe 稳态6s tab${i}: ${p}`);
    }
  }

  // 阶段 2.5: 虚拟背景(简易人像) —— 出向视频轨应该换成 canvas 处理后的流: 连接不断、对端继续收
  await activate(cdp, pages[0].sessionId);
  const bgMode = await evalIn(cdp, pages[0].sessionId,
    `(async () => { const vm = ${VM}; await vm.setBg('blur'); return vm.bgMode; })()`);
  await sleep(2500);
  const bgIn = [];
  for (let i = 0; i < pages.length; i++) {
    await activate(cdp, pages[i].sessionId);
    bgIn.push(await evalIn(cdp, pages[i].sessionId, statsExpr));
  }
  await activate(cdp, pages[1].sessionId);
  const bgStates = await evalIn(cdp, pages[1].sessionId,
    `[...window.tongpin.calls.values()].map((s) => s.pc.connectionState)`);
  const bgOk = bgMode === 'blur' && bgStates.length === 2 && bgStates.every((s) => s === 'connected') &&
               bgIn[0].outBytes > 0 && bgIn[1].inBytes > 0 && bgIn[2].inBytes > 0;
  if (bgOk) {
    console.log(`虚拟背景: 出向轨换成处理后的流, 连接保持 (tab0 发 ${bgIn[0].outBytes} 字节, 对端在收)`);
  } else {
    failed = true;
    console.error(`虚拟背景断言失败: ${JSON.stringify({ bgMode, bgStates, flow: bgIn.map((s) => `${s.inBytes}/${s.outBytes}`) })}`);
  }
  await activate(cdp, pages[0].sessionId);
  if (process.env.E2E_SHOT_BG) {
    await activate(cdp, pages[1].sessionId);   // 拍"别人看到的"那一路
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[1].sessionId);
    writeFileSync(process.env.E2E_SHOT_BG, Buffer.from(s.data, 'base64'));
    console.log(`截图(虚拟背景): ${process.env.E2E_SHOT_BG}`);
  }
  await evalIn(cdp, pages[0].sessionId, `(() => { (${VM}).stopBg(); return true; })()`);
  await sleep(600);

  // 阶段 3: 房间聊天 —— 写走 POST /api/rooms/chat, 读搭 /api/rooms/state 的 chat 字段同一拍带回。
  // 断言: tab0 发出的是自己那条; tab1 收到; tab1 面板关着时未读 +1;
  // 而且用户文本按纯文本渲染 (HTML 被转义) —— 聊天是最脏的用户输入, 这条最重要。
  await activate(cdp, pages[0].sessionId);
  const chatText = `e2e-<b>${SUFFIX}</b>-${Math.random().toString(36).slice(2, 6)}`;
  const sent = await evalIn(
    cdp,
    pages[0].sessionId,
    `(async () => {
       const vm = ${VM};
       vm.toggleChat();
       vm.chatInput = ${JSON.stringify(chatText)};
       await vm.sendChat();
       return { open: vm.chatOpen, mine: vm.chatMessages.map(m => m.text), input: vm.chatInput };
     })()`,
  );
  if (!sent.open || !sent.mine.includes(chatText) || sent.input !== '') {
    failed = true;
    console.error(`聊天发送断言失败: ${JSON.stringify(sent)}`);
  }

  // tab1 的聊天面板先不打开: 一边等它轮询收到, 一边验证未读计数
  let got = null;
  for (let i = 0; i < 30; i++) {
    await activate(cdp, pages[1].sessionId);
    got = await evalIn(
      cdp,
      pages[1].sessionId,
      `(() => { const vm = ${VM}; return { msgs: vm.chatMessages.map(m => m.text), unread: vm.chatUnread }; })()`,
    );
    if (got.msgs.includes(chatText)) break;
    await sleep(500);
  }
  await activate(cdp, pages[1].sessionId);
  const rendered = await evalIn(
    cdp,
    pages[1].sessionId,
    `(async () => {
       const vm = ${VM};
       if (!vm.chatOpen) vm.toggleChat();
       await vm.$nextTick();   // v-if 是异步渲染的, 不等一拍 DOM 还是空的
       return document.querySelector('.chat__list')?.innerHTML || '';
     })()`,
  );
  const escaped = rendered.includes('&lt;b&gt;') && !rendered.includes('<b>');
  if (!got || !got.msgs.includes(chatText)) {
    failed = true;
    console.error('聊天接收断言失败: tab1 没收到消息');
  } else if (got.unread < 1) {
    failed = true;
    console.error(`聊天未读断言失败: unread=${got.unread}`);
  } else if (!escaped) {
    failed = true;
    console.error(`聊天转义断言失败 (用户文本被当成 HTML 渲染): ${rendered.slice(0, 200)}`);
  } else {
    console.log(`聊天: tab0 发出, tab1 收到 (未读 ${got.unread}), 文本按纯文本渲染`);
  }

  // 阶段 4: 举手 —— 状态在 participants[].hand, 自己和对端都该看到
  await activate(cdp, pages[0].sessionId);
  await evalIn(
    cdp,
    pages[0].sessionId,
    `(async () => { const vm = ${VM}; if (!vm.myHand) await vm.toggleHand(); return vm.myHand; })()`,
  );
  let handOk = false;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[0].sessionId);
    const mine = await evalIn(cdp, pages[0].sessionId, `(${VM})?.myHand`);
    await activate(cdp, pages[1].sessionId);
    const seen = await evalIn(
      cdp,
      pages[1].sessionId,
      `(${VM})?.remotes?.some((p) => p.hand)`,
    );
    if (mine && seen) { handOk = true; break; }
    await sleep(500);
  }
  if (handOk) console.log('举手: 自己与对端都看到 ✋');
  else { failed = true; console.error('举手断言失败: 对端没看到 hand=true'); }

  // 静音状态同步: tab0 关麦, tab1 的成员列表里应该看到 mic=false
  await activate(cdp, pages[0].sessionId);
  await evalIn(cdp, pages[0].sessionId,
    `(async () => { const vm = ${VM}; if (vm.micOn) vm.toggleMic(); return vm.micOn; })()`);
  let micSeen = false;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[1].sessionId);
    const seen = await evalIn(cdp, pages[1].sessionId, `(${VM})?.remotes?.some((p) => p.mic === false)`);
    if (seen) { micSeen = true; break; }
    await sleep(400);
  }
  if (micSeen) console.log('静音同步: 对端看到 mic=false');
  else { failed = true; console.error('静音同步断言失败: 对端没看到 mic=false'); }
  // 还原开麦, 别影响后面"全体静音"那条断言
  await activate(cdp, pages[0].sessionId);
  await evalIn(cdp, pages[0].sessionId,
    `(async () => { const vm = ${VM}; if (!vm.micOn) vm.toggleMic(); return vm.micOn; })()`);

  // 阶段 4.6: 视图与快捷键 —— 点某格放大 (演示者视图) + 键盘 v 关摄像头
  await activate(cdp, pages[0].sessionId);
  const view = await evalIn(cdp, pages[0].sessionId, `(async () => {
      const vm = ${VM};
      const target = (vm.remotes[0] || {}).id;
      vm.toggleFocus(target);
      await vm.$nextTick();   // class 绑定是异步渲染的
      return { focus: vm.focusPid, target, cls: !!document.querySelector('.grid.is-focus') };
    })()`);
  const key = (type) => cdp.send('Input.dispatchKeyEvent',
    { type, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, text: type === 'keyDown' ? 'v' : undefined },
    pages[0].sessionId);
  await key('keyDown');
  await sleep(300);
  const camAfterKey = await evalIn(cdp, pages[0].sessionId, `(${VM})?.camOn`);
  await key('keyDown');   // 再按一次还原
  if (process.env.E2E_SHOT_FOCUS) {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[0].sessionId);
    writeFileSync(process.env.E2E_SHOT_FOCUS, Buffer.from(s.data, 'base64'));
    console.log(`截图(放大视图): ${process.env.E2E_SHOT_FOCUS}`);
  }
  await evalIn(cdp, pages[0].sessionId, `(() => { (${VM}).focusPid = ''; return true; })()`);
  await sleep(300);
  const camBack = await evalIn(cdp, pages[0].sessionId, `(${VM})?.camOn`);
  if (view.focus && view.focus === view.target && view.cls && camAfterKey === false && camBack === true) {
    console.log(`视图/快捷键: 点格放大生效 (focus=${view.focus}), 按 v 关摄像头再按回来`);
  } else {
    failed = true;
    console.error(`视图/快捷键断言失败: ${JSON.stringify({ view, camAfterKey, camBack })}`);
  }

  // 阶段 5: 表情反应 —— 瞬时效果, 走信令广播 (kind='reaction')
  await activate(cdp, pages[0].sessionId);
  await evalIn(cdp, pages[0].sessionId, `(${VM}).sendReaction('👍')`);
  let reactOk = false;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[1].sessionId);
    const n = await evalIn(
      cdp,
      pages[1].sessionId,
      `(${VM})?.reactions?.filter((r) => r.emoji === '👍').length || 0`,
    );
    if (n >= 1) { reactOk = true; break; }
    await sleep(400);
  }
  if (reactOk) console.log('表情反应: 对端收到了 👍');
  else { failed = true; console.error('表情反应断言失败: 对端没收到反应'); }

  // 阶段 6: 主持人 —— tab0 是建房的人 = 主持人; 只有它能看到"移出"按钮
  await activate(cdp, pages[0].sessionId);
  const host0 = await evalIn(
    cdp,
    pages[0].sessionId,
    `({ am: (${VM}).amHost, kicks: document.querySelectorAll('.tile__kick').length })`,
  );
  await activate(cdp, pages[1].sessionId);
  const host1 = await evalIn(
    cdp,
    pages[1].sessionId,
    `({ am: (${VM}).amHost, kicks: document.querySelectorAll('.tile__kick').length })`,
  );
  if (host0.am && !host1.am && host0.kicks === 2 && host1.kicks === 0) {
    console.log('主持人: 只有建房者能看到"移出"按钮, 别人看不到');
  } else {
    failed = true;
    console.error(`主持人断言失败: ${JSON.stringify({ host0, host1 })}`);
  }

  // 全体静音: 主持人发一条信令, 各端把自己静音
  await activate(cdp, pages[0].sessionId);
  await evalIn(cdp, pages[0].sessionId, `(${VM}).muteAll()`);
  let muted = false;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[1].sessionId);
    const mic = await evalIn(cdp, pages[1].sessionId, `(${VM})?.media?.mic`);
    if (mic === false) { muted = true; break; }
    await sleep(400);
  }
  if (muted) console.log('全体静音: 主持人一键, 对端被静音');
  else { failed = true; console.error('全体静音断言失败: 对端没被静音'); }

  // 会议锁定: 主持人锁上 -> 对端 state 里 should 看到 locked=true
  await activate(cdp, pages[0].sessionId);
  await evalIn(cdp, pages[0].sessionId,
    `(async () => { const vm = ${VM}; if (!vm.locked) await vm.toggleLock(); return vm.locked; })()`);
  let lockSeen = false;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[1].sessionId);
    const v = await evalIn(cdp, pages[1].sessionId, `(${VM})?.locked`);
    if (v === true) { lockSeen = true; break; }
    await sleep(400);
  }
  if (lockSeen) console.log('会议锁定: 对端看到 locked=true');
  else { failed = true; console.error('会议锁定断言失败: 对端没看到 locked=true'); }
  await activate(cdp, pages[0].sessionId);
  await evalIn(cdp, pages[0].sessionId,
    `(async () => { const vm = ${VM}; if (vm.locked) await vm.toggleLock(); return vm.locked; })()`);

  // 移出成员: 主持人踢掉最后一个标签页, 它下一拍会发现房间空了 + removed 标志, 回大厅
  await activate(cdp, pages[0].sessionId);
  // 明确踢"2 号标签页自己报的 pid" —— 不依赖远端列表的顺序 (hash 顺序不该被假设)
  await activate(cdp, pages[2].sessionId);
  const victim = await evalIn(cdp, pages[2].sessionId, `(${VM})?.myPid`);
  await activate(cdp, pages[0].sessionId);
  const inList = await evalIn(cdp, pages[0].sessionId,
    `(${VM}).remotes.some((p) => p.id === ${JSON.stringify(victim)})`);
  if (!victim || !inList) {
    failed = true;
    console.error(`移出成员: 拿不到 2 号的 pid 或不在名单里 (${victim})`);
  } else {
    await evalIn(cdp, pages[0].sessionId, `(${VM}).kickMember(${JSON.stringify(victim)})`);
  }
  let kicked = null;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[2].sessionId);
    kicked = await evalIn(
      cdp,
      pages[2].sessionId,
      `({ view: (${VM})?.view, err: (${VM})?.errors?.form || '' })`,
    );
    if (kicked.view === 'home') break;
    await sleep(500);
  }
  if (kicked && kicked.view === 'home' && /移出/.test(kicked.err)) {
    console.log(`移出成员: 被踢的人回到大厅 (提示: ${kicked.err})`);
  } else {
    failed = true;
    console.error(`移出成员断言失败: ${JSON.stringify(kicked)}`);
  }

  // 可选: E2E_SHOT=<路径.png> 时给开了聊天面板的那个标签页截个图 (人工看 UI 用, CI 不设就不跑)
  if (process.env.E2E_PROBE) {
    for (let i = 0; i < pages.length; i++) {
      await activate(cdp, pages[i].sessionId);
      const p = await evalIn(cdp, pages[i].sessionId, `JSON.stringify(window.__probe)`);
      console.log(`probe tab${i}: ${p}`);
    }
  }

  if (process.env.E2E_SHOT) {
    const tab = Math.min(pages.length - 1, Math.max(0, Number(process.env.E2E_SHOT_TAB ?? 1)));
    await activate(cdp, pages[tab].sessionId);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[tab].sessionId);
    writeFileSync(process.env.E2E_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`截图: ${process.env.E2E_SHOT}`);
  }

  // 阶段 7: 同一账号"在别处"再登录一次 -> 这个标签页应该被挤下线 (回登录页 + 说明原因)
  const reLogin = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `e2e${SUFFIX}1`, password: 'e2e-pass-123' }),
  });
  if (!reLogin.ok) {
    failed = true;
    console.error(`挤下线用例: 二次登录失败 HTTP ${reLogin.status}`);
  }
  let out = null;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[1].sessionId);
    out = await evalIn(
      cdp,
      pages[1].sessionId,
      `({ view: (${VM})?.view, err: (${VM})?.errors?.form || '' })`,
    );
    if (out.view === 'auth') break;
    await sleep(500);
  }
  if (out && out.view === 'auth' && /登录/.test(out.err)) {
    console.log(`挤下线: 被顶掉的标签页回到登录页 (提示: ${out.err})`);
  } else {
    failed = true;
    console.error(`挤下线断言失败: ${JSON.stringify(out)}`);
  }

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
