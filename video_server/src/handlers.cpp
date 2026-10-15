// 客户端 API: 极简 HTTP/1.1 + JSON。
//
//   字节流 --parseRequest()--> Request --route()--> Resp --sendResp()--> 字节流
//
// 状态放在哪:
//   账号和会话       -> PostgreSQL (db.* / auth.*)
//   会话校验缓存      -> Redis      (60 秒 TTL, 见 requireAuth)
//   房间在线 + 信令   -> Redis      (presence.*)
//   这个进程自己      -> 什么都不存
//
// 这个进程是完全无状态的, 所以可以起任意多份放在负载均衡后面, 任意一份挂了都不影响
// 正在开会的房间。这也是这套代码能从"单机 demo"变成"多实例"的关键改动。
//
// 还没有: WebSocket、SDP/ICE 之外的媒体转发 (见 README「信令和媒体」)。
#include "handlers.h"

#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <string>
#include <utility>
#include <vector>

#include "auth.h"
#include "db.h"
#include "events.h"
#include "json.h"
#include "log.h"
#include "metrics.h"
#include "presence.h"
#include "random.h"
#include "redis.h"
#include "server.h"
#include "turncred.h"

namespace {

// -------------------------------------------------------------------- 常量
constexpr size_t kMaxHead = 16 * 1024;  // 请求行 + 头
constexpr size_t kMaxBody = 64 * 1024;  // 请求体 (现在的接口都是小 JSON)
constexpr size_t kMaxFileBytes = 8u << 20;

// 信令搬运的一些上限。SDP 一般 2-4KB, 给宽一点。
constexpr size_t kMaxSignalPayload = 16 * 1024;
constexpr size_t kMaxSignalKind = 16;

// 静态资源根目录。setWebRoot() 在 start() 之前写一次, 之后只读, 不用加锁。
std::string g_webRoot = "../video_client";

// 交给浏览器的 ICE 服务器列表, 原样是一段 JSON 数组文本。
// 部署时通过环境变量 ICE_SERVERS 覆盖 (见 README)。
std::string g_iceServers = R"([{"urls":"stun:stun.l.google.com:19302"}])";

// TURN 的 REST 临时凭证配置。TURN_URL / TURN_SECRET 都配了才启用 (见 README)。
// setTurnConfig() 在 start() 之前写一次, 之后所有请求只读。
std::string g_turnUrl;
std::string g_turnSecret;
long long g_turnTtl = 12 * 60 * 60;  // 临时凭证有效期, 默认 12 小时

// 这台实例的名字 (容器里就是 hostname)。多实例部署时用来确认负载均衡真的在分发,
// /api/health 会带上它。
std::string g_instance = "?";

std::string randomRoomCode() {
    // 9 位数字房间号 (首位非 0)。数字比字母好念、好记, 也不会有 i/l/o 听不清的问题;
    // 首位从 1-9 起, 免得前导 0 被人写漏或念掉。9 位 = 9 亿种, 加上进房时的占用检查,
    // 撞号概率可以忽略。
    std::string s;
    s.reserve(9);
    s.push_back((char)('1' + rnd::below(9)));
    for (int i = 1; i < 9; ++i) s.push_back((char)('0' + rnd::below(10)));
    return s;
}

std::string lower(std::string s) {
    for (char& ch : s) ch = (char)std::tolower((unsigned char)ch);
    return s;
}

// 房间成员 -> 下发给前端的 JSON。
// 注意 token 只留在服务端, 下发的只有 pid / 名字 / 是不是我。
std::string peersJson(const std::vector<presence::Member>& members, const std::string& selfToken) {
    std::string arr = "[";
    bool first = true;
    for (const presence::Member& m : members) {
        if (!m.live) continue;  // 心跳断了的当不在
        if (!first) arr += ',';
        first = false;
        arr += "{\"id\":";
        arr += json::quote(m.pid);
        arr += ",\"name\":";
        arr += json::quote(m.user);
        arr += ",\"me\":";
        arr += (m.token == selfToken) ? "true" : "false";
        arr += ",\"hand\":";
        arr += m.hand ? "true" : "false";
        arr += ",\"mic\":";
        arr += m.mic ? "true" : "false";
        arr += '}';
    }
    arr += ']';
    return arr;
}

std::string normalizeRoom(const std::string& raw) {
    std::string out;
    out.reserve(raw.size());
    for (char ch : raw) {
        const unsigned char c = (unsigned char)ch;
        if (c >= 'A' && c <= 'Z') {
            out.push_back((char)(c - 'A' + 'a'));
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
            out.push_back((char)c);
        } else {
            return std::string();  // 有非法字符
        }
    }
    return out;
}

// ---------------------------------------------------------------- HTTP 解析
struct Request {
    std::string method;
    std::string path;
    std::string query;  // path 里 '?' 后面那段, 原样
    std::string body;
    std::string token;  // Authorization: Bearer xxx
    bool keepAlive = true;
};

struct Resp {
    int code = 200;
    std::string type = "application/json; charset=utf-8";
    std::string body;
};

enum class Parse { Ok, NeedMore, Bad };

const char* statusText(int code) {
    switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 401: return "Unauthorized";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 409: return "Conflict";
        case 413: return "Payload Too Large";
        case 429: return "Too Many Requests";
        case 431: return "Request Header Fields Too Large";
        case 500: return "Internal Server Error";
        case 503: return "Service Unavailable";
        default: return "OK";
    }
}

