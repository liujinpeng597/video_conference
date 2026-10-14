#pragma once

#include <cstddef>
#include <string>

struct Connection;

// 新连接建立 (已注册进 epoll, 可以 send)
void onConnect(Connection& c);

// 收到数据。data/len 是这一次 read 到的原始字节, 不保证是完整的一帧。
// HTTP 的分帧 (半包/粘包) 在 handlers.cpp 里用 Connection::in 处理。
void onMessage(Connection& c, const char* data, size_t len);

// 连接关闭。此时 fd 已关闭, 只能做状态清理。
void onClose(Connection& c);

// 前端静态资源根目录 (video_client), 必须在 Server::start() 之前设置。
// 之后只读, 所以不需要加锁。
void setWebRoot(const std::string& dir);

// 交给浏览器的 ICE 服务器列表, 一段 JSON 数组文本, 例如
//   [{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]
// 服务端不解析它, 原样从 /api/ice 发出去。同样要在 start() 之前设置。
void setIceServers(const std::string& jsonArray);

// TURN 的 REST 临时凭证配置 (coturn --use-auth-secret 的配套实现)。
// 配了之后 /api/ice 会给每个登录用户现场签发 "<过期时间戳>:账号" + HMAC-SHA1 口令;
// 不配就只下发 setIceServers 的静态列表。同样要在 start() 之前设置。
// ttlSeconds <= 0 时用默认值 (12 小时)。
void setTurnConfig(const std::string& url, const std::string& secret, long long ttlSeconds);
