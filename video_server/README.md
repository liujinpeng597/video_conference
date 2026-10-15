# video_server

视频会议后端：epoll + 线程池，C++17，Linux。

**进程本身不存任何状态。** 账号和会话在 PostgreSQL，房间在线状态和信令在 Redis。
所以可以起任意多份放在负载均衡后面，任意一份挂了都不影响正在开会的房间。
开发时它顺便还发前端静态文件；生产上这一步交给 nginx（见下面的部署结构）。

## 跑起来

最快的路子是 Docker，一条命令起一整套（3 个后端实例 + nginx + PostgreSQL + Redis）：

```bash
docker compose up -d --build      # 在仓库根目录
# 浏览器打开 http://127.0.0.1:9000   ← 走 nginx, 不是直连某一台后端
```

反复请求 `/api/health`，返回里的 `instance` 会在三台之间变，这就是负载均衡在生效。

只想在 WSL 里跑二进制、中间件用容器：

```bash
# 前提: 根目录 .env 已建好 (cp .env.example .env, 填好 POSTGRES_PASSWORD)
docker compose up -d db redis
sudo apt install -y build-essential pkg-config libpq-dev libsodium-dev libhiredis-dev
cd video_server && make && ./video_server --port 9000 --web ../video_client \
    --db postgresql://video:<POSTGRES_PASSWORD>@127.0.0.1:5432/video_conference \
    --redis redis://127.0.0.1:6379
```

> 拉不动 Docker Hub 的话，根目录 `.env` 里的 `POSTGRES_IMAGE` / `REDIS_IMAGE` /
> `NGINX_IMAGE` 可以指到镜像站，见 `.env.example`。更干净的做法是在 Docker Desktop
> 的 Docker Engine 设置里加 `registry-mirrors`，这样镜像名还能保持官方写法。

启动时连不上数据库会重试 10 秒再报错退出（compose 里起容器有先后顺序，不等一下会误报）。
**连不上 Redis 直接退出**：房间状态和信令都在那儿，没有它这个进程干不了活，
半死不活地跑起来只会更难查。建表是幂等的，每次启动都跑一遍。

### 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--port N` | 9000 | 监听端口（只监 IPv4） |
| `--workers N` | CPU 核数 | 工作线程数 |
| `--web DIR` | `../video_client` | 前端静态目录，相对当前工作目录 |
| `--db CONNINFO` | 见上 | PostgreSQL 连接串，优先级高于 `DATABASE_URL` |
| `--redis URL` | `redis://127.0.0.1:6379` | Redis 连接串，优先级高于 `REDIS_URL` |

环境变量：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 同 `--db`，`--db` 优先 |
| `REDIS_URL` | 同 `--redis`，`--redis` 优先；形如 `redis://[:密码@]主机:端口[/库号]` |
| `ICE_SERVERS` | 交给浏览器的 ICE 服务器列表，一段 JSON 数组文本，见「信令和媒体」 |
| `TURN_URL` | TURN 地址（如 `turn:公网IP:3478`）；与 `TURN_SECRET` 一起配好才启用 |
| `TURN_SECRET` | 与 coturn 共享的密钥，用于签发临时凭证（见「信令和媒体」） |
| `TURN_TTL_SECONDS` | 临时凭证有效期，默认 `43200`（12 小时） |
| `LOGIN_FAIL_MAX` | 同一账号连续失败几次锁定，默认 `5` |
| `LOGIN_LOCK_SECONDS` | 失败锁定时长（秒），默认 `900`（15 分钟） |
| `KAFKA_BROKERS` | Kafka 地址（如 `kafka:9092`）；不配 = 事件流关闭 |
| `KAFKA_TOPIC` | 事件 topic，默认 `meeting.events` |

## 结构

