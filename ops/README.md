# ops: 备份与恢复演练

PostgreSQL 里存着账号和会话——这是整套系统**唯一丢不起的数据**（房间状态和信令在 Redis，
本来就是易失的, 重建即可）。下面三个脚本都通过 compose 的一次性容器跑,
Windows（PowerShell）/ Linux / CI 下命令完全一样。

## 用法

```bash
# 备份一次 (写进 ./backups/, 自动轮转保留最近 14 份)
docker compose run --rm backup

# 恢复演练: 恢复到临时库 -> 核对数据 -> 删掉临时库 (全程不碰线上库)
docker compose run --rm backup /ops/restore-drill.sh

# 灾后恢复: 恢复到新库 video_conference_restored, 打印人工切换步骤 (不会直接覆盖线上库)
docker compose run --rm backup /ops/restore.sh /backups/video_conference-XXXX.dump
```

环境变量: `KEEP=30` 改保留份数; `KEEP_DRILL=1` 保留演练库供人工检查。

## 策略 (RPO / RTO)

- **RPO（最多丢多少数据）= 备份间隔。** 目前是手动/定时工具, 没有内置调度。
  在生产机器上挂一条定时任务, 一天一次 → RPO ≤ 24h; 想要更小就加频率（每 6 小时一次 → RPO ≤ 6h）。
- **RTO（多久能恢复）= 实测数字。** 本次演练: 161 个账号 / 20.8 KB 的库,
  createdb + pg_restore **<1 秒**。这个库还小, 数据量上来后请重跑
  `restore-drill.sh` 记录新数字——耗时脚本会直接打印。
- **为什么是全量 pg_dump 而不是 WAL 归档/流复制**: 单机演示部署、数据量小,
  要的是"简单到能演练"。真到要求分钟级 RPO 时再上 WAL 归档, 要求 RPO≈0 时再上主从——
  那时把方案换掉即可, 这三个脚本的界面不变。

## 定时任务示例

Linux crontab（每天 03:00）:

```cron
0 3 * * * cd /path/to/video_conference && docker compose run --rm backup >> /var/log/vc-backup.log 2>&1
```

Windows 计划任务（每天 03:00, 在 PowerShell 里执行一次; 路径换成你的仓库路径）:

```powershell
schtasks /create /tn "video_conference 备份" /sc daily /st 03:00 /tr "powershell -Command \"cd 'C:\path\to\video_conference'; docker compose run --rm backup\""
```

（Docker Desktop 需要处于运行状态。）

## 已知边界（还没做的）

- **异地副本**: 待办——需要另一台机器/云存储。在那之前这台机器整个坏掉时, 备份也一起没。
  最省事的下一步是把 `backups/` 同步到另一台机器或对象存储（顺带加密）。
- **备份文件权限**: 备份落在 `backups/`（已在 .gitignore）; 内容含账号数据
  （密码是 Argon2id 哈希, 不能直接还原明文, 但仍属敏感数据）, 别进版本库、别随手共享。
- **演练自动化**: 现在是手动/按需跑; 理想情况是备份后自动演练一次, 失败就告警。

## 演练记录

| 日期 | 备份文件 | 数据量 | RTO | 结果 |
|---|---|---|---|---|
| 2026-10-14 | `video_conference-20261014-043906.dump` | 161 账号 / 20.8 KB | <1 秒 | 通过（含抽查账号哈希一致性、行数对照） |
| 2026-10-14 | `video_conference-20261014-045446.dump` | 173 账号 / 22.6 KB | <1 秒 | 通过（复跑；抽查哈希一致、行数对照通过） |
