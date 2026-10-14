// 负载测试 (k6): 压 API 层 —— 进房 / 2 秒轮询 / 协商期信令。
//
// 媒体是浏览器两两直连 (mesh), 不经过服务器, 所以这里量的是每次请求背后的
// 1 次 PostgreSQL 点查 (令牌/账号) + 6~8 条 Redis 命令 (在线状态 + 信令箱)。
// 这正是"轮询模型下, 1000 并发用户 ≈ 500 rps"里那 500 rps 的来源。
//
//   bash ops/loadtest/run.sh                 # 默认 60 VU / 1 分钟
//   VUS=200 DURATION=3m bash ops/loadtest/run.sh
//
// 设计取舍 (细节见 README.md):
// - 一个 VU = 一个账号 + 一个会话令牌 = 一个参会者 (和前端的"一个标签页一个令牌"一致);
// - setup() 直连 app:9000 建账号, 绕过 nginx 的登录/注册限流 (那是防爆破的 20r/m,
//   不是容量瓶颈本身); 压测主体走 nginx, 和真实用户同一条链路;
// - 房间每 6 人一间, 对齐后端 kMaxRoomPeers 的 mesh 上限。
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const VUS       = Number(__ENV.VUS || 60);
const DURATION  = __ENV.DURATION || '60s';
const AUTH_BASE = __ENV.AUTH_BASE || 'http://app:9000'; // setup 用: 直连后端
const API_BASE  = __ENV.API_BASE || 'http://nginx';     // 主体用: 走真实入口
const ROOM_SIZE = Number(__ENV.ROOM_SIZE || 6);
const POLL_MS   = Number(__ENV.POLL_MS || 2000);
const RUN_ID    = __ENV.RUN_ID || Math.random().toString(36).slice(2, 8);
const PASSWORD  = 'lt-password-1';

// 一条"像真的"的 SDP / ICE 信令, 大约 2KB (真实 offer 3~4KB, 这里取保守值)
const SDP_LIKE = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\n' +
    'a=candidate:842163049 1 udp 1677729535 203.0.113.7 52831 typ srflx\r\n'.repeat(24);

const signalsSent = new Counter('lt_signals_sent');
const signalsDelivered = new Counter('lt_signals_delivered');
const inboxMessages = new Counter('lt_inbox_messages');
const enterDuration = new Trend('lt_enter_duration', true);

export const options = {
    scenarios: {
        meeting: {
            executor: 'ramping-vus',
            startVUs: 0,
            stages: [
                { duration: __ENV.RAMP_UP || '15s', target: VUS },
                { duration: DURATION, target: VUS },
                { duration: '5s', target: 0 },
            ],
        },
    },
    thresholds: {
        http_req_failed: ['rate<0.01'],
        http_req_duration: ['p(95)<400', 'p(99)<1000'],
        checks: ['rate>0.99'],
    },
};

const JSON_HEADERS = { 'Content-Type': 'application/json' };

// 建 VUS 个账号 (每个账号 = 一个参会者)。注意每个注册背后是一次 Argon2id (m=64MB),
// 60 VU 大概要 15~30 秒 —— 这是有意的成本, 不是卡住了。
export function setup() {
    const tokens = [];
    for (let i = 0; i < VUS; i++) {
        const username = `lt_${RUN_ID}_${i}`;
        const body = JSON.stringify({ username, password: PASSWORD });
        let res = http.post(`${AUTH_BASE}/api/register`, body, { headers: JSON_HEADERS });
        if (res.status !== 200) {
            // 账号已存在 (同一个 RUN_ID 重跑) 就改登录
            res = http.post(`${AUTH_BASE}/api/login`, body, { headers: JSON_HEADERS });
        }
        if (res.status !== 200) {
            throw new Error(`建号失败 ${username}: ${res.status} ${res.body}`);
        }
        tokens.push(JSON.parse(res.body).token);
    }
    console.log(`setup 完成: ${tokens.length} 个账号 (RUN_ID=${RUN_ID})`);
    return { tokens };
}

// VU 局部状态: k6 同一个 VU 会复用同一个 JS 运行时, 所以模块级变量跨 iteration 保留。
let session = null;

function signal(token, to, kind, payload) {
    const res = http.post(`${API_BASE}/api/rooms/signal`,
        JSON.stringify({ to, kind, payload }), {
            headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
        });
    signalsSent.add(1);
    if (res.status === 200) {
        check(res, { '信令送达': (r) => JSON.parse(r.body).delivered === true });
        try {
            if (JSON.parse(res.body).delivered === true) signalsDelivered.add(1);
        } catch (e) { /* 上面 check 已经记失败 */ }
    } else {
        check(res, { '信令 200': (r) => r.status === 200 });
    }
}

// 一个 iteration = 一拍: 轮询一次 + 发一条(或新同伴的几条)信令 + 睡到下一拍。
// 时长到了 k6 会把 sleep 打断, iteration 结束, 不会热转。
export default function (data) {
    const token = data.tokens[(__VU - 1) % data.tokens.length];
    const auth = { Authorization: `Bearer ${token}` };

    if (!session) {
        const room = `load-${RUN_ID}-${Math.floor((__VU - 1) / ROOM_SIZE)}`;
        const res = http.post(`${API_BASE}/api/rooms/enter`,
            JSON.stringify({ room }), { headers: { ...JSON_HEADERS, ...auth } });
        enterDuration.add(res.timings.duration);
        if (!check(res, { '进房 200': (r) => r.status === 200 })) {
            sleep(2); // 进不去就下一拍再试, 不把 VU 打死
            return;
        }
        const body = JSON.parse(res.body);
        const me = (body.participants || []).find((p) => p.me);
        session = { pid: me ? me.id : null, since: 0, known: {} };
        // 新人进房: 给每个已经在场的人发一轮协商信令 (真实 mesh 里就是新人发 offer)
        for (const p of (body.participants || [])) {
            if (p.me) continue;
            session.known[p.id] = true;
            signal(token, p.id, 'offer', { sdp: SDP_LIKE });
            signal(token, p.id, 'ice', { candidate: 'candidate:842163049 1 udp ' + SDP_LIKE.slice(0, 120) });
        }
    }

    // 拍一: 刷新心跳 + 取走信令收件箱
    const st = http.get(`${API_BASE}/api/rooms/state?since=${session.since}`, { headers: auth });
    if (!check(st, { 'state 200': (r) => r.status === 200 })) {
        sleep(POLL_MS / 1000);
        return;
    }
    const state = JSON.parse(st.body);
    session.since = state.seq;
    if (Array.isArray(state.messages) && state.messages.length > 0) {
        inboxMessages.add(state.messages.length);
    }

    const others = (state.participants || []).filter((p) => !p.me && p.id !== session.pid);

    // 拍二: 刚出现的同伴 -> 补一轮协商信令; 老同伴 -> 按 ICE trickle 的节奏发一条
    for (const p of others) {
        if (!session.known[p.id]) {
            session.known[p.id] = true;
            signal(token, p.id, 'offer', { sdp: SDP_LIKE });
            signal(token, p.id, 'ice', { candidate: 'candidate:842163049 1 udp ' + SDP_LIKE.slice(0, 120) });
        }
    }
    if (others.length > 0) {
        const pick = others[Math.floor(Math.random() * others.length)];
        signal(token, pick.id, 'ice', { candidate: 'candidate:842163049 1 udp 1677729535 203.0.113.7 52831 typ srflx' });
    }

    sleep(POLL_MS / 1000);
}
