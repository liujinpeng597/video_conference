// 事件流消费者: meeting.events -> 审计 JSONL (/data/events.log + stdout)。
//
// 为什么必须有消费者: 没有消费者的消息队列是摆设。这条链路的最小真实用途是审计
// (谁在什么时候进了哪个房间、谁登录失败); 以后的通知 / 录制转码 / 统计入库
// 都可以作为新的消费者组挂在同一个 topic 上, 互不影响。
//
// 消费语义: 至少一次 (自动提交位移)。审计重复一条比少一条强; 要严格去重
// 可以用事件里的 (type, ts) 做幂等键, 现在不做。
#include <librdkafka/rdkafka.h>

#include <csignal>
#include <cstdio>
#include <cstdlib>

namespace {

volatile std::sig_atomic_t g_stop = 0;
void onSignal(int) { g_stop = 1; }

}  // namespace

int main() {
    const char* brokers = std::getenv("KAFKA_BROKERS");
    if (brokers == nullptr || *brokers == '\0') brokers = "kafka:9092";
    const char* topic = std::getenv("KAFKA_TOPIC");
    if (topic == nullptr || *topic == '\0') topic = "meeting.events";
    const char* group = std::getenv("KAFKA_GROUP");
    if (group == nullptr || *group == '\0') group = "event-audit";
    const char* outPath = std::getenv("EVENTS_LOG");
    if (outPath == nullptr || *outPath == '\0') outPath = "/data/events.log";

    std::signal(SIGINT, onSignal);
    std::signal(SIGTERM, onSignal);

    std::FILE* out = std::fopen(outPath, "a");
    if (out == nullptr) std::fprintf(stderr, "[events] 打不开 %s, 只写 stdout\n", outPath);

    char errstr[512] = {0};
    rd_kafka_conf_t* conf = rd_kafka_conf_new();
    rd_kafka_conf_set(conf, "bootstrap.servers", brokers, errstr, sizeof(errstr));
    rd_kafka_conf_set(conf, "group.id", group, errstr, sizeof(errstr));
    rd_kafka_conf_set(conf, "auto.offset.reset", "earliest", errstr, sizeof(errstr));
    rd_kafka_conf_set(conf, "log_level", "3", errstr, sizeof(errstr));

    rd_kafka_t* consumer = rd_kafka_new(RD_KAFKA_CONSUMER, conf, errstr, sizeof(errstr));
    if (consumer == nullptr) {
        std::fprintf(stderr, "[events] 消费者创建失败: %s\n", errstr);
        return 1;
    }
    rd_kafka_poll_set_consumer(consumer);

    rd_kafka_topic_partition_list_t* topics = rd_kafka_topic_partition_list_new(1);
    rd_kafka_topic_partition_list_add(topics, topic, RD_KAFKA_PARTITION_UA);
    if (rd_kafka_subscribe(consumer, topics) != RD_KAFKA_RESP_ERR_NO_ERROR) {
        std::fprintf(stderr, "[events] 订阅 %s 失败\n", topic);
        return 1;
    }
    rd_kafka_topic_partition_list_destroy(topics);
    std::fprintf(stderr, "[events] 消费者就绪: %s (group=%s, 落盘 %s)\n", topic, group, outPath);

    while (!g_stop) {
        rd_kafka_message_t* m = rd_kafka_consumer_poll(consumer, 500);
        if (m == nullptr) continue;
        if (m->err == RD_KAFKA_RESP_ERR__PARTITION_EOF) {
            rd_kafka_message_destroy(m);
            continue;
        }
        if (m->err != 0) {
            std::fprintf(stderr, "[events] 消费出错: %s\n", rd_kafka_message_errstr(m));
            rd_kafka_message_destroy(m);
            continue;
        }
        const char* data = (const char*)m->payload;
        const size_t len = m->len;
        if (out != nullptr) {
            std::fwrite(data, 1, len, out);
            std::fputc('\n', out);
            std::fflush(out);  // 审计日志: 每条都落盘, 崩了也不丢已收的
        }
        std::fwrite(data, 1, len, stdout);
        std::fputc('\n', stdout);
        std::fflush(stdout);
        rd_kafka_message_destroy(m);
    }

    std::fprintf(stderr, "[events] 收到退出信号, 关闭消费者\n");
    rd_kafka_consumer_close(consumer);
    rd_kafka_destroy(consumer);
    if (out != nullptr) std::fclose(out);
    return 0;
}