// 从 buf 头部切出一个完整请求, 切掉的部分从 buf 里 erase。
// 不完整 -> NeedMore; 格式错 -> Bad, *err 是建议的状态码。
Parse parseRequest(std::string& buf, Request* req, int* err) {
    *err = 400;
    const size_t headEnd = buf.find("\r\n\r\n");
    if (headEnd == std::string::npos) {
        if (buf.size() > kMaxHead) {
            *err = 431;
            return Parse::Bad;
        }
        return Parse::NeedMore;
    }
    if (headEnd > kMaxHead) {
        *err = 431;
        return Parse::Bad;
    }

    const size_t lineEnd = buf.find("\r\n");
    if (lineEnd == std::string::npos || lineEnd > headEnd) return Parse::Bad;

    // 请求行: METHOD SP TARGET SP HTTP/1.1
    const std::string line = buf.substr(0, lineEnd);
    const size_t sp1 = line.find(' ');
    const size_t sp2 = line.rfind(' ');
    if (sp1 == std::string::npos || sp2 == sp1) return Parse::Bad;
    req->method = line.substr(0, sp1);
    const std::string target = line.substr(sp1 + 1, sp2 - sp1 - 1);
    if (line.compare(sp2 + 1, 5, "HTTP/") != 0) return Parse::Bad;

    // 头
    size_t contentLength = 0;
    size_t p = lineEnd + 2;
    while (p < headEnd) {
        const size_t e = buf.find("\r\n", p);
        if (e == std::string::npos || e > headEnd) break;
        const std::string h = buf.substr(p, e - p);
        p = e + 2;
        const size_t colon = h.find(':');
        if (colon == std::string::npos) continue;
        const std::string k = lower(h.substr(0, colon));
        std::string v = h.substr(colon + 1);
        const size_t a = v.find_first_not_of(" \t");
        const size_t b = v.find_last_not_of(" \t");
        v = (a == std::string::npos) ? std::string() : v.substr(a, b - a + 1);

        if (k == "content-length") {
            contentLength = (size_t)std::strtoul(v.c_str(), nullptr, 10);
        } else if (k == "authorization") {
            if (v.size() > 7 && lower(v.substr(0, 7)) == "bearer ") req->token = v.substr(7);
        } else if (k == "connection") {
            if (lower(v).find("close") != std::string::npos) req->keepAlive = false;
        }
    }
    if (contentLength > kMaxBody) {
        *err = 413;
        return Parse::Bad;
    }

    const size_t total = headEnd + 4 + contentLength;
    if (buf.size() < total) return Parse::NeedMore;

    const size_t q = target.find('?');
    req->path = (q == std::string::npos) ? target : target.substr(0, q);
    req->query = (q == std::string::npos) ? std::string() : target.substr(q + 1);
    req->body.assign(buf, headEnd + 4, contentLength);
    buf.erase(0, total);
    return Parse::Ok;
}

// 从 query 里取一个非负整数, 没有或者不合法就返回 def。
// 只认 key=<十进制数字>, 别的形式一律当没有。
long long queryInt(const std::string& query, const char* key, long long def) {
    const std::string k = std::string(key) + "=";
    size_t p = 0;
    while (p < query.size()) {
        const size_t amp = query.find('&', p);
        const std::string item = query.substr(p, (amp == std::string::npos ? query.size() : amp) - p);
        if (item.compare(0, k.size(), k) == 0) {
            const std::string v = item.substr(k.size());
            if (v.empty() || v.size() > 18) return def;
            for (char ch : v) {
                if (ch < '0' || ch > '9') return def;
            }
            return std::strtoll(v.c_str(), nullptr, 10);
        }
        if (amp == std::string::npos) break;
        p = amp + 1;
    }
    return def;
}

void sendResp(Connection& c, const Resp& r, bool keepAlive) {
    std::string out;
    out.reserve(256 + r.body.size());
    out += "HTTP/1.1 ";
    out += std::to_string(r.code);
    out += ' ';
    out += statusText(r.code);
    out += "\r\nContent-Type: ";
    out += r.type;
    out += "\r\nContent-Length: ";
    out += std::to_string(r.body.size());
    out += keepAlive ? "\r\nConnection: keep-alive" : "\r\nConnection: close";
    // 不开 CORS: 前端和 API 同源部署 (nginx 既发静态文件又反代 /api), 浏览器不会发预检;
    // 需要跨域调试的话, 更安全的做法是在这里按白名单发 Access-Control-Allow-Origin,
    // 而不是给所有站点开 *。
    out += "\r\nCache-Control: no-store";
    out += "\r\n\r\n";
    out += r.body;
    c.send(out);
}

// 回包并请求关闭。如果 send() 没把 out 写干净 (对端慢 / 包大), 不能立刻 close,
// 否则缓冲里剩下的字节会直接丢 —— 交给 onWritable 写完再关。
void respondAndClose(Connection& c, const Resp& r) {
    sendResp(c, r, false);
    if (c.out.empty()) {
        c.close();
    } else {
        c.closeAfterFlush = true;
    }
}

Resp okJson(std::string body) {
    Resp r;
    r.code = 200;
    r.body = std::move(body);
    return r;
}

Resp errJson(int code, const std::string& msg) {
    Resp r;
    r.code = code;
    r.body = "{\"error\":" + json::quote(msg) + "}";
    return r;
}

Resp errText(int code, const std::string& msg) {
    Resp r;
    r.code = code;
    r.type = "text/plain; charset=utf-8";
    r.body = msg + "\n";
    return r;
}

// ------------------------------------------------------------------ 鉴权
// 令牌校验结果缓存在 Redis, TTL 60 秒: 命中就直接放行, 每请求省一次 PG 点查
// (压测里 PG 点是整套链路最大的 CPU 头, 见 ops/loadtest/README.md 的瓶颈分析)。
//
// key 直接用令牌本体: 令牌是 64 位十六进制随机串, Redis 只在内网(回环),
// 信任域和 PG 相同, 不必再哈希一层。
//
// 代价: 吊销最多晚 60 秒生效。正常退出登录会同步删缓存; 残余窗口只有
// "并发请求刚好在删除前把旧结果回填" 这一种, 上界 60 秒, 接受。
std::string sessCacheKey(const std::string& token) { return "sess:" + token; }
// 这个账号当前有哪些会话校验缓存键 —— 换新会话时按它把旧的清掉 (见 clearSessCache)
std::string sessIndexKey(const std::string& user) { return "sessidx:" + lower(user); }

