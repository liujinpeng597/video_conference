#!/usr/bin/env bash
# 告警闭环演练: 起 Alertmanager + alert-sink, 往 Alertmanager 灌一条合成告警,
# 断言 alert-sink 收到了它 —— 证明"指标越线 -> 规则触发 -> 路由 -> 通知送达"这条
# 链路是通的。不接任何云服务; 换成真通知渠道 (改 alertmanager.yml 的 webhook url)
# 之后本演练照样适用, 只是终点从打印容器换成钉钉/飞书/Slack。
#
#   bash ops/alert-drill.sh        # 结束时自动收掉这两个容器
set -u
cd "$(dirname "$0")/.."

DOCKER=${DOCKER:-docker}
compose() { "$DOCKER" compose --profile monitoring "$@"; }

AM=${AM_URL:-http://127.0.0.1:9093}
SINK=${SINK_URL:-http://127.0.0.1:9099}

fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
cleanup() { compose rm -sf alertmanager alert-sink >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== 1/3 起 Alertmanager + alert-sink =="
compose up -d alert-sink alertmanager >/dev/null

ready=0
for i in $(seq 1 30); do
    if curl -fsS -m 3 "$SINK/" 2>/dev/null | grep -q "alert-sink up"; then ready=1; break; fi
    sleep 1
done
[ "$ready" = 1 ] && ok "alert-sink 就绪" \
    || { bad "alert-sink 没起来"; compose logs alert-sink --tail 20 2>/dev/null || true; exit 1; }

ready=0
for i in $(seq 1 30); do
    if curl -fsS -m 3 "$AM/-/ready" >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
done
[ "$ready" = 1 ] && ok "Alertmanager 就绪" \
    || { bad "Alertmanager 没起来"; compose logs alertmanager --tail 20 2>/dev/null || true; exit 1; }

echo "== 2/3 灌一条合成告警 =="
MARK="drill-$(date +%s)-$$"
# endsAt 用固定的远未来时间, 免得依赖 GNU date 的 -d 参数 (各平台行为不一致)
payload=$(cat <<JSON
[
  {
    "labels": {"alertname": "DrillAlert", "severity": "critical", "instance": "drill", "mark": "$MARK"},
    "annotations": {"summary": "闭环演练告警 $MARK"},
    "startsAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "endsAt": "2099-01-01T00:00:00Z"
  }
]
JSON
)
curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -d "$payload" "$AM/api/v2/alerts" >/dev/null \
    && ok "告警已提交给 Alertmanager ($MARK)" || bad "提交告警失败"

echo "== 3/3 断言 alert-sink 收到了 =="
got=0
for i in $(seq 1 30); do
    if compose logs alert-sink 2>/dev/null | grep -q "$MARK"; then got=1; break; fi
    sleep 1
done
[ "$got" = 1 ] && ok "告警已送达 alert-sink (闭环打通)" \
    || { bad "alert-sink 没收到告警"; compose logs alert-sink --tail 20 2>/dev/null || true; }

echo
[ "$fail" = 0 ] && echo "==== 告警闭环演练通过 ====" || echo "==== 有断言失败 ===="
exit "$fail"
