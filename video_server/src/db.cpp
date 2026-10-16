#include "log.h"
#include "db.h"
#include "migration.h"

#include "metrics.h"

#include <libpq-fe.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

namespace db {
namespace {

std::string g_conninfo;

// 每个线程一条连接。libpq 的连接不能跨线程共用, 这样最省事:
// 不要连接池, 不用加锁, 断了下次用的时候自己重连。
thread_local PGconn* t_conn = nullptr;

std::string trimErr(const char* msg) {
    std::string s = msg ? msg : "";
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
    return s;
}

// 拿当前线程的连接, 必要时新建/重连。
PGconn* handle(std::string* err) {
    if (t_conn != nullptr && PQstatus(t_conn) == CONNECTION_OK) return t_conn;
    if (t_conn != nullptr) {
        PQfinish(t_conn);
        t_conn = nullptr;
    }
    t_conn = PQconnectdb(g_conninfo.c_str());
    if (t_conn == nullptr) {
        *err = "PQconnectdb 返回空";
        return nullptr;
    }
    if (PQstatus(t_conn) != CONNECTION_OK) {
        *err = trimErr(PQerrorMessage(t_conn));
        PQfinish(t_conn);
        t_conn = nullptr;
        return nullptr;
    }
    // libpq 是同步 API, 一条跑不完的语句能把整个 worker 线程卡死, 给个上限
    PQclear(PQexec(t_conn, "SET statement_timeout = '5s'"));
    return t_conn;
}

// 跑一条带参数的 SQL。成功返回结果集 (调用方 PQclear), 失败返回 nullptr 并填 *err。
// 连接坏了会重连并重试一次 (理由和 redis.cpp 的 run() 一样: thread_local 连接在
// PG 重启后要等"下一次使用"才发现坏, 恢复期每个连接各失败一次; 取舍也相同)。
PGresult* query(std::string* err, const char* sql, const std::vector<std::string>& params) {
    PGconn* c = handle(err);
    if (c == nullptr) {
        metrics::countDbError();
        return nullptr;
    }

    std::vector<const char*> values;
    values.reserve(params.size());
    for (const std::string& p : params) values.push_back(p.c_str());

    PGresult* r = PQexecParams(c, sql, (int)values.size(), nullptr,
                               values.empty() ? nullptr : values.data(), nullptr, nullptr, 0);
    if (PQstatus(c) == CONNECTION_BAD) {  // 连接坏了: 重连 + 重试一次
        metrics::countDbError();
        PQclear(r);
        PQfinish(t_conn);
        t_conn = nullptr;
        c = handle(err);
        if (c == nullptr) return nullptr;
        r = PQexecParams(c, sql, (int)values.size(), nullptr,
                         values.empty() ? nullptr : values.data(), nullptr, nullptr, 0);
    }
    const ExecStatusType st = PQresultStatus(r);
    if (st != PGRES_TUPLES_OK && st != PGRES_COMMAND_OK) {
        metrics::countDbError();
        *err = trimErr(PQresultErrorMessage(r));
        PQclear(r);
        return nullptr;
    }
    return r;
}

const char* kindName(TokenKind k) { return k == TokenKind::Remember ? "remember" : "session"; }

}  // namespace

// --- 迁移机制内部用 ---

bool execStatement(const std::string& sql, std::string* err) {
    PGconn* c = handle(err);
    if (c == nullptr) {
        metrics::countDbError();
        return false;
    }
    PGresult* r = PQexec(c, sql.c_str());
    if (PQstatus(c) == CONNECTION_BAD) {  // 连接坏了: 重连 + 重试一次
        metrics::countDbError();
        PQclear(r);
        PQfinish(t_conn);
        t_conn = nullptr;
        c = handle(err);
        if (c == nullptr) return false;
        r = PQexec(c, sql.c_str());
    }
    const ExecStatusType st = PQresultStatus(r);
    const bool ok = (st == PGRES_COMMAND_OK || st == PGRES_TUPLES_OK);
    if (!ok) {
        metrics::countDbError();
        *err = trimErr(PQresultErrorMessage(r));
    }
    PQclear(r);
    return ok;
}

bool execParams(const std::string& sql, const std::vector<std::string>& params, std::string* err) {
    PGresult* r = query(err, sql.c_str(), params);
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool queryScalar(const std::string& sql, const std::vector<std::string>& params, std::string* out,
                 std::string* err) {
    out->clear();
    PGresult* r = query(err, sql.c_str(), params);
    if (r == nullptr) return false;
    if (PQntuples(r) > 0 && PQnfields(r) > 0) *out = PQgetvalue(r, 0, 0);
    PQclear(r);
    return true;
}

bool init(const std::string& conninfo, const std::string& migrations_dir, std::string* err) {
    g_conninfo = conninfo;

    // 默认 connect_timeout 是 0 (等操作系统超时, 可能两分钟), 这里压到 3 秒,
    // 不然连错地址时整个进程会像死了一样卡住。URI 和 key=value 两种写法要分开处理。
    if (g_conninfo.rfind("postgres://", 0) == 0 || g_conninfo.rfind("postgresql://", 0) == 0) {
        g_conninfo += (g_conninfo.find('?') == std::string::npos) ? "?connect_timeout=3" : "&connect_timeout=3";
    } else if (g_conninfo.find("connect_timeout") == std::string::npos) {
        g_conninfo += " connect_timeout=3";
    }

    // 起来的时候数据库可能还没就绪 (compose 里很常见), 重试一小会儿
    constexpr int kTries = 10;
    std::string last;
    for (int i = 0; i < kTries; ++i) {
        std::string e;
        if (handle(&e) != nullptr) {
            // 连上了就跑迁移 (幂等)。建表/改表失败属于配置或迁移文件问题, 重试没意义。
            if (!migration::run(migrations_dir, err)) {
                *err = "迁移失败: " + *err;
                return false;
            }
            return true;
        }
        last = e;
        if (i + 1 < kTries) {
            logmsg("[db] 连不上数据库, 1 秒后重试 (%d/%d): %s\n", i + 1, kTries, e.c_str());
            std::this_thread::sleep_for(std::chrono::seconds(1));
        }
    }
    *err = "连不上数据库: " + last;
    return false;
}

bool createUser(const std::string& username, const std::string& hash, User* out, std::string* err) {
    err->clear();
    // 靠唯一约束防并发重名, 不靠先查后插 (那样有竞态)
    PGresult* r = query(err,
                        "INSERT INTO users (username, username_lc, password_hash) "
                        "VALUES ($1, lower($1), $2) "
                        "ON CONFLICT (username_lc) DO NOTHING "
                        "RETURNING id, username",
                        {username, hash});
    if (r == nullptr) return false;

    const bool made = PQntuples(r) == 1;
    if (made) {
        out->id = std::strtoll(PQgetvalue(r, 0, 0), nullptr, 10);
        out->username = PQgetvalue(r, 0, 1);
    }
    PQclear(r);
    return made;  // false 且 *err 为空 = 用户名被占了
}

bool findUser(const std::string& username, User* out, std::string* err) {
    err->clear();
    PGresult* r = query(err, "SELECT id, username, password_hash FROM users WHERE username_lc = lower($1)",
                        {username});
    if (r == nullptr) return false;

    const bool found = PQntuples(r) == 1;
    if (found) {
        out->id = std::strtoll(PQgetvalue(r, 0, 0), nullptr, 10);
        out->username = PQgetvalue(r, 0, 1);
        out->passwordHash = PQgetvalue(r, 0, 2);
    }
    PQclear(r);
    return found;
}

bool insertToken(const std::string& tokenHash, long long userId, TokenKind kind, long long ttlSeconds,
                 std::string* err) {
    err->clear();
    PGresult* r = query(err,
                        "INSERT INTO auth_tokens (token_hash, user_id, kind, expires_at) "
                        "VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision))",
                        {tokenHash, std::to_string(userId), kindName(kind), std::to_string(ttlSeconds)});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool lookupToken(const std::string& tokenHash, TokenInfo* out, std::string* err) {
    err->clear();
    // 纯读, 不写 last_seen —— 前端每 2 秒就要查一次房间状态, 每次都写库没必要
    PGresult* r = query(err,
                        "SELECT t.user_id, u.username, t.kind "
                        "  FROM auth_tokens t JOIN users u ON u.id = t.user_id "
                        " WHERE t.token_hash = $1 AND t.expires_at > now()",
                        {tokenHash});
    if (r == nullptr) return false;

    const bool found = PQntuples(r) == 1;
    if (found) {
        out->userId = std::strtoll(PQgetvalue(r, 0, 0), nullptr, 10);
        out->username = PQgetvalue(r, 0, 1);
        out->kind = (std::string(PQgetvalue(r, 0, 2)) == "remember") ? TokenKind::Remember
                                                                    : TokenKind::Session;
    }
    PQclear(r);
    return found;
}

bool deleteToken(const std::string& tokenHash, std::string* err) {
    err->clear();
    PGresult* r = query(err, "DELETE FROM auth_tokens WHERE token_hash = $1", {tokenHash});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool deleteUserTokens(long long userId, const std::string& keepHash, std::string* err) {
    err->clear();
    PGresult* r = nullptr;
    if (keepHash.empty()) {
        r = query(err, "DELETE FROM auth_tokens WHERE user_id = $1", {std::to_string(userId)});
    } else {
        r = query(err, "DELETE FROM auth_tokens WHERE user_id = $1 AND token_hash <> $2",
                  {std::to_string(userId), keepHash});
    }
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool updatePassword(long long userId, const std::string& hash, std::string* err) {
    err->clear();
    PGresult* r = query(err, "UPDATE users SET password_hash = $2 WHERE id = $1",
                        {std::to_string(userId), hash});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool closeVisit(const std::string& username, const std::string& room, std::string* err) {
    err->clear();
    PGresult* r = nullptr;
    if (room.empty()) {
        r = query(err,
                  "UPDATE room_visits SET left_at = now() WHERE username = $1 AND left_at IS NULL",
                  {username});
    } else {
        r = query(err,
                  "UPDATE room_visits SET left_at = now() "
                  "WHERE username = $1 AND room = $2 AND left_at IS NULL",
                  {username, room});
    }
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool recordVisit(const std::string& username, const std::string& room, std::string* err) {
    // 先把上一条没关的关掉, 再记新的
    if (!closeVisit(username, std::string(), err)) return false;
    PGresult* r = query(err, "INSERT INTO room_visits (username, room) VALUES ($1, $2)",
                        {username, room});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

// ------------------------------------------------------------------ 会议录制
// 字节在 blob 层 (blob.h), 这里只管元数据。object_key 由调用方生成。
bool addRecording(const std::string& username, const std::string& room, const std::string& objectKey,
                  long long seconds, long long* id, std::string* err) {
    err->clear();
    PGresult* r = query(err,
                        "INSERT INTO recordings (username, room, object_key, seconds) "
                        "VALUES ($1, $2, $3, $4) RETURNING id",
                        {username, room, objectKey, std::to_string(seconds)});
    if (r == nullptr) return false;
    *id = std::strtoll(PQgetvalue(r, 0, 0), nullptr, 10);
    PQclear(r);
    return true;
}

bool addRecordingBytes(long long id, long long bytes, std::string* err) {
    err->clear();
    PGresult* r = query(err, "UPDATE recordings SET bytes = $1 WHERE id = $2",
                        {std::to_string(bytes), std::to_string(id)});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool listRecordings(const std::string& username, std::vector<Recording>* out, std::string* err) {
    err->clear();
    PGresult* r = query(err,
                        "SELECT id, room, object_key, bytes, seconds,"
                        "       EXTRACT(EPOCH FROM created_at)::bigint "
                        "  FROM recordings WHERE username = $1 ORDER BY created_at DESC LIMIT 200",
                        {username});
    if (r == nullptr) return false;
    for (int i = 0; i < PQntuples(r); ++i) {
        Recording rec;
        rec.id = std::strtoll(PQgetvalue(r, i, 0), nullptr, 10);
        rec.room = PQgetvalue(r, i, 1);
        rec.objectKey = PQgetvalue(r, i, 2);
        rec.bytes = std::strtoll(PQgetvalue(r, i, 3), nullptr, 10);
        rec.seconds = std::strtoll(PQgetvalue(r, i, 4), nullptr, 10);
        rec.createdSec = std::strtoll(PQgetvalue(r, i, 5), nullptr, 10);
        out->push_back(std::move(rec));
    }
    PQclear(r);
    return true;
}

bool getRecording(const std::string& username, long long id, Recording* out, std::string* err) {
    err->clear();
    *out = Recording();
    PGresult* r = query(err,
                        "SELECT id, room, object_key, bytes, seconds,"
                        "       EXTRACT(EPOCH FROM created_at)::bigint "
                        "  FROM recordings WHERE id = $1 AND username = $2",
                        {std::to_string(id), username});
    if (r == nullptr) return false;
    if (PQntuples(r) == 1) {
        out->id = std::strtoll(PQgetvalue(r, 0, 0), nullptr, 10);
        out->room = PQgetvalue(r, 0, 1);
        out->objectKey = PQgetvalue(r, 0, 2);
        out->bytes = std::strtoll(PQgetvalue(r, 0, 3), nullptr, 10);
        out->seconds = std::strtoll(PQgetvalue(r, 0, 4), nullptr, 10);
        out->createdSec = std::strtoll(PQgetvalue(r, 0, 5), nullptr, 10);
    }
    PQclear(r);
    return true;   // 查不到不算错: 调用方看 out->id == 0 (和 getProfile 一个规矩)
}

bool deleteRecording(const std::string& username, long long id, std::string* err) {
    err->clear();
    PGresult* r = query(err, "DELETE FROM recordings WHERE id = $1 AND username = $2",
                        {std::to_string(id), username});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool expiredRecordings(long long olderThanSec, std::vector<std::string>* keys, std::string* err) {
    err->clear();
    PGresult* r = query(err,
                        "DELETE FROM recordings WHERE created_at < now() - ($1 || ' seconds')::interval "
                        "RETURNING object_key",
                        {std::to_string(olderThanSec)});
    if (r == nullptr) return false;
    for (int i = 0; i < PQntuples(r); ++i) keys->push_back(PQgetvalue(r, i, 0));
    PQclear(r);
    return true;
}

bool recentVisits(const std::string& username, long long limit, std::vector<Visit>* out,
                  std::string* err) {
    err->clear();
    PGresult* r = query(err,
                        "SELECT room,"
                        "       EXTRACT(EPOCH FROM joined_at)::bigint,"
                        "       COALESCE(EXTRACT(EPOCH FROM left_at)::bigint, 0),"
                        "       EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - joined_at))::bigint "
                        "  FROM room_visits WHERE username = $1 "
                        " ORDER BY joined_at DESC LIMIT $2",
                        {username, std::to_string(limit)});
    if (r == nullptr) return false;
    for (int i = 0; i < PQntuples(r); ++i) {
        Visit v;
        v.room = PQgetvalue(r, i, 0);
        v.joinedSec = std::strtoll(PQgetvalue(r, i, 1), nullptr, 10);
        v.leftSec = std::strtoll(PQgetvalue(r, i, 2), nullptr, 10);
        v.seconds = std::strtoll(PQgetvalue(r, i, 3), nullptr, 10);
        out->push_back(std::move(v));
    }
    PQclear(r);
    return true;
}

bool getProfile(const std::string& username, Profile* out, std::string* err) {
    err->clear();
    PGresult* r = query(err, "SELECT username, display_name, avatar_ver FROM users WHERE username = $1",
                        {username});
    if (r == nullptr) return false;
    const bool found = PQntuples(r) == 1;
    if (found) {
        out->username = PQgetvalue(r, 0, 0);
        out->displayName = PQgetvalue(r, 0, 1);
        out->avatarVer = std::strtoll(PQgetvalue(r, 0, 2), nullptr, 10);
    }
    PQclear(r);
    return found;
}

bool setDisplayName(const std::string& username, const std::string& name, std::string* err) {
    err->clear();
    PGresult* r = query(err, "UPDATE users SET display_name = $2 WHERE username = $1",
                        {username, name});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool setAvatar(const std::string& username, const std::string& dataUrl, std::string* err) {
    err->clear();
    PGresult* r = query(err,
                        "UPDATE users SET avatar = $2, avatar_ver = avatar_ver + 1 WHERE username = $1",
                        {username, dataUrl});
    if (r == nullptr) return false;
    PQclear(r);
    return true;
}

bool getAvatar(const std::string& username, std::string* dataUrl, std::string* err) {
    err->clear();
    dataUrl->clear();
    PGresult* r = query(err, "SELECT avatar FROM users WHERE username = $1", {username});
    if (r == nullptr) return false;
    if (PQntuples(r) == 1 && PQnfields(r) == 1) *dataUrl = PQgetvalue(r, 0, 0);
    PQclear(r);
    return true;
}

bool countUsers(long long* out, std::string* err) {
    err->clear();
    PGresult* r = query(err, "SELECT count(*) FROM users", {});
    if (r == nullptr) return false;
    *out = std::strtoll(PQgetvalue(r, 0, 0), nullptr, 10);
    PQclear(r);
    return true;
}

void purgeExpired() {
    std::string err;
    PGresult* r = query(&err, "DELETE FROM auth_tokens WHERE expires_at < now()", {});
    if (r != nullptr) {
        PQclear(r);
        return;
    }
    if (!err.empty()) logmsg("[db] 清理过期令牌失败: %s\n", err.c_str());
}

}  // namespace db
