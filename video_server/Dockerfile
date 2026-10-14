# 编译阶段 —— 注意 build context 是仓库根目录, 因为运行阶段要一起打包 video_client
FROM ubuntu:24.04 AS build

# 依赖单独一层: 只改 C++ 代码时这一层还能命中缓存
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config libpq-dev libsodium-dev libhiredis-dev curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY video_server/ ./video_server/
RUN make -C video_server -j"$(nproc)"

# 前端放在 make 之后: 改前端不会让上面那层编译缓存失效。
# 测试服务也复用这个阶段, 所以它也得有 video_client (smoke.sh 会检查静态资源)。
COPY video_client/ ./video_client/

# 运行阶段 —— 只带运行时要的东西, 不带编译器和头文件
# curl 是给 compose 里的 healthcheck 用的 (它要真的去请求 /api/health)
FROM ubuntu:24.04

RUN apt-get update \
 && apt-get install -y --no-install-recommends libpq5 libsodium23 libhiredis1.1.0 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /src/video_server/video_server /app/video_server
COPY --from=build /src/video_client /app/video_client/

EXPOSE 9000
# 前端静态文件由这个进程直接发, 所以只需要一个端口
CMD ["./video_server", "--port", "9000", "--web", "video_client"]
