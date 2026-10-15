#!/usr/bin/env bash
# k6 负载测试的一键入口: 在 compose 网络里起一个 k6 容器, 压 127.0.0.1:9000 后面那套链路。
#
#   bash ops/loadtest/run.sh                     # 60 VU / 1 分钟
#   VUS=200 DURATION=3m bash ops/loadtest/run.sh
#
# 前提: 栈已起来 (docker compose up -d)。跑完看 ops/loadtest/out/summary.json。
# 这台机器拉不动 Docker Hub 时, K6_IMAGE 指向能用的镜像源。
set -euo pipefail

cd "$(dirname "$0")/../.." # 仓库根目录

NETWORK="${NETWORK:-video_conference_default}"
K6_IMAGE="${K6_IMAGE:-docker.m.daocloud.io/grafana/k6:latest}"

# Git Bash (MSYS) 会把容器里的 "/scripts/..." 参数错误地转换成 Windows 路径,
# 结果是 k6 在 C:\GitHub\Git\scripts 找脚本。把宿主目录转成 Windows 形式并关闭
# 参数转换, 两边路径就都对了; Linux / CI 下这两步是空操作。
SCRIPTS_DIR="$PWD/ops/loadtest"
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        SCRIPTS_DIR=$(cygpath -w "$SCRIPTS_DIR")
        export MSYS2_ARG_CONV_EXCL='*'
        ;;
esac

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
    echo "找不到网络 $NETWORK —— 先把栈起来: docker compose up -d" >&2
    exit 1
fi

mkdir -p ops/loadtest/out

docker run --rm -i --network "$NETWORK" \
    -v "${SCRIPTS_DIR}:/scripts" \
    -e VUS="${VUS:-60}" \
    -e DURATION="${DURATION:-60s}" \
    -e RAMP_UP="${RAMP_UP:-15s}" \
    -e ROOM_SIZE="${ROOM_SIZE:-6}" \
    -e POLL_MS="${POLL_MS:-2000}" \
    -e AUTH_BASE="${AUTH_BASE:-http://app:9000}" \
    -e API_BASE="${API_BASE:-http://nginx}" \
    -e RUN_ID="${RUN_ID:-$(date +%s | tail -c 7)}" \
    "$K6_IMAGE" run --summary-export=/scripts/out/summary.json /scripts/load.js
