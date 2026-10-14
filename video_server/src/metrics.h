#pragma once

#include <cstdint>
#include <string>

// 极简 Prometheus 指标 (纯内存原子计数, 不引任何库)。
//
// 只做"上线首月够用"的那一档: 请求量/状态码分布、延迟直方图、房间数、
// 依赖错误计数。多实例部署时每个实例各暴露一份, 由 Prometheus 汇总。
// 暴露给 Prometheus 的入口是 GET /metrics (app 端口不对外发布, nginx 也不代理它)。
namespace metrics {

// 请求分类 (和告警/面板的 label 对应)
enum class Route {
    Login,
    Register,
    Me,
    Rooms,
    State,
    Signal,
    Ice,
    Health,
    Static,
    Other,
};

Route classify(const std::string& path);

// 一个请求处理完时调 (micros = 处理耗时微秒)。多线程安全。
void observeRequest(Route r, int status, uint64_t micros);

// 依赖出错时调 (redis.cpp / db.cpp 的失败分支各一处)
void countRedisError();
void countDbError();

// 事件流 (Kafka) 的发布计数 (见 events.cpp)
void countEventPublished();
void countEventDropped();

// 渲染 Prometheus 文本格式
std::string render();

}  // namespace metrics
