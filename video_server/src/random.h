// 密码学安全的随机数。令牌和房间号都是"猜不到才有意义"的东西, 所以统一走 libsodium 的
// CSPRNG。之前用的 std::mt19937 是可预测的, 拿它生成会话令牌等于没有令牌。
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace rnd {

// n 字节随机数据的十六进制表示 (长度是 2n)
std::string hex(std::size_t bytes);

// [0, n) 之间的均匀整数, 没有取模偏差。n == 0 时返回 0。
std::uint32_t below(std::uint32_t n);

}  // namespace rnd