```
main.cpp            参数解析, 初始化认证/数据库/Redis, 起服务
reactor.*           EventLoop：一个线程一个 epoll 实例, eventfd 做跨线程唤醒
thread_pool.*       ThreadPool：N 个线程各跑一个 EventLoop, 连接 round-robin 分配
server.*            Server：accept 循环 + 连接读写/关闭；Connection 定义
handlers.*          HTTP/1.1 分帧 + 路由 + 静态资源        (不存状态)
presence.*          房间在线状态 + 信令收件箱 -> Redis
auth.*              账号与会话：Argon2id 密码、令牌签发与校验
db.*                PostgreSQL：连接、建表、用户/令牌的 SQL
redis.*             Redis：连接、命令封装 (hiredis)
events.*            会议生命周期事件 -> Kafka (可选, 尽力而为; 见「事件流」)
consumer/           事件流消费者: 审计 JSONL (独立二进制 event_consumer)
random.*            libsodium CSPRNG：令牌和房间号都从这来
json.*              最小 JSON 工具：扁平对象取字符串/布尔值/原始片段 + 转义
test/json_test.cpp  json.* 的单测
test/smoke.sh       全链路测试 (含多实例互通)
Dockerfile          两阶段构建 (build 装编译器, 运行只带 libpq5/libsodium23/libhiredis1.1.0)
```

并发模型：主线程只做 accept，收到连接后按 round-robin 投给某个 worker 线程；
那条连接之后的所有事件都只在该线程的 epoll 上处理，**所以连接表不用加锁**。
PostgreSQL 和 Redis 都是每个线程一条连接（`thread_local`，断了自动重连），不用连接池。
**进程里没有共享可变状态，所以现在一把锁都不需要。**
所有 socket 都是非阻塞 + `EPOLLET`，读写都循环到 `EAGAIN`。
`SIGINT/SIGTERM` 走 `signalfd` 收在 accept loop 上，优雅退出。

## 状态放在哪

这是这套代码从"单机 demo"变成"能挂负载均衡"的关键，所以单独说清楚：

| 东西 | 放哪 | 为什么 |
|---|---|---|
| 账号、密码哈希 | PostgreSQL | 耐久事实，必须落盘 |
| 会话 / 长期令牌 | PostgreSQL | 同上，而且要能被吊销 |
| **会话校验缓存（60 秒）** | **Redis** | 去掉每请求一次 PG 点查；退出登录同步删除，吊销最多晚 60 秒生效 |
| **房间里有谁** | **Redis** | 易失事实 + 每个参会者每 0.4-2 秒写一次；落数据库是没必要的写入压力 |
| **信令收件箱** | **Redis** | 同上，而且消息有时效性 |
| **全局信令序号** | **Redis** | 多台后端不能各发各的号，否则客户端的 `since` 游标会错乱；取号和入队必须在一个 Lua 脚本里原子完成，不然并发下会丢信令 |
| 这个进程自己的东西 | 无 | 所以可以随便起几份、随便杀 |

Redis 的 key 布局（都在 `presence.cpp` 顶部写了）：

```
room:{房间号}     HASH    token -> "pid␟user␟seenMs"   整个房间一个 60 秒 TTL
session:{令牌}    STRING  "room␟pid␟user"             我在哪个房间
mailbox:{令牌}    LIST    "seq␟from␟kind␟payload"      待取走的信令, 只留最近 64 条
signaling:seq     INCR    全局单调序号
```

**为什么房间靠 TTL 而不是自己写清理程序**：房间没人心跳了就该消失，这正是 `EXPIRE`
的语义。自己写清理要处理"最后一个走的人崩了"这种情况（谁来清理？清理早了会不会误删？），
而 TTL 天然处理，代价只是空房间最多多活 60 秒。

一个已知的取舍：在线状态用的 `seen` 时间戳来自**各后端自己的时钟**。
同机多容器没问题；真分到多台机器上要保证 NTP 大致同步，否则快的那台会把慢的那台上的人
判成掉线。要更严格就用 Redis 的 `TIME` 命令当时间源。

## 数据库

两张表，服务端启动时自动建（`CREATE TABLE IF NOT EXISTS`）：

```sql
users        (id, username, username_lc, password_hash, created_at)
             username_lc 上有 UNIQUE —— 用户名大小写不敏感, 靠唯一约束防并发抢注
auth_tokens  (token_hash, user_id, kind, created_at, expires_at)
             kind ∈ ('session', 'remember'); user_id 外键 ON DELETE CASCADE
```

数据库只放真正耐久的东西：账号和会话。房间在线状态在 Redis（见上）。

