// 一个够用就好的 Redis 客户端。
//
// 用 hiredis 的同步接口, 每个线程一条连接 (和 db.cpp 一个路子: hiredis 的
// redisContext 不能跨线程共用, 所以 thread_local 懒建、断了自动重连)。
// 所有命令都用 redisCommandArgv 传参数数组而不是拼字符串, 所以用户名里的
// 空格、引号、换行都不会把命令拆坏。
#pragma once

#include <string>
#include <vector>

namespace redis {

// 进程启动时调一次 (在起线程池之前)。url 形如 redis://[:密码@]主机:端口[/库号]
bool init(const std::string& url, std::string* err);

struct Field {
    std::string name;
    std::string value;
};

// 下面这些统一的约定: 成功返回 true。
// get 找不到 key 时返回 false 且 *err 为空 (和 db.* 一个习惯), *err 非空才是真出错。

bool get(const std::string& key, std::string* out, std::string* err);
bool setEx(const std::string& key, const std::string& value, long long ttlSec, std::string* err);
bool del(const std::string& key, std::string* err);
bool expire(const std::string& key, long long ttlSec, std::string* err);
bool exists(const std::string& key, bool* out, std::string* err);

bool hGetAll(const std::string& key, std::vector<Field>* out, std::string* err);
bool hSet(const std::string& key, const std::string& field, const std::string& value, std::string* err);
bool hDel(const std::string& key, const std::string& field, std::string* err);
bool hLen(const std::string& key, long long* out, std::string* err);

bool rPush(const std::string& key, const std::string& value, std::string* err);
bool lRange(const std::string& key, std::vector<std::string>* out, std::string* err);
// 只保留最后 n 条 (LTRIM -n -1)
bool lKeepLast(const std::string& key, long long n, std::string* err);

// 全局单调计数器。多台后端不能各发各的序号, 信令的 seq 必须全局唯一且递增。
bool incr(const std::string& key, long long* out, std::string* err);

// 原子地往信令收件箱里追加一条: 取序号 -> 拼条目 -> 入队 -> 裁剪 -> 续期,
// 五步在一个 Lua 脚本里跑完, Redis 执行脚本期间不掺别的命令。
// 为什么必须原子: 取号和入队要是分两步, 并发下会"序号小的条目后入队",
// 收件人用 since 游标过滤时会把它永久跳过 (这条信令就丢了)。
// sep 是条目内的分隔符 (0x1f); maxLen 只保留最后多少条; ttlSec 给收件箱续期。
// 成功时 *seq 是本次分配的序号。
bool mailboxPush(const std::string& seqKey, const std::string& mailboxKey,
                 const std::string& fromPid, const std::string& kind,
                 const std::string& payload, const std::string& sep,
                 long long maxLen, long long ttlSec, long long* seq, std::string* err);

// 数一下匹配的 key 有多少个, 最多数 limit 个 (给 /api/health 用, 不是精确值)
bool countKeys(const std::string& pattern, long long limit, long long* out, std::string* err);

}  // namespace redis
