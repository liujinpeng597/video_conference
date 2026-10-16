// 账号与会话。
//
// 密码: libsodium 的 Argon2id。crypto_pwhash_str 产出的是自带盐和参数的字符串, 直接存库,
//       校验用 crypto_pwhash_str_verify, 参数以后调高强度也不会让老密码失效。
// 令牌: randombytes_buf 取 32 字节 (CSPRNG)。给客户端明文, 库里只存 SHA-256 十六进制,
//       这样库被拖走也不能直接拿来登录。
//
// 两层令牌:
//   session  12 小时, 一次登录一个, 前端放在标签页级的 sessionStorage 里
//   remember 30 天, 只有勾了"保持登录"才有, 前端放在 localStorage 里, 只能用来换新 session
// 分开是为了不把"保持登录"和"一个标签页 = 一个参会者"这两件事搅在一起。
#pragma once

#include <string>

namespace auth {

// 进程启动时调一次 (sodium_init)。要在起线程池之前调用。
void init();

enum class Status {
    Ok,
    BadRequest,  // 参数不合法
    Taken,       // 用户名被占用
    BadCreds,    // 用户名 / 密码 / 令牌不对
    Error,       // 服务端或数据库出错
};

struct Result {
    Status status = Status::Error;
    std::string error;          // 给用户看的中文说明
    std::string username;
    std::string token;          // 短会话令牌
    std::string rememberToken;  // 只有 remember = true 才有
};

Result registerUser(const std::string& name, const std::string& password, bool remember);
Result login(const std::string& name, const std::string& password, bool remember);

// 用 remember 令牌换一个新的 session 令牌。remember 令牌本身不动,
// 因为可能还有别的标签页正在用它。
Result resume(const std::string& rememberToken);

enum class Check { Ok, BadToken, Error };

// 校验会话令牌。成功时把用户名写进 *username。
Check whoAmI(const std::string& token, std::string* username, std::string* error);

// 退出登录: 删掉这个会话; 传了 rememberToken 就一起删 (退出登录 = 忘掉我)。
Check logout(const std::string& token, const std::string& rememberToken, std::string* error);

// 密码哈希 / 校验 (libsodium Argon2id, 自带盐)。账号密码用它, 房间密码也用它。
bool hashPassword(const std::string& pass, std::string* out);
bool verifyPassword(const std::string& hash, const std::string& pass);

// 改密码: 校验旧密码 -> 校验新密码 -> 换哈希 -> 把其它令牌全部吊销 (只留当前这枚会话),
// 于是别的设备会被踢下去重新登录。
Result changePassword(const std::string& token, const std::string& oldPassword,
                      const std::string& newPassword);

}  // namespace auth
