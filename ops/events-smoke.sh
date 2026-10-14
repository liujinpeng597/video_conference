#!/usr/bin/env bash
# 事件流端到端冒烟: 起 Kafka(profile events) + 审计消费者 + 应用,
# 用真实 API 产生会议生命周期事件, 断言消费者把事件落进了审计日志。
#
#   bash ops/events-smoke.sh        # 结束时自动收掉整套容器
set -u
cd "$(dirname "$0")/.."

DOCKER=${DOCKER:-docker}
BASE=${BASE:-http://127.0.0.1:9000}
# 关键: 让 compose 插值把应用也指到 Kafka (shell 环境变量优先于 .env)
export KAFKA_BROKERS=${KAFKA_BROKERS:-kafka:9092}

compose() { "$DOCKER" compose --profile events "$@"; }

fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

cleanup() { compose down >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1/3 起 Kafka + 消费者 + 应用 =="
compose up -d --build >/dev/null

ready=0
# 就绪信号用日志里的 "Kafka Server started": 瞬时、不挂。
# (别用 kafka-topics.sh 探活 —— AdminClient 在 broker 没起来时按 60s 超时挂住,
#  每次探测耗掉一分钟, 窗口再大也可能被吃光。)
for i in $(seq 1 90); do
    if compose logs kafka 2>/dev/null | grep -q "Kafka Server started"; then
        ready=1
        break
    fi
    sleep 2
done
if [ "$ready" = 1 ]; then
    ok "Kafka 就绪 (约 $((i * 2))s)"
else
    bad "Kafka 180 秒内没就绪"
    echo "--- Kafka 日志 (最后 15 行) ---"
    compose logs kafka --tail 15 2>/dev/null || true
    exit 1
fi
# broker 起来后给它几秒把 controller 选举/元数据稳定下来, 再产生事件
sleep 3

for i in $(seq 1 30); do curl -sm 3 "$BASE/api/health" 2>/dev/null | grep -q '"ok":true' && break; sleep 1; done
curl -sm 3 "$BASE/api/health" | grep -q '"ok":true' && ok "应用健康" || bad "应用没起来"

# 记下审计文件当前大小: 文件是 append 的, 断言只看本次新增的字节 (拿旧内容判会假绿)
before=$(compose exec -T events sh -c 'wc -c < /data/events.log 2>/dev/null || echo 0' | tr -dc '0-9')
before=${before:-0}

echo "== 2/3 用真实 API 产生事件 =="
TS=$(date +%s)
U1="evtsmoke${TS}a"
U2="evtsmoke${TS}b"
T1=$(curl -sm 5 -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
     -d "{\"username\":\"$U1\",\"password\":\"evt-pass-1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
T2=$(curl -sm 5 -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
     -d "{\"username\":\"$U2\",\"password\":\"evt-pass-1\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$T1" ] && [ -n "$T2" ] && ok "两个账号就绪" || bad "注册失败"

# 登录失败 (审计事件)
curl -sm 5 -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$U1\",\"password\":\"wrong-pass\"}" >/dev/null

# U1 建房 (room_created + participant_joined), U2 进房 (participant_joined), U2 离开 (participant_left)
room=$(curl -sm 5 -X POST "$BASE/api/rooms/enter" -H 'Content-Type: application/json' \
       -H "Authorization: Bearer $T1" -d '{}' | sed -n 's/.*"room":"\([^"]*\)".*/\1/p')
[ -n "$room" ] && ok "建了房间 $room" || bad "建房失败"
curl -sm 5 -X POST "$BASE/api/rooms/enter" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $T2" -d "{\"room\":\"$room\"}" >/dev/null
curl -sm 5 -X POST "$BASE/api/rooms/leave" -H 'Content-Type: application/json' \
    -H "Authorization: Bearer $T2" -d '{}' >/dev/null

echo "== 3/3 等消费者落盘并断言 =="
# 消费者可能比生产者晚连上 Kafka (重试要几秒), 所以是"轮询等事件出现"而不是固定 sleep
newlog=""
for i in $(seq 1 30); do
    newlog=$(compose exec -T events sh -c "tail -c +$((before + 1)) /data/events.log 2>/dev/null" || true)
    all=1
    for t in room_created participant_joined participant_left login_failed; do
        case "$newlog" in *"\"type\":\"$t\""*) ;; *) all=0 ;; esac
    done
    [ "$all" = 1 ] && break
    sleep 2
done
for t in room_created participant_joined participant_left login_failed; do
    case "$newlog" in
        *"\"type\":\"$t\""*) ok "事件已落盘: $t" ;;
        *) bad "缺事件: $t" ;;
    esac
done
case "$newlog" in
    *"\"room\":\"$room\""*) ok "事件里带房间号 $room (分区 key)" ;;
    *) bad "事件里没找到房间号 $room" ;;
esac

echo
if [ "$fail" = 0 ]; then
    echo "==== 事件流冒烟全部通过 ===="
else
    echo "==== 有断言失败 ===="
    echo "--- 消费者日志 (最后 10 行) ---"
    compose logs events --tail 10 2>/dev/null || true
fi
exit "$fail"