// 清掉某个账号的会话校验缓存。换新会话 / 退出登录时调。
// 不清的话, 被挤下线的客户端还能靠缓存继续过鉴权最多 60 秒 —— 等于没挤掉。
void clearSessCache(const std::string& user) {
    std::string err;
    std::vector<std::string> keys;
    if (!redis::sMembers(sessIndexKey(user), &keys, &err)) return;  // 尽力而为
    for (const std::string& k : keys) redis::del(k, &err);
    redis::del(sessIndexKey(user), &err);
}

// 定义在下面 (用到 envNum), 这里先声明
bool tokenRateLimited(const std::string& token);

bool requireAuth(const Request& req, std::string* user, Resp* fail) {
    // 先问缓存: 命中直接过; 未命中或 Redis 故障都走下面的慢路径
    // (err 非空 = Redis 故障, 当作没命中, 不能因为缓存把请求打挂)
    std::string cached;
    std::string cacheErr;
    if (redis::get(sessCacheKey(req.token), &cached, &cacheErr) && !cached.empty()) {
        *user = cached;
    } else {
        // 慢路径: 查库 (也只有这里会给出 401 / 500)。失败结果不进缓存。
        std::string err;
        switch (auth::whoAmI(req.token, user, &err)) {
            case auth::Check::Ok: {
                // 回填缓存, 尽力而为: 写失败只是下次还走慢路径
                std::string fillErr;
                redis::setEx(sessCacheKey(req.token), *user, 60, &fillErr);
                // 顺手把这枚缓存键记到账号名下: 换新会话时要能按账号把旧会话的缓存一起清掉
                redis::sAdd(sessIndexKey(*user), sessCacheKey(req.token), &fillErr);
                redis::expire(sessIndexKey(*user), 12 * 3600, &fillErr);
                break;
            }
            case auth::Check::Error:
                logmsg("[api] 查会话失败: %s\n", err.c_str());
                *fail = errJson(500, "服务端查会话失败");
                return false;
            case auth::Check::BadToken:
            default:
                *fail = errJson(401, "登录状态失效了，重新登录一下");
                return false;
        }
    }

    // 按令牌限流 (放在鉴权之后: 只对合法令牌计数, 未登录的请求交给 nginx 按 IP 挡)
    if (tokenRateLimited(req.token)) {
        *fail = errJson(429, "请求太频繁了，歇一下再试");
        return false;
    }
    return true;
}

// auth::Result -> HTTP 响应
Resp fromAuthResult(const auth::Result& r) {
    if (r.status != auth::Status::Ok) {
        switch (r.status) {
            case auth::Status::BadRequest: return errJson(400, r.error);
            case auth::Status::Taken: return errJson(409, r.error);
            case auth::Status::BadCreds: return errJson(401, r.error);
            default: return errJson(500, r.error.empty() ? "服务端出错" : r.error);
        }
    }
    std::string body = "{\"token\":";
    body += json::quote(r.token);
    body += ",\"user\":";
    body += json::quote(r.username);
    if (!r.rememberToken.empty()) {
        body += ",\"remember_token\":";
        body += json::quote(r.rememberToken);
    }
    body += '}';
    return okJson(std::move(body));
}

// ------------------------------------------------------------------ 接口实现
Resp apiRegister(const Request& req) {
    std::string name;
    std::string pass;
    if (!json::getString(req.body, "username", &name) || !json::getString(req.body, "password", &pass)) {
        return errJson(400, "请求体里要有 username 和 password 两个字符串字段");
    }
    bool remember = false;
    json::getBool(req.body, "remember", &remember);
    const auth::Result r = auth::registerUser(name, pass, remember);
    if (r.status == auth::Status::Ok) clearSessCache(r.username);  // 顶掉别处可能有的旧会话
    return fromAuthResult(r);
}

// ------------------------------------------------------------------ 登录失败锁定
// 按账号数失败次数, 5 次错密码锁 15 分钟。和 nginx 那层的按 IP 限流互补:
// 这层挡"换着 IP 撞同一个账号", 那层挡"换着账号撞"。
// 计数放 Redis (多实例共享); Redis 出错时放行不锁 —— 限流是保险丝,
// 不能因为缓存不可用把所有人挡在门外 (和房间功能的降级思路一致)。
// 阈值和时长可以用环境变量覆盖 (LOGIN_FAIL_MAX / LOGIN_LOCK_SECONDS),
// 部署时想临时收紧或放宽不用重新编译; 不配就用默认值。
long long envNum(const char* name, long long fallback) {
    const char* v = std::getenv(name);
    if (v == nullptr || *v == '\0') return fallback;
    const long long n = std::strtoll(v, nullptr, 10);
    return n > 0 ? n : fallback;
}
const long long kLoginMaxFails = envNum("LOGIN_FAIL_MAX", 5);
const long long kLoginLockSecs = envNum("LOGIN_LOCK_SECONDS", 15 * 60);

std::string loginFailKey(const std::string& name) {
    // 用户名大小写不敏感 (注册时 LIN 会撞 lin), 计数也按小写归一
    return "login_fail:" + lower(name);
}

// 该账号是否处于锁定期。Redis 连不上就当没锁, 记一行日志。
bool loginLocked(const std::string& name) {
    std::string v;
    std::string err;
    if (!redis::get(loginFailKey(name), &v, &err)) {
        if (!err.empty()) logmsg("[api] 读登录失败计数出错, 本次放行: %s\n", err.c_str());
        return false;
    }
    return std::strtoll(v.c_str(), nullptr, 10) >= kLoginMaxFails;
}

