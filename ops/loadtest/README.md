# 负载测试（k6）

量的是 **API 层**：进房、每 2 秒一次 `state` 轮询（心跳 + 收件箱）、协商期信令互发。
媒体是浏览器两两直连（mesh），不经过服务器，所以这里压的正是"轮询模型下每次请求背后
1 次 PostgreSQL 点查 + 6~8 条 Redis 命令"这条链路 —— 路线图里"1000 并发用户 ≈ 500 rps"
说的就是它。

## 怎么跑

前提：栈已经起来（`docker compose up -d`）。

```bash
bash ops/loadtest/run.sh                    # 默认 60 VU / 1 分钟
VUS=200 DURATION=3m bash ops/loadtest/run.sh
```

Windows 上在 Git Bash 里可以直接用 `run.sh`（脚本里已处理 MSYS 的路径转换问题）；
PowerShell 里想直接调容器的话：

```powershell
docker run --rm -i --network video_conference_default `
  -v "$($PWD.Path)\ops\loadtest:/scripts" `
  -e VUS=200 -e DURATION=3m -e RUN_ID=ps1 `
  docker.m.daocloud.io/grafana/k6:latest run --summary-export=/scripts/out/summary.json /scripts/load.js
```

产物：`ops/loadtest/out/summary.json`（机器可读的汇总）。

> Windows + Docker Desktop 上如果同时在跑镜像构建 / trivy 扫描，偶发容器内 DNS 抖动：
> 现象是 k6 侧 `http_req_failed` 大面积失败、而 nginx 访问日志里一行都没有 —— 重跑即可，
> 别把它当成服务端的问题。

## 它怎么模拟一个参会者

| 真实前端 | 压测里 |
|---|---|
| 一个标签页 = 一个会话令牌 = 一个参会者 | 一个 VU 一个账号、一个令牌（`setup()` 里注册得到） |
| 进房 `POST /api/rooms/enter` | 每 6 个 VU 分一间房（对齐后端 `kMaxRoomPeers`） |
| 空闲 2 秒一次 `GET /api/rooms/state?since=N` | 每拍一次，`since` 用上一拍返回的 `seq` |
| 新人进房给在场每个人发 offer + ICE（约 400ms 协商期） | 进房/发现新同伴时发 1 条 offer + 1 条 ice（~2KB 载荷） |
| 协商完成后 ICE trickle 继续流动 | 每拍再向随机一名同伴发 1 条 ice |

两处刻意的取舍：

- **建号绕过 nginx**：`setup()` 直连 `app:9000`。nginx 对 `/api/login`、`/api/register`
  有 20r/m 的防爆破限流，200 个 VU 会直接吃 429 —— 那是安全策略，不是容量瓶颈。
  压测主体仍然走 `nginx`，和真实用户同一条链路。
- **建号慢是有意的**：每次注册背后一次 Argon2id（m=64MB），60 VU 的 `setup()` 大概
  15~30 秒；200 VU 更久。看到 setup 阶段停着不动不用担心。

## 怎么读结果

- `http_req_duration` 的 `p(95)`：一次 API 调用的端到端延迟（含 nginx → app → PG/Redis）；
- `http_req_failed`：非 2xx 比例，阈值 1%；
- `lt_signals_delivered` / `lt_signals_sent`：信令真实投递率（`delivered:false` 说明目标不在房了）；
- `lt_inbox_messages`：VU 侧真实收到的信令条数 —— 和发出量对得上，说明收发两向都通；
- `iteration_duration` 应稳定在 `POLL_MS`（2 秒）附近。

## 容量口径（写进部署文档的那句话）

```
空闲期每个用户每秒 1 次轮询 (2s 间隔) + 每拍 1 条信令:
    1000 并发用户 × (0.5 + 0.5) ≈ 1000 rps  (协商/流动期)
    1000 并发用户 × 0.5        ≈  500 rps  (只有轮询时, 路线图里的口径)

PostgreSQL 连接数 = 副本数 × 每副本 workers (--workers, 默认 = 核数)
     2 核 VPS 默认: 3 副本 × 2~4 workers = 6~12 条, 远低于 max_connections=100
     要跨机扩容时才需要重新核对这个乘积
