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
