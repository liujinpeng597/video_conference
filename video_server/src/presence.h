// 房间在线状态 + 信令收件箱。
//
// 这两样东西以前放在进程内存里, 一加第二台后端就废了: A 的请求被负载均衡打到 2 号后端,
// 就看 1 号后端里的房间表, 于是"时通时不通"。现在全部外置到 Redis, 每台后端都是无状态的,
// 负载均衡可以随便轮询, 任意一台挂了也不影响正在开会的房间。
//
// Redis 里的 key:
//   room:{房间号}      HASH    token -> "pid\x1fuser\x1fseenMs"   整个房间一个 TTL
//   session:{令牌}     STRING  "room\x1fpid\x1fuser"              我在哪个房间
//   mailbox:{令牌}     LIST    "seq\x1ffrom\x1fkind\x1fpayload"    待取走的信令, 只留最近 64 条
//                      取号和入队在一个 Lua 脚本里原子完成 -> 信箱内 seq 严格递增
//   signaling:seq      INCR    全局单调序号
//
// 为什么房间用 TTL 而不是自己做清理: 房间没人心跳了就该消失, 这正是 EXPIRE 的语义。
// 自己写清理程序要处理"最后一个走的人崩了"这种情况, 而 TTL 天然处理。
//
// 分隔符用 \x1f (US): 用户名校验不允许控制字符, 信令 payload 是合法 JSON
// (JSON 里的控制字符必须转义成 \u00XX 六个字符), 所以这个字节不会出现在字段值里。
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace presence {

struct Member {
    std::string token;  // 会话令牌, 只在服务端用, 不下发给浏览器
    std::string pid;    // 房间内的信令地址, 会下发给浏览器
    std::string user;
    int64_t seenMs = 0;
    bool live = false;  // seen 还在 TTL 内
    bool hand = false;  // 举手 (单人标志, 存房间 hash 的 @hand:<token> 字段)
    bool mic = true;    // 麦克风开着 (存 @mic:<token>; 默认开)
    bool share = false; // 正在共享屏幕 (存 @share:<token>) —— 让别人看得见是谁在共享
    long long avatarVer = 0;  // 头像版本 (存 @av:<token>; 0 = 没头像), 给图片 URL 当缓存指纹
};

struct Signal {
    uint64_t seq = 0;
    std::string from;
    std::string kind;
    std::string payload;  // 客户端发来的原始 JSON 片段
};

struct ChatMessage {
    uint64_t id = 0;      // 房间内单调递增, 当 since 游标用
    std::string from;     // 发送者的 pid
    std::string name;     // 发送者的用户名
    std::string text;
};

struct Me {
    std::string room;
    std::string pid;
    std::string user;
};

// 我在哪个房间。返回 false 时: *err 为空 = 不在任何房间, *err 非空 = 出错了。
bool whereAmI(const std::string& token, Me* me, std::string* err);

// 这个房间号现在有人吗 (用来避免分配重复的房间号)
bool roomLive(const std::string& room, bool* out, std::string* err);

enum class Enter { Ok, Full, Locked, Error };

// 进房间。会清掉上一个房间留下的信令, 不然会去连一个已经不在的人。
// 成功时 *pid 是新分配的信令地址 (每次进房间都换一个)。
Enter enter(const std::string& token, const std::string& user, const std::string& room,
            std::string* pid, std::vector<Member>* members, std::string* err);

// 心跳 + 取回成员列表和信令收件箱。不在房间里时 *room 为空。
// *hostPid 是主持人的 pid (没有主持人时为空串) —— 主持人 = 建房的人。
bool sync(const std::string& token, uint64_t since, std::string* room,
          std::vector<Member>* members, std::vector<Signal>* msgs, std::string* hostPid,
          bool* locked, std::string* err);

enum class Send { Delivered, NoSuchPeer, NotInRoom, Error };

// 把一条信令放进目标参会者的收件箱。只能发给同一个房间里还活着的人。
Send send(const std::string& token, const std::string& toPid, const std::string& kind,
          const std::string& payload, std::string* err);

// 房间聊天。存 Redis 列表 (只留最近 kChatMax 条, 带 TTL), 用房间内序号做游标,
// 设计上刻意和信令收件箱同一套路: 取号 + 入队原子 (redis::chatPush)。
enum class Chat { Ok, NotInRoom, Empty, TooLong, BadText, Error };

// 往我当前所在的房间发一条。成功时 *out 是入库的那条 (带分配到的 id 和发送者信息)。
Chat postChat(const std::string& token, const std::string& text, ChatMessage* out, std::string* err);

// 取房间里 id > since 的消息。room 为空 (不在房间) 时返回空列表。
bool chatSince(const std::string& room, uint64_t since, std::vector<ChatMessage>* out,
               std::string* err);

// 举手 / 放手。房间成员表里带一个 hand 标志, 心跳时保留 (sync 里单独处理)。
enum class Hand { Ok, NotInRoom, Error };
Hand setHand(const std::string& token, bool raised, std::string* err);

// 麦克风开关 (让房间里别人看得见你是不是静音了)
enum class Mic { Ok, NotInRoom, Error };
Mic setMic(const std::string& token, bool on, std::string* err);

// 头像版本上报 (进房后调一次): 房间成员表里带上它, 别人才知道该拉哪一版头像。
enum class Ava { Ok, NotInRoom, Error };
Ava setAvatarVer(const std::string& token, long long ver, std::string* err);

// 屏幕共享状态上报 (让别人看得见是谁在共享)
enum class Share { Ok, NotInRoom, Error };
Share setShare(const std::string& token, bool on, std::string* err);

// 会中改名: 直接改房间成员表那一格里显示的名字 (个人资料里的昵称同步改过)
enum class Name { Ok, NotInRoom, Error };
Name setName(const std::string& token, const std::string& name, std::string* err);

// 按房间里的 pid 找这个人的会话令牌 (取头像用: 只有同房间的人能拿, 且不把用户名下发给别人)
bool tokenByPid(const std::string& room, const std::string& pid, std::string* out, std::string* err);

// 主持人把某个成员移出房间 (踢人)。只有主持人能踢, 只能踢同房间活着的人。
// *targetToken 回传被踢者的令牌, 调用方要用它清掉会话校验缓存 (见 handlers.cpp 的 kick 处理)。
enum class Kick { Ok, NotHost, NoSuchPeer, NotInRoom, Error };
Kick kick(const std::string& byToken, const std::string& targetPid, std::string* targetToken,
          std::string* err);

// 会议锁定: 锁上以后只有主持人能进 (已经在里面的人不受影响)。
enum class Lock { Ok, NotHost, NotInRoom, Error };
Lock setLocked(const std::string& token, bool locked, std::string* err);

bool leave(const std::string& token, std::string* err);

// 活跃房间数 (给 /api/health 用, SCAN 出来的, 有上限)
bool activeRooms(long long* out, std::string* err);

}  // namespace presence
