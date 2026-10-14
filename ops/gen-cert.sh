#!/usr/bin/env bash
# 生成本地自签 TLS 证书 (CA + 服务器证书), 输出到 nginx/certs/。
#
# 用法:
#   bash ops/gen-cert.sh                            # 只给 localhost / 127.0.0.1 / ::1 签
#   bash ops/gen-cert.sh 192.168.1.5 meeting.lan     # 额外加局域网 IP / 域名
#
# 产出:
#   nginx/certs/ca.crt      根证书 (装进系统信任列表后浏览器不再报警, 见 nginx/README.md)
#   nginx/certs/server.crt  服务器证书 (https://localhost 用的就是它)
#   nginx/certs/server.key  私钥
#
# 用 ubuntu:24.04 容器里的 openssl 生成, 宿主机什么都不用装。
# 换成真实证书时把 server.crt / server.key 换成同名文件即可, 其它配置不用动。
set -euo pipefail
cd "$(dirname "$0")/.."

DOCKER=${DOCKER:-docker}
CERT_DIR=nginx/certs
mkdir -p "$CERT_DIR"

# Git Bash / MSYS 会把 -v 参数里 /开头的路径做转换, 把 "主机:容器" 拆坏。
# 处理: 主机路径换成 Windows 形式 (C:/...), 并关掉这次调用的路径转换。
# Linux / macOS 上这段完全不生效。
HOST_CERT_DIR="$(pwd)/$CERT_DIR"
case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*)
        HOST_CERT_DIR=$(cygpath -m "$HOST_CERT_DIR")
        export MSYS_NO_PATHCONV=1
        ;;
esac

# 组装 SAN (现代浏览器不看 CN, 只看 SAN); 参数含数字和点以外字符的一律当域名。
SAN="DNS:localhost,IP:127.0.0.1,IP:::1"
CN=localhost
for arg in "$@"; do
    case "$arg" in
        *[!0-9.]*) SAN="$SAN,DNS:$arg" ;;
        *)         SAN="$SAN,IP:$arg" ;;
    esac
done
[ "$#" -gt 0 ] && CN="$1"

echo "证书覆盖地址: $SAN"
"$DOCKER" run --rm -e SAN="$SAN" -e CN="$CN" \
    -v "$HOST_CERT_DIR:/certs" ubuntu:24.04 bash -c '
        set -e
        # ubuntu 基础镜像不带 openssl 命令, 装一下 (只有生成证书时才需要)
        if ! command -v openssl >/dev/null 2>&1; then
            apt-get update -qq >/dev/null
            apt-get install -y -qq --no-install-recommends openssl >/dev/null
            rm -rf /var/lib/apt/lists/*
        fi
        cd /certs
        # 根证书: 十年有效; 已存在就复用 (重新生成会让浏览器丢失信任, 又要重装一次)
        if [ ! -f ca.key ]; then
            openssl req -x509 -newkey rsa:2048 -nodes \
                -keyout ca.key -out ca.crt -days 3650 \
                -subj "/CN=video-conference local CA"
            echo "已生成新的根证书 ca.crt"
        fi
        # 服务器证书: 自建 CA 签发的证书, 浏览器接受的有效期上限是 398 天
        openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr \
            -subj "/CN=$CN"
        printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\n" "$SAN" > server.ext
        openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
            -out server.crt -days 397 -extfile server.ext
        rm -f server.csr server.ext
        openssl x509 -in server.crt -noout -subject -dates -ext subjectAltName
    '
echo
echo "下一步: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build"
echo "然后打开 https://localhost; 想不弹警告, 把 nginx/certs/ca.crt 装进系统信任列表 (见 nginx/README.md)。"
