/* 同频 · 前端逻辑
 *
 * 没有构建步骤: 页面直接引 vendor/vue.global.prod.js (完整版, 带模板编译器) 和这个文件。
 * 视图状态只有一个 view 变量: booting -> auth -> lobby -> room。
 *
 * 媒体走 WebRTC。现在的拓扑是 mesh (两两直连): 每个人和其他每个人都建一条 RTCPeerConnection,
 * 服务器只转发信令 (SDP / ICE candidate), 媒体不经过服务器。所以房间人数上限压得很低,
 * 想开更多人得换 SFU, 见 README。
 *
 * 信令用轮询而不是 WebSocket/SSE: 每条请求都是独立的, 负载均衡和 nginx 都不用特殊配置,
 * 后端重启也只影响一拍。代价是协商多几百毫秒, 相对 ICE 收集本身可以忽略。
 * 房间状态和信令收件箱合成一个接口 (/api/rooms/state), 一条轮询循环搞定:
 * 协商期间 400ms 一拍, 都连上了退回 2 秒。
 *
 * 登录状态分两层, 分别存在两个地方:
 *   sessionStorage 里的 tp_token    短会话 (服务端 12 小时), 每个标签页一份
 *   localStorage   里的 tp_remember 长期令牌 (服务端 30 天), 勾了"保持登录"才有
 * 故意不合并: 一个标签页一个短会话, 所以本地开两个标签页就是两个参会者;
 * 长期令牌只用来换新的短会话, 关掉浏览器明天再来也还是登录状态。
 */
