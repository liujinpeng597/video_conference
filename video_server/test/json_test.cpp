// json.* 的自测。跑法: make test, 或者 bash test/smoke.sh。
// 只盯容易写错的地方: 转义 / 代理对 / 脏输入不能崩也不能误判。
#include <cassert>
#include <cstdio>
#include <string>

#include "../src/json.h"

int main() {
    std::string v;

    // --- 正常取值 ---------------------------------------------------------
    assert(json::getString(R"({ "username" : "lin" , "password" : "hunter2" })", "username", &v) && v == "lin");
    assert(json::getString(R"({"username":"lin","password":"hunter2"})", "password", &v) && v == "hunter2");
    assert(json::getString(R"({"user":"阿岚"})", "user", &v) && v == "阿岚");
    assert(json::getString("{}", "a", &v) == false);

    // 键不存在 / 值不是字符串
    assert(!json::getString(R"({"a":"1"})", "b", &v));
    assert(!json::getString(R"({"a":1})", "a", &v));
    assert(!json::getString(R"({"a":null})", "a", &v));

    // --- 嵌套与顺序 -------------------------------------------------------
    // 先出现的坏键不能顶掉后面真正要找的键
    assert(json::getString(R"({"username":123,"username":"good"})", "username", &v) && v == "good");
    // 嵌套里的同名键必须被跳过 (只认顶层)
    assert(json::getString(R"({"outer":{"username":"bad"},"username":"good"})", "username", &v) && v == "good");
    assert(json::getString(R"({"a":[1,2,{"b":"x"}],"b":"y"})", "b", &v) && v == "y");

    // --- 转义 -------------------------------------------------------------
    assert(json::getString(R"({"u":"a\"b\\c\nd\te"})", "u", &v) && v == "a\"b\\c\nd\te");
    assert(json::getString(R"({"us\u0065rname":"x"})", "username", &v) && v == "x");
    assert(json::getString(R"({"u":"\u4e2d\u6587"})", "u", &v) && v == "中文");
    assert(json::getString(R"({"u":"\ud83d\ude00"})", "u", &v) && v == "\xf0\x9f\x98\x80");
    assert(json::getString(R"({"u":"\ud83d"})", "u", &v) && v == "\xef\xbf\xbd");  // 落单代理 -> U+FFFD

    // --- 脏输入一律 false, 不崩 -------------------------------------------
    assert(!json::getString("", "a", &v));
    assert(!json::getString("{", "a", &v));
    assert(!json::getString(R"({"u":)", "u", &v));
    assert(!json::getString(R"({"u":"没闭合)", "u", &v));
    assert(!json::getString(R"([{"u":"x"}])", "u", &v));
    assert(!json::getString(R"({"u""x"})", "u", &v));
    assert(!json::getString(R"({"u":"x" "b":"y"})", "b", &v));
    assert(!json::getString(std::string("{\"u\":\"a\0b\"}", 11), "u", &v));  // 裸 NUL 非法

    // --- quote ------------------------------------------------------------
    assert(json::quote("lin") == "\"lin\"");
    assert(json::quote("a\"b\\c") == "\"a\\\"b\\\\c\"");
    assert(json::quote("l1\nl2") == "\"l1\\nl2\"");
    assert(json::quote(std::string(1, '\x01')) == "\"\\u0001\"");
    assert(json::quote("中文") == "\"中文\"");  // 非 ASCII 直接原样出

    // --- getBool ----------------------------------------------------------
    bool b = false;
    assert(json::getBool(R"({"remember":true})", "remember", &b) && b);
    assert(json::getBool(R"({"remember":false})", "remember", &b) && !b);
    assert(json::getBool(R"({ "remember" : true , "x" : 1 })", "remember", &b) && b);
    // 不是布尔字面量一律 false, 不做 "1"/"yes" 这种宽松解释
    assert(!json::getBool(R"({"remember":"true"})", "remember", &b));
    assert(!json::getBool(R"({"remember":1})", "remember", &b));
    assert(!json::getBool(R"({"other":true})", "remember", &b));
    assert(!json::getBool(R"({"remember":tru})", "remember", &b));
    // 和 getString 混在一起也不能串
    assert(json::getBool(R"({"u":"x","remember":true})", "remember", &b) && b);
    assert(json::getString(R"({"u":"x","remember":true})", "u", &v) && v == "x");
    assert(!json::getString(R"({"u":"x","remember":true})", "remember", &v));
    assert(!json::getBool(R"({"remember":true})", "u", &b));

    std::printf("json: 全部通过\n");
    return 0;
}
