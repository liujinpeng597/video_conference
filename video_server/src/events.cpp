#include "events.h"

#include <librdkafka/rdkafka.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <string>

#include "json.h"
#include "log.h"
#include "metrics.h"

namespace events {
namespace {

rd_kafka_t* g_producer = nullptr;
rd_kafka_topic_t* g_topic = nullptr;

// 投递回调在 poll 里被调: 成功计数, 失败计数 + 每 100 条打一行日志 (不刷屏)
void onDelivery(rd_kafka_t*, const rd_kafka_message_t* msg, void*) {
    if (msg->err != 0) {
        metrics::countEventDropped();
        static std::atomic<int> n{0};
        if (n.fetch_add(1) % 100 == 0) {
            logmsg("[events] 事件投递失败 (累计 %d 条): %s\n", n.load(), rd_kafka_err2str(msg->err));
        }
    } else {
        metrics::countEventPublished();
    }
}

}  // namespace

void init(const std::string& brokers, const std::string& topic) {
    if (brokers.empty()) return;  // 没配 = 关闭
    const std::string topicName = topic.empty() ? "meeting.events" : topic;

    char errstr[512] = {0};
    rd_kafka_conf_t* conf = rd_kafka_conf_new();
    rd_kafka_conf_set(conf, "bootstrap.servers", brokers.c_str(), errstr, sizeof(errstr));
    // 尽力而为的取舍: 单节点等 1 条 ack 就够; 攒 20ms 发一批; 5 秒还没发出去就当丢
    rd_kafka_conf_set(conf, "acks", "1", errstr, sizeof(errstr));
    rd_kafka_conf_set(conf, "linger.ms", "20", errstr, sizeof(errstr));
    rd_kafka_conf_set(conf, "message.timeout.ms", "5000", errstr, sizeof(errstr));
    rd_kafka_conf_set(conf, "log_level", "3", errstr, sizeof(errstr));  // 只留 error
    rd_kafka_conf_set_dr_msg_cb(conf, onDelivery);

    g_producer = rd_kafka_new(RD_KAFKA_PRODUCER, conf, errstr, sizeof(errstr));
    if (g_producer == nullptr) {
        logmsg("[events] Kafka 生产者创建失败, 事件功能关闭: %s\n", errstr);
        return;
    }
    g_topic = rd_kafka_topic_new(g_producer, topicName.c_str(), nullptr);
    if (g_topic == nullptr) {
        logmsg("[events] 建 topic 句柄失败, 事件功能关闭\n");
        rd_kafka_destroy(g_producer);
        g_producer = nullptr;
        return;
    }
    logmsg("[events] 事件流已启用: %s -> %s\n", brokers.c_str(), topicName.c_str());
}

void emitRaw(const std::string& type, const std::string& key, const std::string& payloadJson) {
    if (g_producer == nullptr || g_topic == nullptr) return;

    // 信封: type + 毫秒时间戳; 消费端不用猜事件从哪来、什么时候来
    const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::system_clock::now().time_since_epoch())
                        .count();
    std::string body = "{\"type\":" + json::quote(type) +
                       ",\"ts\":" + std::to_string(ms) +
                       ",\"payload\":" + payloadJson + "}";

    const int rc = rd_kafka_produce(
        g_topic, RD_KAFKA_PARTITION_UA, RD_KAFKA_MSG_F_COPY,
        (void*)body.data(), body.size(),
        key.empty() ? nullptr : (void*)key.data(), key.size(),
        nullptr);
    if (rc != 0) {
        metrics::countEventDropped();
        static std::atomic<int> n{0};
        if (n.fetch_add(1) % 100 == 0) {
            logmsg("[events] 本地队列满, 事件被丢 (累计 %d 条)\n", n.load());
        }
    }
    rd_kafka_poll(g_producer, 0);  // 非阻塞: 把投递回调跑掉
}

void roomEvent(const std::string& type, const std::string& room, const std::string& user) {
    emitRaw(type, room, "{\"room\":" + json::quote(room) + ",\"user\":" + json::quote(user) + "}");
}

void userEvent(const std::string& type, const std::string& user) {
    emitRaw(type, user, "{\"user\":" + json::quote(user) + "}");
}

}  // namespace events
