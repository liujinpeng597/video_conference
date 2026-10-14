#!/bin/sh
# 备份 video_conference 到 /backups (宿主机上的 ./backups)。
# 由 compose 的 backup 服务执行: docker compose run --rm backup
# 轮转: 默认保留最近 14 份, 可用 KEEP 环境变量覆盖。
set -eu

KEEP=${KEEP:-14}
TS=$(date -u +%Y%m%d-%H%M%S)
OUT="/backups/video_conference-$TS.dump"

echo "[backup] pg_dump -> $OUT"
# -Fc: 自定义格式, 自带压缩, 恢复时可用 pg_restore (支持并行)
pg_dump -h db -U video -d video_conference -Fc -f "$OUT"
echo "[backup] 完成, 大小 $(ls -lh "$OUT" | awk '{print $5}')"

# 轮转: 只保留最近的 $KEEP 份
ls -1t /backups/video_conference-*.dump 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
    echo "[backup] 轮转删除 $f"
    rm -f "$f"
done
echo "[backup] 当前保留 $(ls -1 /backups/video_conference-*.dump 2>/dev/null | wc -l) 份"
