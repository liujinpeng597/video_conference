#include "log.h"
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "auth.h"
#include "db.h"
#include "events.h"
#include "handlers.h"
#include "redis.h"
#include "server.h"

namespace {

const char* kDefaultDb = "postgresql://video:video@127.0.0.1:5432/video_conference";
const char* kDefaultRedis = "redis://127.0.0.1:6379";

void usage(const char* prog) {
    logmsg(
                 "usage: %s [--port N] [--workers N] [--web DIR] [--db CONNINFO] [--redis URL]\n"
                 "  --web DIR       前端静态资源目录, 默认 ../video_client\n"
                 "  --db CONNINFO   PostgreSQL 连接串, 默认取 DATABASE_URL, 再没有就用 %s\n"
                 "  --redis URL     Redis 连接串, 默认取 REDIS_URL, 再没有就用 %s\n",
                 prog, kDefaultDb, kDefaultRedis);
}

}  // namespace

int main(int argc, char** argv) {
    uint16_t port = 9000;
    int workers = 0;  // 0 = 按 CPU 核数
    std::string web = "../video_client";

    std::string dbUrl;
    if (const char* env = std::getenv("DATABASE_URL")) dbUrl = env;
    if (dbUrl.empty()) dbUrl = kDefaultDb;

    std::string redisUrl;
    if (const char* env = std::getenv("REDIS_URL")) redisUrl = env;
    if (redisUrl.empty()) redisUrl = kDefaultRedis;

    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "-h" || a == "--help") {
            usage(argv[0]);
            return 0;
        }
        if (i + 1 >= argc) {
            logmsg("%s needs a value\n", a.c_str());
            usage(argv[0]);
            return 2;
        }
        const std::string v = argv[++i];

        if (a == "--web") {
            web = v;
        } else if (a == "--db") {
            dbUrl = v;
        } else if (a == "--redis") {
            redisUrl = v;
        } else if (a == "--port") {
            const int n = std::atoi(v.c_str());
            if (n < 1 || n > 65535) {
                logmsg("bad port: %s\n", v.c_str());
                return 2;
            }
            port = (uint16_t)n;
        } else if (a == "--workers") {
            workers = std::atoi(v.c_str());
        } else {
            usage(argv[0]);
            return 2;
        }
    }

    // 算密码用的 libsodium 初始化和那个等时占位哈希, 要在起线程池之前做完
    auth::init();

    std::string dbErr;
    if (!db::init(dbUrl, &dbErr)) {
        logmsg("[srv] 数据库初始化失败: %s\n", dbErr.c_str());
        logmsg("[srv] 先把库起起来: docker compose up -d db redis\n");
        return 1;
    }
    logmsg("[srv] 数据库已就绪\n");

    // 房间在线状态和信令都在 Redis 里, 没有它这个进程没法工作 (它自己不存任何状态),
    // 所以这里连不上就直接退出, 不要半死不活地跑起来。
    std::string redisErr;
    if (!redis::init(redisUrl, &redisErr)) {
        logmsg("[srv] Redis 初始化失败: %s\n", redisErr.c_str());
        logmsg("[srv] 先把库起起来: docker compose up -d db redis\n");
        return 1;
    }
    logmsg("[srv] Redis 已就绪\n");

    // 交给浏览器的 ICE 服务器列表。走环境变量而不是命令行参数, 因为 compose 里
    // 用 environment 传最自然, 而且它是部署配置不是日常开关。
    if (const char* ice = std::getenv("ICE_SERVERS")) setIceServers(ice);

    // TURN 的 REST 临时凭证: URL 和共享密钥都配了才启用 (见 handlers.cpp / README)。
    // 有效期可选, TURN_TTL_SECONDS 给了非正数就退回默认 12 小时。
    const char* turnUrl = std::getenv("TURN_URL");
    const char* turnSecret = std::getenv("TURN_SECRET");
    long long turnTtl = 0;
    if (const char* ttl = std::getenv("TURN_TTL_SECONDS")) turnTtl = std::strtoll(ttl, nullptr, 10);
    if (turnUrl && *turnUrl && turnSecret && *turnSecret) setTurnConfig(turnUrl, turnSecret, turnTtl);

    // 事件流 (可选): 配了 KAFKA_BROKERS 才启用。事件是尽力而为的审计/统计流,
    // 不挡任何业务请求 (取舍见 events.h)。
    if (const char* kb = std::getenv("KAFKA_BROKERS"); kb != nullptr && *kb != '\0') {
        const char* kt = std::getenv("KAFKA_TOPIC");
        events::init(kb, kt != nullptr ? kt : "");
    }

    setWebRoot(web);
    Server server(port, workers);
    if (!server.start()) return 1;
    return server.run();
}
