// PostgreSQL 访问层。
//
// libpq 的 PGconn 不是线程安全的, 所以每个 worker 线程各拿一条连接 (thread_local 懒建,
// 断了下次用的时候自动重连)。业务侧把它当函数库用就行, 不用管连接从哪来。
//
// 所有语句都用参数绑定 (PQexecParams), 不做字符串拼接, 所以没有 SQL 注入面。
// 这里只管"怎么存", 密码怎么算、令牌怎么发是 auth.* 的事。
#pragma once

#include <string>
#include <vector>

namespace db {

// 进程启动时调一次 (在起线程池之前, 所以 g_conninfo 之后只读):
// 连接数据库 + 建表。数据库还没起来时会重试一小会儿。
bool init(const std::string& conninfo, const std::string& migrations_dir, std::string* err);

struct User {
    long long id = 0;
    std::string username;
    std::string passwordHash;  // 只有 findUser 会填
};

// 建账号。返回 false 时看 *err:
//   空     = 用户名已被占用 (正常业务情况)
//   非空   = 真的出错了
bool createUser(const std::string& username, const std::string& hash, User* out, std::string* err);

// 按用户名查账号 (大小写不敏感), 连 password_hash 一起取出来。查不到返回 false 且 *err 为空。
bool findUser(const std::string& username, User* out, std::string* err);

// 令牌。库里只存 SHA-256 十六进制, 不存明文。
enum class TokenKind { Session, Remember };

bool insertToken(const std::string& tokenHash, long long userId, TokenKind kind, long long ttlSeconds,
                 std::string* err);

struct TokenInfo {
    long long userId = 0;
    std::string username;
    TokenKind kind = TokenKind::Session;
};

// 查令牌, 过期的当作查不到。查不到返回 false 且 *err 为空。
bool lookupToken(const std::string& tokenHash, TokenInfo* out, std::string* err);

bool deleteToken(const std::string& tokenHash, std::string* err);

// 删掉某个账号的令牌 (换新会话时用: 一次登录只留一个有效会话 = "挤掉上一台设备")。
// keepHash 非空时保留这一枚 (resume 用的是长期令牌, 别把它自己清掉, 否则"保持登录"当场失效)。
bool deleteUserTokens(long long userId, const std::string& keepHash, std::string* err);

// 改密码 (hash 已经是算好的 Argon2id 字符串)
bool updatePassword(long long userId, const std::string& hash, std::string* err);

// 会议历史 (room_visits 表): 进房记一条, 离开补 left_at。
// recordVisit 会先把这个人上一条没关的先关掉 (被踢/掉线/崩溃都可能没走到 leave)。
bool recordVisit(const std::string& username, const std::string& room, std::string* err);
bool closeVisit(const std::string& username, const std::string& room, std::string* err);

struct Visit {
    std::string room;
    long long joinedSec = 0;   // 进房时间 (epoch 秒, 前端自己格式化)
    long long leftSec = 0;     // 0 = 还在会里
    long long seconds = 0;     // 时长 (进行中的按"到现在"算)
};
bool recentVisits(const std::string& username, long long limit, std::vector<Visit>* out,
                  std::string* err);

// 用户总数。给 /api/health 用, 顺便当"数据库还活着吗"的探针。
bool countUsers(long long* out, std::string* err);

// 顺手清掉过期的令牌 (登录/注册时做一次就够, 失败只记日志不报错)
void purgeExpired();

// --- 迁移机制内部用, 别处不要调 ---
// 执行一段 SQL (可以是用分号分隔的多条语句, 走 libpq 简单查询协议)。不看结果集。
bool execStatement(const std::string& sql, std::string* err);

// 执行一条带 $1..$n 参数的语句, 不看结果集。
bool execParams(const std::string& sql, const std::vector<std::string>& params, std::string* err);

// 执行一条带参数的查询, 第一行第一列写入 *out。查询成功但没有数据行时 *out 为空串。
// 返回 false = 查询本身失败 (*err 有原因), 与"没有数据行"是两回事。
bool queryScalar(const std::string& sql, const std::vector<std::string>& params, std::string* out,
                 std::string* err);

}  // namespace db
