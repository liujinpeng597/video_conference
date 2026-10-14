#include "log.h"

#include <unistd.h>

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <mutex>

namespace {

// 实例名 = hostname (和 /api/health 里报的 instance 一致, 容器里就是容器 id 短名)
const char* instanceName() {
    static char name[64] = {0};
    if (name[0] == '\0') {
        if (gethostname(name, sizeof(name) - 1) != 0) std::snprintf(name, sizeof(name), "?");
        name[sizeof(name) - 1] = '\0';
    }
    return name;
}

std::mutex g_mu;  // 一条日志只有一次 fputs, 避免多线程输出交错

}  // namespace

void logmsg(const char* fmt, ...) {
    char msg[2048];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(msg, sizeof(msg), fmt, ap);
    va_end(ap);

    // 调用点有的自带前后换行 (它们原来直接拼给 fprintf): 统一收成"恰好一行",
    // 不然会出现只有 "[时间] [实例]" 前缀的空行。usage 那种多行消息保留内部换行。
    const char* body = msg;
    while (*body == '\n' || *body == '\r') ++body;
    size_t blen = std::strlen(body);
    while (blen > 0 && (body[blen - 1] == '\n' || body[blen - 1] == '\r')) --blen;

    timespec ts{};
    clock_gettime(CLOCK_REALTIME, &ts);
    tm tmv{};
    localtime_r(&ts.tv_sec, &tmv);

    char line[sizeof(msg) + 128];
    std::snprintf(line, sizeof(line),
                  "[%04d-%02d-%02d %02d:%02d:%02d.%03ld] [%s] %.*s\n",
                  tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday,
                  tmv.tm_hour, tmv.tm_min, tmv.tm_sec, ts.tv_nsec / 1000000,
                  instanceName(), (int)blen, body);

    std::lock_guard<std::mutex> lock(g_mu);
    std::fputs(line, stderr);
}