密码存的是 libsodium `crypto_pwhash_str` 的输出（Argon2id，自带盐和参数）：

```
$argon2id$v=19$m=65536,t=2,p=1$QOpEid3CbqX...     97 字符
```

令牌（会话和长期）给客户端的是 64 个十六进制字符的随机串，库里只存它的 SHA-256，
所以数据库被拖走也不能直接拿来登录。

会话策略：

| 类型 | 有效期 | 存哪 | 用途 |
|---|---|---|---|
| `session` | 12 小时 | 前端 sessionStorage（每个标签页一份） | 日常请求 |
| `remember` | 30 天 | 前端 localStorage | 只用来换新的 session |

分成两层是有意的：这样"保持登录"不会把两个标签页并成同一个会话，
一个标签页 = 一个参会者这件事还能成立。过期令牌在每次登录/注册时顺手清掉。

## 接口

请求和响应都是 JSON。除 `/api/health` 和 `/api/session/resume` 外都要带
`Authorization: Bearer <token>`。

| 方法 | 路径 | 请求体 | 成功响应 |
|---|---|---|---|
| GET | `/api/health` | - | `{"ok":true,"users":N,"rooms":M}`，数据库不通时 `{"ok":false,…}` |
| POST | `/api/register` | `{"username","password","remember"?}` | `{"token","user","remember_token"?}` |
| POST | `/api/login` | `{"username","password","remember"?}` | 同上 |
| POST | `/api/session/resume` | `{"remember_token"}` | `{"token","user"}` |
| POST | `/api/logout` | `{"remember_token"?}` | `{"ok":true}` |
| GET | `/api/me` | - | `{"user"}` |
| POST | `/api/rooms/enter` | `{"room"}`，`room` 可为空 | `{"room","participants":[…]}` |
| GET | `/api/rooms/state?since=N&chat=M` | - | 成员列表 + 信令收件箱 + 房间聊天 + `host` / `removed`（前端每 0.4-2 秒轮一次） |
| POST | `/api/rooms/signal` | `{"to","kind","payload"}` | `{"ok":true,"delivered":bool}` |
| POST | `/api/rooms/chat` | `{"text"}` | `{"id","from","name","text"}` |
| POST | `/api/rooms/hand` | `{"raised":bool}` | `{"ok":true,"hand":bool}` |
| POST | `/api/rooms/kick` | `{"pid"}` | `{"ok":true}`；只有主持人能调 |
| POST | `/api/rooms/leave` | - | `{"ok":true}` |
| GET | `/api/ice` | - | `{"iceServers":[…]}`；需登录，配了 TURN 时现场签发临时凭证 |

- 房间号留空（前端「创建会议」走的就是这条）就自动分配一个 **9 位数字**（首位非 0，如 `483920175`）——
  数字比字母好念好记。前端「加入会议」要求填房间号，不再靠"留空"来区分创建/加入。
- `participants` 每项是 `{"id","name","me","hand"}`。`id` 是**房间内的信令地址**，随机生成，
  不是自增序号（自增的话别人能猜着号给你塞信令）。它只对同一个房间的人可见。
- `/api/rooms/state` 同时干两件事：刷新心跳 + 取走信令收件箱。合成一个接口是为了让前端
  只用一条轮询循环。`since` 是客户端已经处理到的序号，服务端只把 `<= since` 的消息**过滤掉**
  （并不逐条删除：收件箱只保留最近 64 条、空闲 60 秒整体过期，靠这两条兜底防堆积）；
  响应里的 `seq` 是本次真的下发的消息里的最大序号（没有新消息就原样返回 `since`），
  客户端拿它当下一次的 `since`。
- `kind` 只允许 `offer` / `answer` / `ice`，`payload` 最大 16KB。
- 房间聊天：**写**走 `POST /api/rooms/chat`，**读**搭在 `/api/rooms/state` 上（`chat` 参数是本端
  已收到的最大消息 id），所以不额外发请求。消息存 Redis 列表（只留最近 50 条、10 分钟 TTL），
  序号在房间内单调递增，游标语义和信令收件箱一致；房间空了再进新人会先清掉旧历史。
  服务端只校验文本（非空、≤500 字节、无控制字符），前端用 `{{ }}` 转义渲染，不做 HTML 注入。