// 记一次失败。每次失败都续期: 一直撞就一直锁着, 停手 15 分钟自动解锁。
void noteLoginFail(const std::string& name) {
    std::string err;
    long long n = 0;
    if (!redis::incr(loginFailKey(name), &n, &err)) {
        if (!err.empty()) logmsg("[api] 记登录失败次数出错: %s\n", err.c_str());
        return;
    }
    redis::expire(loginFailKey(name), kLoginLockSecs, &err);
}

void clearLoginFails(const std::string& name) {
    std::string err;
    redis::del(loginFailKey(name), &err);
}

// ------------------------------------------------------------------ 令牌限流
// nginx 那层按 IP 限流, 挡不住"NAT 后一个 IP 挤着很多真人用户"和"单个账号被脚本刷"。
// 这层按令牌计数 (计数放 Redis, 多实例共享): 每个令牌每 PER_TOKEN_WINDOW_SECONDS 秒
// 最多 PER_TOKEN_RPM 次。阈值可用环境变量覆盖, 不配用默认; PER_TOKEN_RPM=0 关闭这层。
// Redis 故障时放行 —— 限流是保险丝, 不能因为它挂了把所有人挡在门外 (和登录锁定同思路)。
const long long kTokenRpm = envNum("PER_TOKEN_RPM", 600);
const long long kTokenWindowSecs = envNum("PER_TOKEN_WINDOW_SECONDS", 60);

bool tokenRateLimited(const std::string& token) {
    if (kTokenRpm <= 0) return false;
    // key 直接用令牌本体: 和 sessCacheKey 一样, 令牌是 64 位十六进制随机串, 在内部信任域
    const std::string key = "rl:tok:" + token;
    long long n = 0;
    std::string err;
    if (!redis::incrWithTtl(key, kTokenWindowSecs, &n, &err)) {
        if (!err.empty()) logmsg("[api] 令牌限流计数出错, 本次放行: %s\n", err.c_str());
        return false;
    }
    if (n > kTokenRpm) {
        metrics::countRateLimited();
        return true;
    }
    return false;
}

Resp apiLogin(const Request& req) {
    std::string name;
    std::string pass;
    if (!json::getString(req.body, "username", &name) || !json::getString(req.body, "password", &pass)) {
        return errJson(400, "请求体里要有 username 和 password 两个字符串字段");
    }
    // 锁定检查放在密码校验之前: 锁定期连 Argon2 都不跑 —— 每次校验固定吃 64MB 内存,
    // 不限住的话一个脚本就能把进程内存打满。
    if (loginLocked(name)) {
        const long long mins = (kLoginLockSecs + 59) / 60;
        return errJson(429, "尝试的次数太多了，请 " + std::to_string(mins) + " 分钟后再试");
    }
    bool remember = false;
    json::getBool(req.body, "remember", &remember);
    const auth::Result r = auth::login(name, pass, remember);
    if (r.status == auth::Status::BadCreds) {
        noteLoginFail(name);
        events::userEvent("login_failed", lower(name));  // 审计事件 (可选事件流)
    } else if (r.status == auth::Status::Ok) {
        clearLoginFails(name);
        clearSessCache(r.username);  // 一次登录只留一个会话: 把别处旧会话的缓存清掉
    }
    return fromAuthResult(r);
}

// 用"保持登录"的长期令牌换一个新的短期会话。前端开新标签页时走这条路。
Resp apiSessionResume(const Request& req) {
    std::string rememberToken;
    if (!json::getString(req.body, "remember_token", &rememberToken)) {
        return errJson(400, "请求体里要有 remember_token");
    }
    const auth::Result r = auth::resume(rememberToken);
    if (r.status == auth::Status::Ok) clearSessCache(r.username);  // 旧会话的缓存一起清掉
    return fromAuthResult(r);
}

Resp apiLogout(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string rememberToken;
    json::getString(req.body, "remember_token", &rememberToken);

    // 退出登录就别留在房间里了。失败不影响登出, 记一行日志就行
    // (房间 key 有 TTL, 就算这次没清掉, 一分钟以后也会自己消失)。
    std::string leaveErr;
    if (!presence::leave(req.token, &leaveErr)) {
        logmsg("[api] 退出登录时清房间失败: %s\n", leaveErr.c_str());
    }

    std::string err;
    if (auth::logout(req.token, rememberToken, &err) == auth::Check::Error) {
        logmsg("[api] 退出登录删令牌失败: %s\n", err.c_str());
        return errJson(500, "服务端清理会话失败");
    }
    // 令牌已吊销, 缓存副本立刻删掉, 否则最多 60 秒内旧令牌还能通过校验
    std::string cacheErr;
    if (!redis::del(sessCacheKey(req.token), &cacheErr)) {
        logmsg("[api] 退出登录删会话缓存失败: %s\n", cacheErr.c_str());
    }
    return okJson("{\"ok\":true}");
}

Resp apiMe(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;
    return okJson("{\"user\":" + json::quote(user) + "}");
}

// 这台实例的名字 (容器里就是 hostname)。多实例部署时用它确认负载均衡真的在分发。
const std::string& instanceName() {
    static const std::string name = [] {
        char buf[128] = {0};
        if (::gethostname(buf, sizeof buf - 1) != 0) return std::string("unknown");
        buf[sizeof buf - 1] = '\0';
        return std::string(buf);
    }();
    return name;
}

Resp apiHealth() {
    long long users = -1;
    std::string err;
    if (!db::countUsers(&users, &err)) {
        return okJson("{\"ok\":false,\"error\":\"数据库连不上\"}");
    }
    long long rooms = 0;
    if (!presence::activeRooms(&rooms, &err)) {
        return okJson("{\"ok\":false,\"error\":\"Redis 连不上\"}");
    }
    // instance 是给多实例部署排查用的: 反复请求这个接口, instance 应该会变
    return okJson("{\"ok\":true,\"users\":" + std::to_string(users) +
                  ",\"rooms\":" + std::to_string(rooms) +
                  ",\"instance\":" + json::quote(instanceName()) + "}");
}

