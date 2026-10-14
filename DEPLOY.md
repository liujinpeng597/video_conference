# 部署手册：一台 VPS + 一个域名

> 本机开发不需要看这份文档。这里是把系统认真放到公网上的步骤清单。
> **状态：步骤已冻结，但尚未在任何真实服务器上执行过** —— 第一次部署时按「上线自检」逐条核对。
> 需要域名 / 云资源的部分（A 记录、可选 Cloudflare、对象存储）等就位后照做即可。

## 0. 目标形态与端口

```
浏览器 ──80/443──▶ nginx（TLS 终止、限流、静态文件）──▶ app ×N（无状态）
浏览器 ◀──3478/UDP 中继──▶ coturn（TURN，临时凭证签发）
                  app ─▶ PostgreSQL / Redis（只绑本机，不出机器）
```

ufw 放行清单（就这些）：

| 端口 | 协议 | 用途 |
|---|---|---|
| 22 | tcp | SSH |
| 80 | tcp | HTTP 跳转 + 证书签发验证 |
| 443 | tcp | HTTPS |
| 3478 | tcp + udp | TURN |
| 49160-49200 | udp | TURN 中继端口段（并发通话量大了同时调大 compose 的 min/max-port） |

5432 / 6379 由 compose 绑在 `127.0.0.1` 上，**不要**在 ufw 放行。Docker 发布的端口会绕过
ufw，所以这一层安全靠「根本不发布」保证，见 `docker-compose.yml` 里的注释。

## 1. 开机器（一次性）

- VPS：2 核 4GB 起步（3 个 app 副本 + PG + Redis + coturn 都在一台）；
- 系统 Ubuntu 24.04；
- 域名一条 A 记录指向 VPS 公网 IP（例：`meet.example.com`）；
- 本机 SSH 公钥已加到服务器。

```bash
# 部署用户（别用 root 跑服务）
adduser deploy && usermod -aG sudo deploy
# SSH 只留密钥
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

# 防火墙
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49160:49200/udp
sudo ufw enable

# 自动安全更新（可选）
sudo apt-get update && sudo apt-get install -y unattended-upgrades
```

装 Docker Engine + Compose 插件（官方 apt 源），`docker compose version` 能跑即可。

## 2. 首次部署

```bash
git clone git@github.com:liujinpeng597/video_conference.git
cd video_conference
cp .env.example .env
$EDITOR .env
```

`.env` 里至少要改：

```bash
POSTGRES_PASSWORD=<强随机，用字母数字>
TURN_SECRET=<openssl rand -hex 32>
TURN_URL=turn:meet.example.com:3478        # 客户端从这里连你的 TURN
# 服务器能直连 Docker Hub 的话，把 POSTGRES_IMAGE / REDIS_IMAGE / NGINX_IMAGE 三行删掉
```

起服务（生产覆盖 = 80/443 + TLS）：

```bash
bash ops/gen-cert.sh meet.example.com   # 先用自签把链路跑通
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## 3. 换成真证书（有域名后）

用 certbot 的 webroot 模式。nginx 的 `/.well-known/acme-challenge/` 已经对好
`nginx/acme-webroot/`（见 `docker-compose.prod.yml` 的挂载）：

```bash
docker run --rm \
  -v "$PWD/nginx/acme-webroot:/var/www/acme" \
  -v "$PWD/nginx/letsencrypt:/etc/letsencrypt" \
  certbot/certbot certonly --webroot -w /var/www/acme \
  -d meet.example.com --agree-tos -m you@example.com

# 换成 nginx 读的文件名，再热加载
cp nginx/letsencrypt/live/meet.example.com/fullchain.pem nginx/certs/server.crt
cp nginx/letsencrypt/live/meet.example.com/privkey.pem   nginx/certs/server.key
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec nginx nginx -s reload
```

续期（crontab，每月 1 号 3 点；证书过期 = 全站不可用 + 浏览器拒开摄像头，这条必须装）：

```cron
0 3 1 * * cd /opt/video_conference && docker run --rm -v "$PWD/nginx/acme-webroot:/var/www/acme" -v "$PWD/nginx/letsencrypt:/etc/letsencrypt" certbot/certbot renew --quiet && cp nginx/letsencrypt/live/meet.example.com/fullchain.pem nginx/certs/server.crt && cp nginx/letsencrypt/live/meet.example.com/privkey.pem nginx/certs/server.key && docker compose -f docker-compose.yml -f docker-compose.prod.yml exec nginx nginx -s reload
```

## 4. 备份

```cron
0 4 * * * cd /opt/video_conference && docker compose run --rm backup >> /var/log/vc-backup.log 2>&1
```

策略、恢复步骤与 RPO/RTO 见 `ops/README.md`。**还没做**：异地副本 —— 目前备份和服务器
同生共死，等另一台机器 / 对象存储就位后补上（ops/README.md 里也记着这条）。

## 5. 上线自检清单

- [ ] `curl -I https://meet.example.com/` → 200；`curl -I http://...` → 301
- [ ] `https://meet.example.com/api/health` → `"ok":true`
- [ ] 两台不同网络的设备（手机 4G + 家里宽带）进同一房间，音视频互通
      （这条走通 == TURN 真的在工作）
- [ ] `sudo ss -lunp | grep 3478` 有监听
- [ ] 连续输错密码 20 次 → 429（nginx 按 IP 限流）；换账号再连错 5 次 → 该账号被锁
- [ ] `docker kill video_conference-app-1` 后页面还能用（3 副本 + nginx 重试）

## 6. 升级与回滚