- 举手：状态挂在房间成员表里（`participants[].hand`），`POST /api/rooms/hand` 切换。
  成员值现在是 `pid\x1fuser\x1fseen\x1fhand` 四段；心跳（每次 `sync` 重写成员那一格）会**先读后写**
  保住 `hand`，否则别人一举手就会被你下一拍心跳冲掉。
- 表情反应：**没有服务端存储**。它是瞬时效果，前端直接用一个信令广播（`kind="reaction"`，
  `payload={"emoji":…}`）发给同房间所有人，各端本地浮一下；`kind` 本来就是自由字符串。
- 主持人 = **建房的人**（房间 hash 里一个特殊字段存 host token，跟着房间 TTL 一起过期；
  主持人离开且还有人时，角色交接给剩下的第一个人）。`/api/rooms/state` 下发 `host`（主持人 pid）
  和 `removed`（这一拍发现自己已被移出）。
- 全体静音是**前端信令广播**（`kind="mute-all"`，各端把自己静音），服务端不存状态；
  移出成员（`POST /api/rooms/kick`）走服务端强校验：只有主持人能调。被移出的人**登录还在**，
  只是房间状态被清空，前端据此回大厅 —— 带 `removed` 标记，提示"被主持人移出"，
  不会误报成"服务端重启"。
- 退出登录会把长期令牌一起吊销（退出 = 忘掉我）。
- 出错统一返回 `{"error":"中文说明"}`，前端直接显示这句话。
- 校验：用户名 3-20、密码 6-64 个字符（按码点算，必须是合法 UTF-8）；
  404 / 405 / 413 / 431 各自对应。静态资源路径走字符白名单，`..` 一律拒绝。
- 登录失败按账号计次：5 次错密码锁 15 分钟（计数在 Redis，多实例共享；
  Redis 不可用时放行不锁——限流是保险丝，不是单点）。

## 信令和媒体

浏览器之间要通话，得先交换两样东西：**SDP**（各自支持什么编解码、几条流）和
**ICE candidate**（各自的网络路径）。这个交换过程叫信令，必须由服务器中转。

**服务器在这里只当搬运工。** 它不认识 SDP 也不认识 ICE candidate，`payload` 是原样
收下、原样转发的 JSON 片段。这样加屏幕共享、改编解码、以后换 SFU，后端一行都不用动。

```
A --POST /api/rooms/signal--> [B 的收件箱] --GET /api/rooms/state--> B
```

三个必须有的约束，缺一个都是洞：

1. **只能发给同一个房间里还活着的人。** 不做这个检查，任何登录用户都能往别人房间塞信令。
2. **收件箱按会话令牌分，一个令牌一个箱。** 一个标签页一个令牌，所以不会串。
3. **进新房间/离开/退出时清空收件箱。** 不然会去连一个已经不在的人。

媒体本身**不经过这台服务器**：现在是 mesh（两两直连），浏览器之间直接走 SRTP/UDP。
服务器只转发信令。代价是每个人要给其他每个人发一路，上行是 (N-1) 倍，
所以房间人数上限现在是 **6**（`kMaxRoomPeers`）。想开更多人得换 SFU。

ICE 服务器列表从环境变量 `ICE_SERVERS` 读，通过 `/api/ice` 发给浏览器（需要登录）：

```bash
ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]'
```

**TURN 用临时凭证（TURN REST）**：compose 里带了 coturn（`coturn/`），只要配好
`TURN_URL` + `TURN_SECRET`，`/api/ice` 就会给每个登录用户现场签发一条 TURN 条目：
用户名是 `过期时间戳:账号`，口令是 `base64(HMAC-SHA1(共享密钥, 用户名))`——coturn 那边
用 `--use-auth-secret` 按同一公式校验。静态口令不用进前端，泄露的凭证最多活到时间戳
过期（默认 12 小时）。签名实现和 RFC 2202 测试向量在 `src/turncred.*` 与 `test/turncred_test.cpp`。

默认只有一个公共 STUN。**局域网自用够了，但对外提供服务时 TURN 是必需项**：
对称 NAT 和企业网下大概一到两成的连接直连建不起来，没有 TURN 的现象是"有些人就是连不上"。