Resp apiRoomsEnter(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string raw;
    const bool asked = json::getString(req.body, "room", &raw) && !raw.empty();

    std::string err;
    if (asked) {
        raw = normalizeRoom(raw);
        if (raw.size() < 3 || raw.size() > 40) {
            return errJson(400, "房间号只能用字母、数字和连字符，长度 3-40");
        }
    } else {
        // 房间在 Redis 里带 TTL, 空房间会自己消失, 所以这里只要问"这个号码现在活着吗"。
        // 两台后端同时分配出同一个号码的窗口极小, 而且真撞上了也只是两个人进了同一个房间,
        // 不是数据损坏, 所以不为了它上分布式锁。
        for (int i = 0; i < 8 && raw.empty(); ++i) {
            const std::string cand = randomRoomCode();
            bool live = false;
            if (!presence::roomLive(cand, &live, &err)) return errJson(500, "查房间失败：" + err);
            if (!live) raw = cand;
        }
        if (raw.empty()) return errJson(503, "分配不到空闲房间号，过会儿再试");
    }

    std::string pid;
    std::vector<presence::Member> members;
    switch (presence::enter(req.token, user, raw, &pid, &members, &err)) {
        case presence::Enter::Ok:
            // 会议生命周期事件 -> Kafka (可选, 尽力而为; 见 events.h)。
            // 房间号自动分配 = 这次进房顺带建了个新房间。
            if (!asked) events::roomEvent("room_created", raw, user);
            events::roomEvent("participant_joined", raw, user);
            {   // 会议历史 (room_visits 表): 尽力而为, 失败不影响进房
                std::string herr;
                db::recordVisit(user, raw, &herr);
            }
            break;
        case presence::Enter::Full:
            return errJson(409, "房间满了");
        case presence::Enter::Locked:
            return errJson(403, "会议已锁定，主持人解锁后才能进");
        default:
            return errJson(500, "进房间失败：" + err);
    }
    return okJson("{\"room\":" + json::quote(raw) +
                  ",\"participants\":" + peersJson(members, req.token) + "}");
}

// 房间同步: 一次请求拿回"成员列表 + 我的信令收件箱"。
// 合成一个接口是为了让前端只用一条轮询循环: 协商期间 400ms 一拍, 连上以后退回 2 秒。
Resp apiRoomsState(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    const uint64_t since = (uint64_t)queryInt(req.query, "since", 0);

    std::string room;
    std::vector<presence::Member> members;
    std::vector<presence::Signal> msgs;
    std::string hostPid;
    bool locked = false;
    std::string err;
    if (!presence::sync(req.token, since, &room, &members, &msgs, &hostPid, &locked, &err)) {
        return errJson(500, "同步房间状态失败：" + err);
    }

    // seq 只推进到"这一拍真的发出去的消息"为止, 不能用全局最大值:
    // 万一有一条 seq 更小的消息是在这次读取之后才写进信箱的, 用全局最大值就会把它永久跳过。
    uint64_t seq = since;
    std::string arr = "[";
    bool first = true;
    for (const presence::Signal& s : msgs) {
        if (!first) arr += ',';
        first = false;
        if (s.seq > seq) seq = s.seq;
        arr += "{\"seq\":";
        arr += std::to_string(s.seq);
        arr += ",\"from\":";
        arr += json::quote(s.from);
        arr += ",\"kind\":";
        arr += json::quote(s.kind);
        arr += ",\"payload\":";
        arr += s.payload;  // 客户端发来的原始 JSON 片段, 原样转回
        arr += '}';
    }
    arr += ']';

    // 房间聊天和成员列表同一拍带回 (省一次轮询): chat 参数是客户端已收到的最大消息 id。
    // 只有打开了聊天面板的前端才会带它; 不带就是 0, 会拿到最近的历史。
    const uint64_t chatAfter = (uint64_t)queryInt(req.query, "chat", 0);
    std::vector<presence::ChatMessage> chat;
    if (!presence::chatSince(room, chatAfter, &chat, &err)) {
        return errJson(500, "同步房间消息失败：" + err);
    }
    uint64_t chatSeq = chatAfter;
    std::string chatArr = "[";
    bool chatFirst = true;
    for (const presence::ChatMessage& m : chat) {
        if (!chatFirst) chatArr += ',';
        chatFirst = false;
        if (m.id > chatSeq) chatSeq = m.id;
        chatArr += "{\"id\":";
        chatArr += std::to_string(m.id);
        chatArr += ",\"from\":";
        chatArr += json::quote(m.from);
        chatArr += ",\"name\":";
        chatArr += json::quote(m.name);
        chatArr += ",\"text\":";
        chatArr += json::quote(m.text);
        chatArr += '}';
    }
    chatArr += ']';

    // 不在房间里了: 看看是不是刚被主持人移出 (踢人时留过标记), 好给前端一个准确的原因
    bool removed = false;
    if (room.empty()) {
        std::string v;
        std::string e;
        if (redis::get("kicked:" + req.token, &v, &e) && !v.empty()) {
            removed = true;
            redis::del("kicked:" + req.token, &e);
        }
    }

    return okJson("{\"room\":" + json::quote(room) +
                  ",\"participants\":" + peersJson(members, req.token) +
                  ",\"host\":" + json::quote(hostPid) +
                  ",\"locked\":" + (locked ? "true" : "false") +
                  ",\"removed\":" + (removed ? "true" : "false") +
                  ",\"seq\":" + std::to_string(seq) +
                  ",\"messages\":" + arr +
                  ",\"chat\":" + chatArr +
                  ",\"chatSeq\":" + std::to_string(chatSeq) + "}");
}

