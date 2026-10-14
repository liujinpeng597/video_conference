#!/usr/bin/env bash
# 降级演练 (非破坏性): 验证"依赖挂了会发生什么", 结束后保证服务恢复原状。
# 演练矩阵见 DEPLOY.md 第 9 节; PG / Redis 只 stop 不删, 数据无损。
#
#   bash ops/degradation-drill.sh          # 需要开发形态已在跑 (docker compose up -d)
set -u
cd "$(dirname "$0")/.."

BASE=${BASE:-http://127.0.0.1:9000}
DOCKER=${DOCKER:-docker}
compose() { "$DOCKER" compose "$@"; }

fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }

health_raw()  { curl -sm 4 "$BASE/api/health" || true; }
health_ok()   { health_raw | grep -q '"ok":true'; }
health_down() { health_raw | grep -q '"ok":false'; }
status_of()   { curl -sm 10 -o /dev/null -w '%{http_code}' "$@" || echo 000; }
login_code()  { # 用户名 密码
    status_of -X POST "$BASE/api/login" -H 'Content-Type: application/json' \
        -d "{\"username\":\"$1\",\"password\":\"$2\"}"
}

# 无论从哪一步退出, 都把中间件拉回来 (幂等)
restore_all() { compose start db redis >/dev/null 2>&1 || true; }
trap restore_all EXIT

echo "== 0/3 基线圈 =="
if health_ok; then ok "健康检查 ok:true"; else bad "基线就不健康, 先把栈起好 (docker compose up -d)"; fi

USER_D="drill$(date +%s)"
reg=$(curl -sm 10 -X POST "$BASE/api/register" -H 'Content-Type: application/json' \
      -d "{\"username\":\"$USER_D\",\"password\":\"drill-pass-1\"}" || true)
TOKEN=$(printf '%s' "$reg" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | head -1)
[ -n "$TOKEN" ] && ok "注册并拿到会话令牌" || bad "基线注册失败: $reg"

code=$(status_of "$BASE/api/rooms/state?since=0" -H "Authorization: Bearer $TOKEN")
[ "$code" = "200" ] && ok "rooms/state 200" || bad "基线 rooms/state=$code"

echo
echo "== 1/3 Redis 挂 =="
compose stop redis >/dev/null
down=0
for i in $(seq 1 10); do health_down && { down=1; break; }; sleep 1; done
if [ "$down" = 1 ]; then ok "health ok:false (预期)"; else bad "Redis 挂了 10s 内 health 仍不是 ok:false"; fi
code=$(status_of "$BASE/api/rooms/state?since=0" -H "Authorization: Bearer $TOKEN")
[ "$code" = "500" ] && ok "rooms/state 500 (预期)" || bad "期望 500, 实际 $code"
code=$(login_code "$USER_D" "drill-pass-1")
[ "$code" = "200" ] && ok "登录不受影响 (只依赖 PG)" || bad "期望登录 200, 实际 $code"

# 恢复窗口给足: Windows Docker Desktop 偶发容器内 DNS 抖动时, 重连可能比 Linux 慢
compose start redis >/dev/null
i=0
for i in $(seq 1 60); do health_ok && break; sleep 1; done
if health_ok; then ok "Redis 起回后健康恢复 (约 ${i}s)"; else bad "Redis 起回后 60s 内仍未恢复"; fi
code=$(status_of "$BASE/api/rooms/state?since=0" -H "Authorization: Bearer $TOKEN")
[ "$code" = "200" ] && ok "rooms/state 恢复 200" || bad "恢复失败, state=$code"

echo
echo "== 2/3 PostgreSQL 挂 =="
compose stop db >/dev/null
down=0
for i in $(seq 1 10); do health_down && { down=1; break; }; sleep 1; done
if [ "$down" = 1 ]; then ok "health ok:false (预期)"; else bad "PG 挂了 10s 内 health 仍不是 ok:false"; fi
code=$(login_code "$USER_D" "drill-pass-1")
case "$code" in
    5*|401) ok "登录失败 ($code, 预期 5xx/401)" ;;
    *)      bad "期望登录 5xx/401, 实际 $code" ;;
esac

compose start db >/dev/null
i=0
for i in $(seq 1 90); do health_ok && break; sleep 1; done
if health_ok; then ok "PG 起回后健康恢复 (约 ${i}s)"; else bad "PG 起回后 90s 内仍未恢复"; fi
code=$(login_code "$USER_D" "drill-pass-1")
[ "$code" = "200" ] && ok "登录恢复 200" || bad "恢复失败, login=$code"

echo
if [ "$fail" = 0 ]; then
    echo "==== 降级演练全部通过 (服务已恢复到演练前状态) ===="
else
    echo "==== 有断言失败 (服务同样已尝试恢复, 请检查) ===="
fi
exit "$fail"