## 多实例部署

```
                     浏览器
                        │
                   ┌────▼────┐
                   │  nginx  │  静态文件 + TLS + 反向代理 (今天只做了前两件事的一半)
                   └────┬────┘
          ┌─────────────┼─────────────┐
     ┌────▼───┐    ┌────▼───┐    ┌────▼───┐
     │ app 1  │    │ app 2  │    │ app 3  │   三个进程, 各自无状态
     └──┬──┬──┘    └──┬──┬──┘    └──┬──┬──┘
        │  └──────────┼──┼──────────┘  │
        │         ┌───▼──▼───┐         │
        └────────►│  Redis   │◄────────┘      房间在线 + 信令
                  └──────────┘
                  ┌──────────┐
        账号/会话 │PostgreSQL│
                  └──────────┘
```

**已经在做、而且验证过的：**

- 三个后端实例（`docker compose up -d` 就是 3 个）共用一个 Redis，任意一台都能服务
  任意请求。测试里专门有一段：两个独立进程，A 在 1 号开房间、B 从 2 号进去、两边互相
  发信令，全部通过。
- **不需要 sticky session。** 每条请求都是独立的短连接，nginx 默认配置直接反代。
  这也是当初信令选轮询而不是 WebSocket/SSE 的原因：长连接过 nginx 要调 `proxy_buffering`
  和一堆超时，还把客户端绑死在某一台上，那台重启就断流。
- 静态文件交给 nginx 直接发（`./video_client` 挂进去），后端不用管。
- 挂掉一台实例，另外两台照常服务（实测杀掉一台后连打 30 次请求，30/30 成功）。

**nginx 那个配置里有个坑，值得单独说：** upstream 里的名字默认只在启动时解析一次。
`docker compose --scale app=3` 时服务名 `app` 会解析出多个 IP，但老写法只在启动时
解析一遍，结果三台只会用到一台。所以 `nginx/nginx.conf` 里用的是 nginx **1.27.3+** 的
`upstream` + `server app:9000 resolve;`：按 Docker 内置 DNS（127.0.0.11）的周期重新
解析，实例增减和挂掉都能跟上，同时 `keepalive` 复用后端连接。旧版本 nginx 不支持
upstream 里的 `resolve`（要么升级，要么退回"变量 + resolver"的写法，代价是每请求新建连接）。

还有一句实话：**nginx 开源版没有主动健康检查**，那是 NGINX Plus 的功能。现在靠
"DNS 摘除 + `proxy_next_upstream` 重试"近似。要做到真正的健康检查和优雅摘流，
得换 NGINX Plus / HAProxy / 云 LB。

**还没做、但迟早要做的：**

- **TLS 终止**在 nginx 这一层，加证书就行，代码不用动。
- **限流**：现在没有。放在 nginx（`limit_req`）或者应用里按用户名/IP 记失败次数都可以。
  这是当前最该补的安全缺口。
- **可观测性**：`/metrics` + monitoring profile + 带毫秒时间戳/实例名的日志已就位
  （见「可观测性」一节）；外部探活与告警通知渠道等公网部署时再接。
- **`X-Forwarded-For`**：过 nginx 之后后端看到的对端地址全是 nginx 的 IP。要拿真实 IP
  得读这个头，但读它就要决定信不信它（客户端能伪造），现在没读，日志里当它不存在。
- **Redis 本身是单点**。真要高可用得上哨兵/集群，或者至少让它跑在独立机器上并配持久化
  （现在故意关了持久化，因为房间状态本来就是易失的）。
- **按房间分片**：如果房间多到单台 Redis 扛不住，可以按房间号哈希分到多个 Redis 实例。
  现在这个规模完全不需要。

**跟 HTTP 后端不能混在一起的：**

- **TURN（coturn）要单独部署**，需要公网 IP 和一个固定的 UDP 端口段，不是 HTTP，
  挂不到 nginx 后面。
- 以后真上 SFU 也一样：独立进程 + 自己的 UDP 端口段。

## 可观测性

