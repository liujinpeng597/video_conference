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
  const STORE_THEME = 'tp_theme';          // localStorage, 外观: auto | light | dark

  // 主题要在挂载之前就定下来: 晚了深色模式会先闪一下白 (脚本在 body 末尾, 这里等于立刻执行)。
  let systemDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  function applyTheme(want) {
    // 只认 light / dark, 其余 (含 auto) 一律跟系统
    const resolved = (want === 'light' || want === 'dark') ? want : (systemDark ? 'dark' : 'light');
    document.documentElement.dataset.theme = resolved;
  }
  applyTheme(localStorage.getItem(STORE_THEME) || 'auto');

  // 弹窗关掉之后把焦点还给打开它的那颗按钮 —— 键盘用户不至于掉到页面开头
  let modalOpener = null;

  const SYNC_IDLE_MS = 2000;   // 都连上了以后, 房间状态多久看一次
  const SYNC_BUSY_MS = 400;    // 还有连接没建好时多久看一次
  const HEALTH_MS = 5000;      // 服务端没响应时的重试间隔
  const SESSION_CHECK_MS = 2000;  // 大厅里多久验一次"这个会话还有效吗" (要和房间轮询一样快, 被顶掉时才像"立刻")

  // -------------------------------------------------------------- 对端连接表
  // 故意放在组件外面, 而且不是响应式的: RTCPeerConnection / MediaStream
  // 这类对象塞进 Vue 的响应式代理里会出各种怪问题 (内部槽位被代理掉)。
  // 界面要用的状态另外用 peerState / peerHasVideo 两个普通对象同步过去。
  const calls = new Map();     // pid -> { pc, polite, makingOffer, ignoreOffer, stream }
  const videoEls = new Map();  // pid -> <video>
  const peerMissing = new Map();   // pid -> 连续几拍不在名单里 (连续两拍才拆连接)
  const peerRebuilds = new Map();  // pid -> 看门狗已重建次数 (连上清零, 上限 3 次)
  let reactionSeq = 0;             // 表情浮动体的自增 key
  const statsPrev = new Map();     // pid -> 上一次 getStats 的累计值 (算码率/丢包率要用增量)
  // 声音: 一个 AudioContext + 每个人的 analyser (说话高亮 / 试麦电平条都用它)
  let audioCtx = null;
  const analysers = new Map();     // pid(或 'me') -> { src, an }
  let levelTimer = 0;
  let prevPids = new Set();        // 上一拍的成员, 用来"有人进/出"提示音
  let prevHands = new Map();       // pid -> 上一拍有没有举手
  // 自己的预览: 首页右侧一个, "创建会议"弹窗里还有一个, 可能同时在 (不能用单个 ref)
  const previewEls = [];
  // 屏幕共享和防锁屏的真实对象同理: MediaStream / WakeLockSentinel 都不能进响应式
  let shareStream = null;          // 正在共享的 getDisplayMedia 流
  // 虚拟背景(简易人像模式)的处理链路: 摄像头 -> 隐藏 video -> canvas -> captureStream
  let bgStream = null;             // canvas.captureStream() 出来的流 (出向视频轨换它)
  let bgCanvas = null;
  let bgVideo = null;
  let bgRAF = 0;
  let wakeLock = null;             // 屏幕常亮锁 (手机端尽量别锁屏)

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
        pw: { old: '', next: '', confirm: '', error: '', done: false },
        displayName: '',    // 昵称 (房间列表里显示这个)
        avatarSrc: '',      // 头像 (data URL)
        nickInput: '',      // 昵称输入框
        nickSaved: false,
        profErr: '',
        profSection: '',    // 个人中心: '' = 分组列表, 否则是打开的某一组 (二级页)
        history: [],        // 会议历史 (room_visits 表): [{ room, joined, left, seconds }]
        showAllHistory: false,
        joinOpen: false,    // "加入会议"弹窗: 房间号输入框只在弹窗里出现
        joinPass: '',       // 加入加密会议时填的密码
        needsPass: false,   // 服务端说这个会议要密码 (428) 时掀开密码输入框
        createOpen: false,  // "创建会议"弹窗: 本地预览 + 要不要设会议密码
        createPass: false,  // 勾了才建加密房间
        createPassInput: '',
        roomEncrypted: false,   // 当前这个会议是加密的 (顶栏显示一枚"已加密"标签)
        todayDay: '',
        todayWeek: '',

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

        // 通话质量 (每 2 秒从 getStats 采样一次): pid -> { inKbps, outKbps, lossPct, jitterMs, rttMs, q }
        peerStats: {},
        avFail: {},         // pid -> 1 (头像加载失败, 退回显示首字母)
        membersOpen: false, // 成员面板
        speaking: {},       // pid -> true (正在说话, 只写变化, 免得每 150ms 重渲染)
        micLevel: 0,        // 本地麦克风电平 (试麦条)
        devices: { mic: [], cam: [] },
        devSel: { mic: '', cam: '' },
        soundOn: true,      // 进/出、举手的提示音
        theme: localStorage.getItem(STORE_THEME) || 'auto',   // 外观: auto | light | dark
        leaveArmed: false,  // "离开会议"点第一下只是待确认
        endArmed: false,    // "结束会议" (主持人) 同理
        renaming: false,
        renameInput: '',
        // 聊天: 服务端只留最近 50 条, 客户端内存里最多留 200 条
        chatOpen: false,
        chatMessages: [],   // [{ id, from, name, text }]
        chatInput: '',
        chatSince: 0,       // 已经收到的最大消息 id (游标)
        chatUnread: 0,
        chatSending: false,
        chatError: '',

        // 举手 / 表情: 举手状态在 participants[].hand (服务端权威); 表情是本地浮动的瞬时效果
        emojiOpen: false,
        reactions: [],   // [{ key, emoji }] 2.5 秒后自动移除
        reactionChoices: ['👍', '👏', '🎉', '😂', '❤️', '✋'],

        // 主持人: host 是主持人的 pid (来自服务端); notice 是房间里的临时提示条
        host: '',
        locked: false,      // 会议锁定 (主持人可切; 锁上后新人进不来)
        notice: '',
        noticeTimer: 0,

        media: { stream: null, cam: true, mic: true, error: '', recovering: false },
        sharing: false,             // 屏幕共享进行中 (真正的流在模块级, 不进响应式)
        bgMode: 'off',              // 虚拟背景(简易人像): 'off' | 'blur' | 'solid'
        focusPid: '',               // 点某格放大 (演示者视图); 空 = 宫格
        copied: false,
        syncTimer: 0,
        clockTimer: 0,
        healthTimer: 0,
        sessTimer: 0,
        statsTimer: 0,
        leaveTimer: 0,
        endTimer: 0,
        copyTimer: 0,
      };
    },

    computed: {
      remotes() { return this.participants.filter((p) => !p.me); },
      // 给 CSS 用: 决定网格是单人铺满还是多列
      tiles() { return String(this.remotes.length + 1); },
      micOn() { return this.media.mic; },
      camOn() { return this.media.cam; },
      // 我有没有举手: 以服务端返回的成员表为准 (自己那一项的 hand 字段)
      myHand() {
        const me = this.participants.find((p) => p.me);
        return !!(me && me.hand);
      },
      // 我是不是主持人 (host 是服务端下发的 pid)
      amHost() { return !!this.myPid && this.host === this.myPid; },
      // 顶栏 / 房间名字显示的名字: 昵称优先, 没设昵称就用登录名
      whoName() { return this.displayName || this.user; },
      // 房间里"我"这一格显示的名字 (服务端成员表里就是昵称)
      myName() {
        const me = this.participants.find((p) => p.me);
        return (me && me.name) || this.whoName;
      },
      // 最近会议默认只露 3 条, 点"全部会议"展开
      shownHistory() { return this.showAllHistory ? this.history : this.history.slice(0, 3); },
      // 成员面板: 举手的排前面 (举手就是为了被看见)。sort 是稳定的, 同组里顺序不变。
      participantsSorted() {
        return [...this.participants].sort((a, b) => (b.hand ? 1 : 0) - (a.hand ? 1 : 0));
      },
      // 个人中心的二级页标题 / 列表里显示的当前主题名
      profSectionName() {
        return { me: '个人资料', security: '账号安全', display: '界面与显示',
                 media: '媒体设备', notice: '通知与提示音' }[this.profSection] || '';
      },
      themeName() {
        return { auto: '跟随系统', light: '浅色', dark: '深色' }[this.theme] || '跟随系统';
      },
      // 有对端的连接被判定成"差"就给一条横幅: 这种时候人往往先怀疑"是不是坏了"
      netPoor() {
        return this.remotes.some((p) => {
          const s = this.peerStats[p.id];
          return s && s.q === 'poor';
        });
      },
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

      // 会议里的键盘快捷键: m 静音 / v 关摄像头 / f 全屏。输入框里打字时不抢键。
      window.addEventListener('keydown', (e) => {
        if (this.joinOpen || this.createOpen) {          // 弹窗开着: 只认 Esc
          if (e.key === 'Escape') { e.preventDefault(); this.closeJoin(); this.closeCreate(); }
          return;
        }
        if (this.view !== 'room') return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === 'm') { e.preventDefault(); this.toggleMic(); }
        else if (k === 'v') { e.preventDefault(); this.toggleCam(); }
        else if (k === 'f') { e.preventDefault(); this.toggleFullscreen(); }
        else if (e.key === 'Escape') { this.focusPid = ''; }
      });

      // 页面从后台切回前台时立刻补一拍心跳: 后台标签页的定时器会被浏览器节流,
      // 可能超过服务端 30 秒的心跳阈值, 别人会误判你掉线。
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.view === 'room') {
          this.scheduleSync(0);
          this.acquireWakeLock();  // Wake Lock 在页面隐藏时会被系统释放, 回前台重新申请
        }
      });

      // 外接摄像头 / 麦克风插拔 (路线图 P1 前端兼容性): 拔掉自动换轨, 插回来自动恢复,
      // 不用刷新页面 (见 recoverMedia)。iOS 上 devicechange 基本不触发, 不影响原有行为。
      if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', () => { this.recoverMedia(); });
      }

      // 选"跟随系统"时, 系统切深浅色要跟着切 (applyTheme 在脚本开头已经跑过一次了)
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
          systemDark = e.matches;
          if (this.theme === 'auto') applyTheme('auto');
        });
      }
    },

    beforeUnmount() {
      this.stopTimers();
      this.stopShare();
      this.releaseWakeLock();
      this.closeAllCalls();
      this.stopMedia();
    },

    methods: {
      // ------------------------------------------------------------ 小工具
      initial(name) {
        const s = (name || '').trim();
        return s ? s.slice(0, 1) : '?';
      },

      // 外观: 存下来 + 立刻应用到 <html> 上 (真正的配色在 app.css 的 data-theme 块里)
      setTheme(v) {
        this.theme = (v === 'light' || v === 'dark') ? v : 'auto';
        try { localStorage.setItem(STORE_THEME, this.theme); } catch (err) { /* 隐私模式下写不进去, 不影响这次生效 */ }
        applyTheme(this.theme);
      },

      // 自己的预览。视频元素会因为切视图 / 弹窗开合被换掉, 所以用函数 ref, 并且记一个集合
      // (首页和"创建会议"弹窗里各有一个, 可能同时在)。
      bindVideo(el) {
        if (!el) return;
        for (let i = previewEls.length - 1; i >= 0; --i) {
          if (!previewEls[i].isConnected) previewEls.splice(i, 1);   // 换掉的元素顺手清出集合
        }
        if (!previewEls.includes(el)) previewEls.push(el);
        // 只在"真的换了流"时才赋值: srcObject 一赋值就会触发 <video> 的加载算法
        // (emptied -> loadstart -> loadeddata), 画面会黑一下再回来。这个函数 ref 在每次
        // 重渲染时都会被调用 (计时器每秒一次 + 每拍轮询), 不加这个判断就是每秒闪一下。
        const want = this.localSource();
        if (el.srcObject !== want) el.srcObject = want;
      },

      // 本地预览该显示哪一路: 共享屏幕 > 虚拟背景 > 摄像头
      localSource() {
        if (this.sharing && shareStream) return shareStream;
        if (this.bgMode !== 'off' && bgStream) return bgStream;
        return this.media.stream;
      },
      syncPreview() {
        const want = this.localSource();
        for (const el of previewEls) if (el.srcObject !== want) el.srcObject = want;
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
        // 这个函数由内联 ref 在每次重渲染时调用, 别每次都对已在播的元素 play()
        // (空转的 promise 没意义, 还会把 audioBlocked 误判出来)
        if (el.paused) {
          const p = el.play();
          if (p && p.catch) {
            // 浏览器不给自动播放带声音的流 (还没发生过用户交互), 让用户点一下
            p.catch(() => { this.audioBlocked = true; });
          }
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
      goHome() {
        this.view = 'home';
        const d = new Date();
        const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
        this.todayDay = (d.getMonth() + 1) + '月' + d.getDate() + '日';
        this.todayWeek = wk;
        this.startMedia();
        // 大厅不发别的请求, 所以定时确认会话还有效: 被别处登录挤下线的那台会自己回登录页,
        // 而不是一直"看起来还登着", 直到点了什么才发现。
        this.checkSession();
        this.loadHistory();   // 大厅里顺便把"最近会议"拉一份
        this.loadMe();        // 昵称 / 头像
        this.loadDevices();   // 设备下拉
        // 邀请链接进来时弹窗已经开着 (见 prefillFromHash): 把光标放进房间号, 回车就进
        if (this.joinOpen) this.$nextTick(() => { const el = this.$refs.roomInput; if (el) el.focus(); });
      },

      // "加入会议"那个大按钮: 弹出加入会议弹窗, 焦点落到房间号输入框
      focusJoin() {
        this.errors = {};
        this.needsPass = false;   // 重新走一遍, 上回"要密码"的状态不留着
        modalOpener = document.activeElement;
        this.joinOpen = true;
        this.$nextTick(() => { const el = this.$refs.roomInput; if (el) el.focus(); });
      },
      closeJoin() {
        this.joinOpen = false;
        this.restoreFocus();
      },
      // "创建会议"那个大按钮: 弹出创建弹窗 (本地预览 + 可选会议密码)
      openCreate() {
        this.errors = {};
        modalOpener = document.activeElement;
        this.createOpen = true;
      },
      closeCreate() {
        this.createOpen = false;
        this.restoreFocus();
      },
      // 关弹窗之后把焦点还给打开它的人 (不是弹窗里最后点的那个控件)
      restoreFocus() {
        if (modalOpener && modalOpener.isConnected && modalOpener.focus) modalOpener.focus();
        modalOpener = null;
      },
      // 最近会议里的"进入": 填上房间号直接进
      rejoin(code) {
        this.roomInput = code;
        this.joinRoom();
      },

      // 个人中心: 进这一屏就把摄像头关掉 (不用一直亮着), 回会议页会自动重开
      goProfile() {
        this.view = 'profile';
        this.profSection = '';   // 每次进来都回到分组列表, 不要停在上次那一页
        this.nickInput = this.displayName || '';
        this.nickSaved = false;
        this.profErr = '';
        this.stopMedia();
        this.checkSession();
        this.loadMe();
        this.loadDevices();   // "媒体设备"那页要设备清单 (首页进来时已经有了, 这里是兜底)
      },
      // 个人中心: 分组列表 -> 某一组 (就是二级页, 不上路由, 一个变量够了)
      openProfSection(id) {
        this.profErr = '';
        if (id === 'me') this.nickInput = this.displayName || '';
        this.profSection = id;
        // 键盘用户: 打开二级页把焦点送到"返回"上, 不然焦点还留在已经消失的那一行上
        this.$nextTick(() => { const el = this.$refs.profBack; if (el) el.focus(); });
      },
      closeProfSection() {
        this.profSection = '';
      },

      async loadMe() {
        try {
          const r = await this.authed('GET', '/api/me');
          this.user = r.user || this.user;
          this.displayName = r.display_name || '';
          this.avatarSrc = r.avatar || '';
        } catch (err) {
          if (err.dead) this.sessionDead();
        }
      },

      async saveNickname() {
        this.profErr = '';
        this.busy = true;
        try {
          await this.authed('POST', '/api/profile', { display_name: this.nickInput });
          this.displayName = this.nickInput;
          this.nickSaved = true;
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.profErr = err.message || '保存昵称失败';
        } finally {
          this.busy = false;
        }
      },

      // 换头像: <input type=file> 选图 -> canvas 压成 128x128 -> data URL -> 发给后端
      async pickAvatar(ev) {
        const file = ev.target.files && ev.target.files[0];
        ev.target.value = '';
        if (!file) return;
        this.profErr = '';
        this.busy = true;
        try {
          const data = await this.shrinkImage(file);
          await this.authed('POST', '/api/avatar', { data });
          this.avatarSrc = data;
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.profErr = err.message || '换头像失败';
        } finally {
          this.busy = false;
        }
      },

      async removeAvatar() {
        this.profErr = '';
        this.busy = true;
        try {
          await this.authed('POST', '/api/avatar', { data: '' });
          this.avatarSrc = '';
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.profErr = err.message || '移除头像失败';
        } finally {
          this.busy = false;
        }
      },

      // 按 cover 把选中的图压到 128x128 的 jpeg data URL (用 canvas, 不引任何库)
      shrinkImage(file) {
        return new Promise((resolve, reject) => {
          const url = URL.createObjectURL(file);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(url);
            const size = 128;
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const g = c.getContext('2d');
            const scale = Math.max(size / img.width, size / img.height);
            const w = img.width * scale;
            const h = img.height * scale;
            g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
            resolve(c.toDataURL('image/jpeg', 0.85));
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('这张图读不了'));
          };
          img.src = url;
        });
      },

      async loadHistory() {
        try {
          const r = await this.authed('GET', '/api/history?limit=10');
          this.history = Array.isArray(r.visits) ? r.visits : [];
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.history = [];   // 读不到就当没有, 不打扰
        }
      },
      // 房间里别人的头像: 走 /api/avatar (只能取同房间的人, 不泄露登录名); 加载失败就退回首字母
      avatarUrl(p) {
        return '/api/avatar?room=' + encodeURIComponent(this.room) +
               '&pid=' + encodeURIComponent(p.id) + '&v=' + (p.av || 0);
      },
      avOk(p) { return (p.av || 0) > 0 && !this.avFail[p.id]; },
      avFail(pid) { this.avFail[pid] = 1; },

      histDur(v) {
        const s = Math.max(0, Math.floor(v.seconds || 0));
        const pad = (n) => String(n).padStart(2, '0');
        const t = s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
                            : `${Math.floor(s / 60)}:${pad(s % 60)}`;
        return (v.left ? '时长 ' : '进行中 · ') + t;
      },
      histWhen(v) {
        const d = new Date((v.joined || 0) * 1000);
        const mins = Math.floor((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return '刚刚';
        if (mins < 60) return mins + ' 分钟前';
        if (mins < 1440) return Math.floor(mins / 60) + ' 小时前';
        return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
      },

      checkSession() {
        clearTimeout(this.sessTimer);
        if (this.view !== 'home') return;
        this.authed('GET', '/api/me').then(() => {
          this.sessTimer = setTimeout(this.checkSession, SESSION_CHECK_MS);
        }).catch((err) => {
          if (err.dead) {
            this.sessionDead();
            return;
          }
          this.sessTimer = setTimeout(this.checkSession, SESSION_CHECK_MS);  // 网络抖了, 下一拍再试
        });
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

      // 服务端不认这个会话了 (被另一台设备挤下线 / 过期 / 退出): 本地清干净回登录页, 并说明原因。
      // 一次登录只留一个会话 —— 换设备登录会把这边顶掉, 所以文案点一下"可能别处登录了"。
      sessionDead(msg) {
        this.forgetSession();
        this.goAuth();
        this.errors = { form: msg || '登录状态已失效（可能在另一台设备登录了，或已过期），重新登录一下' };
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
            this.goHome();
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
          this.goHome();
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

      // 改密码: 成功以后服务端会把其它令牌都吊销 (只留当前会话), 别处得重新登录
      async changePassword() {
        this.pw.error = '';
        this.pw.done = false;
        if (!this.pw.old || !this.pw.next) {
          this.pw.error = '原密码和新密码都要填';
          return;
        }
        if (this.pw.next !== this.pw.confirm) {
          this.pw.error = '两次输入的新密码不一样';
          return;
        }
        this.busy = true;
        try {
          await this.authed('POST', '/api/password',
                            { old_password: this.pw.old, new_password: this.pw.next });
          this.pw = { old: '', next: '', confirm: '', error: '', done: true };
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.pw.error = err.message || '修改失败';
        } finally {
          this.busy = false;
        }
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
          this.goHome();
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
        if (m) {
          this.roomInput = m[1].toLowerCase();
          // 邀请链接进来的: 直接把"加入会议"弹窗打开, 房间号已经填好了, 回车就进
          this.joinOpen = true;
        }
      },

      // 加入别人的会议 (必须填房间号; 加密会议还要密码)
      async joinRoom() {
        const code = this.roomInput.trim();
        if (!code) {
          this.errors = { form: '要加入别人的会议请先填房间号；想开新会议就点下面的「创建会议」。' };
          return;
        }
        await this.enterRoom(code, this.joinPass);
      },

      // 创建新会议: 不带房间号, 服务端分配一个。勾了"设置会议密码"就是加密房间
      async createRoom() {
        const pass = this.createPass ? this.createPassInput.trim() : '';
        if (pass && pass.length < 4) {
          this.errors = { form: '会议密码至少 4 位' };
          return;
        }
        await this.enterRoom('', pass);
      },

      async enterRoom(code, pass) {
        this.errors = {};
        this.actx();   // 趁着这次点击把手势用在解锁音频上下文上 (提示音要用)
        this.busy = true;
        try {
          const r = await this.authed('POST', '/api/rooms/enter', { room: code, pass: pass || '' });
          // 提示音基线要在 applyRoom 之前清: 不然它会拿"上一个房间的人"当基线 (进门就响一声)
          prevPids.clear();
          prevHands.clear();
          this.applyRoom(r);
          await this.loadIce();
          this.joinedAt = Date.now();
          this.nowTick = Date.now();
          this.sigSince = 0;      // 进房间就从头开始收信令
          this.lastHandledSeq = 0;
          this.resetChat();
          this.avFail = {};       // 头像加载失败的记录, 换房间要清
          this.membersOpen = false;
          this.focusPid = '';
          this.startLevelTimer();
          this.view = 'room';
          this.joinOpen = false;   // 进房之后弹窗收掉
          this.createOpen = false;
          this.joinPass = '';
          this.needsPass = false;
          this.roomEncrypted = !!pass;   // 带密码进来的就是加密会议 (普通房间不显示这枚标签)
          this.createPass = false;       // 下次创建从"不加密"重新开始
          this.createPassInput = '';
          this.acquireWakeLock();  // 手机端尽量别锁屏 (锁屏后 JS 被挂起, 会被判掉线)
          this.roomInput = '';
          this.scheduleSync(0);
          this.clockTimer = setInterval(() => { this.nowTick = Date.now(); }, 1000);
          this.statsTimer = setInterval(this.sampleStats, 2000);   // 通话质量采样
          this.syncCalls();
          this.publishMic();   // 把"我现在是开麦还是静音"报给服务端, 名单里才准
        } catch (err) {
          if (err.dead) {
            this.sessionDead('登录状态已失效，重新登录一下');
          } else if (err.status === 428) {
            // 加密会议: 这不是"错误", 是把密码输入框掀开让用户接着填
            this.needsPass = true;
            this.joinOpen = true;   // 从"最近会议"直接点进来的, 也得能看到这个输入框
            this.$nextTick(() => { const el = this.$refs.passInput; if (el) el.focus(); });
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
        if (typeof r.host === 'string') this.host = r.host;
        if (typeof r.locked === 'boolean') this.locked = r.locked;
        if (Array.isArray(r.participants)) {
          this.participants = r.participants;
          const me = r.participants.find((p) => p.me);
          if (me) this.myPid = me.id;
          this.noteArrivals(r.participants);   // 有人进/出/举手 -> 提示音
        }
      },

      // --------------------------------------------------------------- 聊天
      // 聊天复用同一条轮询 (/api/rooms/state 里带 chat 游标), 不额外发请求;
      // 消息文本在模板里用 {{ }} 渲染 (Vue 自动转义), 不做任何 innerHTML。
      // 顺带清房间作用域的瞬时 UI (表情浮动体)。
      resetChat() {
        this.chatMessages = [];
        this.chatSince = 0;
        this.chatUnread = 0;
        this.chatInput = '';
        this.chatSending = false;
        this.chatError = '';
        this.reactions = [];
        this.emojiOpen = false;
        this.notice = '';
      },

      toggleChat() {
        this.chatOpen = !this.chatOpen;
        if (this.chatOpen) {
          this.membersOpen = false;   // 两个抽屉都靠右, 只留一个
          this.chatUnread = 0;
          this.chatError = '';
          this.scrollChat();
        }
      },

      // 把这一拍带回的消息并进来。自己刚发的那条已经先落进列表了, 按 id 去重。
      // 游标只前进到服务端确认的 chatSeq, 不回退 —— 否则会漏掉别人在这前后的消息。
      applyChat(r) {
        if (typeof r.chatSeq === 'number' && r.chatSeq > this.chatSince) this.chatSince = r.chatSeq;
        const msgs = Array.isArray(r.chat) ? r.chat : [];
        if (msgs.length === 0) return;
        let added = 0;
        for (const m of msgs) {
          if (this.chatMessages.some((x) => x.id === m.id)) continue;
          this.chatMessages.push({ id: m.id, from: m.from, name: m.name, text: m.text });
          added++;
        }
        if (this.chatMessages.length > 200) {
          this.chatMessages.splice(0, this.chatMessages.length - 200);
        }
        if (!this.chatOpen) this.chatUnread += added;
        else if (added > 0) this.scrollChat();
      },

      scrollChat() {
        this.$nextTick(() => {
          const el = this.$refs.chatList;
          if (el) el.scrollTop = el.scrollHeight;
        });
      },

      async sendChat() {
        const text = this.chatInput.trim();
        if (!text || this.chatSending) return;
        this.chatSending = true;
        this.chatError = '';
        try {
          const r = await this.authed('POST', '/api/rooms/chat', { text });
          if (r && typeof r.id === 'number' && !this.chatMessages.some((x) => x.id === r.id)) {
            this.chatMessages.push({ id: r.id, from: r.from, name: r.name, text: r.text });
          }
          this.chatInput = '';
          this.scrollChat();
        } catch (err) {
          if (err.dead) {
            this.sessionDead();
            return;
          }
          this.chatError = err.message || '消息没发出去';
        } finally {
          this.chatSending = false;
        }
      },

      // --------------------------------------------------------- 举手 / 表情
      // 举手状态由服务端 (participants[].hand) 权威; 切完立刻补一拍, UI 马上就变。
      // 出错不弹提示: 下一拍同步会以服务端状态为准, 自然纠正。
      async toggleHand() {
        try {
          await this.authed('POST', '/api/rooms/hand', { raised: !this.myHand });
          this.scheduleSync(0);
        } catch (err) {
          if (err.dead) { this.sessionDead(); }
        }
      },

      // 表情反应: 走信令广播 (kind='reaction')。它是瞬时效果, 不进房间状态, 所以不用后端存储。
      sendReaction(emoji) {
        if (!this.reactionChoices.includes(emoji)) return;
        this.emojiOpen = false;
        this.floatReaction(this.myPid, emoji);  // 自己本地也浮一下
        for (const p of this.remotes) this.sendSignal(p.id, 'reaction', { emoji });
      },
      floatReaction(from, emoji) {
        if (!this.reactionChoices.includes(emoji)) return;  // 只认白名单里的表情
        const key = ++reactionSeq;
        this.reactions.push({ key, from, emoji });
        setTimeout(() => {
          this.reactions = this.reactions.filter((r) => r.key !== key);
        }, 2500);
      },

      // ------------------------------------------------------------- 主持人
      // 主持人 = 建房的人 (服务端从房间状态里下发 host pid)。这里只做两件事:
      // 全体静音 (广播一条信令, 各自把自己静音) 和 移出成员 (走服务端, 只有主持人有权)。
      flash(msg) {
        this.notice = msg;
        clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => { this.notice = ''; }, 4000);
      },
      muteAll() {
        for (const p of this.remotes) this.sendSignal(p.id, 'mute-all', {});
        this.applyMuteAll('主持人把所有人静音了');  // 自己也算一个
      },
      applyMuteAll(msg) {
        const track = this.media.stream && this.media.stream.getAudioTracks()[0];
        if (track) track.enabled = false;
        this.media.mic = false;
        this.publishMic();   // 自己被一键静音也要让名单体现出来
        this.flash(msg || '主持人让你静音了');
      },
      // 会议锁定: 锁上以后新人进不来 (已经在里面的不受影响)
      async toggleLock() {
        try {
          const r = await this.authed('POST', '/api/rooms/lock', { locked: !this.locked });
          const now = (r && typeof r.locked === 'boolean') ? r.locked : !this.locked;
          this.locked = now;
          this.flash(now ? '会议已锁定，新人进不来' : '已解锁，可以进来了');
          this.scheduleSync(0);
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.flash(err.message || '操作失败');
        }
      },
      async kickMember(pid) {
        try {
          await this.authed('POST', '/api/rooms/kick', { pid });
          this.flash('已把该成员移出会议');
          this.scheduleSync(0);
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.flash(err.message || '移出失败');
        }
      },

      // ------------------------------------------------------------- 视图
      // 点某一格放大 (演示者视图), 再点一次回宫格; Esc 也能退出放大。
      toggleFocus(pid) {
        this.focusPid = this.focusPid === pid ? '' : pid;
      },
      toggleFullscreen() {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
      },

      // --------------------------------------------------------- 声音 / 电平
      // 一个 AudioContext 反复用; 每个人 (含自己) 挂一个 analyser 算音量。
      actx() {
        if (!audioCtx) {
          const C = window.AudioContext || window.webkitAudioContext;
          if (!C) return null;
          audioCtx = new C();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        return audioCtx;
      },
      attachAnalyser(key, stream) {
        if (!stream || stream.getAudioTracks().length === 0) return;
        const cur = analysers.get(key);
        if (cur && cur.stream === stream) return;          // 已经是这条流了
        if (cur) {                                          // 换了设备 / 重新协商换了流: 换掉旧的
          try { cur.src.disconnect(); } catch (err) { /* 已经断了 */ }
          analysers.delete(key);
        }
        const ctx = this.actx();
        if (!ctx) return;
        try {
          const src = ctx.createMediaStreamSource(stream);
          const an = ctx.createAnalyser();
          an.fftSize = 512;
          src.connect(an);   // 只分析, 不接 destination: 否则会把声音再放一遍
          analysers.set(key, { src, an, stream, buf: new Uint8Array(an.fftSize) });
        } catch (err) { /* 流没有音轨 / 已结束, 忽略 */ }
      },
      detachAnalysers() {
        for (const a of analysers.values()) { try { a.src.disconnect(); } catch (err) {} }
        analysers.clear();
      },
      startLevelTimer() {
        if (levelTimer) return;
        levelTimer = setInterval(this.sampleLevels, 150);
      },
      stopLevelTimer() {
        if (levelTimer) { clearInterval(levelTimer); levelTimer = 0; }
        this.speaking = {};
        this.micLevel = 0;
      },
      // 说话高亮只写"变没变": 每 150ms 都写响应式的话整屏会跟着重渲染
      sampleLevels() {
        for (const [key, a] of analysers) {
          a.an.getByteTimeDomainData(a.buf);
          let sum = 0;
          for (let i = 0; i < a.buf.length; i++) {
            const v = (a.buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / a.buf.length);
          const sp = rms > 0.02;
          if (key === 'me') {
            const lv = Math.round(Math.min(1, rms * 10) * 12) / 12;   // 量化成 12 档
            if (lv !== this.micLevel) this.micLevel = lv;
            if (this.myPid && sp !== !!this.speaking[this.myPid]) this.speaking[this.myPid] = sp;
          } else if (sp !== !!this.speaking[key]) {
            this.speaking[key] = sp;
          }
        }
      },

      // 提示音: 用振荡器现场合成两声短音, 不引音频文件
      beep(up) {
        if (!this.soundOn) return;
        const ctx = this.actx();
        if (!ctx) return;
        const play = () => {
          const t0 = ctx.currentTime;
          const notes = up ? [[0, 660], [0.12, 880]] : [[0, 560], [0.12, 420]];
          for (const [dt, f] of notes) {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, t0 + dt);
            g.gain.exponentialRampToValueAtTime(0.1, t0 + dt + 0.02);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.12);
            o.connect(g).connect(ctx.destination);
            o.start(t0 + dt);
            o.stop(t0 + dt + 0.15);
          }
        };
        // 上下文没被手势解锁时 currentTime 是冻着的: 排下去的点在恢复之后已经过期, 等于没响。
        // 所以先 resume 再把音排上。
        if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {});
        else play();
      },
      // 有人进 / 有人走 / 有人举手 -> 提示音 (第一拍只记基线, 不然一进房就响一串)
      noteArrivals(members) {
        const now = new Set(members.map((m) => m.id));
        const hands = new Map(members.map((m) => [m.id, !!m.hand]));
        if (prevPids.size > 0) {
          for (const id of now) if (!prevPids.has(id) && id !== this.myPid) { this.beep(true); break; }
          for (const id of prevPids) if (!now.has(id)) { this.beep(false); break; }
          for (const [id, h] of hands) {
            if (id !== this.myPid && h && !prevHands.get(id)) { this.beep(true); break; }
          }
        }
        prevPids = now;
        prevHands = hands;
      },

      // ------------------------------------------------------------- 设备
      async loadDevices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
          const list = await navigator.mediaDevices.enumerateDevices();
          this.devices.mic = list.filter((d) => d.kind === 'audioinput');
          this.devices.cam = list.filter((d) => d.kind === 'videoinput');
          const st = this.media.stream;
          const vt = st && st.getVideoTracks()[0];
          const at = st && st.getAudioTracks()[0];
          this.devSel.cam = (vt && vt.getSettings().deviceId) || localStorage.getItem('tp_dev_cam') || '';
          this.devSel.mic = (at && at.getSettings().deviceId) || localStorage.getItem('tp_dev_mic') || '';
        } catch (err) { /* 没授权时列表可能是空的, 用系统默认设备就行 */ }
      },
      async switchDevice(kind, id) {
        if (kind === 'mic') { this.devSel.mic = id; localStorage.setItem('tp_dev_mic', id); }
        else { this.devSel.cam = id; localStorage.setItem('tp_dev_cam', id); }
        if (!this.media.stream) return;
        const want = {
          audio: this.devSel.mic ? { deviceId: { exact: this.devSel.mic } } : true,
          video: this.devSel.cam ? { deviceId: { exact: this.devSel.cam } } : true,
        };
        const old = this.media.stream;
        try {
          const s = await navigator.mediaDevices.getUserMedia(want);
          // 先把新轨换到每条连接上, 再停旧轨 (反了对端会黑一下)
          for (const state of calls.values()) {
            for (const t of s.getTracks()) {
              const sender = state.pc.getSenders().find((x) => x.track && x.track.kind === t.kind);
              if (sender) await sender.replaceTrack(t).catch(() => {});
            }
          }
          old.getTracks().forEach((t) => t.stop());
          this.applyStream(s);
        } catch (err) {
          this.media.error = '换设备失败：' + (err.message || err);
        }
      },

      // --------------------------------------------------- 成员面板 / 布局
      toggleMembers() {
        this.membersOpen = !this.membersOpen;
        if (this.membersOpen) this.chatOpen = false;   // 两个抽屉都靠右, 只留一个
      },
      // 让某个人把自己静音 (和他自己按静音一样, 服务端不下发强制指令)
      muteOne(pid) {
        this.sendSignal(pid, 'mute-all', { one: true });   // one: 只是"请你自己静音", 不是全体
        this.flash('已请对方静音');
      },
      // 请某个人开麦 (和"请静音"对称: 服务端不下发强制指令, 是对方自己那边打开)
      askUnmute(pid) {
        this.sendSignal(pid, 'mute-all', { one: true, on: true });
        this.flash('已请对方开麦');
      },
      applyMicAsk(one) {
        const track = this.media.stream && this.media.stream.getAudioTracks()[0];
        if (track) track.enabled = true;
        this.media.mic = true;
        this.publishMic();   // 名单里也要变回"没静音"
        this.flash(one ? '主持人请你开麦' : '主持人让大家开麦');
      },
      // 复制房间号 (顶栏那串数字点一下就行)
      copyRoom() {
        const text = this.room;
        const done = () => this.flash('房间号已复制：' + text);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(() => this.flash('复制失败，手动记一下吧'));
        } else {
          this.flash('房间号：' + text);
        }
      },
      // 聊天里 @全体: 只是往输入框里放个前缀 (服务端不理解 @, 就是个约定)
      atAll() {
        if (!/^@全体/.test(this.chatInput)) this.chatInput = '@全体 ' + this.chatInput;
      },
      // 把 "@全体" 切出来单独加粗。分段渲染, 不用 v-html —— 聊天内容是最脏的用户输入。
      chatParts(text) {
        const s = String(text || '');
        const out = [];
        let i = 0;
        while (i < s.length) {
          const j = s.indexOf('@全体', i);
          if (j < 0) { out.push({ t: s.slice(i) }); break; }
          if (j > i) out.push({ t: s.slice(i, j) });
          out.push({ t: '@全体', at: true });
          i = j + 3;
        }
        return out.length ? out : [{ t: '' }];
      },
      // 布局: 宫格 -> 我最大 -> 主持人最大 -> 宫格 (点某一格放大也是同一套 focusPid)
      cycleLayout() {
        // 自己就是主持人时"我"和"主持人"是同一个人, 去重; 没有主持人也少一档
        const modes = [...new Set(['', this.myPid, this.host || ''])];
        const i = modes.indexOf(this.focusPid);
        this.focusPid = modes[(i + 1) % modes.length];
        this.flash('布局：' + this.layoutName() + (this.focusPid ? ' 的画面放大' : '（宫格）'));
      },
      layoutName() {
        if (!this.focusPid) return '布局';
        if (this.focusPid === this.myPid) return '我';
        if (this.focusPid === this.host) return '主持人';
        return '放大';
      },
      leaveClick() {
        if (this.leaveArmed) { this.leave(); return; }
        this.leaveArmed = true;
        clearTimeout(this.leaveTimer);
        clearTimeout(this.endTimer);
        this.leaveTimer = setTimeout(() => { this.leaveArmed = false; }, 3000);
      },
      // "结束会议" (只有主持人有这颗按钮): 和离开会议一样, 点第一下只是待确认
      endClick() {
        if (this.endArmed) { this.endMeeting(); return; }
        this.endArmed = true;
        clearTimeout(this.endTimer);
        this.endTimer = setTimeout(() => { this.endArmed = false; }, 3000);
      },
      async endMeeting() {
        this.endArmed = false;
        clearTimeout(this.endTimer);
        try {
          await this.authed('POST', '/api/rooms/end');
          this.droppedOut('会议已结束，所有人都被请出了');
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.flash(err.message || '结束会议失败');
        }
      },
      async saveMyName() {
        const name = this.renameInput.trim();
        try {
          await this.authed('POST', '/api/profile', { display_name: name });
          this.displayName = name;
          this.renaming = false;
          this.scheduleSync(0);   // 服务端已经把成员表里的名字改了, 补一拍就显示新名字
        } catch (err) {
          if (err.dead) { this.sessionDead(); return; }
          this.flash(err.message || '改名失败');
        }
      },
      publishShare(on) {
        if (this.view !== 'room') return;
        this.authed('POST', '/api/rooms/share', { on }).then(() => this.scheduleSync(0)).catch(() => {});
      },

      // --------------------------------------------------------- 通话质量
      // 每 2 秒从每条 PeerConnection 的 getStats 采样, 算"收/发码率 + 丢包率 + 抖动 + 往返"。
      // 速率用"这次累计值 - 上次累计值"除以时间差 —— 标准做法。浏览器自己也在做拥塞控制,
      // 这里只是把它的结果读出来给用户看。
      async sampleStats() {
        for (const [pid, state] of calls) {
          if (!state.pc || state.pc.connectionState === 'closed') continue;
          if (state.stream) this.attachAnalyser(pid, state.stream);   // 说话高亮 / 提示音要的音量分析
          let rep = null;
          try {
            rep = await state.pc.getStats();
          } catch (err) {
            continue;
          }
          let inBytes = 0, outBytes = 0, lost = 0, recv = 0, jitter = 0, rtt = 0;
          rep.forEach((r) => {
            if (r.type === 'inbound-rtp' && !r.isRemote) {
              inBytes += r.bytesReceived || 0;
              lost += r.packetsLost || 0;
              recv += r.packetsReceived || 0;
              if (typeof r.jitter === 'number') jitter = Math.max(jitter, r.jitter);
            } else if (r.type === 'outbound-rtp' && !r.isRemote) {
              outBytes += r.bytesSent || 0;
            } else if (r.type === 'candidate-pair' && r.state === 'succeeded') {
              if (typeof r.currentRoundTripTime === 'number') rtt = Math.max(rtt, r.currentRoundTripTime);
            }
          });
          const t = performance.now();
          const prev = statsPrev.get(pid);
          statsPrev.set(pid, { t, inBytes, outBytes, lost, recv });
          if (!prev) continue;                       // 第一拍只记基线
          const dt = (t - prev.t) / 1000;
          if (dt < 0.2) continue;
          const inKbps = Math.max(0, ((inBytes - prev.inBytes) * 8) / dt / 1000);
          const outKbps = Math.max(0, ((outBytes - prev.outBytes) * 8) / dt / 1000);
          const dLost = Math.max(0, lost - prev.lost);
          const dRecv = Math.max(0, recv - prev.recv);
          const total = dLost + dRecv;
          const lossPct = total > 0 ? (dLost / total) * 100 : 0;
          const q = (lossPct < 1 && rtt < 0.15) ? 'good' : (lossPct < 5 && rtt < 0.3) ? 'fair' : 'poor';
          this.peerStats[pid] = {
            inKbps: Math.round(inKbps), outKbps: Math.round(outKbps),
            lossPct: Math.round(lossPct * 10) / 10,
            jitterMs: Math.round(jitter * 1000), rttMs: Math.round(rtt * 1000), q,
          };
        }
      },
      qText(pid) {
        const s = this.peerStats[pid];
        if (!s || s.inKbps <= 0) return '';
        return (s.inKbps >= 1000 ? (s.inKbps / 1000).toFixed(1) + 'M' : s.inKbps + 'k') +
               ' · ' + s.lossPct + '%';
      },
      qTitle(pid) {
        const s = this.peerStats[pid];
        if (!s) return '';
        return `收 ${s.inKbps} kbps / 发 ${s.outKbps} kbps · 丢包 ${s.lossPct}% · 抖动 ${s.jitterMs}ms · 往返 ${s.rttMs}ms`;
      },

      // ------------------------------------------------------- 轮询 / 同步
      stopTimers() {
        clearTimeout(this.syncTimer);
        clearInterval(this.clockTimer);
        clearInterval(this.statsTimer);
        clearTimeout(this.noticeTimer);
        clearTimeout(this.sessTimer);
        clearTimeout(this.leaveTimer);
        this.syncTimer = 0;
        this.clockTimer = 0;
        this.statsTimer = 0;
        this.noticeTimer = 0;
        this.sessTimer = 0;
        this.leaveTimer = 0;
        this.leaveArmed = false;
        this.endTimer = 0;
        this.endArmed = false;
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
          const r = await this.authed('GET', '/api/rooms/state?since=' + this.sigSince + '&chat=' + this.chatSince);
          this.applyRoom(r);
          await this.applySignals(r);
          this.applyChat(r);
          this.syncCalls();
          // 房间状态是放在 Redis 里的。万一 Redis 重启 (数据没开持久化),
          // 我们的 session 就没了, 服务端会回一个空房间号。这时候留在会议界面
          // 只会看到一个没有房间号的空会议室, 不如老老实实退回大厅重进。
          if (this.view === 'room' && !this.room) {
            this.droppedOut(r.ended ? '主持人结束了这场会议'
                                    : (r.removed ? '你被主持人移出了会议'
                                                 : '房间状态没了（服务端重启过），重新加入一次'));
            return;
          }
        } catch (err) {
          if (err.dead) {
            this.sessionDead();
            return;   // 别再排下一拍了
          }
          // 其它错误 (比如某一拍网络抖了) 下一拍自己会好
        }
        if (this.view === 'room') this.scheduleSync();
      },

      // 被动退出房间 (不是用户点的"离开"): 本地清干净, 回大厅并说明原因
      droppedOut(msg) {
        this.stopTimers();
        this.stopShare();
        this.stopBg();
        this.releaseWakeLock();
        this.closeAllCalls();
        this.room = '';
        this.participants = [];
        this.myPid = '';
        this.joinedAt = 0;
        this.sigSince = 0;
        this.lastHandledSeq = 0;
        this.resetChat();
        this.view = 'home';
        this.errors = { form: msg };
        // 被动退出之后人在大厅, 大厅不发别的请求 —— 得把"会话还在不在"这条心跳重新接上,
        // 不然这个标签页会一直"看起来还登着", 连账号在别处登录了都不会发现 (goHome 里也一样)。
        this.checkSession();
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
          shareAdded: false,   // 这条连接的视频轨是"共享时补加的" (停共享要 removeTrack)
        };
        calls.set(pid, state);
        this.peerState[pid] = pc.connectionState;

        // 发哪些轨: 摄像头流照发; 正在共享屏幕时, 视频轨换成屏幕轨。
        // 完全没有流又没共享 = 纯接收 (recvonly), 否则对方的 offer 会被我们整条拒掉。
        const camStream = this.media.stream;
        const camTracks = camStream ? camStream.getTracks() : [];
        const shareTrack = (this.sharing && shareStream) ? shareStream.getVideoTracks()[0] : null;
        if (camTracks.length === 0 && !shareTrack) {
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.addTransceiver('video', { direction: 'recvonly' });
        } else {
          let sentVideo = false;
          for (const t of camTracks) {
            if (t.kind === 'video') continue;  // 视频统一在下面处理
            pc.addTrack(t, camStream);
          }
          if (shareTrack) {
            pc.addTrack(shareTrack, shareStream);
            state.shareAdded = true;  // 停共享时 removeTrack, 而不是换回摄像头
            sentVideo = true;
          } else if (camTracks.length > 0) {
            const camVideo = camStream.getVideoTracks()[0];
            if (camVideo) {
              pc.addTrack(camVideo, camStream);
              sentVideo = true;
            }
          }
          if (!sentVideo) pc.addTransceiver('video', { direction: 'recvonly' });
          if (camTracks.length === 0) pc.addTransceiver('audio', { direction: 'recvonly' });
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
        // 表情反应是瞬时效果, 不建 PeerConnection
        if (msg.kind === 'reaction') {
          this.floatReaction(msg.from, (msg.payload || {}).emoji);
          return;
        }
        if (msg.kind === 'mute-all') {
          // 只认主持人发的; 一个人被单独静音和"全体静音"文案分开
          const pl = msg.payload || {};
          if (msg.from === this.host) {
            // on = 反过来, 是"请你开麦"
            if (pl.on) this.applyMicAsk(!!pl.one);
            else this.applyMuteAll(pl.one ? '主持人让你静音了' : '主持人把所有人静音了');
          }
          return;
        }
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
        statsPrev.clear();
        this.peerStats = {};
        this.audioBlocked = false;
      },

      async leave() {
        this.stopTimers();
        this.stopShare();
        this.stopBg();
        this.releaseWakeLock();
        this.closeAllCalls();
        try { await this.authed('POST', '/api/rooms/leave', {}); } catch (err) { /* 忽略 */ }
        this.room = '';
        this.participants = [];
        this.myPid = '';
        this.joinedAt = 0;
        this.sigSince = 0;
        this.lastHandledSeq = 0;
        this.resetChat();
        this.view = 'home';
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
          // 轨道都活着: 只是切视图回来, 重新绑一下预览就行
          if (this.media.stream.getTracks().every((t) => t.readyState === 'live')) {
            this.syncPreview();
            return;
          }
          // 有轨道已经死了 (设备被拔掉): 走和插拔事件同一条修复路径
          this.recoverMedia();
          return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          this.media.error = '这个环境不给用摄像头。用 http://localhost 打开，或者直接进房间。';
          return;
        }
        // 有存过设备选择就用它, 没有就用系统默认
        const savedMic = localStorage.getItem('tp_dev_mic');
        const savedCam = localStorage.getItem('tp_dev_cam');
        const want = {
          video: savedCam ? { deviceId: { exact: savedCam } } : true,
          audio: savedMic ? { deviceId: { exact: savedMic } } : true,
        };
        navigator.mediaDevices.getUserMedia(want).then((stream) => {
          this.applyStream(stream);
        }).catch((err) => {
          this.media.error = err && err.name === 'NotAllowedError'
            ? '你拒绝了摄像头或麦克风权限。在地址栏左边重新允许，然后点重试。'
            : '拿不到摄像头或麦克风，可能被别的程序占用了。可以点重试，或者直接进房间。';
        });
      },

      // 摄像头/麦克风插拔 (路线图 P1 前端兼容性): 拔掉时浏览器把那条 track 置成 ended,
      // 这里只重拿死掉的那些种类 (视频死了不动音频), 拿到后就地换轨 —— MediaStream 里
      // 换一条 + 每个连接 replaceTrack, 不触发重新协商, 对端几秒内自己恢复。
      // 拿不回来 (设备还没插回) 就落错误提示; 用户插回后 devicechange 会再试, 或点「重试」。
      async recoverMedia() {
        if (this.media.recovering || !this.media.stream) return;
        const s = this.media.stream;
        const dead = s.getTracks().filter((t) => t.readyState === 'ended');
        if (!dead.length) return;  // 只是新插了设备, 现有轨道都活着
        const wantCam = this.media.cam;  // 保持用户之前的开关: 关着的, 新轨道也先关着
        const wantMic = this.media.mic;
        this.media.recovering = true;
        try {
          const fresh = await navigator.mediaDevices.getUserMedia({
            video: dead.some((t) => t.kind === 'video'),
            audio: dead.some((t) => t.kind === 'audio'),
          });
          for (const t of fresh.getTracks()) {
            const old = s.getTracks().find((x) => x.kind === t.kind && x.readyState === 'ended');
            if (!old) continue;
            t.enabled = t.kind === 'video' ? wantCam : wantMic;
            for (const state of calls.values()) {
              const sender = state.pc.getSenders().find((x) => x.track === old);
              // replaceTrack 是异步生效的: 要等它落地, 不然下面的兜底会误判成"这条轨道还没挂上"
              if (sender) {
                try { await sender.replaceTrack(t); } catch (e) { /* 连接正在重建, 交给看门狗 */ }
              }
            }
            s.removeTrack(old);
            old.stop();
            s.addTrack(t);
          }
          // 兜底: 建连接时还没有摄像头/麦克风的那条 pc (只有 recvonly transceiver),
          // 没有可换的 sender, 就补一条新的, 让它自己触发重新协商
          for (const state of calls.values()) {
            for (const t of s.getTracks()) {
              if (!state.pc.getSenders().some((x) => x.track === t)) {
                try { state.pc.addTrack(t, s); } catch (e) { /* 同上 */ }
              }
            }
          }
          this.media.cam = s.getVideoTracks().length > 0 && wantCam;
          this.media.mic = s.getAudioTracks().length > 0 && wantMic;
          this.media.error = '';
        } catch (e) {
          this.media.error = '摄像头或麦克风断开了：接回来，或点重试。';
          // cam / mic 既表示开关也表示"设备在不在": 没有活着的轨道 = 设备不在了
          const live = (kind) => s.getTracks().some((t) => t.kind === kind && t.readyState === 'live');
          this.media.cam = live('video') && wantCam;
          this.media.mic = live('audio') && wantMic;
        } finally {
          this.media.recovering = false;
        }
      },

      applyStream(stream) {
        this.media.stream = stream;
        this.media.cam = stream.getVideoTracks().length > 0;
        this.media.mic = stream.getAudioTracks().length > 0;
        this.syncPreview();
        this.attachAnalyser('me', stream);   // 试麦电平条 + 自己说话高亮
        this.startLevelTimer();
        this.loadDevices();                  // 设备列表 / 当前选中项

        // 如果授权弹窗比"加入会议"慢 (用户在大厅停留很久), 进房间时还没有轨道,
        // 那时建的是 recvonly 的连接。这里把轨道补上, addTrack 会自动触发重新协商。
        for (const state of calls.values()) {
          for (const t of stream.getTracks()) {
            if (!state.pc.getSenders().some((s) => s.track === t)) state.pc.addTrack(t, stream);
          }
        }
      },

      stopMedia() {
        this.stopBg();       // 处理链路的源(摄像头)要没了, 先拆掉
        this.detachAnalysers();
        this.stopLevelTimer();
        if (this.media.stream) {
          this.media.stream.getTracks().forEach((t) => t.stop());
          this.media.stream = null;
        }
        this.syncPreview();
        this.media.cam = true;
        this.media.mic = true;
      },

      // 静音只改 track.enabled, 不停 track —— 停了就得重新申请权限, 而且会触发重新协商
      toggleMic() {
        const track = this.media.stream && this.media.stream.getAudioTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        this.media.mic = track.enabled;
        this.publishMic();   // 让房间里别人也看得见我静音了
      },

      // 把当前麦克风开关同步到服务端 (进房后 / 每次切换后)
      publishMic() {
        if (this.view !== 'room') return;
        this.authed('POST', '/api/rooms/mic', { on: this.media.mic }).then(() => {
          this.scheduleSync(0);
        }).catch(() => { /* 下一拍同步会以服务端状态为准 */ });
      },

      toggleCam() {
        const track = this.media.stream && this.media.stream.getVideoTracks()[0];
        if (!track) return;
        track.enabled = !track.enabled;
        this.media.cam = track.enabled;
      },

      // ------------------------------------------------------------- 屏幕共享
      // 已有的对端连接优先用 replaceTrack 换视频轨: 不触发重新协商, 对端画面无缝切过去;
      // 从"纯接收"模式 (当初就没有摄像头) 建立的对端只能 addTrack, 那一次会重新协商 ——
      // 正是 perfect negotiation 覆盖的场景。浏览器共享条里的"停止共享"通过 track ended 回调处理。
      async toggleShare() {
        if (this.bgMode !== 'off') this.stopBg();   // 两者都要占用出向视频轨, 不并存
        if (this.sharing) { this.stopShare(); return; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
          console.warn('这个浏览器不支持屏幕共享 (getDisplayMedia)');
          return;
        }
        let stream;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        } catch (err) {
          return;  // 用户取消了选择源, 静默即可
        }
        const track = stream.getVideoTracks()[0];
        if (!track) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        shareStream = stream;
        this.sharing = true;
        this.publishShare(true);   // 让别人也看到"谁在共享"
        track.addEventListener('ended', () => this.stopShare());  // 浏览器共享条的"停止共享"
        for (const state of calls.values()) {
          const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) {
            try { await sender.replaceTrack(track); } catch (err) { console.warn('屏幕轨替换失败', err); }
          } else {
            try {
              state.pc.addTrack(track, shareStream);  // 触发重新协商, 交给 perfect negotiation
              state.shareAdded = true;
            } catch (err) {
              console.warn('加屏幕轨失败', err);
            }
          }
        }
        this.syncPreview();   // 本地预览切到屏幕
      },

      stopShare() {
        if (!this.sharing) return;
        this.sharing = false;
        this.publishShare(false);
        const track = shareStream && shareStream.getVideoTracks()[0];
        const camTrack = this.media.stream ? this.media.stream.getVideoTracks()[0] : null;
        for (const state of calls.values()) {
          if (state.shareAdded) {
            state.shareAdded = false;
            const sender = track ? state.pc.getSenders().find((s) => s.track === track) : null;
            if (sender) { try { state.pc.removeTrack(sender); } catch (err) { /* 连接可能已关 */ } }
          } else {
            const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            // 换回摄像头轨; 摄像头本来就没有/已停 => null, 只停发
            if (sender) sender.replaceTrack(camTrack || null).catch(() => {});
          }
        }
        if (shareStream) {
          shareStream.getTracks().forEach((t) => t.stop());
          shareStream = null;
        }
        this.syncPreview();
      },

      // ------------------------------------------------------- 虚拟背景
      // 老实说: 这是"简易人像模式" —— 画面中心一块椭圆里的人像保持清晰, 四周模糊或填纯色。
      // 没做 AI 抠像 (真实分割要引分割模型, 和"离线可跑、不加外部依赖"的前提冲突; 要做就得
      // 把模型 vendor 进仓库)。但链路是真的: 摄像头 -> 隐藏 <video> -> canvas 处理 ->
      // captureStream -> 给每条连接 replaceTrack 换出向视频轨, 所以对端看到的确实是处理后的画面。
      cycleBg() {
        const next = this.bgMode === 'off' ? 'blur' : (this.bgMode === 'blur' ? 'solid' : 'off');
        this.setBg(next);
      },
      async setBg(mode) {
        this.stopBg();
        this.bgMode = mode;
        if (mode === 'off') return;
        const camTrack = this.media.stream && this.media.stream.getVideoTracks()[0];
        if (!camTrack) { this.bgMode = 'off'; this.flash('先打开摄像头再用虚拟背景'); return; }
        if (this.sharing) { this.bgMode = 'off'; this.flash('共享屏幕时不能开虚拟背景'); return; }

        bgVideo = document.createElement('video');
        bgVideo.muted = true;
        bgVideo.playsInline = true;
        bgVideo.srcObject = new MediaStream([camTrack]);
        await bgVideo.play().catch(() => {});
        bgCanvas = document.createElement('canvas');
        bgCanvas.width = 640;
        bgCanvas.height = 360;
        const ctx = bgCanvas.getContext('2d');
        const draw = () => {
          if (!bgCanvas || !bgVideo) return;
          const w = bgCanvas.width, h = bgCanvas.height;
          ctx.filter = 'none';
          if (mode === 'solid') {
            ctx.fillStyle = '#2b3a55';
            ctx.fillRect(0, 0, w, h);
          } else {
            ctx.filter = 'blur(12px) brightness(.7)';
            ctx.drawImage(bgVideo, -24, -14, w + 48, h + 28);   // 画大一圈, 免得边上露出模糊边
            ctx.filter = 'none';
          }
          ctx.save();
          ctx.beginPath();
          ctx.ellipse(w * 0.5, h * 0.54, w * 0.26, h * 0.46, 0, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(bgVideo, 0, 0, w, h);
          ctx.restore();
          bgRAF = requestAnimationFrame(draw);
        };
        draw();
        bgStream = bgCanvas.captureStream(24);
        const track = bgStream.getVideoTracks()[0];
        for (const state of calls.values()) {
          const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender) {
            try { await sender.replaceTrack(track); } catch (err) { /* 连接可能正在重建, 交给看门狗 */ }
          } else {
            try { state.pc.addTrack(track, bgStream); state.bgAdded = true; } catch (err) { /* 忽略 */ }
          }
        }
        this.syncPreview();
      },
      stopBg() {
        if (bgRAF) { cancelAnimationFrame(bgRAF); bgRAF = 0; }
        const camTrack = this.media.stream ? this.media.stream.getVideoTracks()[0] : null;
        for (const state of calls.values()) {
          if (state.bgAdded) {
            state.bgAdded = false;
            const t = bgStream ? bgStream.getVideoTracks()[0] : null;
            const sender = t ? state.pc.getSenders().find((s) => s.track === t) : null;
            if (sender) { try { state.pc.removeTrack(sender); } catch (err) { /* 忽略 */ } }
          } else {
            const sender = state.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
            if (sender) sender.replaceTrack(camTrack || null).catch(() => {});
          }
        }
        if (bgStream) {
          bgStream.getTracks().forEach((t) => t.stop());
          bgStream = null;
        }
        bgCanvas = null;
        bgVideo = null;
        this.bgMode = 'off';
        this.syncPreview();
      },

      // ------------------------------------------------------------- 防锁屏
      // 手机端锁屏会把 JS 挂起, 超过心跳阈值就被别人判掉线; 进房时尽量申请屏幕常亮
      // (Screen Wake Lock)。不支持 / 被电量策略拒绝都静默跳过, 不影响任何功能。
      async acquireWakeLock() {
        try {
          if (!navigator.wakeLock || wakeLock) return;
          wakeLock = await navigator.wakeLock.request('screen');
          wakeLock.addEventListener('release', () => { wakeLock = null; });
        } catch (err) { /* 无所谓 */ }
      },

      releaseWakeLock() {
        try {
          if (wakeLock) {
            wakeLock.release();
            wakeLock = null;
          }
        } catch (err) { /* 忽略 */ }
      },
    },
  }).mount('#app');

  // 调试用: 控制台里能直接看每条对端连接的状态和统计。
  // WebRTC 出问题的时候 (听不到声、看不到画面) 没有这个基本没法查:
  //   [...tongpin.calls].map(([pid, c]) => [pid, c.pc.connectionState])
  //   await (await [...tongpin.calls][0][1].pc.getStats()).forEach(r => ...)
  window.tongpin = { calls, videoEls };
})();