- 升级 = 切到新 tag：`git fetch --tags && git checkout v0.2.0 && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
- 回滚 = 切回旧 tag 再 `up -d --build`。数据库没有迁移框架（只做向后兼容的
  `ALTER TABLE ... IF NOT EXISTS`），**破坏性变更前必须先跑一次备份**
- 备选路线：直接用 CI 推的 GHCR 镜像（`docker login ghcr.io` 后把 compose 里的
  `build:` 换成 `image:`），服务器上不需要编译器

## 7. 故障速查

| 现象 | 先查什么 |
|---|---|
| 打开是 502 | `docker compose ps`；`docker compose logs app --tail 50` |
| https 打不开 | 证书是否过期；80 是否被别的程序占用（跳转和 ACME 都用它） |
| 有人转圈连不上 | TURN：3478/udp 放行了吗；`TURN_URL` 是不是公网地址 |
| 拿不到摄像头 | 是不是从 http 打开的（getUserMedia 只在 https / localhost 可用） |
| 数据库连不上 | `docker compose logs db`；磁盘空间 |

## 8. 容量参数（副本 × workers × 连接数）

并发用户数和 rps 的换算口径、瓶颈排序和实测数字见 `ops/loadtest/README.md`；
这里只留运维要用的公式：

```
每秒请求数 ≈ 并发用户数 × (0.5 轮询 + 0.5~1 信令)      # 1000 用户 ≈ 500~1000 rps
PostgreSQL 连接数 = 副本数 × 每副本 workers             # 默认 workers = 核数
Redis 连接数     = 副本数 × 每副本 workers             # hiredis, 每个 worker 一条
```

- 2 核 VPS：在 `.env` 里写 `APP_WORKERS=2`。3 副本 × 2 = 6 条 PG / Redis 连接。
  注意默认值的坑：`--workers 0` 取的是**宿主机**核数（容器里看不到 CPU 配额），
  小机器上会超卖，所以显式收窄。
- 8 核以上：默认值就够（3 × 8 = 24 条 PG 连接，离 `max_connections=100` 很远）；
  真要跨机扩容时再核对这个乘积。
- 实测（8 vCPU 开发机）：950 并发用户 ≈ 950 rps 时整栈只用 ~1.2/8 核，瓶颈排序是
  PostgreSQL 点查 > nginx 转发 > Redis。单机上"加副本"不会明显抬高上限，
  先把这个乘积和 PG 的 `max_connections` 预算算清楚更值。

## 9. 降级矩阵（依赖挂了发生什么）

| 依赖 | 用户看到什么 | 现在怎么办 |
|---|---|---|
| PostgreSQL 挂 | 登录 / 注册 / 会话校验 / 房间状态全 5xx；**已在开会的人媒体不受影响**（媒体不经过服务器），但刷新或重进会失败 | 起回 PG 即恢复（服务自动重连）；本机演练：`bash ops/degradation-drill.sh` |
| Redis 挂 | `/api/health` 返回 `ok:false`；进房 / 轮询 / 信令 5xx；已开会的画面声音继续，但状态与信令停更、看门狗重连会失败 | 起回 Redis 即恢复；进程启动时连不上 Redis 会拒绝启动（fail-fast，有意的） |
| nginx 挂 | 全站不可用（唯一入口，单点） | 重启 nginx；真正的入口高可用要第二实例 + VIP / 云 LB（P2） |
| coturn 挂 | 直连 / 局域网通话不受影响；对称 NAT、企业网的用户连不上 | 重启 coturn；容器内 `turnutils_stunclient -p 3478 127.0.0.1` 自检 |

## 10. Runbook（部署 / 回滚 / 恢复 / 轮换）

- **部署**：`git fetch --tags && git checkout v0.x.y && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`
- **回滚**：切回上一个 tag 再 `up -d --build`（代码和镜像都在 tag 里；数据库只做向后兼容变更，破坏性变更前先备份）
- **恢复备份**：见 `ops/README.md`（`docker compose run --rm backup /ops/restore.sh <dump>`，恢复进新库后按打印的步骤人工切换）
- **轮换数据库口令**：改 `.env` 的 `POSTGRES_PASSWORD` → `docker compose up -d --force-recreate db` → `docker compose up -d --force-recreate app`
- **证书续期**：见第 3 节的 cron（证书过期 = 浏览器拒开摄像头，必须装）
- **看日志**：`docker compose logs app --since 10m`；日志带毫秒时间戳和实例名（格式见 `video_server/README.md`）
- **压测数字**：`ops/loadtest/README.md` 的"实测记录"（开发机 950 VU ≈ 950 rps、0 失败；瓶颈是每请求一次 PG 令牌点查）

## 11. 移动端与浏览器兼容

- **video 需要安全上下文**：https 或 localhost，否则拿不到摄像头（自签 + 信任 CA 见 `nginx/README.md`）。
- **iOS Safari / 手机锁屏**：JS 被系统挂起，超过服务端 30 秒心跳阈值会被别人判掉线；
  前端"连续两拍"宽限期只对弱网抖动有效，救不了锁屏 —— 文案上建议提示"手机端保持屏幕常亮 / 前台"。
- **桌面浏览器后台标签**：定时器会被节流，弱网下同样可能被判掉线；已有缓解：
  30 秒阈值 + 两拍宽限 + 回到前台立刻补心跳。
- **外接摄像头热插拔**：页面监听 `devicechange`，轨道 ended 时自动重取并 `replaceTrack`
  （尽力而为，插拔瞬间可能仍需几秒恢复；无头环境无法自动化验证这条）。