**指标**：每个后端实例在 `GET /metrics` 暴露 Prometheus 纯文本指标（自己实现，没引库）：
按接口类别和状态码的请求计数、延迟直方图、活跃房间数、Redis / PostgreSQL 错误计数、
实例名与运行时长。app 端口不对外发布、nginx 也不代理这个路径，所以指标只在 compose 网络内可见。

```bash
# Prometheus(127.0.0.1:9090) + Grafana(127.0.0.1:3001, admin/admin)
docker compose --profile monitoring up -d
# Grafana 里有预置面板「同频 · 总览」: 流量/延迟、错误率、房间数与登录失败
```

告警规则在 `monitoring/prometheus/alerts.yml`（实例掉线、5xx 比例超 1%、p95 延迟、依赖错误增长）。
触发后交给 Alertmanager 分组 / 路由 / 抑制，再送到通知渠道 —— 本机默认渠道是内置的 `alert-sink`
（收到就打印），不接任何云服务就能把"越线 -> 规则 -> 路由 -> 送达"整条闭环跑通并可测：

```bash
docker compose --profile monitoring up -d   # prometheus + grafana + alertmanager + alert-sink
bash ops/alert-drill.sh                     # 闭环演练: 灌一条合成告警, 断言送达 sink (CI 里也跑)
```

换成真渠道（钉钉 / 飞书 / Slack）时只改 `monitoring/alertmanager/alertmanager.yml` 里的 webhook url，
规则和路由都不用动。外部探活（Uptime 服务盯 `/api/health` 与证书到期）等有公网部署时再加。

**日志**：所有 stderr 日志带毫秒时间戳和实例名，例如
`[2026-10-14 13:37:22.123] [0be35c58deae] [api] POST /api/login -> 401` ——
多实例混在 `docker compose logs` 里也能分清是谁在说话；nginx 访问日志本来就带 `rt` / `upstream`。
规模内不上 ELK，`docker logs` + json-file 轮转（10m × 5）就是正解。

## 事件流（Kafka，可选）

会议生命周期事件（`room_created` / `participant_joined` / `participant_left` / `login_failed`）
通过 librdkafka 发到 `meeting.events`，按房间号分区（同一房间内有序）。消费者
`event_consumer`（源码在 `consumer/`，独立二进制）把事件落成审计日志 `/data/events.log`，
同时打到 stdout（`docker compose logs events` 直接能看）。

**信令为什么仍然不走 MQ**：信令是点对点、亚秒级、带 TTL 的邮箱语义 —— 每个参会者一个
收件箱、过期即弃，Redis List+TTL 就是对的工具；Kafka 是"追加日志"语义，适合审计、
统计和以后的通知 / 录制转码（作为新的消费者组挂在同一个 topic 上即可），不适合当收件箱。

**定位是尽力而为**：Kafka 挂了事件会丢（`/metrics` 的 `video_events_dropped_total` 能看到），
但业务请求完全不受影响 —— 审计少几条可以接受，会议卡一秒不行。

```bash
docker compose --profile events up -d --build   # Kafka(单节点 KRaft) + 消费者
# 应用侧要发事件, 还需要在 .env 里加 KAFKA_BROKERS=kafka:9092
bash ops/events-smoke.sh                        # 端到端冒烟 (CI 里也会跑)
```

## 自测

```bash
docker compose run --rm test      # 推荐: 复用编译阶段镜像, 不用在本地装依赖
```

> 注意 `run` 不会自动重建镜像。改了代码要加 `--build`，不然跑的是镜像里那份旧的。

或者在已经装好依赖的机器上：

```bash
make test          # 单测 (json.* 与 turncred.*)
bash test/smoke.sh # 全链路 (需要能连的 PostgreSQL 和 Redis, 见文件头)
```

`smoke.sh` 覆盖：编译、单测（json / TURN 凭证）、注册/登录/会话（含失败锁定）、
ICE/TURN 临时凭证签发、保持登录与续期、令牌吊销、
房间进出与人数、房间号规整、信令搬运与权限（同房间校验、payload 原样透传、
序号去重、超长拒绝、并发顺序原子化）、路由与错误码、静态资源与路径穿越、大文件整包送达、
**多实例互通（两个独立进程共享 Redis：互相看得到房间、信令双向可达、人数上限跨实例生效）**、
4 个并发注册抢同一个用户名（唯一约束）、5 条并发请求、连接回收、
**重启服务端后账号和会话还在**、**按令牌限流（额度内 200 / 超额 429 / 计数按令牌分 / 删 key 后恢复）**、
SIGTERM 优雅退出。

