#include "json.h"

#include <cstdio>

namespace json {
namespace {

void skipWs(const std::string& s, std::size_t* i) {
    while (*i < s.size()) {
        const char ch = s[*i];
        if (ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
            ++*i;
        } else {
            break;
        }
    }
}

// 读 4 位十六进制。成功返回 true。
bool hex4(const std::string& s, std::size_t i, unsigned* out) {
    if (i + 4 > s.size()) return false;
    unsigned v = 0;
    for (int k = 0; k < 4; ++k) {
        const char ch = s[i + (std::size_t)k];
        v <<= 4;
        if (ch >= '0' && ch <= '9') {
            v |= (unsigned)(ch - '0');
        } else if (ch >= 'a' && ch <= 'f') {
            v |= (unsigned)(ch - 'a' + 10);
        } else if (ch >= 'A' && ch <= 'F') {
            v |= (unsigned)(ch - 'A' + 10);
        } else {
            return false;
        }
    }
    *out = v;
    return true;
}

void appendUtf8(std::string* out, unsigned cp) {
    if (cp < 0x80) {
        out->push_back((char)cp);
    } else if (cp < 0x800) {
        out->push_back((char)(0xC0 | (cp >> 6)));
        out->push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out->push_back((char)(0xE0 | (cp >> 12)));
        out->push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        out->push_back((char)(0x80 | (cp & 0x3F)));
    } else {
        out->push_back((char)(0xF0 | (cp >> 18)));
        out->push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
        out->push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
        out->push_back((char)(0x80 | (cp & 0x3F)));
    }
}

// 跳过一个值 (字符串 / 数字 / true / false / null / 对象 / 数组), i 停在值后面。
bool skipValue(const std::string& s, std::size_t* i) {
    skipWs(s, i);
    if (*i >= s.size()) return false;

    const char ch = s[*i];
    if (ch == '"') {
        std::string tmp;
        const std::size_t e = parseString(s, *i, &tmp);
        if (e == std::string::npos) return false;
        *i = e;
        return true;
    }
    if (ch == '{' || ch == '[') {
        // 括号本来就是配平的, 所以只数同一种括号、遇到字符串就整段跳过即可
        const char open = ch;
        const char close = (ch == '{') ? '}' : ']';
        int depth = 0;
        while (*i < s.size()) {
            const char d = s[*i];
            if (d == '"') {
                std::string tmp;
                const std::size_t e = parseString(s, *i, &tmp);
                if (e == std::string::npos) return false;
                *i = e;
                continue;
            }
            if (d == open) {
                ++depth;
            } else if (d == close) {
                if (--depth == 0) {
                    ++*i;
                    return true;
                }
            }
            ++*i;
        }
        return false;
    }

    const std::size_t begin = *i;
    while (*i < s.size() && s[*i] != ',' && s[*i] != '}' && s[*i] != ']') ++*i;
    return *i > begin;
}

bool isWs(char ch) { return ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r'; }

// 要找的值的类型。同名键可能出现多次, 只有类型对上的那次才算 (见下面的注释)。
enum class Want { String, Bool, Any };

bool matches(const std::string& s, std::size_t begin, std::size_t end, Want want) {
    if (begin >= end) return false;
    if (want == Want::Any) return true;
    if (want == Want::String) return s[begin] == '"';
    const std::string v = s.substr(begin, end - begin);
    return v == "true" || v == "false";
}

// 在顶层对象里找到 key, 把它的原始值切片 [begin, end) 交出来。getString/getBool 共用。
// 同一个键出现多次时, 取第一个"类型对得上"的, 而不是第一个出现的 —— 这样
// {"username":123,"username":"good"} 仍然能读到 "good"。
bool rawValue(const std::string& body, const std::string& key, Want want, std::size_t* begin,
              std::size_t* end) {
    std::size_t i = 0;
    skipWs(body, &i);
    if (i >= body.size() || body[i] != '{') return false;
    ++i;

    for (;;) {
        skipWs(body, &i);
        if (i < body.size() && body[i] == '}') return false;

        std::string k;
        const std::size_t ke = parseString(body, i, &k);
        if (ke == std::string::npos) return false;
        i = ke;

        skipWs(body, &i);
        if (i >= body.size() || body[i] != ':') return false;
        ++i;
        skipWs(body, &i);

        const std::size_t vs = i;
        if (!skipValue(body, &i)) return false;
        std::size_t ve = i;
        while (ve > vs && isWs(body[ve - 1])) --ve;

        if (k == key && matches(body, vs, ve, want)) {
            *begin = vs;
            *end = ve;
            return true;
        }

        skipWs(body, &i);
        if (i < body.size() && body[i] == ',') {
            ++i;
            continue;
        }
        return false;  // 既不是 ',' 也不是 '}' -> 格式不对
    }
}

}  // namespace

std::size_t parseString(const std::string& s, std::size_t i, std::string* out) {
    if (i >= s.size() || s[i] != '"') return std::string::npos;
    ++i;
    out->clear();
    while (i < s.size()) {
        const unsigned char ch = (unsigned char)s[i];
        if (ch == '"') return i + 1;
        if (ch != '\\') {
            if (ch < 0x20) return std::string::npos;  // 控制字符必须写成 \uXXXX
            out->push_back((char)ch);
            ++i;
            continue;
        }
        if (i + 1 >= s.size()) return std::string::npos;
        const char esc = s[i + 1];
        i += 2;
        switch (esc) {
            case '"': out->push_back('"'); break;
            case '\\': out->push_back('\\'); break;
            case '/': out->push_back('/'); break;
            case 'b': out->push_back('\b'); break;
            case 'f': out->push_back('\f'); break;
            case 'n': out->push_back('\n'); break;
            case 'r': out->push_back('\r'); break;
            case 't': out->push_back('\t'); break;
            case 'u': {
                unsigned cp = 0;
                if (!hex4(s, i, &cp)) return std::string::npos;
                i += 4;
                if (cp >= 0xD800 && cp <= 0xDBFF) {
                    // 高代理: 后面跟低代理才是一个完整码点, 落单就换成 U+FFFD
                    unsigned lo = 0;
                    if (i + 1 < s.size() && s[i] == '\\' && s[i + 1] == 'u' && hex4(s, i + 2, &lo) &&
                        lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000u + ((cp - 0xD800u) << 10) + (lo - 0xDC00u);
                        i += 6;
                    } else {
                        cp = 0xFFFD;
                    }
                } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                    cp = 0xFFFD;
                }
                appendUtf8(out, cp);
                break;
            }
            default: return std::string::npos;
        }
    }
    return std::string::npos;  // 引号没闭合
}

bool getString(const std::string& body, const std::string& key, std::string* out) {
    std::size_t begin = 0;
    std::size_t end = 0;
    if (!rawValue(body, key, Want::String, &begin, &end)) return false;
    // 整段切片必须就是一个字符串, 不能是 "x" 后面还拖着东西
    return parseString(body, begin, out) == end;
}

bool getBool(const std::string& body, const std::string& key, bool* out) {
    std::size_t begin = 0;
    std::size_t end = 0;
    if (!rawValue(body, key, Want::Bool, &begin, &end)) return false;
    *out = (body.compare(begin, end - begin, "true") == 0);
    return true;
}

bool getRaw(const std::string& body, const std::string& key, std::string* out) {
    std::size_t begin = 0;
    std::size_t end = 0;
    if (!rawValue(body, key, Want::Any, &begin, &end)) return false;
    // 这一段是 skipValue 跳出来的一整个 JSON 值, 结构上是完整的,
    // 所以直接拼进响应里也不会把 JSON 弄坏
    out->assign(body, begin, end - begin);
    return true;
}

std::string quote(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 2);
    out.push_back('"');
    for (std::size_t i = 0; i < s.size(); ++i) {
        const unsigned char ch = (unsigned char)s[i];
        switch (ch) {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (ch < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof buf, "\\u%04x", (unsigned)ch);
                    out += buf;
                } else {
                    out.push_back((char)ch);
                }
        }
    }
    out.push_back('"');
    return out;
}

}  // namespace json
