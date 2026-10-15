#include "redis.h"

#include "metrics.h"

#include <hiredis/hiredis.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace redis {
namespace {

std::string g_host = "127.0.0.1";
int g_port = 6379;
std::string g_password;
int g_db = 0;
bool g_inited = false;

// hiredis 的同步连接不能跨线程用 -> 每线程一条, 断了下次用的时候重连
thread_local redisContext* t_ctx = nullptr;

// 把一条命令的返回值包起来, 出了作用域自动释放
struct Reply {
    redisReply* r = nullptr;
    Reply() = default;
    explicit Reply(redisReply* p) : r(p) {}
    Reply(const Reply&) = delete;
    Reply& operator=(const Reply&) = delete;
    Reply(Reply&& o) noexcept : r(o.r) { o.r = nullptr; }
    Reply& operator=(Reply&& o) noexcept {
        if (this != &o) {
            if (r != nullptr) freeReplyObject(r);
            r = o.r;
            o.r = nullptr;
        }
        return *this;
    }
    ~Reply() {
        if (r != nullptr) freeReplyObject(r);
    }
    bool ok() const { return r != nullptr && r->type != REDIS_REPLY_ERROR; }
    std::string errText() const {
        if (r == nullptr) return "hiredis 返回空";
        if (r->type == REDIS_REPLY_ERROR) return r->str ? std::string(r->str, r->len) : "redis 报错";
        return std::string();
    }
};

Reply command(redisContext* c, const std::vector<std::string>& args) {
    std::vector<const char*> argv;
    std::vector<size_t> lens;
    argv.reserve(args.size());
    lens.reserve(args.size());
    for (const std::string& a : args) {
        argv.push_back(a.data());
        lens.push_back(a.size());
    }
    return Reply((redisReply*)redisCommandArgv(c, (int)args.size(), argv.data(), lens.data()));
}

redisContext* handle(std::string* err) {
    if (!g_inited) {
        *err = "redis::init 还没调";
        return nullptr;
    }
    if (t_ctx != nullptr && t_ctx->err == 0) return t_ctx;
    if (t_ctx != nullptr) {
        redisFree(t_ctx);
        t_ctx = nullptr;
    }

    timeval connectTimeout{2, 0};
    redisContext* c = redisConnectWithTimeout(g_host.c_str(), g_port, connectTimeout);
    if (c == nullptr) {
        *err = "连不上 redis (" + g_host + ":" + std::to_string(g_port) + ")";
        return nullptr;
    }
    if (c->err != 0) {
        *err = c->errstr;
        redisFree(c);
        return nullptr;
    }
    // 同步接口: 一条卡住的命令会把整个 worker 线程拖死, 给个上限
    timeval opTimeout{3, 0};
    redisSetTimeout(c, opTimeout);

    if (!g_password.empty()) {
        Reply r = command(c, {"AUTH", g_password});
        if (!r.ok()) {
            *err = "AUTH 失败: " + r.errText();
            redisFree(c);
            return nullptr;
        }
    }
    if (g_db != 0) {
        Reply r = command(c, {"SELECT", std::to_string(g_db)});
        if (!r.ok()) {
            *err = "SELECT 失败: " + r.errText();
            redisFree(c);
            return nullptr;
        }
    }

    t_ctx = c;
    return t_ctx;
}

// 跑一条命令。失败时 *err 一定有值; 连接坏了就重连并重试一次, 还不行才把错误抛出去。
//
// 为什么必须重试: hiredis 的连接坏了不会立刻知道, 而每个 worker 线程各持一条
// thread_local 连接 —— Redis 重启后, 每条连接都要等"下一次使用"才发现自己坏了,
// 于是恢复后的最初十几次请求会分散地各失败一次 (实测: 3 副本 × 4 线程 ≈ 12 条连接,
// 每条失败一次才各自重连)。重连重试把这个窗口消掉, 恢复变成无感的。
// 取舍: 命令"已到服务端但回包丢了"时可能重复执行一次, 对本项目的用途
// (计数 / 信令信箱 / 查询) 可接受。
Reply run(std::string* err, const std::vector<std::string>& args) {
    redisContext* c = handle(err);
    if (c == nullptr) return Reply();

    Reply r = command(c, args);
    if (!r.ok() && c->err != 0) {  // 连接级错误: 重连 + 重试一次
        metrics::countRedisError();
        redisFree(t_ctx);
        t_ctx = nullptr;
        c = handle(err);
        if (c == nullptr) return Reply();
        r = command(c, args);
    }
    if (!r.ok()) {
        *err = r.errText();
        if (c->err != 0) {  // 重试后还坏: 丢掉, 下次重来
            redisFree(t_ctx);
            t_ctx = nullptr;
        }
    }
    return r;
}

// %XX 解码, 只用在密码上 (密码里有 @ / 之类字符时得转义)
std::string percentDecode(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            const auto hex = [](char ch) -> int {
                if (ch >= '0' && ch <= '9') return ch - '0';
                if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
                if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
                return -1;
            };
            const int hi = hex(s[i + 1]);
            const int lo = hex(s[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out.push_back((char)((hi << 4) | lo));
                i += 2;
                continue;
            }
        }
        out.push_back(s[i]);
    }
    return out;
}