// 把一条信令放进目标参会者的收件箱。
// 服务器不看 payload 内容 (SDP / ICE candidate 都不用懂), 只做"同房间内"这个权限检查。
Resp apiRoomsSignal(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string to;
    std::string kind;
    if (!json::getString(req.body, "to", &to) || !json::getString(req.body, "kind", &kind)) {
        return errJson(400, "请求体里要有 to 和 kind");
    }
    if (to.empty() || to.size() > 64) return errJson(400, "to 不合法");
    if (kind.empty() || kind.size() > kMaxSignalKind) return errJson(400, "kind 不合法");

    std::string payload;
    if (!json::getRaw(req.body, "payload", &payload)) return errJson(400, "请求体里要有 payload");
    if (payload.size() > kMaxSignalPayload) return errJson(413, "信令内容太大了");

    std::string err;
    switch (presence::send(req.token, to, kind, payload, &err)) {
        case presence::Send::Delivered:
            return okJson("{\"ok\":true,\"delivered\":true}");
        case presence::Send::NoSuchPeer:
            return okJson("{\"ok\":true,\"delivered\":false}");
        case presence::Send::NotInRoom:
            return errJson(409, "你还没进房间");
        default:
            return errJson(500, "转发信令失败：" + err);
    }
}

// 房间聊天: 发一条消息。读取走 /api/rooms/state 的 chat 字段 (同一拍带回, 不用再轮询)。
// 文本校验 (非空 / 不超长 / 无控制字符) 在 presence::postChat 里。
Resp apiRoomsChat(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string text;
    if (!json::getString(req.body, "text", &text)) return errJson(400, "请求体里要有 text");

    presence::ChatMessage msg;
    std::string err;
    switch (presence::postChat(req.token, text, &msg, &err)) {
        case presence::Chat::Ok:
            break;
        case presence::Chat::NotInRoom:
            return errJson(409, "不在房间里, 不能发言");
        case presence::Chat::Empty:
            return errJson(400, "消息不能为空");
        case presence::Chat::TooLong:
            return errJson(413, "消息太长了");
        case presence::Chat::BadText:
            return errJson(400, "消息里有不允许的字符");
        default:
            return errJson(500, "发送消息失败：" + err);
    }
    return okJson("{\"id\":" + std::to_string(msg.id) +
                  ",\"from\":" + json::quote(msg.from) +
                  ",\"name\":" + json::quote(msg.name) +
                  ",\"text\":" + json::quote(msg.text) + "}");
}

// 举手 / 放手: 状态进房间成员表, 别人从 /api/rooms/state 的 participants[].hand 读到。
Resp apiRoomsHand(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    bool raised = false;
    if (!json::getBool(req.body, "raised", &raised)) return errJson(400, "请求体里要有 raised (布尔)");

    std::string err;
    switch (presence::setHand(req.token, raised, &err)) {
        case presence::Hand::Ok:
            return okJson(std::string("{\"ok\":true,\"hand\":") + (raised ? "true}" : "false}"));
        case presence::Hand::NotInRoom:
            return errJson(409, "你还没进房间");
        default:
            return errJson(500, "切换举手失败：" + err);
    }
}

// 主持人把某个成员移出房间。被踢的人的会话会被一并清掉, 下一次轮询拿到 401 -> 前端回登录页。
Resp apiRoomsKick(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string pid;
    if (!json::getString(req.body, "pid", &pid) || pid.empty()) return errJson(400, "请求体里要有 pid");

    std::string targetToken;
    std::string err;
    switch (presence::kick(req.token, pid, &targetToken, &err)) {
        case presence::Kick::Ok:
            break;
        case presence::Kick::NotHost:
            return errJson(403, "只有主持人能移出成员");
        case presence::Kick::NoSuchPeer:
            return errJson(404, "房间里没有这个人");
        case presence::Kick::NotInRoom:
            return errJson(409, "你还没进房间");
        default:
            return errJson(500, "移出失败：" + err);
    }
    // 留一个"被移出"的标记 (60 秒): 被踢的人下一拍轮询会发现房间空了, 靠这个标记知道
    // 原因是"被主持人移出", 而不是误报"服务端重启了"。标志用一次就删。
    if (!targetToken.empty()) {
        std::string markErr;
        redis::setEx("kicked:" + targetToken, "1", 60, &markErr);
    }
    return okJson("{\"ok\":true}");
}

// 麦克风开关上报: 让房间里别人看得见你是不是静音了 (状态进房间成员表, 从 participants[].mic 读)。
Resp apiRoomsMic(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    bool on = true;
    if (!json::getBool(req.body, "on", &on)) return errJson(400, "请求体里要有 on (布尔)");

    std::string err;
    switch (presence::setMic(req.token, on, &err)) {
        case presence::Mic::Ok:
            return okJson(std::string("{\"ok\":true,\"mic\":") + (on ? "true}" : "false}"));
        case presence::Mic::NotInRoom:
            return errJson(409, "你还没进房间");
        default:
            return errJson(500, "上报麦克风状态失败：" + err);
    }
}

// 会议锁定 / 解锁 (只有主持人能调)。锁上以后新的人进不来, 已经在里面的不受影响。
Resp apiRoomsLock(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    bool locked = true;
    if (!json::getBool(req.body, "locked", &locked)) return errJson(400, "请求体里要有 locked (布尔)");

    std::string err;
    switch (presence::setLocked(req.token, locked, &err)) {
        case presence::Lock::Ok:
            return okJson(std::string("{\"ok\":true,\"locked\":") + (locked ? "true}" : "false}"));
        case presence::Lock::NotHost:
            return errJson(403, "只有主持人能锁定 / 解锁会议");
        case presence::Lock::NotInRoom:
            return errJson(409, "你还没进房间");
        default:
            return errJson(500, "锁定失败：" + err);
    }
}

