#include "metrics.h"

#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <string>

#include "redis.h"

namespace metrics {
namespace {

constexpr int kRoutes = 10;
constexpr int kBuckets = 9;
constexpr int kOverflow = kBuckets;  // > 2.5s 的都落这里
constexpr double kBucketLe[kBuckets] = {0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5};

const char* kRouteName[kRoutes] = {"login", "register", "me",    "rooms",  "state",
                                   "signal", "ice",    "health", "static", "other"};

// 固定状态码表 (分布看得准); 表外的一律归 "other"
constexpr int kStatuses = 16;
const int kStatusCode[kStatuses] = {200, 201, 204, 301, 302, 304, 400, 401,
                                    404, 405, 409, 413, 429, 431, 500, 503};

int statusSlot(int code) {
    for (int i = 0; i < kStatuses; ++i) {
        if (kStatusCode[i] == code) return i;
    }
    return kStatuses;  // other
}

std::atomic<uint64_t> g_req[kRoutes][kStatuses + 1];
std::atomic<uint64_t> g_hist[kRoutes][kBuckets + 1];
std::atomic<uint64_t> g_sumUs[kRoutes];
std::atomic<uint64_t> g_count[kRoutes];
std::atomic<uint64_t> g_redisErr{0};
std::atomic<uint64_t> g_dbErr{0};
std::atomic<uint64_t> g_evtPub{0};
std::atomic<uint64_t> g_evtDrop{0};
std::atomic<uint64_t> g_rateLimited{0};

const std::chrono::steady_clock::time_point g_start = std::chrono::steady_clock::now();

void appendLine(std::string* out, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
void appendLine(std::string* out, const char* fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    out->append(buf);
    out->push_back('\n');
}

}  // namespace

Route classify(const std::string& path) {
    if (path == "/api/login") return Route::Login;
    if (path == "/api/register") return Route::Register;
    if (path == "/api/me" || path == "/api/logout" || path == "/api/session/resume") return Route::Me;
    if (path == "/api/rooms/state") return Route::State;
    if (path == "/api/rooms/signal") return Route::Signal;
    if (path == "/api/rooms/enter" || path == "/api/rooms/leave") return Route::Rooms;
    if (path == "/api/ice") return Route::Ice;
    if (path == "/api/health") return Route::Health;
    if (path == "/metrics") return Route::Other;
    if (path.rfind("/api/", 0) == 0) return Route::Other;
    return Route::Static;
}

void observeRequest(Route r, int status, uint64_t micros) {
    const int ri = static_cast<int>(r);
    g_req[ri][statusSlot(status)].fetch_add(1, std::memory_order_relaxed);
    g_count[ri].fetch_add(1, std::memory_order_relaxed);
    g_sumUs[ri].fetch_add(micros, std::memory_order_relaxed);

    const double seconds = (double)micros / 1e6;
    int b = kOverflow;
    for (int i = 0; i < kBuckets; ++i) {
        if (seconds <= kBucketLe[i]) {
            b = i;
            break;
        }
    }
    g_hist[ri][b].fetch_add(1, std::memory_order_relaxed);
}

void countRedisError() { g_redisErr.fetch_add(1, std::memory_order_relaxed); }
void countDbError() { g_dbErr.fetch_add(1, std::memory_order_relaxed); }
void countEventPublished() { g_evtPub.fetch_add(1, std::memory_order_relaxed); }
void countEventDropped() { g_evtDrop.fetch_add(1, std::memory_order_relaxed); }
void countRateLimited() { g_rateLimited.fetch_add(1, std::memory_order_relaxed); }

std::string render() {
    std::string out;
    out.reserve(8192);

    appendLine(&out, "# TYPE video_requests_total counter");
    for (int i = 0; i < kRoutes; ++i) {
        for (int s = 0; s <= kStatuses; ++s) {
            const uint64_t v = g_req[i][s].load(std::memory_order_relaxed);
            if (v == 0) continue;
            char code[8];
            std::snprintf(code, sizeof(code), "%d", s == kStatuses ? 0 : kStatusCode[s]);
            const char* label = (s == kStatuses) ? "other" : code;
            appendLine(&out, "video_requests_total{route=\"%s\",status=\"%s\"} %llu",
                       kRouteName[i], label, (unsigned long long)v);
        }
    }

    appendLine(&out, "# TYPE video_request_duration_seconds histogram");
    for (int i = 0; i < kRoutes; ++i) {
        uint64_t cumulative = 0;
        for (int b = 0; b < kBuckets; ++b) {
            cumulative += g_hist[i][b].load(std::memory_order_relaxed);
            appendLine(&out,
                       "video_request_duration_seconds_bucket{route=\"%s\",le=\"%g\"} %llu",
                       kRouteName[i], kBucketLe[b], (unsigned long long)cumulative);
        }
        const uint64_t total = g_count[i].load(std::memory_order_relaxed);
        appendLine(&out, "video_request_duration_seconds_bucket{route=\"%s\",le=\"+Inf\"} %llu",
                   kRouteName[i], (unsigned long long)total);
        const uint64_t sum = g_sumUs[i].load(std::memory_order_relaxed);
        appendLine(&out, "video_request_duration_seconds_sum{route=\"%s\"} %llu.%06llu",
                   kRouteName[i], (unsigned long long)(sum / 1000000), (unsigned long long)(sum % 1000000));
        appendLine(&out, "video_request_duration_seconds_count{route=\"%s\"} %llu",
                   kRouteName[i], (unsigned long long)total);
    }

    // 房间数是 SCAN 现算的 (上限 500); Redis 挂了就不输出这一条, 别让 scrape 卡住
    long long rooms = 0;
    std::string err;
    if (redis::countKeys("room:*", 500, &rooms, &err)) {
        appendLine(&out, "# TYPE video_rooms_active gauge");
        appendLine(&out, "video_rooms_active %lld", rooms);
    }

    appendLine(&out, "# TYPE video_redis_errors_total counter");
    appendLine(&out, "video_redis_errors_total %llu",
               (unsigned long long)g_redisErr.load(std::memory_order_relaxed));
    appendLine(&out, "# TYPE video_db_errors_total counter");
    appendLine(&out, "video_db_errors_total %llu",
               (unsigned long long)g_dbErr.load(std::memory_order_relaxed));
    appendLine(&out, "# TYPE video_events_published_total counter");
    appendLine(&out, "video_events_published_total %llu",
               (unsigned long long)g_evtPub.load(std::memory_order_relaxed));
    appendLine(&out, "# TYPE video_events_dropped_total counter");
    appendLine(&out, "video_events_dropped_total %llu",
               (unsigned long long)g_evtDrop.load(std::memory_order_relaxed));
    appendLine(&out, "# TYPE video_ratelimited_total counter");
    appendLine(&out, "video_ratelimited_total %llu",
               (unsigned long long)g_rateLimited.load(std::memory_order_relaxed));

    char host[64] = {0};
    if (gethostname(host, sizeof(host) - 1) != 0) std::snprintf(host, sizeof(host), "?");
    appendLine(&out, "# TYPE video_build_info gauge");
    appendLine(&out, "video_build_info{instance=\"%s\"} 1", host);
    const auto uptime = std::chrono::duration_cast<std::chrono::seconds>(
        std::chrono::steady_clock::now() - g_start);
    appendLine(&out, "# TYPE video_uptime_seconds gauge");
    appendLine(&out, "video_uptime_seconds %lld", (long long)uptime.count());

    return out;
}

}  // namespace metrics
