# TURN 中继 (coturn)。
#
# 直接用 Ubuntu 的 coturn 包, 不拉 coturn 官方镜像: 这台机器直连 Docker Hub 拉不动,
# ubuntu:24.04 反正是这套编排已经依赖的基础镜像, 少一个镜像源依赖。
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends coturn \
 && rm -rf /var/lib/apt/lists/*

# 参数全部来自 compose 的 command (见 docker-compose.yml)
ENTRYPOINT ["turnserver"]
