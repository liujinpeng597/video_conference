#include "random.h"

#include <sodium.h>

#include <cstdio>
#include <mutex>

namespace rnd {
namespace {

// libsodium 用之前要 init 一次。放 here 而不是让调用方记得先调, 免得埋一个隐式的初始化顺序。
void ensureInit() {
    static std::once_flag once;
    std::call_once(once, [] {
        if (sodium_init() < 0) {
            // 这种情况下 randombytes_* 会自己 abort, 不会静默返回弱随机
            std::fputs("[rnd] sodium_init 失败\n", stderr);
        }
    });
}

}  // namespace

std::string hex(std::size_t bytes) {
    ensureInit();
    static const char kHex[] = "0123456789abcdef";
    std::string raw(bytes, '\0');
    if (bytes > 0) randombytes_buf(&raw[0], bytes);

    std::string out;
    out.reserve(bytes * 2);
    for (unsigned char c : raw) {
        out.push_back(kHex[c >> 4]);
        out.push_back(kHex[c & 15]);
    }
    return out;
}

std::uint32_t below(std::uint32_t n) {
    ensureInit();
    if (n == 0) return 0;
    return randombytes_uniform(n);
}

}  // namespace rnd
