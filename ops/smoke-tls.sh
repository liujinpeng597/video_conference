#!/usr/bin/env bash
# 生产形态冒烟: 自签证书 + docker-compose.prod.yml, 用 curl 验证整条入口链路:
#   https 健康检查 / 首页 200 / http 301 跳转 / 未登录 401 / 登录限流 429。
# 本地和 CI 都能跑; 需要能访问 docker CLI。
# 注意: 结束时会 down 掉本项目的容器 (数据卷不动)。
set -euo pipefail
cd "$(dirname "$0")/.."

DOCKER=${DOCKER:-docker}
# 端口优先取环境变量, 其次 .env (和 compose 的取值规则一致)
if [ -f .env ]; then
    v=$(grep -E '^HTTP_PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '\r' || true); [ -n "${v:-}" ] && HTTP_PORT=$v
    v=$(grep -E '^HTTPS_PORT=' .env | tail -n1 | cut -d= -f2- | tr -d '\r' || true); [ -n "${v:-}" ] && HTTPS_PORT=$v
fi
HTTP_PORT=${HTTP_PORT:-80}
HTTPS_PORT=${HTTPS_PORT:-443}

COMPOSE=("$DOCKER" compose -f docker-compose.yml -f docker-compose.prod.yml)
cleanup() { "${COMPOSE[@]}" down >/dev/null 2>&1 || true; }
trap cleanup EXIT

pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; exit 1; }

echo "== 1/3 生成自签证书 =="
DOCKER="$DOCKER" bash ops/gen-cert.sh >/dev/null
pass "nginx/certs/ 就绪"

echo "== 2/3 起生产形态 (80/443 + TLS) =="
"${COMPOSE[@]}" up -d --build >/dev/null

echo "== 3/3 断言 =="
ok=""
for _ in $(seq 1 60); do
    if curl -ks -m 3 "https://localhost:$HTTPS_PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
    sleep 2
done
[ -n "$ok" ] || { "${COMPOSE[@]}" logs --tail 30 nginx 2>/dev/null || true; fail "120 秒内 https /api/health 没有就绪"; }
pass "https :$HTTPS_PORT /api/health -> ok"

code=$(curl -ks -o /dev/null -w '%{http_code}' "https://localhost:$HTTPS_PORT/")
[ "$code" = "200" ] && pass "https 首页 200" || fail "https 首页期望 200, 实际 $code"

code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$HTTP_PORT/api/health")
[ "$code" = "301" ] && pass "http :$HTTP_PORT 301 跳 https" || fail "http 期望 301, 实际 $code"

code=$(curl -ks -o /dev/null -w '%{http_code}' "https://localhost:$HTTPS_PORT/api/ice")
[ "$code" = "401" ] && pass "未登录 /api/ice 401" || fail "/api/ice 期望 401, 实际 $code"

# 随机用户名: 后端按账号锁定不会触发, 能撞到的一定是 nginx 的按 IP 限流。
# nginx 限流文案是"操作太频繁", 和后端锁定的"尝试次数过多"区分开。
hit=""
for i in $(seq 1 16); do
    body=$(curl -ks -m 5 -X POST "https://localhost:$HTTPS_PORT/api/login" \
        -H 'Content-Type: application/json' \
        -d "{\"username\":\"rl$i$RANDOM\",\"password\":\"wrongpass123\"}" 2>/dev/null || true)
    case "$body" in *"操作太频繁"*) hit=1; break ;; esac
done
[ -n "$hit" ] && pass "快速 16 次登录触发 nginx 429 (限流生效)" || fail "快速登录没触发限流"

echo
echo "==== 生产形态冒烟全部通过 ===="
