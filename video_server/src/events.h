#pragma once

#include <string>

// 会议生命周期事件流 (Kafka)。
//
// 为什么事件走 Kafka 而信令不走:
//   信令 (offer/answer/ICE) 是"点对点、亚秒级、带 TTL 的邮箱"语义 —— 每个参会者
//   一个收件箱, 消息过期即弃, 必须低延迟; Redis 的 List+TTL 就是对的工具。
//   Kafka 是"追加日志 / 流"语义: 同一事件多方消费、可以重放、可以离线攒批 ——
//   适合审计、统计, 以及以后的通知 / 录制转码这类异步链路, 不适合当收件箱。
//
// 可靠性定位: 尽力而为。Kafka 不可用时事件会丢 (记日志 + 计数), 但绝不阻塞、
// 绝不影响业务请求 —— 审计少几条可以接受, 会议本身不允许卡。
namespace events {

// 进程启动时调一次; brokers 为空 = 功能关闭 (零开销)。topic 默认 meeting.events。
void init(const std::string& brokers, const std::string& topic);

// 发一个事件。key 用于分区 (同一房间的事件落在同一分区, 保证房间内有序)。
// 线程安全: librdkafka 的 producer 本身线程安全。
void emitRaw(const std::string& type, const std::string& key, const std::string& payloadJson);

// 常用封装: 房间类事件带 room + user; 账号类事件带 user。
void roomEvent(const std::string& type, const std::string& room, const std::string& user);
void userEvent(const std::string& type, const std::string& user);

}  // namespace events
