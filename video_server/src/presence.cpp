#include "presence.h"

#include <chrono>
#include <cstdlib>

#include "random.h"
#include "redis.h"

namespace presence {
namespace {

// 这么久没心跳就不算在房间里了。
// 为什么是 30s 而不是更小: 稳定期 2s 一拍, 后台标签页会被浏览器节流, 弱网还会丢拍;
// 7s 只容得下 3 拍, 一次抖动就把健康的连接判成离线、立刻拆掉。30s 能扛住这些,
// 代价是崩掉的浏览器最多 30s 后才从名单里消失 (媒体层面 WebRTC 会更早报 failed)。
constexpr int64_t kPresenceTtlMs = 30000;
constexpr long long kKeyTtlSec = 60;      // room / session / mailbox 的 Redis TTL
// mesh(两两直连)下每个人都要给其他每个人发一路, 上行是 (N-1) 倍, 6 人差不多到顶了
constexpr size_t kMaxRoomPeers = 6;
// 一次协商几十条消息就够了, 留 64 条是给"轮询丢了一拍重试"用的
constexpr long long kMailboxMax = 64;
// 房间聊天: 只留最近 50 条, 10 分钟没人聊就整条过期。TTL 比房间的 60s 宽, 是为了
// "低头处理点别的、回头还能看到刚才的对话"; 房间真的空了 enter 会把它清掉,
// 所以复用的房间号上不会看到上一个房间的聊天。
constexpr long long kChatMax = 50;
constexpr long long kChatTtlSec = 600;
constexpr size_t kMaxChatText = 500;  // 单条上限 (字节)
constexpr char kSep = '\x1f';
// 房间 hash 里存"主持人 token"的字段名 (主持人 = 建房的人)。token 是十六进制串, 带 '@'
// 的名字不会撞上; 它不是成员 —— parseMember 解析不出来会当成"不在", peersJson 会跳过。
constexpr char kHostField[] = "@host";
constexpr char kLockField[] = "@locked";   // "1" = 会议锁定, 只有主持人能进

int64_t nowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string roomKey(const std::string& room) { return "room:" + room; }
std::string sessionKey(const std::string& token) { return "session:" + token; }
std::string mailboxKey(const std::string& token) { return "mailbox:" + token; }
std::string chatKey(const std::string& room) { return "chat:" + room; }
std::string chatSeqKey(const std::string& room) { return "chat:seq:" + room; }

const char* kSeqKey = "signaling:seq";

// 把 a/b/c 用 \x1f 拼起来
std::string join3(const std::string& a, const std::string& b, const std::string& c) {
    std::string s;
    s.reserve(a.size() + b.size() + c.size() + 2);
    s += a;
    s.push_back(kSep);
    s += b;
    s.push_back(kSep);
    s += c;
    return s;
}

// 每人一个的"标志"(举手 / 静音) 单独放房间 hash 的字段里, 不塞进成员值 ——
// 成员值每次心跳都会被整个重写, 塞进去就得"先读后写"才保得住, 容易漏。
// 字段名带 '@' (和 @host 一个路子), 不会撞上十六进制的 token。
std::string handField(const std::string& token) { return "@hand:" + token; }
std::string micField(const std::string& token) { return "@mic:" + token; }
std::string avField(const std::string& token) { return "@av:" + token; }
std::string shareField(const std::string& token) { return "@share:" + token; }

// 按前 n 个分隔符切开, 剩下的整段作为最后一项 (payload 里可能有任意内容)
bool splitN(const std::string& s, int n, std::vector<std::string>* out) {
    size_t pos = 0;
    for (int i = 0; i < n; ++i) {
        const size_t p = s.find(kSep, pos);
        if (p == std::string::npos) return false;
        out->push_back(s.substr(pos, p - pos));
        pos = p + 1;
    }
    out->push_back(s.substr(pos));
    return true;
}

Member parseMember(const std::string& token, const std::string& value, int64_t now) {
    Member m;
    m.token = token;
    // 成员值是 pid\x1fuser\x1fseen (至少 3 段)。多出来的段是老格式 (曾经把 hand 塞在值里)
    // 留下的, 直接忽略 —— 标志现在走 @hand:/@mic: 字段, 由 applyFlags 合并。
    std::vector<std::string> parts;
    size_t pos = 0;
    for (int i = 0; i < 2; ++i) {
        const size_t p = value.find(kSep, pos);
        if (p == std::string::npos) {
            m.live = false;  // 字段坏了就当不在
            return m;
        }
        parts.push_back(value.substr(pos, p - pos));
        pos = p + 1;
    }
    // 第 3 段: 从 pos 到下一个分隔符 (或结尾); 后面的段忽略 (老格式把 hand 塞在值里)
    const size_t third = value.find(kSep, pos);
    parts.push_back((third == std::string::npos) ? value.substr(pos) : value.substr(pos, third - pos));
    m.pid = parts[0];
    m.user = parts[1];
    m.seenMs = std::strtoll(parts[2].c_str(), nullptr, 10);
    m.live = (now - m.seenMs) <= kPresenceTtlMs;
    return m;
}

// 把 @hand:<token> / @mic:<token> 标志合并进成员列表 (默认: 没举手、麦克风开着)
void applyFlags(const std::vector<redis::Field>& fields, std::vector<Member>* members) {
    for (Member& m : *members) {
        m.hand = false;
        m.mic = true;
        m.avatarVer = 0;
        m.share = false;
    }
    for (const redis::Field& f : fields) {
        // 字段名形如 @hand:<token> / @mic:<token> / @share:<token> / @av:<token>
        std::string tok;
        int kind = -1;   // 0=hand 1=mic 2=share 3=av
        if (f.name.rfind("@hand:", 0) == 0) { tok = f.name.substr(6); kind = 0; }
        else if (f.name.rfind("@mic:", 0) == 0) { tok = f.name.substr(5); kind = 1; }
        else if (f.name.rfind("@share:", 0) == 0) { tok = f.name.substr(7); kind = 2; }
        else if (f.name.rfind("@av:", 0) == 0) { tok = f.name.substr(4); kind = 3; }
        else continue;
        for (Member& m : *members) {
            if (m.token != tok) continue;
            const bool on = (f.value == "1");
            if (kind == 0) m.hand = on;
            else if (kind == 1) m.mic = on;
            else if (kind == 2) m.share = on;
            else m.avatarVer = std::strtoll(f.value.c_str(), nullptr, 10);
            break;
        }
    }
}

}  // namespace

bool whereAmI(const std::string& token, Me* me, std::string* err) {
    me->room.clear();
    me->pid.clear();
    me->user.clear();

    std::string v;
    if (!redis::get(sessionKey(token), &v, err)) return false;  // err 空 = 不在房间

    std::vector<std::string> parts;
    if (!splitN(v, 2, &parts)) return false;
    me->room = parts[0];
    me->pid = parts[1];
    me->user = parts[2];
    return true;
}

bool roomLive(const std::string& room, bool* out, std::string* err) {
    return redis::exists(roomKey(room), out, err);
}

Enter enter(const std::string& token, const std::string& user, const std::string& room,
            std::string* pid, std::vector<Member>* members, std::string* err) {
    const int64_t now = nowMs();

    // 重新进来时把自己的标志清回默认: 没举手 (麦克风由前端进房后立刻上报一次)
    std::string flagErr;
    redis::hDel(roomKey(room), handField(token), &flagErr);
    redis::hDel(roomKey(room), micField(token), &flagErr);
    redis::hDel(roomKey(room), avField(token), &flagErr);
    redis::hDel(roomKey(room), shareField(token), &flagErr);

    // 先看现在有谁: 成员列表要返回给前端, 顺便做人数上限检查
    std::vector<redis::Field> fields;
    if (!redis::hGetAll(roomKey(room), &fields, err)) return Enter::Error;

    members->clear();
    size_t live = 0;
    bool alreadyHere = false;
    std::string hostToken;
    bool locked = false;
    for (const redis::Field& f : fields) {
        if (f.name == kHostField) { hostToken = f.value; continue; }
        if (f.name == kLockField) { locked = (f.value == "1"); continue; }
        Member m = parseMember(f.name, f.value, now);
        if (m.live) ++live;
        if (m.token == token) alreadyHere = true;
        members->push_back(std::move(m));
    }
    // 已经在房间里的人重新进不算新增 (比如刷新页面后又点了加入)
    if (!alreadyHere && live >= kMaxRoomPeers) return Enter::Full;
    // 会议锁上以后, 只有主持人还能进来 (已经在里面的人不受影响)
    if (!alreadyHere && locked && token != hostToken) return Enter::Locked;

    *pid = rnd::hex(6);  // 每次进房间换一个地址, 免得被人拿旧的乱发

    if (!redis::hSet(roomKey(room), token, join3(*pid, user, std::to_string(now)), err)) {
        return Enter::Error;
    }
    if (!redis::expire(roomKey(room), kKeyTtlSec, err)) return Enter::Error;
    if (!redis::setEx(sessionKey(token), join3(room, *pid, user), kKeyTtlSec, err)) return Enter::Error;
    // 换房间了, 把上一个房间留下的信令清掉
    if (!redis::del(mailboxKey(token), err)) return Enter::Error;
    // 这个房间本来就是空的 (刚被创建, 或者号码被复用): 清掉可能残留的聊天历史,
    // 免得后进来的人看到上一拨人的对话
    if (live == 0) {
        if (!redis::del(chatKey(room), err)) return Enter::Error;
        if (!redis::del(chatSeqKey(room), err)) return Enter::Error;
        // 建房的人就是主持人 (房间 hash 里一个特殊字段, 跟着房间 TTL 一起过期)
        if (!redis::hSet(roomKey(room), kHostField, token, err)) return Enter::Error;
    }

    // 上面的 HGETALL 是在写我之前跑的, 所以自己得补进去
    bool patched = false;
    for (Member& m : *members) {
        if (m.token != token) continue;
        m.pid = *pid;
        m.user = user;
        m.seenMs = now;
        m.live = true;
        patched = true;
    }
    if (!patched) {
        Member me;
        me.token = token;
        me.pid = *pid;
        me.user = user;
        me.seenMs = now;
        me.live = true;
        members->push_back(std::move(me));
    }
    applyFlags(fields, members);   // 把我刚清掉的标志按默认值补齐, 别人按字段里的值
    return Enter::Ok;
}

bool sync(const std::string& token, uint64_t since, std::string* room,
          std::vector<Member>* members, std::vector<Signal>* msgs, std::string* hostPid,
          bool* locked, std::string* err) {
    room->clear();
    members->clear();
    msgs->clear();
    hostPid->clear();
    *locked = false;

    Me me;
    if (!whereAmI(token, &me, err)) return err->empty();  // 不在房间 = 正常情况
    *room = me.room;

    const int64_t now = nowMs();
    // 一次 HGETALL 拿到所有成员 + 标志字段 (@hand:/@mic:)
    std::vector<redis::Field> fields;
    if (!redis::hGetAll(roomKey(me.room), &fields, err)) return false;

    // 心跳: 刷新自己的 seen, 顺便续上 room / session 的 TTL (标志在别的字段里, 不受影响)
    if (!redis::hSet(roomKey(me.room), token, join3(me.pid, me.user, std::to_string(now)), err)) {
        return false;
    }
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return false;
    if (!redis::expire(sessionKey(token), kKeyTtlSec, err)) return false;

    // 用刚读到的字段拼成员表; 我自己的那一格补成"心跳之后"的值
    bool sawMe = false;
    for (const redis::Field& f : fields) {
        Member m = parseMember(f.name, f.value, now);
        if (m.token == token) {
            m.pid = me.pid;
            m.user = me.user;
            m.seenMs = now;
            m.live = true;
            sawMe = true;
        }
        members->push_back(std::move(m));
    }
    if (!sawMe) {  // 兜底: 理论上不会发生 (enter 已经把我写进去了)
        Member m;
        m.token = token;
        m.pid = me.pid;
        m.user = me.user;
        m.seenMs = now;
        m.live = true;
        members->push_back(std::move(m));
    }
    applyFlags(fields, members);   // 举手 / 静音标志 (默认 没举手 / 麦开着)

    // 主持人 = 建房的人 (房间 hash 里的特殊字段)。把 token 翻译成 pid 下发给前端;
    // 主持人已离开时这个 pid 找不到, 留空 = 房间里暂时没有主持人。
    std::string hostToken;
    for (const redis::Field& f : fields) {
        if (f.name == kHostField) {
            hostToken = f.value;
            break;
        }
    }
    for (const redis::Field& f : fields) {
        if (f.name == kLockField) {
            *locked = (f.value == "1");
            break;
        }
    }
    if (!hostToken.empty()) {
        for (const Member& m : *members) {
            if (m.token == hostToken && m.live) {
                *hostPid = m.pid;
                break;
            }
        }
    }

    std::vector<std::string> raw;
    if (!redis::lRange(mailboxKey(token), &raw, err)) return false;
    for (const std::string& item : raw) {
        std::vector<std::string> parts;
        if (!splitN(item, 3, &parts)) continue;
        Signal s;
        s.seq = std::strtoull(parts[0].c_str(), nullptr, 10);
        if (s.seq <= since) continue;  // 客户端已经收过的
        s.from = parts[1];
        s.kind = parts[2];
        s.payload = parts[3];
        msgs->push_back(std::move(s));
    }
    return true;
}

Send send(const std::string& token, const std::string& toPid, const std::string& kind,
          const std::string& payload, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Send::NotInRoom : Send::Error;

    std::vector<redis::Field> fields;
    if (!redis::hGetAll(roomKey(me.room), &fields, err)) return Send::Error;

    // 只能发给同一个房间里还活着的人。不做这个检查, 任何登录用户都能往别人房间塞信令。
    const int64_t now = nowMs();
    std::string target;
    for (const redis::Field& f : fields) {
        Member m = parseMember(f.name, f.value, now);
        if (m.pid == toPid && m.live) {
            target = m.token;
            break;
        }
    }
    if (target.empty()) return Send::NoSuchPeer;

    // 取号 + 入队 + 裁剪 + 续期必须原子完成 (redis::mailboxPush 里有完整解释):
    // 分开跑的话, 并发下"序号小的条目后入队", 收件人的游标一旦越过就永久丢这条信令。
    long long seq = 0;
    if (!redis::mailboxPush(kSeqKey, mailboxKey(target), me.pid, kind, payload,
                            std::string(1, kSep), kMailboxMax, kKeyTtlSec, &seq, err)) {
        return Send::Error;
    }
    return Send::Delivered;
}

Chat postChat(const std::string& token, const std::string& text, ChatMessage* out, std::string* err) {
    // 文本校验: 非空、不超长、不含控制字符 (控制字符既会撞上 \x1f 分隔符,
    // 也会破坏"单行输入"的假设)。UTF-8 的多字节字符 >=0x80, 不受影响。
    if (text.empty()) return Chat::Empty;
    if (text.size() > kMaxChatText) return Chat::TooLong;
    for (unsigned char c : text) {
        if (c < 0x20 || c == 0x7f) return Chat::BadText;
    }

    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Chat::NotInRoom : Chat::Error;

    long long id = 0;
    if (!redis::chatPush(chatSeqKey(me.room), chatKey(me.room), me.pid, me.user, text,
                         std::string(1, kSep), kChatMax, kChatTtlSec, &id, err)) {
        return Chat::Error;
    }
    out->id = (uint64_t)id;
    out->from = me.pid;
    out->name = me.user;
    out->text = text;
    return Chat::Ok;
}

bool chatSince(const std::string& room, uint64_t since, std::vector<ChatMessage>* out,
               std::string* err) {
    out->clear();
    if (room.empty()) return true;  // 不在房间, 没有消息

    std::vector<std::string> raw;
    if (!redis::lRange(chatKey(room), &raw, err)) return false;
    for (const std::string& line : raw) {
        std::vector<std::string> parts;
        if (!splitN(line, 3, &parts)) continue;  // 字段坏了就跳过这一条
        const uint64_t id = std::strtoull(parts[0].c_str(), nullptr, 10);
        if (id <= since) continue;               // 客户端已经收过的
        ChatMessage m;
        m.id = id;
        m.from = parts[1];
        m.name = parts[2];
        m.text = parts[3];
        out->push_back(std::move(m));
    }
    return true;
}

Hand setHand(const std::string& token, bool raised, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Hand::NotInRoom : Hand::Error;
    // 只写自己那一格标志, 不动成员值 (心跳在管那个), 也不用先读后写
    if (!redis::hSet(roomKey(me.room), handField(token), raised ? "1" : "0", err)) return Hand::Error;
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return Hand::Error;
    return Hand::Ok;
}

Share setShare(const std::string& token, bool on, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Share::NotInRoom : Share::Error;
    if (!redis::hSet(roomKey(me.room), shareField(token), on ? "1" : "0", err)) return Share::Error;
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return Share::Error;
    return Share::Ok;
}

Name setName(const std::string& token, const std::string& name, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Name::NotInRoom : Name::Error;
    const int64_t now = nowMs();
    // 成员值就是 pid\x1f显示名\x1fseen, 改名字就直接重写这一格
    if (!redis::hSet(roomKey(me.room), token, join3(me.pid, name, std::to_string(now)), err)) {
        return Name::Error;
    }
    // 关键: 显示名在会话值里也存了一份 (whereAmI 读它, 心跳又用它重写成员值)。
    // 只改成员值的话, 本人下一次心跳就把旧名字写回来了 —— "改名没生效"就是这么来的。
    if (!redis::setEx(sessionKey(token), join3(me.room, me.pid, name), kKeyTtlSec, err)) {
        return Name::Error;
    }
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return Name::Error;
    return Name::Ok;
}

Ava setAvatarVer(const std::string& token, long long ver, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Ava::NotInRoom : Ava::Error;
    if (!redis::hSet(roomKey(me.room), avField(token), std::to_string(ver), err)) return Ava::Error;
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return Ava::Error;
    return Ava::Ok;
}

bool tokenByPid(const std::string& room, const std::string& pid, std::string* out, std::string* err) {
    out->clear();
    if (room.empty() || pid.empty()) return true;
    std::vector<redis::Field> fields;
    if (!redis::hGetAll(roomKey(room), &fields, err)) return false;
    const int64_t now = nowMs();
    for (const redis::Field& f : fields) {
        if (!f.name.empty() && f.name[0] == '@') continue;   // @host / @hand: / @mic: / @av: 不是成员
        const Member m = parseMember(f.name, f.value, now);
        if (m.live && m.pid == pid) {
            *out = m.token;
            break;
        }
    }
    return true;
}

Mic setMic(const std::string& token, bool on, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Mic::NotInRoom : Mic::Error;
    if (!redis::hSet(roomKey(me.room), micField(token), on ? "1" : "0", err)) return Mic::Error;
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return Mic::Error;
    return Mic::Ok;
}

Lock setLocked(const std::string& token, bool locked, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty() ? Lock::NotInRoom : Lock::Error;
    std::vector<redis::Field> fields;
    if (!redis::hGetAll(roomKey(me.room), &fields, err)) return Lock::Error;
    std::string hostToken;
    for (const redis::Field& f : fields) {
        if (f.name == kHostField) {
            hostToken = f.value;
            break;
        }
    }
    if (hostToken != token) return Lock::NotHost;   // 只有主持人能锁 / 解锁
    if (!redis::hSet(roomKey(me.room), kLockField, locked ? "1" : "0", err)) return Lock::Error;
    if (!redis::expire(roomKey(me.room), kKeyTtlSec, err)) return Lock::Error;
    return Lock::Ok;
}

bool leave(const std::string& token, std::string* err) {
    Me me;
    if (!whereAmI(token, &me, err)) return err->empty();  // 本来就不在, 当成成功

    if (!redis::hDel(roomKey(me.room), token, err)) return false;
    {   // 顺手把自己的标志字段也删掉
        std::string ignore;
        redis::hDel(roomKey(me.room), handField(token), &ignore);
        redis::hDel(roomKey(me.room), micField(token), &ignore);
        redis::hDel(roomKey(me.room), avField(token), &ignore);
        redis::hDel(roomKey(me.room), shareField(token), &ignore);
    }
    if (!redis::del(sessionKey(token), err)) return false;
    if (!redis::del(mailboxKey(token), err)) return false;

    // 看看走之后还剩谁 (顺带处理主持人交接)。这些是尽力而为的收尾, 失败不影响"离开"本身。
    std::string ignore;
    std::vector<redis::Field> fields;
    if (redis::hGetAll(roomKey(me.room), &fields, &ignore)) {
        const int64_t now = nowMs();
        std::string hostToken;
        std::string successor;
        int liveMembers = 0;
        for (const redis::Field& f : fields) {
            if (f.name == kHostField) {
                hostToken = f.value;
                continue;
            }
            const Member m = parseMember(f.name, f.value, now);
            if (!m.live) continue;
            ++liveMembers;
            if (successor.empty()) successor = m.token;
        }
        if (liveMembers == 0) {
            // 房间空了: 整把 key 删掉 (含主持人字段), 不然房间数会虚高 (反正也有 TTL 兜底)
            redis::del(roomKey(me.room), &ignore);
        } else if (hostToken == token && !successor.empty()) {
            // 主持人走了但还有人: 把主持人交给剩下的第一个人, 房间不至于没人管
            redis::hSet(roomKey(me.room), kHostField, successor, &ignore);
        }
    }
    return true;
}

Kick kick(const std::string& byToken, const std::string& targetPid, std::string* targetToken,
          std::string* err) {
    targetToken->clear();
    Me me;
    if (!whereAmI(byToken, &me, err)) return err->empty() ? Kick::NotInRoom : Kick::Error;

    std::vector<redis::Field> fields;
    if (!redis::hGetAll(roomKey(me.room), &fields, err)) return Kick::Error;

    const int64_t now = nowMs();
    std::string hostToken;
    std::string victim;
    for (const redis::Field& f : fields) {
        if (f.name == kHostField) {
            hostToken = f.value;
            continue;
        }
        const Member m = parseMember(f.name, f.value, now);
        if (m.live && m.pid == targetPid) victim = m.token;
    }
    if (hostToken != byToken) return Kick::NotHost;  // 只有主持人能踢人
    if (victim.empty()) return Kick::NoSuchPeer;
    if (!leave(victim, err)) return Kick::Error;
    *targetToken = victim;
    return Kick::Ok;
}

bool activeRooms(long long* out, std::string* err) {
    return redis::countKeys("room:*", 10000, out, err);
}

}  // namespace presence