// 改密码。成功以后服务端会把其它令牌都吊销 (只留当前会话), 前端会提示"其它设备已下线"。
Resp apiPassword(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string oldPass;
    std::string newPass;
    if (!json::getString(req.body, "old_password", &oldPass) ||
        !json::getString(req.body, "new_password", &newPass)) {
        return errJson(400, "请求体里要有 old_password 和 new_password");
    }
    const auth::Result r = auth::changePassword(req.token, oldPass, newPass);
    if (r.status == auth::Status::Ok) {
        events::userEvent("password_changed", lower(user));   // 审计事件 (可选事件流)
        return okJson("{\"ok\":true}");
    }
    switch (r.status) {
        case auth::Status::BadRequest: return errJson(400, r.error);
        case auth::Status::BadCreds: return errJson(401, r.error);
        default: return errJson(500, r.error.empty() ? "改密码失败" : r.error);
    }
}

// 我的会议历史: 最近进过的房间 + 时长。数据来自 room_visits 表 (进/离房时写)。
Resp apiHistory(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    long long limit = queryInt(req.query, "limit", 20);
    if (limit < 1 || limit > 100) limit = 20;
    std::vector<db::Visit> visits;
    std::string err;
    if (!db::recentVisits(user, limit, &visits, &err)) {
        return errJson(500, "读会议历史失败：" + err);
    }
    std::string arr = "[";
    bool first = true;
    for (const db::Visit& v : visits) {
        if (!first) arr += ',';
        first = false;
        arr += "{\"room\":" + json::quote(v.room) +
               ",\"joined\":" + std::to_string(v.joinedSec) +
               ",\"left\":" + std::to_string(v.leftSec) +
               ",\"seconds\":" + std::to_string(v.seconds) + "}";
    }
    arr += ']';
    return okJson("{\"visits\":" + arr + "}");
}

Resp apiIce(const Request& req) {
    // 给浏览器用的 ICE 服务器列表。放服务端是为了改部署不用重发前端。
    // 必须登录: 配了 TURN 时这里会下发带时效的临时凭证, 不能对匿名访问者发放。
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    std::string servers = g_iceServers;
    if (!g_turnUrl.empty() && !g_turnSecret.empty()) {
        // TURN REST: 用户名是 "过期时间戳:账号", 口令是按同样字符串算的 HMAC-SHA1。
        // coturn 用同一份共享密钥校对口令, 过期自动失效, 静态口令不用进前端。
        const long long expiry = (long long)std::time(nullptr) + g_turnTtl;
        const std::string turnUser = std::to_string(expiry) + ":" + user;
        const std::string entry = "{\"urls\":" + json::quote(g_turnUrl) +
                                  ",\"username\":" + json::quote(turnUser) +
                                  ",\"credential\":" + json::quote(turncred::credential(g_turnSecret, turnUser)) + "}";

        // 把条目插在数组结尾。g_iceServers 经 setIceServers 校验过, 一定是 "[...]"。
        bool empty = true;
        for (char ch : servers) {
            if (ch != '[' && ch != ']' && !std::isspace((unsigned char)ch)) { empty = false; break; }
        }
        if (empty) {
            servers = "[" + entry + "]";
        } else {
            const size_t close = servers.rfind(']');
            servers = servers.substr(0, close) + "," + entry + "]";
        }
    }
    return okJson("{\"iceServers\":" + servers + "}");
}

Resp apiRoomsLeave(const Request& req) {
    std::string user;
    Resp fail;
    if (!requireAuth(req, &user, &fail)) return fail;

    // 离开后 session 就没了, 房间号要在 leave 之前问 (拿不到也不挡流程)
    std::string room;
    presence::Me me;
    std::string werr;
    if (presence::whereAmI(req.token, &me, &werr)) room = me.room;

    std::string err;
    if (!presence::leave(req.token, &err)) return errJson(500, "离开房间失败：" + err);
    if (!room.empty()) events::roomEvent("participant_left", room, user);
    {   // 会议历史: 把这次访问的 left_at 补上 (尽力而为, 失败不影响离开)
        std::string herr;
        db::closeVisit(user, room, &herr);
    }
    return okJson("{\"ok\":true}");
}

Resp routeApi(const Request& req) {
    const bool isPost = req.method == "POST";
    const bool isGet = req.method == "GET";

    if (req.path == "/api/health") {
        if (!isGet) return errJson(405, "这个接口只支持 GET");
        return apiHealth();
    }
    if (req.path == "/api/register") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRegister(req);
    }
    if (req.path == "/api/login") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiLogin(req);
    }
    if (req.path == "/api/session/resume") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiSessionResume(req);
    }
    if (req.path == "/api/logout") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiLogout(req);
    }
    if (req.path == "/api/me") {
        if (!isGet) return errJson(405, "这个接口只支持 GET");
        return apiMe(req);
    }
    if (req.path == "/api/password") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiPassword(req);
    }
    if (req.path == "/api/history") {
        if (!isGet) return errJson(405, "这个接口只支持 GET");
        return apiHistory(req);
    }
    if (req.path == "/api/rooms/enter") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsEnter(req);
    }
    if (req.path == "/api/rooms/state") {
        if (!isGet) return errJson(405, "这个接口只支持 GET");
        return apiRoomsState(req);
    }
    if (req.path == "/api/rooms/signal") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsSignal(req);
    }
    if (req.path == "/api/rooms/chat") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsChat(req);
    }
    if (req.path == "/api/rooms/hand") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsHand(req);
    }
    if (req.path == "/api/rooms/mic") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsMic(req);
    }
    if (req.path == "/api/rooms/kick") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsKick(req);
    }
    if (req.path == "/api/rooms/lock") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsLock(req);
    }
    if (req.path == "/api/ice") {
        if (!isGet) return errJson(405, "这个接口只支持 GET");
        return apiIce(req);
    }
    if (req.path == "/api/rooms/leave") {
        if (!isPost) return errJson(405, "这个接口只支持 POST");
        return apiRoomsLeave(req);
    }
    return errJson(404, "没有这个接口");
}

