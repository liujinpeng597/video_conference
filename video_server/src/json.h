// 本服务用到的那一点点 JSON: 从扁平对象里取字符串/布尔值 + 生成转义后的字符串。
// 不是通用 JSON 库, 故意只做这几件事。
#pragma once

#include <cstddef>
#include <string>

namespace json {

// 从 s[i] 解析一个 JSON 字符串字面量 (要求 s[i] == '"')。
// 成功: 解码结果写进 *out, 返回结束引号后面那个下标。
// 失败: 返回 std::string::npos。
std::size_t parseString(const std::string& s, std::size_t i, std::string* out);

// 在扁平对象文本里取 key 对应的字符串值。
// 键不存在 / 值不是字符串 / 格式非法, 一律 false。
// 只关心顶层成员, 嵌套对象和数组会被整体跳过。
bool getString(const std::string& body, const std::string& key, std::string* out);

// 同上, 取布尔值 (只认字面量 true / false)。
bool getBool(const std::string& body, const std::string& key, bool* out);

// 取出 key 对应值的**原始 JSON 文本** (对象 / 数组 / 字符串 / 数字 / 布尔都行)。
// 信令转发用它: SDP 和 ICE candidate 长什么样服务器根本不用懂, 当搬运工原样转给对端就行。
bool getRaw(const std::string& body, const std::string& key, std::string* out);

// 转成带引号的 JSON 字符串字面量。
std::string quote(const std::string& s);

}  // namespace json
