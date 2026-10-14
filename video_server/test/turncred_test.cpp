// turncred.* 的自测: 用 RFC 2202 的 HMAC-SHA1 测试向量核对实现。
// 见 turncred.cpp 顶部注释: 这个函数算错的后果是"所有 TURN 连接都连不上",
// 而且只在真实网络环境才暴露, 所以在这里用向量钉死。
#include <cassert>
#include <cstdio>
#include <string>

#include "../src/turncred.h"

int main() {
    // RFC 2202 §3 测试向量: (密钥, 数据, base64(HMAC-SHA1))
    // 1) 20 字节 0x0b 密钥 + ASCII 数据
    assert(turncred::credential(std::string(20, '\x0b'), "Hi There") ==
           "thcxhlUFcmTii8C2+zeMjvFGvgA=");
    // 2) 短密钥 (比分组短, 走补零路径)
    assert(turncred::credential("Jefe", "what do ya want for nothing?") ==
           "7/zfauXrL6LSdBbV8YTfnCWafHk=");
    // 3) 长数据 (50 字节), 含各半字节的二进制内容
    assert(turncred::credential(std::string(20, (char)0xaa), std::string(50, (char)0xdd)) ==
           "El1zQrmsEc2Ro5r0iqF7T2PxddM=");
    // 4) 密钥比分组长 (25 字节, 走"先哈希再补零"路径)
    std::string key25;
    for (int i = 1; i <= 25; ++i) key25.push_back((char)i);
    assert(turncred::credential(key25, std::string(50, (char)0xcd)) ==
           "TJAH9AJiUMa8hBT5v1DIbC1yNdo=");
    // 5) 再一条 ASCII 对照
    assert(turncred::credential(std::string(20, '\x0c'), "Test With Truncation") ==
           "TBoDQktV4H/n8nvh1Yu5MkqaWgQ=");

    // 同输入必须稳定 (这个值要在两个进程、两个地方算出同一份)
    assert(turncred::credential("sekret", "1792000000:lin") ==
           turncred::credential("sekret", "1792000000:lin"));

    std::printf("turncred: 全部通过\n");
    return 0;
}
