#pragma once

#include <string>

// TURN 的 REST 临时凭证 (coturn --use-auth-secret 的配套实现)。
// 公式: credential = base64(HMAC-SHA1(共享密钥, "<过期时间戳>:<用户名>"))。
// coturn 收到分配请求时用同一份密钥重算一遍做校验, 对上才允许中继。
// 这样静态口令不必进前端 —— 泄露的凭证最多活到时间戳过期。
namespace turncred {

// secret 是部署时配的共享密钥 (任意长度); username 是 "<过期的 unix 秒>:<用户>"。
std::string credential(const std::string& secret, const std::string& username);

}  // namespace turncred
