#include "log.h"
#include "auth.h"

#include <sodium.h>

#include <cstdio>

#include "db.h"

namespace auth {
namespace {

constexpr long long kSessionTtlSec = 12 * 3600;        // 12 小时
constexpr long long kRememberTtlSec = 30 * 24 * 3600;  // 30 天

// 用户名 / 密码 里不存在时的等时占位哈希: 让"用户不存在"和"密码错"两条路
// 都花差不多的 CPU 时间, 不然用响应时间就能问出某个用户名注册没注册。
std::string g_dummyHash;

std::string toHex(const unsigned char* p, size_t n) {
    static const char kHex[] = "0123456789abcdef";
    std::string out;
    out.reserve(n * 2);
    for (size_t i = 0; i < n; ++i) {
        out.push_back(kHex[p[i] >> 4]);
        out.push_back(kHex[p[i] & 15]);
    }
    return out;
}

// 32 字节 CSPRNG -> 64 个十六进制字符
std::string randomToken() {
    unsigned char buf[32];
    randombytes_buf(buf, sizeof buf);
    return toHex(buf, sizeof buf);
}

std::string sha256Hex(const std::string& s) {
    unsigned char h[crypto_hash_sha256_BYTES];
    crypto_hash_sha256(h, reinterpret_cast<const unsigned char*>(s.data()), s.size());
    return toHex(h, sizeof h);
}

bool hashPassword(const std::string& pass, std::string* out) {
    char buf[crypto_pwhash_STRBYTES];
    if (crypto_pwhash_str(buf, pass.c_str(), pass.size(), crypto_pwhash_OPSLIMIT_INTERACTIVE,
                          crypto_pwhash_MEMLIMIT_INTERACTIVE) != 0) {
        return false;
    }
    *out = buf;
    return true;
}

bool verifyPassword(const std::string& hash, const std::string& pass) {
    return crypto_pwhash_str_verify(hash.c_str(), pass.c_str(), pass.size()) == 0;
}

// ---------------------------------------------------------------- 输入校验
// 信任边界上的检查, 不能省。

// 合法 UTF-8, 顺便数出码点个数 (长度按字符算, 不按字节)
bool utf8Count(const std::string& s, size_t* count) {
    size_t i = 0;
    size_t n = 0;
    while (i < s.size()) {
        const unsigned char c = (unsigned char)s[i];
        size_t len = 0;
        unsigned cp = 0;
        if (c < 0x80) {
            len = 1;
            cp = c;
        } else if ((c & 0xE0) == 0xC0) {
            len = 2;
            cp = c & 0x1Fu;
        } else if ((c & 0xF0) == 0xE0) {
            len = 3;
            cp = c & 0x0Fu;
        } else if ((c & 0xF8) == 0xF0) {
            len = 4;
            cp = c & 0x07u;
        } else {
            return false;
        }
        if (i + len > s.size()) return false;
        for (size_t k = 1; k < len; ++k) {
            const unsigned char cc = (unsigned char)s[i + k];
            if ((cc & 0xC0) != 0x80) return false;
            cp = (cp << 6) | (cc & 0x3Fu);
        }
        if ((len == 2 && cp < 0x80) || (len == 3 && cp < 0x800) || (len == 4 && cp < 0x10000)) return false;
        if (cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return false;
        i += len;
        ++n;
    }
    *count = n;
    return true;
}

// 用户名: 3-20 个字符, 不许有空格和控制字符
bool validName(const std::string& s, std::string* why) {
    size_t n = 0;
    if (!utf8Count(s, &n)) {
        *why = "用户名不是合法的 UTF-8";
        return false;
    }
    if (n < 3 || n > 20) {
        *why = "用户名要 3-20 个字符";
        return false;
    }
    for (unsigned char ch : s) {
        if (ch < 0x21 || ch == 0x7F) {
            *why = "用户名里不能有空格或控制字符";
            return false;
        }
    }
    return true;
}

// 密码: 6-64 个字符, 允许空格, 不许有控制字符
bool validPass(const std::string& s, std::string* why) {
    size_t n = 0;
    if (!utf8Count(s, &n)) {
        *why = "密码不是合法的 UTF-8";
        return false;
    }
    if (n < 6 || n > 64) {
        *why = "密码要 6-64 个字符";
        return false;
    }
    for (unsigned char ch : s) {
        if (ch < 0x20 || ch == 0x7F) {
            *why = "密码里不能有控制字符";
            return false;
        }
    }
    return true;
}

// ------------------------------------------------------------------- 发牌
// 造令牌: 明文给客户端, 库里只存 hash。
bool mintTokens(long long userId, const std::string& username, bool remember, Result* r) {
    std::string err;
    // 一次登录只留一个有效会话: 先把这账号的旧令牌 (旧会话 + 旧的"保持登录") 全清掉。
    // 于是上一台设备下一个请求就掉线 —— 这就是"换个设备登录会把旧设备挤下线"。
    if (!db::deleteUserTokens(userId, std::string(), &err)) {
        r->status = Status::Error;
        r->error = "清理旧会话失败：" + err;
        return false;
    }
    const std::string session = randomToken();
    if (!db::insertToken(sha256Hex(session), userId, db::TokenKind::Session, kSessionTtlSec, &err)) {
        r->status = Status::Error;
        r->error = "写会话失败：" + err;
        return false;
    }
    r->token = session;
    r->username = username;

    if (remember) {
        const std::string rem = randomToken();
        if (!db::insertToken(sha256Hex(rem), userId, db::TokenKind::Remember, kRememberTtlSec, &err)) {
            r->status = Status::Error;
            r->error = "写长期令牌失败：" + err;
            return false;
        }
        r->rememberToken = rem;
    }
    return true;
}

}  // namespace

void init() {
    if (sodium_init() < 0) {
        logmsg("[auth] sodium_init 失败, 密码功能不可用\n");
    }
    // 拿随机内容算一个哈希, 专门用来给"用户不存在"那条路垫时间
    hashPassword(randomToken(), &g_dummyHash);
}

Result registerUser(const std::string& name, const std::string& password, bool remember) {
    Result r;
    if (!validName(name, &r.error)) {
        r.status = Status::BadRequest;
        return r;
    }
    if (!validPass(password, &r.error)) {
        r.status = Status::BadRequest;
        return r;
    }

    // 哈希很慢 (Argon2 故意设计成慢的), 所以放在任何锁外面做
    std::string hash;
    if (!hashPassword(password, &hash)) {
        r.status = Status::Error;
        r.error = "服务端算不出密码哈希";
        return r;
    }

    db::User u;
    std::string err;
    if (!db::createUser(name, hash, &u, &err)) {
        if (err.empty()) {
            r.status = Status::Taken;
            r.error = "这个用户名已经被注册了";
        } else {
            r.status = Status::Error;
            r.error = "写数据库失败：" + err;
        }
        return r;
    }

    if (!mintTokens(u.id, u.username, remember, &r)) return r;
    r.status = Status::Ok;
    db::purgeExpired();
    return r;
}

Result login(const std::string& name, const std::string& password, bool remember) {
    Result r;
    if (name.empty() || password.empty()) {
        r.status = Status::BadRequest;
        r.error = "用户名和密码都要填";
        return r;
    }

    db::User u;
    std::string err;
    if (!db::findUser(name, &u, &err)) {
        if (!err.empty()) {
            r.status = Status::Error;
            r.error = "查数据库失败：" + err;
            return r;
        }
        verifyPassword(g_dummyHash, password);  // 垫时间, 别让人用响应时间问出用户名存不存在
        r.status = Status::BadCreds;
        r.error = "用户名或密码不对";
        return r;
    }

    if (!verifyPassword(u.passwordHash, password)) {
        r.status = Status::BadCreds;
        r.error = "用户名或密码不对";
        return r;
    }

    if (!mintTokens(u.id, u.username, remember, &r)) return r;
    r.status = Status::Ok;
    db::purgeExpired();
    return r;
}

Result resume(const std::string& rememberToken) {
    Result r;
    if (rememberToken.empty()) {
        r.status = Status::BadCreds;
        r.error = "没有可用的长期令牌";
        return r;
    }

    db::TokenInfo ti;
    std::string err;
    if (!db::lookupToken(sha256Hex(rememberToken), &ti, &err)) {
        if (!err.empty()) {
            r.status = Status::Error;
            r.error = "查数据库失败：" + err;
        } else {
            r.status = Status::BadCreds;
            r.error = "保持登录已经过期了，重新登录一下";
        }
        return r;
    }
    if (ti.kind != db::TokenKind::Remember) {
        // 拿会话令牌来换会话令牌没有意义, 直接拒掉
        r.status = Status::BadCreds;
        r.error = "这个令牌不能用来续期";
        return r;
    }

    // 换新会话前先清掉这账号的其它令牌 (旧会话 + 别的设备留下的长期令牌),
    // 只保留这次正在用的这枚长期令牌 —— 不然它自己会被清掉, "保持登录"当场失效。
    if (!db::deleteUserTokens(ti.userId, sha256Hex(rememberToken), &err)) {
        r.status = Status::Error;
        r.error = "清理旧会话失败：" + err;
        return r;
    }
    std::string newErr;
    const std::string session = randomToken();
    if (!db::insertToken(sha256Hex(session), ti.userId, db::TokenKind::Session, kSessionTtlSec, &newErr)) {
        r.status = Status::Error;
        r.error = "写会话失败：" + newErr;
        return r;
    }
    r.status = Status::Ok;
    r.token = session;
    r.username = ti.username;
    return r;
}

Check whoAmI(const std::string& token, std::string* username, std::string* error) {
    if (token.empty()) return Check::BadToken;
    db::TokenInfo ti;
    std::string err;
    if (!db::lookupToken(sha256Hex(token), &ti, &err)) {
        if (!err.empty()) {
            if (error != nullptr) *error = err;
            return Check::Error;
        }
        return Check::BadToken;
    }
    *username = ti.username;
    return Check::Ok;
}

Check logout(const std::string& token, const std::string& rememberToken, std::string* error) {
    std::string err;
    if (!token.empty() && !db::deleteToken(sha256Hex(token), &err)) {
        if (error != nullptr) *error = err;
        return Check::Error;
    }
    // "退出登录"就该忘掉我, 所以长期令牌也一起删
    if (!rememberToken.empty() && !db::deleteToken(sha256Hex(rememberToken), &err)) {
        if (error != nullptr) *error = err;
        return Check::Error;
    }
    return Check::Ok;
}

}  // namespace auth
