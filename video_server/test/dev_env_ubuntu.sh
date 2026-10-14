#!/usr/bin/env bash
# 在一台 Ubuntu (含 WSL Ubuntu) 上准备 smoke.sh 需要的一切:
#   - 编译依赖 (libpq / libsodium / hiredis)
#   - 本机 PostgreSQL + Redis, 以及 video / video_test 账号和库
# 需要 root (或 sudo) 跑; 幂等, 可以反复执行。
#
#   用法:
#     sudo bash test/dev_env_ubuntu.sh
#     TEST_DB=postgresql://video:video@127.0.0.1:5432/video_test \
#     TEST_REDIS=redis://127.0.0.1:6379 bash test/smoke.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    build-essential pkg-config libpq-dev libsodium-dev libhiredis-dev \
    postgresql redis-server

service postgresql start || pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start
service redis-server start

# smoke.sh 用的测试账号和库 (跟 compose 里的对应用户/库同名, 只是端口不同)
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='video'\"" | grep -q 1 \
    || su - postgres -c "psql -c \"CREATE ROLE video LOGIN PASSWORD 'video'\""
su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='video_test'\"" | grep -q 1 \
    || su - postgres -c "createdb -O video video_test"

pg_isready
redis-cli ping
echo "就绪。跑测试:"
echo "  TEST_DB=postgresql://video:video@127.0.0.1:5432/video_test TEST_REDIS=redis://127.0.0.1:6379 bash test/smoke.sh"
