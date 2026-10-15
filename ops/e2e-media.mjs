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

  // 移出成员: 主持人踢掉最后一个标签页, 它下一拍会发现房间空了 + removed 标志, 回大厅
  await activate(cdp, pages[0].sessionId);
  const remoteIds = await evalIn(cdp, pages[0].sessionId, `(${VM}).remotes.map((p) => p.id)`);
  const victim = remoteIds[remoteIds.length - 1];
  await evalIn(cdp, pages[0].sessionId, `(${VM}).kickMember(${JSON.stringify(victim)})`);
  let kicked = null;
  for (let i = 0; i < 20; i++) {
    await activate(cdp, pages[2].sessionId);
    kicked = await evalIn(
      cdp,
      pages[2].sessionId,
      `({ view: (${VM})?.view, err: (${VM})?.errors?.form || '' })`,
    );
    if (kicked.view === 'lobby') break;
    await sleep(500);
  }
  if (kicked && kicked.view === 'lobby' && /移出/.test(kicked.err)) {
    console.log(`移出成员: 被踢的人回到大厅 (提示: ${kicked.err})`);
  } else {
    failed = true;
    console.error(`移出成员断言失败: ${JSON.stringify(kicked)}`);
  }

  // 可选: E2E_SHOT=<路径.png> 时给开了聊天面板的那个标签页截个图 (人工看 UI 用, CI 不设就不跑)
  if (process.env.E2E_SHOT) {
    const tab = Math.min(pages.length - 1, Math.max(0, Number(process.env.E2E_SHOT_TAB ?? 1)));
    await activate(cdp, pages[tab].sessionId);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, pages[tab].sessionId);
    writeFileSync(process.env.E2E_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`截图: ${process.env.E2E_SHOT}`);
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