另外几个端到端演练在 `ops/`（CI 里都会跑）：`smoke-tls.sh`（生产形态 TLS + 限流）、
`events-smoke.sh`（Kafka 事件流）、`alert-drill.sh`（告警闭环）、`restore-drill.sh`（备份恢复）。
见 `ops/README.md`。

前端那侧的音视频通路验证在浏览器里跑（`--headless=new` + `--use-fake-device-for-media-stream`）：
两个和三个标签页进同一房间，断言对端 `<video>` 真的解码出了帧（`videoWidth > 0` 且在播），
以及 `getStats()` 里收发两个方向的音视频 RTP 字节数都大于 0。

测试用的用户名都带随机后缀，所以可以对同一个库反复跑。

## 已知缺口 / 下一步

- TLS 由入口层 nginx 终止（`docker-compose.prod.yml` + `nginx/README.md`）；后端自身仍然是
  明文 HTTP，所以生产上不要绕过 nginx 直接暴露 9000。
- TURN 已内建：compose 里跑 coturn，后端签发 12 小时临时凭证。对外部署时把 `TURN_URL`
  指到公网地址即可；本机和局域网直连就够了。
- 数据库 schema 走 `migrations/` 下的 `NNNN_*.sql`：进程启动时按 `schema_migrations` 表
  幂等执行（没跑过才跑，按文件名排序）。加表 / 改表就加一个迁移文件，重启自动生效；
  回滚 = 切回旧 tag（旧代码不认新表 / 列，但留着不碍事）。
- 发布与回滚：打 `v*` tag 触发 CI 构建镜像；CD 模板（`.github/workflows/deploy.yml` +
  `ops/deploy.sh`）按 tag 部署到 VPS，自带健康检查和"起不来自动切回上一版"。
  在仓库配好 `SSH_HOST` / `SSH_USER` / `SSH_KEY` 三个 secret 即启用（没配就跳过，不会弄红流水线）。
- **mesh 只能撑到 4-6 人。** 每个人都给其他每个人发一路，上行带宽是 (N-1) 倍。
  要开更多人得换 SFU（mediasoup / LiveKit / Janus），那是另一个量级的项目，
  媒体转发、simulcast、拥塞控制都得自己来或者接现成的。
- 限流有三层：nginx 按 IP（见 `nginx/snippets/ratelimit-zones.conf`）+ 后端按账号失败锁定 +
  **后端按令牌**（每个令牌每 `PER_TOKEN_WINDOW_SECONDS` 秒最多 `PER_TOKEN_RPM` 次，默认 60s / 600 次；
  见 `handlers.cpp` 的 `tokenRateLimited`，Redis 故障时放行）。
- 会话是固定过期，不滑动续期。前端已经在 401 时自动用长期令牌换新的，所以体感上不会中途被踢。
- 信令消息是**尽力投递**：Redis 挂了就全丢，客户端那一路协商会停在半路。
  前端已经处理了这种情况（发现房间没了就退回大厅并提示重进）；协商卡在半路的连接会被看门狗
  自动重建重试（最多 3 次），仍然失败才需要重进房间。
- 每个参会者一块 RTCPeerConnection，没有做带宽自适应（bitrate 由浏览器自己拥塞控制决定），
  也没有 simulcast。
- 没有 IP 黑名单 / WAF / DDoS 防护；对外部署时建议前置 Cloudflare 之类的服务。
- `json.*` 只认扁平对象里的字符串/布尔字段，不是通用 JSON 库。
  （信令 payload 不需要解析，所以现在够用；真需要嵌套解析时换 nlohmann/json。）
- 只监 IPv4；`Server::listenOn` 里有注释说明怎么改双栈。
- 没有迁移框架，加字段就往 `db.cpp` 的 `kSchema` 里补
  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。
- 后端**没有读 `X-Forwarded-For`**，所以在 nginx 后面日志里看到的对端全是 nginx 的地址。