(function () {
  'use strict';

  const { createApp } = Vue;

  const STORE_TOKEN = 'tp_token';          // sessionStorage
  const STORE_USER = 'tp_user';            // sessionStorage
  const STORE_REMEMBER = 'tp_remember';    // localStorage
  const STORE_LAST_USER = 'tp_last_user';  // localStorage, 就是"记住账号"

  const SYNC_IDLE_MS = 2000;   // 都连上了以后, 房间状态多久看一次
  const SYNC_BUSY_MS = 400;    // 还有连接没建好时多久看一次
  const HEALTH_MS = 5000;      // 服务端没响应时的重试间隔

  // -------------------------------------------------------------- 对端连接表
  // 故意放在组件外面, 而且不是响应式的: RTCPeerConnection / MediaStream
  // 这类对象塞进 Vue 的响应式代理里会出各种怪问题 (内部槽位被代理掉)。
  // 界面要用的状态另外用 peerState / peerHasVideo 两个普通对象同步过去。
  const calls = new Map();     // pid -> { pc, polite, makingOffer, ignoreOffer, stream }
  const videoEls = new Map();  // pid -> <video>
  const peerMissing = new Map();   // pid -> 连续几拍不在名单里 (连续两拍才拆连接)
  const peerRebuilds = new Map();  // pid -> 看门狗已重建次数 (连上清零, 上限 3 次)

  // 静态资源和 API 都由 video_server 提供, 所以是同一个源, 路径直接写相对根
  async function call(method, path, body, token) {
    const headers = {};
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error('连不上服务端，确认 video_server 还在跑');
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (err) { data = null; }
    }
    if (!res.ok) {
      // 429 多来自 nginx 的限流 (响应没有 JSON 体), 给一句人话而不是"请求失败 429"
      const msg = (data && data.error) ||
        (res.status === 429 ? '请求太频繁，稍等一会儿再试' : ('请求失败 ' + res.status));
      const e = new Error(msg);
      e.status = res.status;
      throw e;
    }
    return data || {};
  }

  createApp({
    data() {
      return {
        view: 'auth',
        mode: 'login',
        form: { username: '', password: '' },
        remember: true,
        errors: {},
        busy: false,
        showPass: false,
        booting: true,

        token: '',
        user: '',
        health: { state: 'check', text: '正在连服务端' },

        room: '',
        roomInput: '',
        participants: [],
        myPid: '',
        joinedAt: 0,
        nowTick: 0,

        // 信令
        iceServers: [],
        sigSince: 0,
        lastHandledSeq: 0,
        peerState: {},      // pid -> RTCPeerConnection.connectionState
        peerHasVideo: {},   // pid -> 有没有收到画面
        audioBlocked: false,

        media: { stream: null, cam: true, mic: true, error: '' },
        copied: false,
        videoEl: null,
        syncTimer: 0,
        clockTimer: 0,
        healthTimer: 0,
        copyTimer: 0,
      };
    },

    computed: {
      remotes() { return this.participants.filter((p) => !p.me); },
      // 给 CSS 用: 决定网格是单人铺满还是多列
      tiles() { return String(this.remotes.length + 1); },
      micOn() { return this.media.mic; },
      camOn() { return this.media.cam; },
      inviteLink() { return location.origin + '/#' + this.room; },
      elapsed() {
        if (!this.joinedAt) return '';
        const total = Math.max(0, Math.floor((this.nowTick - this.joinedAt) / 1000));
        const pad = (n) => String(n).padStart(2, '0');
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h ? h + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
      },
    },

    mounted() {
      this.checkHealth();
      this.prefillFromHash();
      this.restoreSession();

      // 页面从后台切回前台时立刻补一拍心跳: 后台标签页的定时器会被浏览器节流,
      // 可能超过服务端 30 秒的心跳阈值, 别人会误判你掉线。
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.view === 'room') this.scheduleSync(0);
      });
    },

    beforeUnmount() {
      this.stopTimers();
      this.closeAllCalls();
      this.stopMedia();
    },

    methods: {
      // ------------------------------------------------------------ 小工具
      initial(name) {
        const s = (name || '').trim();
        return s ? s.slice(0, 1) : '?';
      },

      // 自己的预览。视频元素会因为切视图被换掉, 所以用函数 ref。
      bindVideo(el) {
        this.videoEl = el;
        if (el) el.srcObject = this.media.stream;
      },

      // 远端画面同理, 但要按 pid 分开管
      bindRemoteVideo(el, pid) {
        if (el) {
          videoEls.set(pid, el);
          this.attachRemote(pid);
        } else {
          videoEls.delete(pid);
        }
      },

      attachRemote(pid) {
        const el = videoEls.get(pid);
        const call2 = calls.get(pid);
        if (!el || !call2 || !call2.stream) return;
        if (el.srcObject !== call2.stream) el.srcObject = call2.stream;
        const p = el.play();
        if (p && p.catch) {
          // 浏览器不给自动播放带声音的流 (还没发生过用户交互), 让用户点一下
          p.catch(() => { this.audioBlocked = true; });
        }
      },

      unlockAudio() {
        let ok = true;
        for (const pid of videoEls.keys()) {
          const el = videoEls.get(pid);
          if (!el) continue;
          const p = el.play();
          if (p && p.catch) p.catch(() => { ok = false; });
        }
        if (ok) this.audioBlocked = false;
      },

      peerHint(pid) {
        const st = this.peerState[pid];
        if (st === 'failed') return '连接失败';
        if (st === 'disconnected') return '连接不稳';
        if (st === 'connected') return '对方没有画面';
        return '正在连接';
      },

      // 带登录态的请求。服务端说会话没了、而手上还有长期令牌, 就自动续一次再重试。
      async authed(method, path, body) {
        try {
          return await call(method, path, body, this.token);
        } catch (err) {
          if (err.status !== 401) throw err;
          if (!(await this.tryResume())) {
            err.dead = true;  // 短期和长期都没了, 只能重新登录
            throw err;
          }
          return await call(method, path, body, this.token);
        }
      },

      // ------------------------------------------------------- 服务端连通性
      checkHealth() {
        clearTimeout(this.healthTimer);
        call('GET', '/api/health').then((h) => {
          if (h.ok) {
            this.health = { state: 'ok', text: '服务端在线' };
            return;
          }
          // HTTP 通但数据库不通, 得说清楚, 不然会以为是网络问题
          this.health = { state: 'down', text: '服务端在，但数据库连不上' };
          this.healthTimer = setTimeout(this.checkHealth, HEALTH_MS);
        }).catch(() => {
          this.health = { state: 'down', text: '服务端没响应，正在重试' };
          this.healthTimer = setTimeout(this.checkHealth, HEALTH_MS);
        });
      },

      // ------------------------------------------------ 登录状态 (两层令牌)
      goLobby() {
        this.view = 'lobby';
        this.startMedia();
      },

      // 回到登录页。顺便把标签切回"登录": 上次可能停在"注册"上,
      // 退出登录以后再看到注册表单很别扭, 而且照着填会直接撞 409。
      goAuth() {
        this.stopTimers();
        this.closeAllCalls();
        this.view = 'auth';
        this.mode = 'login';
        this.errors = {};
      },

      // 用长期令牌换一个新的短会话。成功返回 true。
      async tryResume() {
        const remember = localStorage.getItem(STORE_REMEMBER);
        if (!remember) return false;
        try {
          const r = await call('POST', '/api/session/resume', { remember_token: remember });
          this.token = r.token;
          this.user = r.user;
          sessionStorage.setItem(STORE_TOKEN, r.token);
          sessionStorage.setItem(STORE_USER, r.user);
          return true;
        } catch (err) {
          // 长期令牌也废了 (过期 / 被吊销 / 服务端换了库), 清掉别再试
          localStorage.removeItem(STORE_REMEMBER);
          return false;
        }
      },

      // 页面加载时恢复: 先试本标签页的短会话, 不行再拿长期令牌换一个
      async restoreSession() {
        this.form.username = localStorage.getItem(STORE_LAST_USER) || '';

        const token = sessionStorage.getItem(STORE_TOKEN);
        if (token) {
          this.token = token;
          this.user = sessionStorage.getItem(STORE_USER) || '';
          try {
            const r = await call('GET', '/api/me', null, token);
            this.user = r.user;
            sessionStorage.setItem(STORE_USER, r.user);
            this.booting = false;
            this.goLobby();
            return;
          } catch (err) {
            if (err.status !== 401) {
              this.errors = { form: err.message };
            }
            sessionStorage.removeItem(STORE_TOKEN);
            sessionStorage.removeItem(STORE_USER);
            this.token = '';
          }
        }

        if (await this.tryResume()) {
          this.booting = false;
          this.goLobby();
          return;
        }
        this.booting = false;
      },

      forgetSession() {
        this.stopTimers();
        this.closeAllCalls();
        this.stopMedia();
        this.token = '';
        this.user = '';
        this.room = '';
        this.participants = [];
        this.myPid = '';
        this.joinedAt = 0;
        this.sigSince = 0;
        this.lastHandledSeq = 0;
        sessionStorage.removeItem(STORE_TOKEN);
        sessionStorage.removeItem(STORE_USER);
        localStorage.removeItem(STORE_REMEMBER);  // 但用户名留着, 下次少打一遍
      },

      // --------------------------------------------------------- 登录 / 注册
      switchMode(m) {
        this.mode = m;
        this.errors = {};
      },

      async submitAuth() {
        const u = this.form.username;
        const p = this.form.password;
        const errs = {};
        if (!u) errs.username = '填个用户名';
        else if (u.length < 3) errs.username = '至少 3 个字符';
        else if (u.length > 20) errs.username = '最多 20 个字符';
        if (!p) errs.password = '填个密码';
        else if (p.length < 6) errs.password = '至少 6 位';
        this.errors = errs;
        if (Object.keys(errs).length) return;

        this.busy = true;
        try {
          const path = this.mode === 'login' ? '/api/login' : '/api/register';
          const r = await call('POST', path, { username: u, password: p, remember: this.remember });

          this.token = r.token;
          this.user = r.user;
          sessionStorage.setItem(STORE_TOKEN, r.token);
          sessionStorage.setItem(STORE_USER, r.user);
          localStorage.setItem(STORE_LAST_USER, u);

          if (this.remember && r.remember_token) {
            localStorage.setItem(STORE_REMEMBER, r.remember_token);
          } else {
            localStorage.removeItem(STORE_REMEMBER);
          }

          this.form.password = '';
          this.goLobby();
        } catch (err) {
          this.errors = { form: err.message };
        } finally {
          this.busy = false;
        }
      },

      async logout() {
        const token = this.token;
        const remember = localStorage.getItem(STORE_REMEMBER) || '';
        this.forgetSession();
        this.goAuth();
        this.checkHealth();
        try {
          // 服务端顺手把长期令牌一起吊销; 服务端没了也无所谓, 本地已经清干净了
          await call('POST', '/api/logout', { remember_token: remember || undefined }, token);
        } catch (err) { /* 忽略 */ }
      },

      // --------------------------------------------------------------- 房间
      prefillFromHash() {
        const m = /^#([a-z0-9-]{3,40})$/i.exec(location.hash || '');
        if (m) this.roomInput = m[1].toLowerCase();
      },

      async enterRoom() {
        this.errors = {};
        this.busy = true;
        try {
          const r = await this.authed('POST', '/api/rooms/enter', { room: this.roomInput });
          this.applyRoom(r);
          await this.loadIce();
          this.joinedAt = Date.now();
          this.nowTick = Date.now();
          this.sigSince = 0;      // 进房间就从头开始收信令
          this.lastHandledSeq = 0;
          this.view = 'room';
          this.roomInput = '';
          this.scheduleSync(0);
          this.clockTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
          this.syncCalls();
        } catch (err) {
          if (err.dead) {
            this.forgetSession();
            this.goAuth();
            this.errors = { form: '登录状态失效了，重新登录一下' };
          } else {
            this.errors = { form: err.message };
          }
        } finally {
          this.busy = false;
        }
      },

      // ICE 服务器列表放服务端, 这样改部署 (换自己的 STUN/TURN) 不用重发前端
      async loadIce() {
        try {
          const r = await this.authed('GET', '/api/ice');
          if (Array.isArray(r.iceServers)) this.iceServers = r.iceServers;
        } catch (err) {
          // 空的也能在本机 / 局域网连上 (走 host candidate), 所以不当成错误
        }
      },

      applyRoom(r) {
        if (typeof r.room === 'string') this.room = r.room;
        if (Array.isArray(r.participants)) {
          this.participants = r.participants;
          const me = r.participants.find((p) => p.me);
          if (me) this.myPid = me.id;
        }
      },

      // ------------------------------------------------------- 轮询 / 同步
      stopTimers() {
        clearTimeout(this.syncTimer);
        clearInterval(this.clockTimer);
        this.syncTimer = 0;
        this.clockTimer = 0;
      },

      scheduleSync(delay) {
        clearTimeout(this.syncTimer);
        const ms = delay !== undefined ? delay : this.syncInterval();
        this.syncTimer = setTimeout(this.sync, ms);
      },

      // 还有对端没连上就快一点, 都好了就退回慢的
      syncInterval() {
        if (this.remotes.length === 0) return SYNC_IDLE_MS;
        const pending = this.remotes.some((p) => this.peerState[p.id] !== 'connected');
        return pending ? SYNC_BUSY_MS : SYNC_IDLE_MS;
      },

      async sync() {
        try {
          const r = await this.authed('GET', '/api/rooms/state?since=' + this.sigSince);
          this.applyRoom(r);
          await this.applySignals(r);
          this.syncCalls();
          // 房间状态是放在 Redis 里的。万一 Redis 重启 (数据没开持久化),
          // 我们的 session 就没了, 服务端会回一个空房间号。这时候留在会议界面
          // 只会看到一个没有房间号的空会议室, 不如老老实实退回大厅重进。
          if (this.view === 'room' && !this.room) {
            this.droppedOut('房间状态没了（服务端重启过），重新加入一次');
            return;
          }
        } catch (err) {
          if (err.dead) {
            this.forgetSession();
            this.goAuth();
            return;   // 别再排下一拍了
          }
          // 其它错误 (比如某一拍网络抖了) 下一拍自己会好
        }
        if (this.view === 'room') this.scheduleSync();
      },

      // 被动退出房间 (不是用户点的"离开"): 本地清干净, 回大厅并说明原因
      droppedOut(msg) {
        this.stopTimers();
        this.closeAllCalls();
        this.room = '';
        this.participants = [];
        this.myPid = '';
        this.joinedAt = 0;
        this.sigSince = 0;
        this.lastHandledSeq = 0;
        this.view = 'lobby';
        this.errors = { form: msg };
      },

      // 必须一条一条 await 着处理: offer 的 setRemoteDescription 是异步的,
      // 要是并发跑, 紧跟其后的 ICE candidate 会在"还没有 remote description"时
      // 撞进 addIceCandidate, 直接抛 InvalidStateError。
      async applySignals(r) {
        if (typeof r.seq === 'number') this.sigSince = r.seq;
        const msgs = Array.isArray(r.messages) ? r.messages : [];
        for (const m of msgs) {
          if (typeof m.seq === 'number' && m.seq <= this.lastHandledSeq) continue;  // 防重复
          if (typeof m.seq === 'number') this.lastHandledSeq = m.seq;
          await this.handleSignal(m);
        }
      },

      // ------------------------------------------------------------ 信令
      sendSignal(to, kind, payload) {
        this.authed('POST', '/api/rooms/signal', { to, kind, payload }).catch(() => {
          // 对方可能刚好走了; 下一拍同步会发现他不在名单里, 那条连接会被清掉
        });
      },

      // mesh: 每个对端一条连接。没有摄像头也要放 recvonly 的 transceiver,
      // 否则对方的 offer 会被我们整条拒掉, 结果连画面都收不到。
      ensureCall(pid) {
        const existing = calls.get(pid);
        if (existing) return existing;

        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        // 谁让步由 pid 大小决定, 两边算出来正好相反
        const state = {
          pc,
          polite: this.myPid > pid,
          makingOffer: false,
          ignoreOffer: false,
          stream: null,
          pendingIce: [],  // remote description 还没到就先攒着的 candidate
          disconnectTimer: 0,  // disconnected 后等 4 秒, 还不恢复就 ICE 重启
          iceRestartedAt: 0,   // 上次 ICE 重启时间 (5 秒节流)
          iceRestarts: 0,      // 连续重启次数, 连上清零 (上限 3)
        };
        calls.set(pid, state);
        this.peerState[pid] = pc.connectionState;

        const stream = this.media.stream;
        const tracks = stream ? stream.getTracks() : [];
        if (tracks.length > 0) {
          for (const t of tracks) pc.addTrack(t, stream);
        } else {
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.addTransceiver('video', { direction: 'recvonly' });
        }

        pc.onicecandidate = (ev) => {
          if (ev.candidate) this.sendSignal(pid, 'ice', { candidate: ev.candidate.toJSON() });
        };

        pc.ontrack = (ev) => {
          state.stream = ev.streams[0];
          if (ev.track.kind === 'video') this.peerHasVideo[pid] = true;
          this.attachRemote(pid);
        };

        pc.onconnectionstatechange = () => {
          const cs = pc.connectionState;
          this.peerState[pid] = cs;
          if (cs === 'connected') {
            clearTimeout(state.disconnectTimer);
            clearTimeout(state.stuckTimer);
            state.iceRestarts = 0;
            peerRebuilds.delete(pid);  // 连上了, 看门狗的重建额度重置
            this.scheduleSync(SYNC_IDLE_MS);
            return;
          }
          if (cs === 'failed') {
            clearTimeout(state.disconnectTimer);
            this.restartCallIce(pid, state);  // 直连断了, 立刻试 ICE 重启
            return;
          }
          if (cs === 'disconnected') {
            // 网络切换的中间态: 先等 4 秒, 自己恢复不了再重启
            clearTimeout(state.disconnectTimer);
            state.disconnectTimer = setTimeout(() => {
              if (calls.get(pid) === state && pc.connectionState === 'disconnected') {
                this.restartCallIce(pid, state);
              }
            }, 4000);
          }
        };

        // perfect negotiation (W3C 的标准写法): 两边可能同时发 offer,
        // 由"礼貌"的一方回滚, 冲突就能自己解开。以后加屏幕共享要重新协商时也照样管用。
        pc.onnegotiationneeded = async () => {
          try {
            state.makingOffer = true;
            await pc.setLocalDescription();
            this.sendSignal(pid, 'offer', { description: pc.localDescription });
          } catch (err) {
            console.warn('发起协商失败', err);
          } finally {
            state.makingOffer = false;
          }
        };

        // 协商看门狗: 15 秒还停在 new/connecting, 多半是 offer/answer/candidate 丢在路上了。
        // 直接重建这条连接重新协商; 重建 3 次还不行就停手 (界面上能看到连接状态)。
        state.stuckTimer = setTimeout(() => {
          if (calls.get(pid) !== state) return;
          const cs = pc.connectionState;
          if (cs !== 'new' && cs !== 'connecting') return;
          const n = (peerRebuilds.get(pid) || 0) + 1;
          peerRebuilds.set(pid, n);
          if (n <= 3) {
            this.closeCall(pid);   // 下一拍 syncCalls 会重新建, 重新发 offer
            this.scheduleSync(0);
          }
        }, 15000);

        return state;
      },

      async handleSignal(msg) {
        // 只处理同一份名单里的人: 名单和消息是同一次响应拿到的, 所以对得上
        if (!this.remotes.some((p) => p.id === msg.from)) return;
        const state = this.ensureCall(msg.from);
        const pc = state.pc;
        const payload = msg.payload || {};

        try {
          if (msg.kind === 'ice') {
            if (!payload.candidate) return;
            if (!pc.remoteDescription) {
              // 描述还没到 (消息乱序 / 丢包), 先攒着, 等 setRemoteDescription 之后再补。
              // 直接调 addIceCandidate 会抛 InvalidStateError。
              state.pendingIce.push(payload.candidate);
              return;
            }
            try {
              await pc.addIceCandidate(payload.candidate);
            } catch (err) {
              // 冲突时被我们丢掉的那路 offer, 会跟着来一批对不上的 candidate, 忽略
              if (!state.ignoreOffer) throw err;
            }
            return;
          }

          const description = payload.description;
          if (!description) return;

          const collision = description.type === 'offer' &&
                            (state.makingOffer || pc.signalingState !== 'stable');
          state.ignoreOffer = !state.polite && collision;
          if (state.ignoreOffer) return;

          await pc.setRemoteDescription(description);

          // 把之前攒下的 candidate 补上
          const waiting = state.pendingIce;
          state.pendingIce = [];
          for (const c of waiting) {
            try {
              await pc.addIceCandidate(c);
            } catch (err) {
              if (!state.ignoreOffer) throw err;
            }
          }

          if (description.type === 'offer') {
            await pc.setLocalDescription();
            this.sendSignal(msg.from, 'answer', { description: pc.localDescription });
          }
        } catch (err) {
          console.warn('处理信令出错', msg.kind, err);
        }
      },

      // failed / 长时间 disconnected 时带 ICE restart 重新协商。
      // 节流 5 秒、最多连续 3 次, 避免连环重启; 连上就清零 (见 onconnectionstatechange)。
      restartCallIce(pid, state) {
        if (calls.get(pid) !== state) return;
        if (typeof state.pc.restartIce !== 'function') return;  // 老浏览器没有这个 API
        if (state.iceRestarts >= 3) return;
        const now = Date.now();
        if (now - state.iceRestartedAt < 5000) return;
        state.iceRestartedAt = now;
        state.iceRestarts++;
        try {
          state.pc.restartIce();
        } catch (err) {
          console.warn('ICE 重启失败', err);
        }
      },

      syncCalls() {
        if (!this.myPid) return;
        const alive = new Set();
        for (const p of this.remotes) {
          alive.add(p.id);
          peerMissing.delete(p.id);
          this.ensureCall(p.id);
        }
        for (const pid of [...calls.keys()]) {
          if (alive.has(pid)) continue;
          // 名单里偶尔少一拍很正常 (轮询抖动/后台节流), 连续两拍不在才真拆连接,
          // 不然弱网下会把本来健康的连接误关了。
          const n = (peerMissing.get(pid) || 0) + 1;
          peerMissing.set(pid, n);
          if (n >= 2) this.closeCall(pid);
        }
      },

      closeCall(pid) {
        const state = calls.get(pid);
        if (!state) return;
        clearTimeout(state.disconnectTimer);
        clearTimeout(state.stuckTimer);
        try { state.pc.close(); } catch (err) { /* 忽略 */ }
        calls.delete(pid);
        videoEls.delete(pid);
        peerMissing.delete(pid);
        delete this.peerState[pid];
        delete this.peerHasVideo[pid];
      },

      closeAllCalls() {
        for (const pid of [...calls.keys()]) this.closeCall(pid);
        peerMissing.clear();
        peerRebuilds.clear();
        this.audioBlocked = false;
      },

      async leave() {
        this.stopTimers();
        this.closeAllCalls();
        try { await this.authed('POST', '/api/rooms/leave', {}); } catch (err) { /* 忽略 */ }
        this.room = '';
        this.participants = [];
        this.myPid = '';
        this.joinedAt = 0;
        this.sigSince = 0;
        this.lastHandledSeq = 0;
        this.view = 'lobby';
      },

      copyInvite() {
        navigator.clipboard.writeText(this.inviteLink).then(() => {
          this.copied = true;
          clearTimeout(this.copyTimer);
          this.copyTimer = setTimeout(() => { this.copied = false; }, 1600);
        }).catch(() => {
          // 剪贴板被拒时就别假装复制成功了, 输入框里能手动选
          this.copied = false;
        });
      },

      // ------------------------------------------------------- 摄像头 / 麦克风
      startMedia() {
        this.media.error = '';
        if (this.media.stream) {
          if (this.videoEl) this.videoEl.srcObject = this.media.stream;
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          this.media.error = '这个环境不给用摄像头。用 http://localhost 打开，或者直接进房间。';
          return;
        }
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((stream) => {
          this.applyStream(stream);
        }).catch((err) => {
          this.media.error = err && err.name === 'NotAllowedError'
            ? '你拒绝了摄像头或麦克风权限。在地址栏左边重新允许，然后点重试。'
            : '拿不到摄像头或麦克风，可能被别的程序占用了。可以点重试，或者直接进房间。';
        });
      },

      applyStream(stream) {
        this.media.stream = stream;
        this.media.cam = stream.getVideoTracks().length > 0;
        this.media.mic = stream.getAudioTracks().length > 0;
        if (this.videoEl) this.videoEl.srcObject = stream;

        // 如果授权弹窗比"加入会议"慢 (用户在大厅停留很久), 进房间时还没有轨道,
        // 那时建的是 recvonly 的连接。这里把轨道补上, addTrack 会自动触发重新协商。
        for (const state of calls.values()) {
          for (const t of stream.getTracks()) {
            if (!state.pc.getSenders().some((s) => s.track === t)) state.pc.addTrack(t, stream);
          }
        }
      },

      stopMedia() {
        if (this.media.stream) {
          this.media.stream.getTracks().forEach((t) => t.stop());
          this.media.stream = null;
        }
        if (this.videoEl) this.videoEl.srcObject = null;
        this.media.cam = true;
        this.media.mic = true;
      },

      // 静音只改 track.enabled, 不停 track —— 停了就得重新申请权限, 而且会触发重新协商
      toggleMic() {
        const track = this.media.stream && this.media.stream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        this.media.mic = track.enabled;
      },

      toggleCam() {
        const track = this.media.stream && this.media.stream.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        this.media.cam = track.enabled;
      },
    },
  }).mount('#app');

  // 调试用: 控制台里能直接看每条对端连接的状态和统计。
  // WebRTC 出问题的时候 (听不到声、看不到画面) 没有这个基本没法查:
  //   [...tongpin.calls].map(([pid, c]) => [pid, c.pc.connectionState])
  //   await (await [...tongpin.calls][0][1].pc.getStats()).forEach(r => ...)
  window.tongpin = { calls, videoEls };
})();
