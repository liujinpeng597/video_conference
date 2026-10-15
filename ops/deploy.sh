#!/usr/bin/env bash
# 在 VPS 上执行的部署脚本 (CD 工作流 .github/workflows/deploy.yml 也调它, 手动发布同样可用)。
#
# 按 tag 发布, 自带健康检查, 起不来就自动回滚到切之前的版本 —— 这就是最小可用的
# "发布 + 回滚"。发布形态 = docker-compose.yml + docker-compose.prod.yml (80/443 + TLS)。
#
#   bash ops/deploy.sh v0.2.0
#
# 需要的环境: git / docker compose / curl。健康检查地址可用 HEALTH_URL 覆盖。
set -euo pipefail
cd "$(dirname "$0")/.."

TAG=${1:?用法: bash ops/deploy.sh <tag, 如 v0.2.0>}
# 生产形态下 nginx 在 80/443 上终止 TLS; 这里直接打本机 nginx 的健康检查,
# 不依赖域名解析。HTTP_PORT 改过的话用 HEALTH_URL 覆盖。
HEALTH=${HEALTH_URL:-http://127.0.0.1:${HTTP_PORT:-80}/api/health}
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml)

# 记下"切之前"的版本, 健康检查失败时退回去
PREV=$(git describe --tags --exact-match 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || echo "")

echo "== 拉取并切到 $TAG (当前: ${PREV:-未知}) =="
git fetch --tags --force
git checkout -f "$TAG"

echo "== 构建并起来 =="
"${COMPOSE[@]}" up -d --build

echo "== 健康检查 ($HEALTH) =="
ok=0
for i in $(seq 1 30); do
    if curl -fsS -m 3 "$HEALTH" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
    sleep 2
done

if [ "$ok" = 1 ]; then
    echo "部署成功: $TAG"
    "${COMPOSE[@]}" ps
    exit 0
fi

echo "!! 健康检查失败, 回滚到 ${PREV:-上一个提交}"
"${COMPOSE[@]}" logs --tail 40 nginx 2>/dev/null || true
if [ -n "$PREV" ]; then
    git checkout -f "$PREV"
    "${COMPOSE[@]}" up -d --build
    echo "已回滚到 $PREV"
fi
exit 1