bool parseUrl(const std::string& url, std::string* err) {
    std::string s = url;
    const std::string scheme = "redis://";
    if (s.rfind(scheme, 0) == 0) s = s.substr(scheme.size());
    if (s.empty()) {
        *err = "redis 地址是空的";
        return false;
    }

    const size_t slash = s.find('/');
    std::string dbPart;
    if (slash != std::string::npos) {
        dbPart = s.substr(slash + 1);
        s = s.substr(0, slash);
    }

    const size_t at = s.rfind('@');
    if (at != std::string::npos) {
        g_password = percentDecode(s.substr(0, at));
        s = s.substr(at + 1);
    }

    const size_t colon = s.rfind(':');
    if (colon != std::string::npos) {
        g_host = s.substr(0, colon);
        const int p = std::atoi(s.substr(colon + 1).c_str());
        if (p < 1 || p > 65535) {
            *err = "redis 端口不合法";
            return false;
        }
        g_port = p;
    } else {
        g_host = s;
    }
    if (g_host.empty()) {
        *err = "redis 主机是空的";
        return false;
    }
    if (!dbPart.empty()) g_db = std::atoi(dbPart.c_str());
    return true;
}

// 收件箱入队脚本 (配合 redis.h 里 mailboxPush 的注释看)。
// 条目格式 "seq\x1ffrom\x1fkind\x1fpayload" 和 presence.cpp 的 splitN 对齐;
// 分隔符由调用方从 ARGV[1] 传进来, 免得在脚本里写转义。
constexpr char kMailboxPushScript[] = R"(local seq = redis.call('INCR', KEYS[1])
redis.call('RPUSH', KEYS[2], seq .. ARGV[1] .. ARGV[2] .. ARGV[1] .. ARGV[3] .. ARGV[1] .. ARGV[4])
redis.call('LTRIM', KEYS[2], -tonumber(ARGV[5]), -1)
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[6]))
return seq)";

// 固定窗口计数: 首次 INCR 到的 key 顺手设 TTL, 两步在一个脚本里跑完 (见 redis.h 的注释)。
constexpr char kIncrWithTtlScript[] = R"(local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])) end
return n)";

}  // namespace

bool init(const std::string& url, std::string* err) {
    err->clear();
    if (!parseUrl(url, err)) return false;
    g_inited = true;

    // 连一次确认可用, 免得服务起来了才发现 Redis 是错的
    std::string e;
    if (handle(&e) == nullptr) {
        *err = "redis 初始化失败: " + e;
        g_inited = false;
        return false;
    }
    return true;
}

bool get(const std::string& key, std::string* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"GET", key});
    if (!r.ok()) return false;
    if (r.r->type == REDIS_REPLY_NIL) return false;  // err 为空 = 不存在
    *out = std::string(r.r->str, (size_t)r.r->len);
    return true;
}

bool setEx(const std::string& key, const std::string& value, long long ttlSec, std::string* err) {
    err->clear();
    return run(err, {"SET", key, value, "EX", std::to_string(ttlSec)}).ok();
}

bool del(const std::string& key, std::string* err) {
    err->clear();
    return run(err, {"DEL", key}).ok();
}

