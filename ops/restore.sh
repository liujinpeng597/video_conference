#!/bin/sh
# 灾后恢复: 把一份备份恢复到一个**新库** video_conference_restored, 然后人工切换。
# 绝不会直接覆盖正在用的 video_conference —— 万一恢复的其实不是想要的那份,
# 现场还在, 还能再来一次。平时不跑这个脚本, 演练用 restore-drill.sh。
#
#   docker compose run --rm backup /ops/restore.sh /backups/video_conference-XXXX.dump
set -eu

DUMP=${1:?用法: restore.sh /backups/<备份文件>}
if [ ! -f "$DUMP" ]; then
    echo "[restore] 找不到文件: $DUMP"
    echo "[restore] /backups 下现有: $(ls -1 /backups/video_conference-*.dump 2>/dev/null | tr '\n' ' ')"
    exit 1
fi

RESTORED_DB=video_conference_restored
echo "[restore] 恢复 $DUMP 到新库 $RESTORED_DB"
dropdb -h db -U video --if-exists "$RESTORED_DB"
createdb -h db -U video "$RESTORED_DB"
pg_restore -h db -U video -d "$RESTORED_DB" -j2 --no-owner "$DUMP"

n=$(psql -h db -U video -d "$RESTORED_DB" -tAc 'select count(*) from users')
echo "[restore] 恢复完成, 账号数: $n"
echo
echo "[restore] 确认数据没问题后, 按下面步骤切换 (在仓库根目录执行):"
echo "  1) 停后端:   docker compose stop app"
echo "  2) 现场改名: docker compose exec db psql -U video -d postgres -c \"ALTER DATABASE video_conference RENAME TO video_conference_bad\""
echo "  3) 新库上线: docker compose exec db psql -U video -d postgres -c \"ALTER DATABASE video_conference_restored RENAME TO video_conference\""
echo "  4) 起后端:   docker compose start app"
echo
echo "[restore] 一切正常后, 想清理旧现场再执行: docker compose exec db dropdb -U video --if-exists video_conference_bad"