// ---------------------------------------------------------------- 静态资源
const char* mimeOf(const std::string& path) {
    const size_t dot = path.rfind('.');
    const std::string ext = (dot == std::string::npos) ? std::string() : lower(path.substr(dot));
    if (ext == ".html") return "text/html; charset=utf-8";
    if (ext == ".css") return "text/css; charset=utf-8";
    if (ext == ".js") return "text/javascript; charset=utf-8";
    if (ext == ".json") return "application/json; charset=utf-8";
    if (ext == ".svg") return "image/svg+xml";
    if (ext == ".png") return "image/png";
    if (ext == ".webp") return "image/webp";
    if (ext == ".ico") return "image/x-icon";
    if (ext == ".woff2") return "font/woff2";
    return "application/octet-stream";
}

// 只放行白名单字符的路径。这样根本不存在 ../ 穿越的可能, 不用再做规范化。
bool resolveStatic(const std::string& url, std::string* out) {
    if (url.empty() || url[0] != '/') return false;
    const size_t q = url.find('?');
    std::string p = (q == std::string::npos) ? url : url.substr(0, q);
    if (p == "/") p = "/index.html";
    if (p.size() > 128) return false;
    for (char ch : p) {
        const unsigned char c = (unsigned char)ch;
        const bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                        ch == '/' || ch == '.' || ch == '-' || ch == '_';
        if (!ok) return false;
    }
    if (p.find("..") != std::string::npos) return false;
    *out = g_webRoot + p;
    return true;
}

bool readWholeFile(const std::string& path, std::string* out) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    out->clear();
    char buf[64 * 1024];
    size_t n = 0;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) {
        out->append(buf, n);
        if (out->size() > kMaxFileBytes) break;
    }
    const bool ok = std::ferror(f) == 0;
    std::fclose(f);
    return ok;
}

Resp serveStatic(const std::string& url) {
    std::string file;
    if (!resolveStatic(url, &file)) return errText(400, "路径不合法");
    std::string body;
    if (!readWholeFile(file, &body)) return errText(404, "没有这个文件");
    Resp r;
    r.code = 200;
    r.type = mimeOf(file);
    r.body = std::move(body);
    return r;
}

// -------------------------------------------------------------------- 分发
void route(Connection& c, const Request& req) {
    const bool isApi = req.path.rfind("/api/", 0) == 0;

    const auto t0 = std::chrono::steady_clock::now();
    Resp r;
    if (req.method == "OPTIONS") {
        r.code = 204;  // 预检
    } else if (isApi) {
        r = routeApi(req);
    } else if (req.path == "/metrics" && req.method == "GET") {
        // 给 Prometheus 刮的纯文本指标。app 端口不对外发布, nginx 也不代理这个路径。
        r.code = 200;
        r.type = "text/plain; version=0.0.4; charset=utf-8";
        r.body = metrics::render();
    } else if (req.method == "GET") {
        r = serveStatic(req.path);
    } else {
        r = errText(405, "静态资源只支持 GET");
    }
    // 请求计数 + 延迟直方图 (纯内存原子操作, 开销可忽略; 见 metrics.cpp)
    const auto us = std::chrono::duration_cast<std::chrono::microseconds>(
                        std::chrono::steady_clock::now() - t0)
                        .count();
    metrics::observeRequest(metrics::classify(req.path), r.code, (uint64_t)us);

    if (isApi && req.method != "OPTIONS") {
        logmsg("[api] %s %s -> %d\n", req.method.c_str(), req.path.c_str(), r.code);
    } else if (!isApi && r.code != 200 && r.code != 204) {
        logmsg("[web] %s %s -> %d\n", req.method.c_str(), req.path.c_str(), r.code);
    }

    sendResp(c, r, req.keepAlive);
}

}  // namespace

// ------------------------------------------------------------------ 对外回调
void setWebRoot(const std::string& dir) { g_webRoot = dir; }

void setIceServers(const std::string& jsonArray) {
    // 只做最粗的检查: 必须是个非空数组。内容原样交给浏览器, 服务端不解析。
    if (jsonArray.size() >= 2 && jsonArray.front() == '[' && jsonArray.back() == ']') {
        g_iceServers = jsonArray;
    } else {
        logmsg("[srv] ICE_SERVERS 不是 JSON 数组, 忽略: %s\n", jsonArray.c_str());
    }
}

void setTurnConfig(const std::string& url, const std::string& secret, long long ttlSeconds) {
    g_turnUrl = url;
    g_turnSecret = secret;
    if (ttlSeconds > 0) g_turnTtl = ttlSeconds;
}

void onConnect(Connection& c) {
    logmsg("[conn] + %s fd=%d\n", c.peer.c_str(), c.fd);
}

void onMessage(Connection& c, const char* data, size_t len) {
    c.in.append(data, len);
    for (;;) {
        Request req;
        int err = 400;
        const Parse p = parseRequest(c.in, &req, &err);
        if (p == Parse::NeedMore) return;
        if (p == Parse::Bad) {
            respondAndClose(c, errJson(err, "请求格式不对"));
            return;
        }
        route(c, req);
        if (c.closed) return;
        if (!req.keepAlive) {
            if (c.out.empty()) {
                c.close();
            } else {
                c.closeAfterFlush = true;  // 还有没写完的, 让 onWritable 收尾
            }
            return;
        }
    }
}

void onClose(Connection& c) {
    // 房间在线状态靠心跳超时回收 (kPresenceTtlMs) + 定期清扫, 这里不用特意做什么
    logmsg("[conn] - %s\n", c.peer.c_str());
}