bool expire(const std::string& key, long long ttlSec, std::string* err) {
    err->clear();
    return run(err, {"EXPIRE", key, std::to_string(ttlSec)}).ok();
}

bool exists(const std::string& key, bool* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"EXISTS", key});
    if (!r.ok()) return false;
    *out = r.r->integer != 0;
    return true;
}

bool hGetAll(const std::string& key, std::vector<Field>* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"HGETALL", key});
    if (!r.ok()) return false;
    if (r.r->type != REDIS_REPLY_ARRAY) return true;  // 空
    for (size_t i = 0; i + 1 < r.r->elements; i += 2) {
        const redisReply* f = r.r->element[i];
        const redisReply* v = r.r->element[i + 1];
        Field field;
        field.name.assign(f->str, (size_t)f->len);
        field.value.assign(v->str, (size_t)v->len);
        out->push_back(std::move(field));
    }
    return true;
}

bool hSet(const std::string& key, const std::string& field, const std::string& value, std::string* err) {
    err->clear();
    return run(err, {"HSET", key, field, value}).ok();
}

bool hDel(const std::string& key, const std::string& field, std::string* err) {
    err->clear();
    return run(err, {"HDEL", key, field}).ok();
}

bool hLen(const std::string& key, long long* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"HLEN", key});
    if (!r.ok()) return false;
    *out = r.r->integer;
    return true;
}

bool rPush(const std::string& key, const std::string& value, std::string* err) {
    err->clear();
    return run(err, {"RPUSH", key, value}).ok();
}

bool lRange(const std::string& key, std::vector<std::string>* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"LRANGE", key, "0", "-1"});
    if (!r.ok()) return false;
    if (r.r->type != REDIS_REPLY_ARRAY) return true;
    for (size_t i = 0; i < r.r->elements; ++i) {
        const redisReply* e = r.r->element[i];
        out->emplace_back(e->str, (size_t)e->len);
    }
    return true;
}

bool lKeepLast(const std::string& key, long long n, std::string* err) {
    err->clear();
    return run(err, {"LTRIM", key, "-" + std::to_string(n), "-1"}).ok();
}

bool incr(const std::string& key, long long* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"INCR", key});
    if (!r.ok()) return false;
    *out = r.r->integer;
    return true;
}

bool incrWithTtl(const std::string& key, long long ttlSec, long long* out, std::string* err) {
    err->clear();
    Reply r = run(err, {"EVAL", kIncrWithTtlScript, "1", key, std::to_string(ttlSec)});
    if (!r.ok()) return false;
    if (r.r->type != REDIS_REPLY_INTEGER) {
        *err = "incrWithTtl: 脚本没返回整数";
        return false;
    }
    *out = r.r->integer;
    return true;
}

bool mailboxPush(const std::string& seqKey, const std::string& mailboxKey,
                 const std::string& fromPid, const std::string& kind,
                 const std::string& payload, const std::string& sep,
                 long long maxLen, long long ttlSec, long long* seq, std::string* err) {
    err->clear();
    Reply r = run(err, {"EVAL", kMailboxPushScript, "2", seqKey, mailboxKey,
                        sep, fromPid, kind, payload,
                        std::to_string(maxLen), std::to_string(ttlSec)});
    if (!r.ok()) return false;
    if (r.r->type != REDIS_REPLY_INTEGER) {
        *err = "mailboxPush: 脚本没返回序号";
        return false;
    }
    *seq = r.r->integer;
    return true;
}

bool countKeys(const std::string& pattern, long long limit, long long* out, std::string* err) {
    err->clear();
    *out = 0;
    std::string cursor = "0";
    long long seen = 0;
    do {
        Reply r = run(err, {"SCAN", cursor, "MATCH", pattern, "COUNT", "200"});
        if (!r.ok()) return false;
        if (r.r->type != REDIS_REPLY_ARRAY || r.r->elements != 2) return true;
        cursor.assign(r.r->element[0]->str, (size_t)r.r->element[0]->len);
        const redisReply* keys = r.r->element[1];
        if (keys->type == REDIS_REPLY_ARRAY) {
            *out += (long long)keys->elements;
            seen += (long long)keys->elements;
        }
    } while (cursor != "0" && seen < limit);
    return true;
}

}  // namespace redis
