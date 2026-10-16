# 故障处置手册（出什么事，按哪几步做）

> 这份是"照着做"的清单，不是设计文档。设计取舍看各子目录 README，部署流程看 `DEPLOY.md`，
> 备份 / 演练 / 告警闭环看 `ops/README.md`。**每条都先在本地验证过命令再写到这儿**。

## 0. 先看哪儿

| 想知道什么 | 看哪 |
|---|---|
| 服务活着吗、打到的是哪个实例 | `curl -s localhost:9000/api/health`（`instance` 会变 = 负载均衡在轮询；`users` 查不到 = 数据库不通） |
| 谁在报错、量多少 | Grafana `http://127.0.0.1:3001`（预置「同频 · 总览」）、Prometheus `9090` |
| 告警有没有发出来 | `docker compose logs alert-sink`（本机默认通知渠道，收到就打印） |
| 容器状态 | `docker compose ps`（`healthy` 是容器的健康检查，不是业务探活） |
| 后端日志 | `docker compose logs --tail=200 app`（带毫秒时间戳 + 实例名） |

## 1. 一分钟分流：是"所有人都连不上"还是"只有某个人"

- **所有人都连不上** → 服务端问题，往下按场景查。
- **只有某个人连不上 / 卡** → 让他打开会中「成员」面板，最下面那块**网络诊断**：
  - `还没采到码率` + 状态不是"已连接" → 协商没成功（多半是直连建不起来、TURN 也没配）；
  - 有码率但**丢包高 / 往返大** → 他那边的网差，让他换网络；
  - 标着**中继** → 两台机器之间直连失败，媒体走 TURN 绕了一圈：能通，慢是正常的。

## 2. 场景表

### Redis 挂了 / 重启过

- 现象：大家从会议里被弹回大厅，提示"房间状态没了（服务端重启过），重新加入一次"；`/api/health` 里 `rooms` 为 0。
- 动作：`docker compose ps redis` → `docker compose restart redis`；然后让在场的人重新进房。
- 影响面：**正在开的会全断**。房间状态（在谁、聊天、静音标志）本来就不持久化
  （`--save "" --appendonly no`，故意的：这些数据易失），所以**没有要恢复的东西**。
- 注意：Redis 故障时限流 / 登录锁定会自动放行（设计如此，见 `handlers.cpp` 的注释），不用当故障处理。

### PostgreSQL 连不上

- 现象：`/api/health` 返回"服务端在，但数据库连不上"；登录 / 注册报 500。
- 动作：`docker compose ps db`；`docker compose exec db pg_isready -U video -d video_conference`；
  起不来先看磁盘满没满（日志轮转已配 `10m × 5`）。
- 数据没了 / 迁坏了 → `bash ops/restore.sh`（恢复到新库并打印人工切换步骤，不会直接覆盖线上库）；
  演练用 `bash ops/restore-drill.sh`。RPO / RTO 见 `ops/README.md`。

### 某个后端实例不健康

- 现象：偶发 502 / 网关错误，`/api/health` 的 `instance` 有时变成一个坏实例的名字。
- 动作：`docker compose ps` 找到那台 → `docker compose restart app`（或 `up -d` 让它补齐副本）。
- 为什么随便重启：三个实例都是**无状态**的（房间在 Redis、账号在 PG），杀掉一台不影响正在开的会。

### 发布 / 回滚

- 发布：打 `v*` tag 触发 CI 构建镜像，CD 模板按 tag 部署（`ops/deploy.sh`）。
- 回滚：切回上一个 tag 重新部署；`ops/deploy.sh` 自带"起不来自动切回上一版"。
- 数据库迁移是"只前进"的：回滚代码不会回滚表结构（旧代码不认新列，但留着不碍事）。

### TLS / 证书

- 现象：浏览器提示不安全、或 nginx 起不来。
- 动作：本地自签用 `bash ops/gen-cert.sh`；正式证书见 `nginx/README.md`。
  验证：`openssl s_client -connect <域名>:443 -servername <域名> </dev/null 2>/dev/null | openssl x509 -noout -dates`。

### 500 尖峰 / 限流被大面积触发

- 先分辨：Grafana 看 5xx 曲线和 `rate_limited` 计数。
  - 限流触发多 = 有人在刷，或者阈值对小机器太紧（`PER_TOKEN_RPM` / `LOGIN_FAIL_MAX` 都是环境变量，改完重启生效）；
  - 5xx 多 = 看 Redis / PG 的连通性（这两条上面的场景已经覆盖）。
- 别把"被限流"当成漏洞：限流是保险丝，故意做成 Redis 故障时放行 —— 不能让它自己变成故障源。

### 告警不响 / 想验证告警链路

- `bash ops/alert-drill.sh`：造一个假告警，走 Prometheus → Alertmanager → alert-sink，看它打印出来。
- 这条演练在 CI 里也跑，所以"告警闭环没坏"是有证据的，不是靠记忆。

## 3. 明确不在这份手册里的

DNS 切换、WAF / CDN 规则、异地副本与主从、真机上的容量参数 —— 这些都要有域名 / 云账号 / 真机器，
写命令也没法在本机验证，所以留在 `DEPLOY.md` 的对应章节里，有机器了再补成这一份的形式。
