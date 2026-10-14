#pragma once

// 带毫秒时间戳和实例名的 stderr 日志。
//
// 多实例部署时 docker logs 里混着三份输出, 没有时间戳和实例名基本没法排查;
// 加这两样就够用了, 不需要上 ELK (规模不匹配)。
// 用法和 printf 一样: logmsg("[api] %s -> %d\n", path, code);
void logmsg(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