```

本机（Docker Desktop，开发机）实测的参考数字记录在下一节；生产数字要以 VPS 实测为准。

## 实测记录

> 每次真正跑过一轮就往这里记一条（日期 / 机器 / 参数 / 关键数字）。

| 日期 | 环境 | 参数 | 结果 |
|---|---|---|---|
| 2026-10-14 | 开发机 Docker Desktop，3 副本 + nginx + PG + Redis | 12 VU / 20s（冒烟，验证脚本本身） | p95 1.7ms，0 失败，信令投递 274/274 |
| 2026-10-14 | 同上（8 vCPU / 4GB 的 Docker 虚拟机） | 200 VU / 90s | **186 rps**，p95 1.61ms / p99 3.6ms，0 失败，信令 12030/12030 全投递 |
| 2026-10-14 | 同上 | 720 VU / 90s | **719 rps**，p95 2.08ms / p99 5.2ms / max 63ms，0 失败，信令 43370/43370 全投递 |
| 2026-10-14 | 同上 | 950 VU / 60s | **约 950 rps**，p95 2.27ms / max 64ms，0 失败，信令 42980/42980 全投递 |
| 2026-10-15 | 同上（与下一行同机同日，作对照） | 950 VU / 60s | **635 rps**（全程均值），p95 1.81ms、中位 1.01ms，0 失败；CPU: PG 13.6% / nginx 5.9% / Redis 4.4% |
| 2026-10-15 | 同上（令牌缓存 + keepalive 之后） | 950 VU / 60s | **634 rps**（同节奏同负载），p95 **1.11ms**、中位 **0.54ms**、max 69ms，0 失败；CPU: PG **2.6%** / Redis 11.1% |

> rps 口径：k6 汇总里的 `http_reqs.rate` 是全窗口平均（把 setup 和升/降档也算进去，
> 会偏低）；表里的 rps 是**稳态值**，用 nginx 访问日志的 20 秒窗口数出来的。

## 优化记录（2026-10-15）

同机同日、同配置（950 VU / 60s）的对照：

| 指标 | 优化前 | 优化后 | 说明 |
|---|---|---|---|
| 请求 p95 | 1.81ms | **1.11ms**（-39%） | 缓存命中省掉一次 PG 点查的往返 |
| 请求中位 | 1.01ms | **0.54ms**（-47%） | |
| PostgreSQL CPU | 13.6% | **2.6%**（-81%） | 令牌校验缓存进 Redis —— 把"最大 CPU 头"摘掉 |
| Redis CPU | 4.4% | 11.1% | 缓存带来的新负载；放它身上是因为它原本最闲 |
| nginx → app 新建连接 | 旧写法：每请求一条 | **78,601 请求只新建 221 条** | `upstream + resolve + keepalive`（≥1.27.3） |
| 失败率 | 0 | 0 | 两轮都 0 |

请求速率两轮持平（≈634 rps）是设计使然：负载由 VU 的 2 秒轮询节奏驱动、不是压极限，
优化体现为**延迟下降与 CPU 余量**（PG 让出来的余量直接换成更大的安全边际）。
再要提吞吐，按下面"瓶颈排序"③ 走。

## 瓶颈在哪一跳（2026-10-14，优化前实测）

在 950 VU（约 950 rps）的稳态窗口里采 `docker stats`，并用 `redis-cli info commandstats`
取压测前后的差值：

| 组件 | CPU（占 8 vCPU 开发机） | 说明 |
|---|---|---|
| PostgreSQL | ~0.42 核（最大头） | 每个认证请求一次令牌点查（`auth_tokens` 命中索引 + join users） |
| app × 3 | 每个 ~0.11 核 | 事件循环读写；Argon2id 只出现在建号/登录阶段 |
| nginx | ~0.22 核 | 每请求新建一条到后端的连接（「变量 + resolver」的写法没有 upstream keepalive） |
| Redis | ~0.17 核 | 约 5 条命令/请求：每条信令 1 次取号 Lua（EVAL 内含 INCR/RPUSH/LTRIM/EXPIRE），每拍心跳 2 个 EXPIRE，外加会话 GET 与房间 HGETALL |
| k6 | ≤ 0.2 核 | 单容器 950 VU，压测机自己没成为瓶颈 |

- 每 100 rps 整套约 0.12~0.15 核：**950 rps 只用了不到 1/7 的 CPU**，单机容量远没到拐点。
- 所以"能撑多少并发"在这个规模不由 CPU 决定，先撞到的是 PG 点查的延迟预算与连接数上限（公式见上一节）。
- 真要再上一个量级：① ✅ 令牌校验缓存进 Redis、② ✅ nginx `upstream` + `resolve` + `keepalive`
  （DNS 动态跟随保住了，要求 nginx ≥1.27.3）都已在 2026-10-15 落地，前后对比见上「优化记录」；
  ③ 再往上才轮到 Redis / 多机（本项目规模远未到）。
- 本机是 Windows + Docker Desktop，syscall 开销高于原生 Linux；绝对数字以 VPS 复测为准
  （命令完全一样，只要把 `run.sh` / `docker run` 里的网络名换成 VPS 上的）。

## 清理压测账号

压测会在 `users` 表里留下 `lt_<RUN_ID>_<n>` 的账号（其余表无损）。清掉：

```bash
docker compose exec db psql -U video -d video_conference \
  -c "DELETE FROM users WHERE username LIKE 'lt\_%';"
```

账号行数不多时也可以留着（每个约 200 字节），下次换个 `RUN_ID` 继续跑。
