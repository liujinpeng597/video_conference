#!/bin/sh
# 恢复演练 (非破坏性): 把一份备份恢复进临时库, 核对数据, 然后删掉临时库。
# 线上库 video_conference 全程只读, 不做任何修改。
#
#   docker compose run --rm backup /ops/restore-drill.sh [备份文件]
#
# 输出里的 "RTO(实测)" 就是"数据恢复到可用"所需的秒数 —— 写进 ops/README.md 的那个数字。
set -eu

DUMP=${1:-$(ls -1t /backups/video_conference-*.dump 2>/dev/null | head -n1)}
if [ -z "$DUMP" ]; then
    echo "[drill] /backups 下没有备份文件, 先跑一次: docker compose run --rm backup"
    exit 1
fi
echo "[drill] 使用备份: $DUMP"

DRILL_DB=video_restore_drill
failed=0

echo "[drill] 准备临时库 $DRILL_DB (dropdb --if-exists -> createdb)"
dropdb -h db -U video --if-exists "$DRILL_DB"
createdb -h db -U video "$DRILL_DB"

START=$(date +%s)
echo "[drill] pg_restore -j2 ..."
pg_restore -h db -U video -d "$DRILL_DB" -j2 --no-owner "$DUMP"
END=$(date +%s)

# ---- 数据核对 ----
echo "[drill] 核对数据"

# 1) 恢复到的东西不是空的
n_users=$(psql -h db -U video -d "$DRILL_DB" -tAc 'select count(*) from users')
if [ "$n_users" -ge 1 ]; then
    echo "[drill] ok   恢复库里有账号: $n_users 个"
else
    echo "[drill] FAIL 恢复库里没有账号数据"
    failed=1
fi

# 2) 抽查一个账号: 备份里存在的账号, 在线上库也必须有且密码哈希一致
#    (psql 的 -c 不展开 :'u' 变量, 所以 SQL 从标准输入进; 顺便避免手工拼字符串)
get_hash() { # $1=库名 $2=用户名
    printf "select password_hash from users where username = :'u'" | \
        psql -h db -U video -d "$1" -v u="$2" -tA -f -
}
sample=$(psql -h db -U video -d "$DRILL_DB" -tAc 'select username from users order by id limit 1')
if [ -n "$sample" ]; then
    hash_backup=$(get_hash "$DRILL_DB" "$sample")
    hash_live=$(get_hash video_conference "$sample")
    if [ -n "$hash_live" ] && [ "$hash_backup" = "$hash_live" ]; then
        echo "[drill] ok   抽查账号 '$sample' 与线上一致"
    else
        echo "[drill] FAIL 抽查账号 '$sample' 在线上对不上 (线上为空或哈希不同)"
        failed=1
    fi
fi

# 3) 行数对照: 备份早于当前, 允许恢复库比线上少 (期间新增注册);
#    但恢复库比线上多是不可能的, 直接判失败。
n_live=$(psql -h db -U video -d video_conference -tAc 'select count(*) from users')
if [ "$n_users" -le "$n_live" ]; then
    echo "[drill] ok   行数对照: 恢复 $n_users <= 线上 $n_live (备份早于当前, 合理)"
else
    echo "[drill] FAIL 行数对照: 恢复 $n_users > 线上 $n_live (不可能, 备份有问题)"
    failed=1
fi

# 4) 会话表可查 (结构完整; 行数本身随过期清理变化, 不做等值比对)
psql -h db -U video -d "$DRILL_DB" -tAc 'select count(*) from auth_tokens' >/dev/null \
    && echo "[drill] ok   auth_tokens 表结构完整" \
    || { echo "[drill] FAIL auth_tokens 表缺失"; failed=1; }

secs=$((END - START))
[ "$secs" -eq 0 ] && secs="<1"
echo "[drill] RTO(实测): $secs 秒 (createdb + pg_restore)"

if [ "${KEEP_DRILL:-0}" = "1" ]; then
    echo "[drill] KEEP_DRILL=1, 保留 $DRILL_DB 供人工检查"
else
    dropdb -h db -U video "$DRILL_DB"
    echo "[drill] 已清理临时库 $DRILL_DB"
fi

if [ "$failed" != 0 ]; then
    echo "[drill] 演练失败"
    exit 1
fi
echo "[drill] 演练通过"
