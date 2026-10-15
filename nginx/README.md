# nginx: 入口层

同一个目录里有两个完整配置, 共用 `snippets/` 里的片段:

| 文件 | 谁用 | 监听 | 用途 |
|---|---|---|---|
| `nginx.conf` | 默认 `docker compose up` | 80 (映射到宿主机 9000) | 本地开发, 明文 HTTP |
| `nginx.tls.conf` | 叠加 `docker-compose.prod.yml` 时 | 80 + 443 | 生产形态: 80 跳 443, 443 终止 TLS |

代理设置 (`proxy-api.conf`)、限流区 (`ratelimit-zones.conf`)、登录/注册限流
(`auth-endpoints.conf`) 三个片段被两个配置共同引用, 改行为只需要改一处。
不用一个文件堆 `if`: nginx 的 http 块里没法写条件, 双文件 + 共享片段最直白。

## 反代: upstream + keepalive (要求 nginx ≥ 1.27.3)

`proxy-api.conf` 不写死后端地址, 而是转发给上游组 `app_backend`
(定义在两个 `nginx*.conf` 的 `http` 块里, 两处保持一致):

```nginx
upstream app_backend {
    zone app_backend 64k;
    server app:9000 resolve;   # 按 resolver 周期重新解析 Docker DNS
    keepalive 32;              # 复用后端连接
}
```

- `resolve` (nginx **1.27.3+**) 让实例增减、换 IP、某台挂掉都能跟上, 不用改配置重启;
  **更老的 nginx 不支持 upstream 里的 `resolve`** —— 要么升级, 要么退回
  "变量 + resolver" 的老写法 (`set $backend "http://app:9000"; proxy_pass $backend;`),
  代价是每个请求新建一条到后端的连接 (压测里这是 nginx 侧 CPU 的大头)。
- `keepalive` 复用后端连接 (`proxy_http_version 1.1` + 清空 `Connection` 头是前提,
  都已经在 `proxy-api.conf` 里)。
- 健康检查仍是 "DNS 摘除 + `proxy_next_upstream` 重试" 近似, 见仓库根目录 README 的说明。

## HTTPS 怎么开

```bash
# 1. 生成自签证书 (默认给 localhost / 127.0.0.1 / ::1 签)
bash ops/gen-cert.sh
# 要给局域网 IP / 域名也签, 作为参数传进来:
bash ops/gen-cert.sh 192.168.1.5 meeting.lan

# 2. 生产形态起全栈
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
# 浏览器打开 https://localhost
```

（Windows 上这一小节里的 bash 命令在 Git Bash 里跑; `docker compose` 那两条 PowerShell 里也能跑。）

### 为什么浏览器还会警告

自签证书不在系统信任列表里。两条路:

1. **把根证书装进信任列表** (推荐; 一次搞定, 之后摄像头权限、直播演示都和真实证书一样):
   - Windows: `certutil -user -addstore Root nginx\certs\ca.crt` (双击 `ca.crt` 按引导装也行)
   - macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain nginx/certs/ca.crt`
   - Linux: 把 `ca.crt` 拷到 `/usr/local/share/ca-certificates/` 再 `sudo update-ca-certificates`
   装完重启浏览器。
2. 直接点"高级 → 继续访问"。页面能看, 但部分浏览器会把这类来源当成降级安全上下文,
   摄像头/麦克风权限可能被拒 —— **演示前请走第 1 条**。

### 换成真实证书

把 `nginx/certs/server.crt` / `server.key` 换成证书机构签发的同名文件即可
(比如 certbot 产物 `fullchain.pem` / `privkey.pem` 改名, 或改配置里的路径), 其余不用动。
80 端口的 `.well-known/acme-challenge` 目录已经留好, 以后上域名可以直接走 HTTP-01 签发。
具体命令和续期 cron 见仓库根目录 `DEPLOY.md`。
没有域名之前, 自签 + 信任 CA 就是本机演示的等效方案。

## 限流说明

- `POST /api/login`、`/api/register` 挂 `limit_req` 区 `auth`: 20 次/分钟、burst 10、按来源 IP 算。
- nginx 触发时返回 429 + `{"error":"操作太频繁，请稍后再试"}`;
  **后端自己的 429** (按账号失败锁定, 5 次失败锁 15 分钟) 会原样透传, 不会被这层替换。
- 注意: `$binary_remote_addr` 在 CDN / 云 LB 后面会变成上一跳地址。将来挂 Cloudflare 时,
  要在这一层用 `real_ip` 模块还原真实 IP, 否则所有人共用一个限流额度。
- 本地用 Docker Desktop 时, 浏览器请求的来源 IP 实际是 Docker 网关地址, 所以"本机按 IP 限流"
  主要意义是演示和 CI 验证; 真实防撞库靠的是后端按账号的失败锁定。

## 生产形态还没做的

- 真实证书的自动续期 (certbot 定时任务)。
- WAF / DDoS 防护 (Cloudflare 前置); nginx 第二实例与主动健康检查 (现在靠 DNS 摘除 + 请求重试)。
