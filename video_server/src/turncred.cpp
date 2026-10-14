// HMAC-SHA1 (RFC 2104) + 标准 base64。用 OpenSSL 实现: 这套工具链里唯一现成的
// SHA-1 —— libsodium 不导出 SHA-1 接口, 而 TURN REST 规范钉死了 HMAC-SHA1。
//
// 正确性靠 test/turncred_test.cpp 里的 RFC 2202 测试向量钉死。这个函数算错
// 一个字节的症状是"所有 TURN 连接都建不起来", 而且只在真实的对称 NAT 环境里
// 才暴露, 所以不能靠"看起来对"。
#include "turncred.h"

#include <openssl/evp.h>
#include <openssl/hmac.h>

#include <cstddef>

namespace turncred {

std::string credential(const std::string& secret, const std::string& username) {
    unsigned char mac[EVP_MAX_MD_SIZE];
    unsigned int macLen = 0;
    // 密钥是任意长度的部署配置串, 长短密钥的处理由 HMAC 本身按 RFC 2104 负责
    HMAC(EVP_sha1(),
         secret.data(), (int)secret.size(),
         reinterpret_cast<const unsigned char*>(username.data()), username.size(),
         mac, &macLen);

    // EVP_EncodeBlock 输出标准 base64 (含 '=' 填充), 和 coturn 的期望一致。
    // 20 字节摘要 -> 28 个字符 + 结束符。
    unsigned char b64[4 * ((int)sizeof(mac) + 2) / 3 + 1];
    const int n = EVP_EncodeBlock(b64, mac, (int)macLen);
    return std::string(reinterpret_cast<char*>(b64), (std::size_t)n);
}

}  // namespace turncred
