#!/usr/bin/env bash
# 全链路测试:
#   编译 -> 单测(json/turncred) -> 账号/会话(含登录失败锁定) -> 保持登录 -> 房间
#   -> 信令(含并发顺序断言) -> ICE/TURN 凭证 -> 静态资源 -> 多实例互通 (两个后端进程)
#   -> 并发 -> 重启后数据还在 -> 优雅退出
#
# 需要能连上的 PostgreSQL 和 Redis。指定方式:
#   TEST_DB=postgresql://user:pass@host:port/db \
#   TEST_REDIS=redis://host:port bash test/smoke.sh
# 默认值是本机 55432 / 56379 端口上的临时容器; 连不上的话, 只要有 docker
# 就自动拉临时容器起来 (用完删掉)。
#
# 测试用的用户名都带随机后缀, 所以可以对同一个库反复执行。
set -u
cd "$(dirname "$0")/.."

PORT=${PORT:-9100}
LOG=${LOG:-/tmp/video_server_smoke.log}
WEB=${WEB:-../video_client}
BASE="http://127.0.0.1:$PORT"

TEST_DB=${TEST_DB:-postgresql://video:video@127.0.0.1:55432/video_test}
PG_IMAGE=${POSTGRES_IMAGE:-postgres:17-alpine}
PG_NAME=video_server_smoke_pg
PG_PORT=55432

TEST_REDIS=${TEST_REDIS:-redis://127.0.0.1:56379}
REDIS_IMAGE=${REDIS_IMAGE:-redis:7-alpine}
REDIS_NAME=video_server_smoke_redis
REDIS_PORT=56379

# TURN 的断言需要服务端配 TURN; compose 的 test 服务已经给了这两个变量,
# 这里再兜一个默认值, 保证"直接在机器/WSL 里跑 smoke"也能全过。
# 第二台实例会用 env -u 去掉它们, 验证"不配 TURN 就不下发"的分支。
TURN_URL=${TURN_URL:-turn:coturn:3478}
TURN_SECRET=${TURN_SECRET:-smoke-turn-secret}
export TURN_URL TURN_SECRET

fail=0
STARTED_PG=0
STARTED_REDIS=0
PID=""
PID2=""
PID3=""
cleanup() {
    [ -n "$PID" ] && kill -9 "$PID" 2>/dev/null
    [ -n "$PID2" ] && kill -9 "$PID2" 2>/dev/null
    [ -n "$PID3" ] && kill -9 "$PID3" 2>/dev/null
    [ "$STARTED_PG" = 1 ] && docker rm -f "$PG_NAME" >/dev/null 2>&1
    [ "$STARTED_REDIS" = 1 ] && docker rm -f "$REDIS_NAME" >/dev/null 2>&1
    return 0
}
trap cleanup EXIT

check() { # 名称 期望 实际
    if [ "$2" = "$3" ]; then
        echo "ok   - $1"
    else
        echo "FAIL - $1: 期望 [$2] 实际 [$3]"
        fail=1
    fi
}
contains() { # 名称 文本 片段
    case "$2" in
        *"$3"*) echo "ok   - $1" ;;
        *) echo "FAIL - $1: 没找到 [$3]"; fail=1 ;;
    esac
}
lacks() { # 名称 文本 不该有的片段
    case "$2" in
        *"$3"*) echo "FAIL - $1: 不该出现 [$3]"; fail=1 ;;
        *) echo "ok   - $1" ;;
    esac
}

# ---------------------------------------------------------------- 数据库
DB_HOST=$(printf '%s' "$TEST_DB" | sed -n 's#.*@\([^:/]*\).*#\1#p')
DB_PORT=$(printf '%s' "$TEST_DB" | sed -n 's#.*@[^:]*:\([0-9]\{1,\}\).*#\1#p')
DB_HOST=${DB_HOST:-127.0.0.1}
DB_PORT=${DB_PORT:-5432}

db_reachable() { (exec 3<>/dev/tcp/"$DB_HOST"/"$DB_PORT") 2>/dev/null; }

if db_reachable; then
    echo "数据库: $TEST_DB"
elif command -v docker >/dev/null 2>&1; then
    echo "连不上 $TEST_DB, 拉一个临时数据库容器 ($PG_IMAGE)"
    docker rm -f "$PG_NAME" >/dev/null 2>&1
    if ! docker run -d --rm --name "$PG_NAME" \
            -e POSTGRES_USER=video -e POSTGRES_PASSWORD=video -e POSTGRES_DB=video_test \
            -p "$PG_PORT":5432 "$PG_IMAGE" >/dev/null; then
        echo "临时数据库起不来 (镜像拉不动? 试试 POSTGRES_IMAGE=<镜像站>/library/postgres:17-alpine)"
        exit 1
    fi
    STARTED_PG=1
    for _ in $(seq 1 60); do
        docker exec "$PG_NAME" pg_isready -U video -d video_test >/dev/null 2>&1 && break
        sleep 0.5
    done
    if ! db_reachable; then
        echo "临时数据库没就绪"
        exit 1
    fi
echo "临时数据库就绪: $TEST_DB"
else
    echo "连不上 $TEST_DB, 也没有 docker。先起库:  docker compose up -d db redis"
    echo "或者指定外部库:  TEST_DB=postgresql://... bash test/smoke.sh"
    exit 1
fi

# ---------------------------------------------------------------- Redis
RHOST=$(printf '%s' "$TEST_REDIS" | sed -n 's#^redis://\([^:/]*\).*#\1#p')
RPORT=$(printf '%s' "$TEST_REDIS" | sed -n 's#^redis://[^:]*:\([0-9]\{1,\}\).*#\1#p')
RHOST=${RHOST:-127.0.0.1}
RPORT=${RPORT:-6379}

redis_reachable() { (exec 3<>/dev/tcp/"$RHOST"/"$RPORT") 2>/dev/null; }

if redis_reachable; then
    echo "Redis : $TEST_REDIS"
elif command -v docker >/dev/null 2>&1; then
    echo "连不上 $TEST_REDIS, 拉一个临时 Redis 容器 ($REDIS_IMAGE)"
    docker rm -f "$REDIS_NAME" >/dev/null 2>&1
    if ! docker run -d --rm --name "$REDIS_NAME" -p "$REDIS_PORT":6379 "$REDIS_IMAGE" \
            redis-server --save '' --appendonly no >/dev/null; then
        echo "临时 Redis 起不来 (镜像拉不动? 试试 REDIS_IMAGE=<镜像站>/library/redis:7-alpine)"
        exit 1
    fi
    STARTED_REDIS=1
    for _ in $(seq 1 40); do
        docker exec "$REDIS_NAME" redis-cli ping >/dev/null 2>&1 && break
        sleep 0.5
    done
    if ! redis_reachable; then
        echo "临时 Redis 没就绪"
        exit 1
    fi
    echo "临时 Redis 就绪: $TEST_REDIS"
else
    echo "连不上 $TEST_REDIS, 也没有 docker。先起:  docker compose up -d db redis"
    exit 1
fi

# ---------------------------------------------------------------- 编译
make -s || { echo "编译失败"; exit 1; }
make -s test || { echo "单测失败"; exit 1; }

rm -f "$LOG"
start_server() { # [端口] [日志里的进程名]
    local port=${1:-$PORT}
    ./video_server --port "$port" --workers 2 --web "$WEB" \
        --db "$TEST_DB" --redis "$TEST_REDIS" >>"$LOG" 2>&1 &
    PID=$!
    sleep 0.7
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "服务端($port)起不来, 日志:"
        tail -n 20 "$LOG"
        exit 1
    fi
}
start_server

# 每次跑用不同的用户名, 这样同一个库可以反复测
SUF=$RANDOM$RANDOM
USER_A="lin$SUF"
USER_B="mei$SUF"
USER_C="zhao$SUF"
USER_D="qian$SUF"
USER_E="sun$SUF"
USER_F="zhou$SUF"
USER_G="wu$SUF"

# 用 bash 自带的 /dev/tcp 发请求, 不依赖 curl。
# Connection: close 让服务端回完就关, cat 才读得到 EOF。
RESP=""
CALL_PORT=""   # 临时指定请求打到哪个端口 (测多实例时用): CALL_PORT=9101 call ...
call() { # method path [body] [token]
    local method=$1 path=$2 payload=${3:-} token=${4:-}
    local port=${CALL_PORT:-$PORT}
    RESP=$(
        exec 5<>/dev/tcp/127.0.0.1/"$port"
        {
            printf '%s %s HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n' "$method" "$path"
            if [ -n "$payload" ]; then
                printf 'Content-Type: application/json\r\nContent-Length: %d\r\n' "${#payload}"
            fi
            if [ -n "$token" ]; then
                printf 'Authorization: Bearer %s\r\n' "$token"
            fi
            printf '\r\n%s' "$payload"
        } >&5
        timeout 10 cat <&5
        exec 5<&- 5>&-
    ) || true
}

status() { printf '%s\n' "$RESP" | head -1 | tr -d '\r' | cut -d' ' -f2; }
body() { printf '%s\n' "$RESP" | tr -d '\r' | sed -n '/^$/,$p' | tail -n +2; }
jstr() { body | sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" | head -1; }
jcount() { body | grep -o "\"$1\":" | wc -l | tr -d ' '; }

echo
echo "---- 健康检查 ----"
call GET /api/health
check "健康检查 200" "200" "$(status)"
contains "健康检查里 ok 为真" "$(body)" '"ok":true'
contains "健康检查带上了实例名 (多实例排查用)" "$(body)" '"instance"'

echo
echo "---- 注册 / 登录 ----"
call POST /api/register "{\"username\":\"$USER_A\",\"password\":\"hunter2\"}"
check "注册 200" "200" "$(status)"
TOKEN_A=$(jstr token)
check "注册返回用户名" "$USER_A" "$(jstr user)"
[ -n "$TOKEN_A" ] && echo "ok   - 拿到 token" || { echo "FAIL - 没拿到 token"; fail=1; }
lacks "不勾保持登录就不发长期令牌" "$(body)" 'remember_token'

call POST /api/register "{\"username\":\"$USER_A\",\"password\":\"whatever\"}"
check "重名注册 409" "409" "$(status)"

call POST /api/register "{\"username\":\"$USER_A\",\"password\":\"hunter2\"}"
check "重名再试一次还是 409" "409" "$(status)"

call POST /api/register "{\"username\":\"$USER_A\",\"password\":\"123\"}"
check "密码太短 400" "400" "$(status)"

call POST /api/register '{"username":123,"password":"hunter2"}'
check "username 不是字符串 400" "400" "$(status)"

call POST /api/register '{"username":"a b c","password":"hunter2"}'
check "用户名带空格 400" "400" "$(status)"

call POST /api/register 'not json at all'
check "请求体不是 JSON 400" "400" "$(status)"

call POST /api/login "{\"username\":\"$USER_A\",\"password\":\"wrong\"}"
check "密码错 401" "401" "$(status)"

call POST /api/login "{\"username\":\"$USER_A\",\"password\":\"hunter2\"}"
check "登录 200" "200" "$(status)"
contains "登录返回 token" "$(body)" '"token":"'
TOKEN_A=$(jstr token)   # 一次登录只留一个会话: 刚登录把注册那枚挤掉了, 后面都用这枚

call POST /api/login '{"username":"nobody_at_all","password":"hunter2"}'
check "不存在的用户也是 401 (不泄露用户名存不存在)" "401" "$(status)"

call POST /api/register "{\"username\":\"LIN$SUF\",\"password\":\"hunter2\"}"
check "用户名大小写不敏感 (LIN 撞 lin) 409" "409" "$(status)"

call POST /api/login "{\"username\":\"LIN$SUF\",\"password\":\"hunter2\"}"
check "大写用户名也能登录 200" "200" "$(status)"
TOKEN_A=$(jstr token)

echo
echo "---- 登录失败锁定 (按账号) ----"
# 5 次错密码锁 15 分钟; 锁的是"账号", 不误伤别人, 也不泄露账号存不存在。
# 15 分钟没法等, 用 Redis 删掉计数模拟到期 (inline 协议, 不依赖 redis-cli)。
USER_L="lock$SUF"
call POST /api/register "{\"username\":\"$USER_L\",\"password\":\"hunter2\"}"
check "注册锁定测试账号 200" "200" "$(status)"

i=1
while [ "$i" -le 5 ]; do
    call POST /api/login "{\"username\":\"$USER_L\",\"password\":\"wrong$i\"}"
    check "第 $i 次错密码 401" "401" "$(status)"
    i=$((i + 1))
done

call POST /api/login "{\"username\":\"$USER_L\",\"password\":\"hunter2\"}"
check "第 6 次密码对也拒绝 (锁定中) 429" "429" "$(status)"

call POST /api/login "{\"username\":\"$USER_A\",\"password\":\"hunter2\"}"
check "锁定只针对该账号, 别的账号不受影响 200" "200" "$(status)"
TOKEN_A=$(jstr token)

exec 9<>/dev/tcp/"$RHOST"/"$RPORT"
printf 'DEL login_fail:%s\r\n' "$USER_L" >&9
DEL_REPLY=$(timeout 3 head -c 4 <&9 | tr -d '\r\n')
exec 9<&- 9>&-
check "从 Redis 删掉失败计数 (模拟 15 分钟到期)" ":1" "$DEL_REPLY"

call POST /api/login "{\"username\":\"$USER_L\",\"password\":\"hunter2\"}"
check "解锁后能正常登录 200" "200" "$(status)"

echo
echo "---- 会话 ----"
call GET /api/me '' "$TOKEN_A"
check "带 token 取自己 200" "200" "$(status)"
check "取回的用户名" "$USER_A" "$(jstr user)"

call GET /api/me
check "不带 token 401" "401" "$(status)"

call GET /api/me '' "deadbeef"
check "假 token 401" "401" "$(status)"

echo
echo "---- 一次登录只留一个会话 ----"
# 换个设备再登录, 旧会话要立刻失效 (不是等 60 秒缓存过期): 会话校验缓存按账号清掉。
USER_S="sess$SUF"
call POST /api/register "{\"username\":\"$USER_S\",\"password\":\"hunter2\"}"
TOKEN_S1=$(jstr token)
call GET /api/me '' "$TOKEN_S1"
check "第一个会话能用 200" "200" "$(status)"
call POST /api/login "{\"username\":\"$USER_S\",\"password\":\"hunter2\"}"
check "同账号再登录一次 200" "200" "$(status)"
TOKEN_S2=$(jstr token)
call GET /api/me '' "$TOKEN_S2"
check "新会话能用 200" "200" "$(status)"
call GET /api/me '' "$TOKEN_S1"
check "旧会话立刻失效 401 (被挤下线)" "401" "$(status)"

echo
echo "---- 保持登录 (长期令牌) ----"
call POST /api/register "{\"username\":\"$USER_C\",\"password\":\"hunter2\",\"remember\":true}"
check "注册时勾了保持登录 200" "200" "$(status)"
REM_C=$(jstr remember_token)
TOKEN_C=$(jstr token)
[ -n "$REM_C" ] && echo "ok   - 拿到了 remember_token" || { echo "FAIL - 没有 remember_token"; fail=1; }

call POST /api/session/resume "{\"remember_token\":\"$REM_C\"}"
check "用长期令牌换新会话 200" "200" "$(status)"
RESUMED=$(jstr token)
check "换回来的是另一个会话令牌" "1" "$([ "$RESUMED" != "$TOKEN_C" ] && echo 1 || echo 0)"

call GET /api/me '' "$RESUMED"
check "换来的会话能用 200" "200" "$(status)"

call POST /api/session/resume "{\"remember_token\":\"$REM_C\"}"
check "长期令牌可以重复用 (别的标签页也要能换) 200" "200" "$(status)"
RESUMED=$(jstr token)   # 每次 resume 换出新的会话, 上一次换来的会被挤掉, 所以取最新的

call POST /api/session/resume '{"remember_token":"deadbeef"}'
check "假长期令牌 401" "401" "$(status)"

call POST /api/session/resume "{\"remember_token\":\"$RESUMED\"}"
check "会话令牌不能当长期令牌用 401" "401" "$(status)"

call POST /api/session/resume '{}'
check "不给长期令牌 400" "400" "$(status)"

call POST /api/logout "{\"remember_token\":\"$REM_C\"}" "$RESUMED"
check "退出登录 200" "200" "$(status)"

call POST /api/session/resume "{\"remember_token\":\"$REM_C\"}"
check "退出后长期令牌被吊销 401" "401" "$(status)"

call GET /api/me '' "$RESUMED"
check "退出后会话令牌也失效 401" "401" "$(status)"

echo
echo "---- 房间 ----"
call POST /api/rooms/enter '{}' "$TOKEN_A"
check "进房间 200" "200" "$(status)"
ROOM=$(jstr room)
check "空房间号时自动分配 (9 位数字, 首位非 0)" "1" "$(printf '%s' "$ROOM" | grep -c '^[1-9][0-9]\{8\}$')"
check "房间里 1 个人" "1" "$(jcount name)"

call POST /api/register "{\"username\":\"$USER_B\",\"password\":\"hunter2\"}"
TOKEN_B=$(jstr token)
[ -n "$TOKEN_B" ] && echo "ok   - 第二个账号拿到 token" || { echo "FAIL - 第二个账号没拿到 token"; fail=1; }

call POST /api/rooms/enter "{\"room\":\"$ROOM\"}" "$TOKEN_B"
check "第二个人进来 200" "200" "$(status)"
check "进的是同一个房间" "$ROOM" "$(jstr room)"
check "房间里 2 个人" "2" "$(jcount name)"
contains "认得出自己" "$(body)" '"me":true'
contains "也认得出别人" "$(body)" '"me":false'

call GET /api/rooms/state '' "$TOKEN_A"
check "轮询房间状态 200" "200" "$(status)"
check "轮询看到 2 个人" "2" "$(jcount name)"

call POST /api/rooms/leave '' "$TOKEN_B"
check "离开房间 200" "200" "$(status)"

call GET /api/rooms/state '' "$TOKEN_A"
check "走了一个, 剩 1 个人" "1" "$(jcount name)"

call GET /api/rooms/state
check "没登录不能看房间状态 401" "401" "$(status)"

echo
echo "---- 房间号规整与拦截 ----"
call POST /api/rooms/enter '{"room":"ABC-DEF-GHI"}' "$TOKEN_A"
check "大写房间号被规整" "abc-def-ghi" "$(jstr room)"

call POST /api/rooms/enter '{"room":"a b"}' "$TOKEN_A"
check "房间号里有空格 400" "400" "$(status)"

call POST /api/rooms/enter '{"room":"ab"}' "$TOKEN_A"
check "房间号太短 400" "400" "$(status)"

echo
echo "---- 信令 (WebRTC 协商消息的搬运) ----"
# 从 participants 里挑出自己和别人的 pid。服务端输出的顺序不保证, 所以按 me 标记找。
jpid() { # true|false
    body | grep -o "{\"id\":\"[^\"]*\",\"name\":\"[^\"]*\",\"me\":$1," |
        sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1
}

call GET /api/ice
check "未登录拿 ICE 配置 401" "401" "$(status)"

call GET /api/ice '' "$TOKEN_A"
check "登录后拿 ICE 配置 200" "200" "$(status)"
contains "返回了 iceServers" "$(body)" '"iceServers"'
contains "默认带一个 STUN" "$(body)" 'stun:'
# 测试服务里配了 TURN_URL=turn:coturn:3478 (见 compose 的 test 服务; 脚本顶部也有默认值兜底),
# 所以每条响应都应该现场签发一条 TURN 临时凭证
contains "下发 TURN 服务器" "$(body)" '"urls":"turn:coturn:3478"'
TURN_USER=$(jstr username)
case "$TURN_USER" in
    [0-9]*:*) echo "ok   - TURN 用户名是 过期时间戳:账号 的形式 ($TURN_USER)" ;;
    *)        echo "FAIL - TURN 用户名格式不对: [$TURN_USER]"; fail=1 ;;
esac
TURN_CRED=$(jstr credential)
case "$TURN_CRED" in
    ''|[!A-Za-z0-9+/=]*) echo "FAIL - TURN 凭证不是非空 base64: [$TURN_CRED]"; fail=1 ;;
    *) echo "ok   - TURN 凭证是 base64 形式" ;;
esac

call POST /api/rooms/enter '{}' "$TOKEN_A"
ROOM=$(jstr room)
PID_A=$(jpid true)
[ -n "$PID_A" ] && echo "ok   - 从成员列表里拿到了自己的 id" || { echo "FAIL - 没有自己的 id"; fail=1; }

call POST /api/rooms/enter "{\"room\":\"$ROOM\"}" "$TOKEN_B"
# 注意: 进房间的响应是"收件人自己视角"的成员列表, 所以 B 自己的 id 是 me:true 那条,
# me:false 那条是 A。用反了就会变成 A 给自己发信令。
PID_B=$(jpid true)
OTHER=$(jpid false)
[ -n "$PID_B" ] && echo "ok   - 拿到了 B 自己的 id" || { echo "FAIL - 没有 B 的 id"; fail=1; }
check "B 看到的另一个人就是 A" "$PID_A" "$OTHER"

# A 给 B 发一条 offer。payload 故意做成嵌套结构, 验证服务器是原样搬运而不是解析重建。
SDP='v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'
call POST /api/rooms/signal \
    "{\"to\":\"$PID_B\",\"kind\":\"offer\",\"payload\":{\"description\":{\"type\":\"offer\",\"sdp\":\"$SDP\"},\"extra\":[1,2,{\"a\":\"b\"}]}}" \
    "$TOKEN_A"
check "发信令 200" "200" "$(status)"
contains "对方在同一个房间, delivered 为真" "$(body)" '"delivered":true'

call GET '/api/rooms/state?since=0' '' "$TOKEN_B"
check "收件人取到 1 条" "1" "$(jcount from)"
contains "SDP 原样带过来了" "$(body)" 'v=0'
contains "嵌套的数组和对象没被弄坏" "$(body)" '"extra":[1,2,{"a":"b"}]'
contains "知道是谁发的" "$(body)" "\"from\":\"$PID_A\""

TOPSEQ=$(body | grep -o '"seq":[0-9]*' | head -1 | cut -d: -f2)
call GET "/api/rooms/state?since=$TOPSEQ" '' "$TOKEN_B"
check "确认过的信令不再重复下发" "0" "$(jcount from)"

# 发给同一个房间里不存在的人: 不报错, 但也不投递
call POST /api/rooms/signal '{"to":"nosuchpid","kind":"offer","payload":{}}' "$TOKEN_A"
check "发给不存在的 pid 不报错" "200" "$(status)"
contains "但是没投递" "$(body)" '"delivered":false'

# 发给别的房间的人: 必须被拦住, 否则谁都能往别人房间塞信令
call POST /api/register "{\"username\":\"$USER_D\",\"password\":\"hunter2\"}"
TOKEN_D=$(jstr token)
call POST /api/rooms/enter '{}' "$TOKEN_D"
PID_D=$(jpid true)
call POST /api/rooms/signal "{\"to\":\"$PID_D\",\"kind\":\"offer\",\"payload\":{}}" "$TOKEN_A"
check "不能给别的房间的人发信令" "1" "$(printf '%s' "$(body)" | grep -c '"delivered":false')"

# 参数校验
call POST /api/rooms/signal "{\"to\":\"$PID_B\",\"kind\":\"offer\"}" "$TOKEN_A"
check "缺 payload 400" "400" "$(status)"

call POST /api/rooms/signal "{\"to\":\"$PID_B\"}" "$TOKEN_A"
check "缺 kind 400" "400" "$(status)"

BIG=$(head -c 20000 /dev/zero | tr '\0' 'x')
call POST /api/rooms/signal "{\"to\":\"$PID_B\",\"kind\":\"offer\",\"payload\":\"$BIG\"}" "$TOKEN_A"
check "payload 太大 413" "413" "$(status)"

call POST /api/rooms/leave '' "$TOKEN_A"
call POST /api/rooms/signal "{\"to\":\"$PID_B\",\"kind\":\"offer\",\"payload\":{}}" "$TOKEN_A"
check "不在房间里不能发信令 409" "409" "$(status)"

echo
echo "---- 并发信令的到达顺序 ----"
# 两个发送者同时往同一个收件箱塞信令时, "取序号"和"入队"必须原子完成。
# 分开跑的话, 并发下会出现"序号小的条目后入队": 收件人的 since 游标一旦越过,
# 这条信令就被当成"已经收过"而永久跳过 —— 表现是某一路协商消息凭空消失。
# 这里让两个人同时各发 25 条, 然后断言: 50 条一条不少, 且信箱里的 seq 严格递增。
USER_R1="kui$SUF"
USER_R2="lie$SUF"
USER_R3="min$SUF"
call POST /api/register "{\"username\":\"$USER_R1\",\"password\":\"hunter2\"}"
TOKEN_R1=$(jstr token)
call POST /api/register "{\"username\":\"$USER_R2\",\"password\":\"hunter2\"}"
TOKEN_R2=$(jstr token)
call POST /api/register "{\"username\":\"$USER_R3\",\"password\":\"hunter2\"}"
TOKEN_R3=$(jstr token)

call POST /api/rooms/enter '{}' "$TOKEN_R1"
RACE_ROOM=$(jstr room)
RACE_PID=$(jpid true)
call POST /api/rooms/enter "{\"room\":\"$RACE_ROOM\"}" "$TOKEN_R2"
call POST /api/rooms/enter "{\"room\":\"$RACE_ROOM\"}" "$TOKEN_R3"
check "并发测试的三个人在同一个房间" "3" "$(jcount name)"

race_send() { # token 标签: 发一条信令, HTTP 状态码写到 /tmp/vs_race_<标签>.code
    exec 8<>/dev/tcp/127.0.0.1/"$PORT"
    local P="{\"to\":\"$RACE_PID\",\"kind\":\"offer\",\"payload\":{\"n\":\"$2\"}}"
    printf 'POST /api/rooms/signal HTTP/1.1\r\nHost: x\r\nConnection: close\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s' \
        "$1" "${#P}" "$P" >&8
    timeout 10 cat <&8 | head -1 | tr -d '\r' | cut -d' ' -f2 >"/tmp/vs_race_$2.code"
    exec 8<&- 8>&-
}

rm -f /tmp/vs_race_*.code
round=0
while [ "$round" -lt 25 ]; do
    race_send "$TOKEN_R2" "${round}a" &
    pa=$!
    race_send "$TOKEN_R3" "${round}b" &
    pb=$!
    wait "$pa" "$pb"
    round=$((round + 1))
done

n_race_ok=0
for f in /tmp/vs_race_*.code; do
    [ "$(cat "$f" 2>/dev/null)" = "200" ] && n_race_ok=$((n_race_ok + 1))
done
check "50 条并发信令全部 200" "50" "$n_race_ok"
rm -f /tmp/vs_race_*.code

call GET '/api/rooms/state?since=0' '' "$TOKEN_R1"
check "收件箱里 50 条一条不少" "50" "$(jcount from)"

# 返回里第一个 seq 是服务端给的游标, 之后每条消息各有一个 seq, 按信箱顺序排列。
race_seqs=$(body | grep -o '"seq":[0-9]*' | cut -d: -f2)
race_msg_seqs=$(printf '%s\n' "$race_seqs" | tail -n +2)
race_asc=1
prev=0
for s in $race_msg_seqs; do
    if [ "$s" -le "$prev" ]; then race_asc=0; fi
    prev=$s
done
check "50 条的 seq 严格递增 (不递增说明取号和入队没原子化, 会丢信令)" "1" "$race_asc"

call GET "/api/rooms/state?since=$prev" '' "$TOKEN_R1"
check "用最新游标再拉一次不重复下发" "0" "$(jcount from)"

echo
echo "---- 房间聊天 ----"
# 新起两个账号 (不打扰上面那批状态) 一起进一个房间。聊天读走 /api/rooms/state 的 chat
# 字段 (和成员列表同一拍), 写走 POST /api/rooms/chat。
USER_CA="chata$SUF"
USER_CB="chatb$SUF"
USER_CX="chatx$SUF"
call POST /api/register "{\"username\":\"$USER_CA\",\"password\":\"hunter2\"}"
TOKEN_CA=$(jstr token)
call POST /api/register "{\"username\":\"$USER_CB\",\"password\":\"hunter2\"}"
TOKEN_CB=$(jstr token)
call POST /api/rooms/enter '{}' "$TOKEN_CA"
CROOM=$(jstr room)
call POST /api/rooms/enter "{\"room\":\"$CROOM\"}" "$TOKEN_CB"
check "两个账号进了同一个房间" "2" "$(jcount name)"

call POST /api/rooms/chat "{\"text\":\"hello 世界\"}" "$TOKEN_CA"
check "发消息 200" "200" "$(status)"
contains "返回里带消息 id" "$(body)" '"id":'

call GET "/api/rooms/state?since=0&chat=0" '' "$TOKEN_CB"
check "另一方能收到消息" "1" "$(jcount text)"
contains "内容原样 (中文和尖括号没坏)" "$(body)" 'hello 世界'
CHAT_SEQ=$(printf '%s' "$(body)" | sed -n 's/.*"chatSeq":\([0-9]*\).*/\1/p')
check "chatSeq 前进到 1" "1" "$CHAT_SEQ"

call GET "/api/rooms/state?since=0&chat=$CHAT_SEQ" '' "$TOKEN_CB"
check "用最新游标再拉不重复下发" "0" "$(jcount text)"

call POST /api/rooms/chat '{"text":""}' "$TOKEN_CA"
check "空消息 400" "400" "$(status)"
LONG_TEXT=$(printf 'x%.0s' $(seq 1 600))
call POST /api/rooms/chat "{\"text\":\"$LONG_TEXT\"}" "$TOKEN_CA"
check "超长消息 413" "413" "$(status)"
call POST /api/rooms/chat '{"text":"a\u001fb"}' "$TOKEN_CA"
check "含控制字符 400" "400" "$(status)"

call POST /api/register "{\"username\":\"$USER_CX\",\"password\":\"hunter2\"}"
TOKEN_CX=$(jstr token)
call POST /api/rooms/chat '{"text":"hi"}' "$TOKEN_CX"
check "不在房间不能发言 409" "409" "$(status)"

call POST /api/rooms/chat '{"text":"hi"}'
check "未登录发言 401" "401" "$(status)"

call GET /api/rooms/chat '' "$TOKEN_CA"
check "聊天只收 POST, GET 405" "405" "$(status)"

# 房间号复用: 人都走了以后, 同一个号码再进新人, 不该看到上一拨的聊天历史
call POST /api/rooms/leave '{}' "$TOKEN_CA"
call POST /api/rooms/leave '{}' "$TOKEN_CB"
call POST /api/rooms/enter "{\"room\":\"$CROOM\"}" "$TOKEN_CX"
call GET "/api/rooms/state?since=0&chat=0" '' "$TOKEN_CX"
check "号码复用时聊天历史被清掉" "0" "$(jcount text)"
call POST /api/rooms/leave '{}' "$TOKEN_CX"

echo
echo "---- 举手 ----"
# 举手标志挂在房间成员表里, 别人从 participants[].hand 读到。关键断言: 心跳 (每次 sync 都会
# 重写成员那一格) 不能把举手标志冲掉 —— 这正是实现时最容易写错的地方。
USER_H1="hand$SUF"
USER_H2="handb$SUF"
USER_H3="handx$SUF"
call POST /api/register "{\"username\":\"$USER_H1\",\"password\":\"hunter2\"}"
TOKEN_H1=$(jstr token)
call POST /api/register "{\"username\":\"$USER_H2\",\"password\":\"hunter2\"}"
TOKEN_H2=$(jstr token)
call POST /api/rooms/enter '{}' "$TOKEN_H1"
HROOM=$(jstr room)
call POST /api/rooms/enter "{\"room\":\"$HROOM\"}" "$TOKEN_H2"
check "两个账号进了同一个房间" "2" "$(jcount name)"

call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "默认没人举手" "0" "$(printf '%s' "$(body)" | grep -o '"hand":true' | wc -l | tr -d ' ')"

call POST /api/rooms/hand '{"raised":true}' "$TOKEN_H1"
check "举手 200" "200" "$(status)"
contains "返回 hand:true" "$(body)" '"hand":true'

call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "另一方能看见他举手了" "1" "$(printf '%s' "$(body)" | grep -o '"hand":true' | wc -l | tr -d ' ')"

# H1 自己再同步两次 (每次都会重写自己那一格): 举手标志必须还在
call GET "/api/rooms/state?since=0" '' "$TOKEN_H1"
call GET "/api/rooms/state?since=0" '' "$TOKEN_H1"
call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "本人心跳后举手标志还在 (没被心跳冲掉)" "1" "$(printf '%s' "$(body)" | grep -o '"hand":true' | wc -l | tr -d ' ')"

call POST /api/rooms/hand '{"raised":false}' "$TOKEN_H1"
check "放手 200" "200" "$(status)"
call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "放手后不再有 hand:true" "0" "$(printf '%s' "$(body)" | grep -o '"hand":true' | wc -l | tr -d ' ')"

call POST /api/register "{\"username\":\"$USER_H3\",\"password\":\"hunter2\"}"
TOKEN_H3=$(jstr token)
call POST /api/rooms/hand '{"raised":true}' "$TOKEN_H3"
check "不在房间不能举手 409" "409" "$(status)"
call POST /api/rooms/hand '{"raised":true}'
check "未登录不能举手 401" "401" "$(status)"
call POST /api/rooms/hand '{}' "$TOKEN_H1"
check "缺 raised 字段 400" "400" "$(status)"

# 静音状态同步: 和举手同一套标志 (房间里别人看得见你静音了)
call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "默认麦是开着的" "0" "$(printf '%s' "$(body)" | grep -o '"mic":false' | wc -l | tr -d ' ')"
call POST /api/rooms/mic '{"on":false}' "$TOKEN_H1"
check "上报静音 200" "200" "$(status)"
contains "返回 mic:false" "$(body)" '"mic":false'
call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "另一方能看见他静音了" "1" "$(printf '%s' "$(body)" | grep -o '"mic":false' | wc -l | tr -d ' ')"
call POST /api/rooms/mic '{"on":true}' "$TOKEN_H1"
call GET "/api/rooms/state?since=0" '' "$TOKEN_H2"
check "重新开麦后不再有 mic:false" "0" "$(printf '%s' "$(body)" | grep -o '"mic":false' | wc -l | tr -d ' ')"
call POST /api/rooms/mic '{"on":false}' "$TOKEN_H3"
check "不在房间不能上报静音 409" "409" "$(status)"
call POST /api/rooms/mic '{"on":false}'
check "未登录不能上报静音 401" "401" "$(status)"
call POST /api/rooms/mic '{}' "$TOKEN_H1"
check "缺 on 字段 400" "400" "$(status)"

call POST /api/rooms/leave '{}' "$TOKEN_H1"
call POST /api/rooms/leave '{}' "$TOKEN_H2"

echo
echo "---- 主持人 / 移出成员 ----"
# 主持人 = 建房的人。权限只在服务端校验 (客户端那个"移除"按钮只是 UI)。
USER_K1="host$SUF"
USER_K2="kick$SUF"
call POST /api/register "{\"username\":\"$USER_K1\",\"password\":\"hunter2\"}"
TOKEN_K1=$(jstr token)
call POST /api/register "{\"username\":\"$USER_K2\",\"password\":\"hunter2\"}"
TOKEN_K2=$(jstr token)
call POST /api/rooms/enter '{}' "$TOKEN_K1"
KROOM=$(jstr room)
call POST /api/rooms/enter "{\"room\":\"$KROOM\"}" "$TOKEN_K2"
check "两个账号进了同一个房间" "2" "$(jcount name)"

call GET "/api/rooms/state?since=0" '' "$TOKEN_K1"
KPID1=$(jpid true)
check "建房者拿到 host = 自己" "$KPID1" "$(jstr host)"
call GET "/api/rooms/state?since=0" '' "$TOKEN_K2"
KPID2=$(jpid true)
check "另一人看到的主持人就是建房者" "$KPID1" "$(jstr host)"

call POST /api/rooms/kick "{\"pid\":\"$KPID1\"}" "$TOKEN_K2"
check "非主持人踢人 403" "403" "$(status)"

call POST /api/rooms/kick "{\"pid\":\"$KPID2\"}" "$TOKEN_K1"
check "主持人踢人 200" "200" "$(status)"
call GET "/api/rooms/state?since=0" '' "$TOKEN_K2"
contains "被踢后房间清空" "$(body)" '"room":""'
contains "带上 removed 标记 (说明是被移出, 不是服务端重启)" "$(body)" '"removed":true'

call POST /api/rooms/kick "{\"pid\":\"$KPID2\"}" "$TOKEN_K1"
check "再踢已不在的人 404" "404" "$(status)"
call POST /api/rooms/kick "{\"pid\":\"$KPID2\"}" "$TOKEN_K2"
check "被踢过的人不在房间踢人 409" "409" "$(status)"
call POST /api/rooms/leave '{}' "$TOKEN_K1"

# 主持人离开后, 角色交接给剩下的人 (房间不至于没人管)
USER_K3="tr$SUF"
call POST /api/register "{\"username\":\"$USER_K3\",\"password\":\"hunter2\"}"
TOKEN_K3=$(jstr token)
call POST /api/rooms/enter '{}' "$TOKEN_K1"
KROOM2=$(jstr room)
call POST /api/rooms/enter "{\"room\":\"$KROOM2\"}" "$TOKEN_K3"
call GET "/api/rooms/state?since=0" '' "$TOKEN_K3"
KPID3=$(jpid true)
call POST /api/rooms/leave '{}' "$TOKEN_K1"
call GET "/api/rooms/state?since=0" '' "$TOKEN_K3"
check "主持人走后角色交给剩下的人" "$KPID3" "$(jstr host)"
call POST /api/rooms/leave '{}' "$TOKEN_K3"

echo
echo "---- 会议锁定 ----"
# 锁上以后新人进不来 (已经在里面的不受影响); 只有主持人能锁 / 解锁。
USER_LK="lk$SUF"
USER_LK2="lkb$SUF"
call POST /api/register "{\"username\":\"$USER_LK\",\"password\":\"hunter2\"}"
TOKEN_LK=$(jstr token)
call POST /api/register "{\"username\":\"$USER_LK2\",\"password\":\"hunter2\"}"
TOKEN_LK2=$(jstr token)
call POST /api/rooms/enter '{}' "$TOKEN_LK"
LKROOM=$(jstr room)
call POST /api/rooms/enter "{\"room\":\"$LKROOM\"}" "$TOKEN_LK2"
check "锁定前两个人都能进" "2" "$(jcount name)"
call GET "/api/rooms/state?since=0" '' "$TOKEN_LK"
check "默认没锁" "0" "$(printf '%s' "$(body)" | grep -o '"locked":true' | wc -l | tr -d ' ')"
call POST /api/rooms/lock '{"locked":true}' "$TOKEN_LK2"
check "非主持人锁定 403" "403" "$(status)"
call POST /api/rooms/leave '{}' "$TOKEN_LK2"
call POST /api/rooms/lock '{"locked":true}' "$TOKEN_LK"
check "主持人锁定 200" "200" "$(status)"
call GET "/api/rooms/state?since=0" '' "$TOKEN_LK"
check "锁定后 state 里 locked:true" "1" "$(printf '%s' "$(body)" | grep -o '"locked":true' | wc -l | tr -d ' ')"
call POST /api/rooms/enter "{\"room\":\"$LKROOM\"}" "$TOKEN_LK2"
check "锁上后新人进不来 403" "403" "$(status)"
call POST /api/rooms/lock '{"locked":false}' "$TOKEN_LK"
check "主持人解锁 200" "200" "$(status)"
call POST /api/rooms/enter "{\"room\":\"$LKROOM\"}" "$TOKEN_LK2"
check "解锁后又能进 200" "200" "$(status)"
call POST /api/rooms/lock '{"locked":true}'
check "未登录锁定 401" "401" "$(status)"
call POST /api/rooms/lock '{}' "$TOKEN_LK"
check "缺 locked 字段 400" "400" "$(status)"
call POST /api/rooms/leave '{}' "$TOKEN_LK"
call POST /api/rooms/leave '{}' "$TOKEN_LK2"

echo
echo "---- 路由 ----"
call GET /api/nope
check "未知接口 404" "404" "$(status)"

call DELETE /api/health
check "错误方法 405" "405" "$(status)"

echo
echo "---- 静态资源 ----"
call GET /
check "首页 200" "200" "$(status)"
contains "首页是前端页面" "$(body)" 'id="app"'
contains "图标 sprite 已经塞进去了" "$(body)" 'id="ic-microphone"'

call GET /app.css
check "app.css 200" "200" "$(status)"
contains "css 里有设计变量" "$(body)" '--brand'

call GET /app.js
check "app.js 200" "200" "$(status)"

call GET /vendor/vue.global.prod.js
check "本地 Vue 200" "200" "$(status)"

call GET /nope.txt
check "不存在的静态文件 404" "404" "$(status)"

call GET /../src/main.cpp
check "路径穿越 400" "400" "$(status)"

call GET /%2e%2e/src/main.cpp
check "编码过的路径穿越 400" "400" "$(status)"

call POST /index.html
check "静态资源只收 GET 405" "405" "$(status)"

# 大文件必须整包送到。这条专门盯 "Connection: close" 那条路径:
# 如果服务端回完就立刻 close, out 缓冲里没写完的字节会被丢掉, 下载就会莫名截断。
if command -v curl >/dev/null 2>&1; then
    want=$(wc -c <"$WEB/vendor/vue.global.prod.js")
    got=$(curl -sS -H 'Connection: close' -o /tmp/vs_smoke_static.raw \
               -w '%{size_download}' "$BASE/vendor/vue.global.prod.js" 2>/dev/null || echo -1)
    check "大静态文件整包送达 ($want 字节)" "$want" "$got"
    rm -f /tmp/vs_smoke_static.raw
else
    echo "skip - 没有 curl, 跳过整包校验"
fi

echo
echo "---- 并发 ----"
# 4 个请求同时抢同一个用户名: 唯一约束保证只有一个能成
rm -f /tmp/vs_reg_*.code
pids=""
i=0
while [ "$i" -lt 4 ]; do
    (
        exec 6<>/dev/tcp/127.0.0.1/"$PORT"
        P="{\"username\":\"dup$SUF\",\"password\":\"hunter2\"}"
        printf 'POST /api/register HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n%s' "${#P}" "$P" >&6
        timeout 10 cat <&6 | head -1 | tr -d '\r' | cut -d' ' -f2 >"/tmp/vs_reg_$i.code"
        exec 6<&- 6>&-
    ) &
    pids="$pids $!"
    i=$((i + 1))
done
for p in $pids; do wait "$p"; done

n200=0
n409=0
for f in /tmp/vs_reg_*.code; do
    case "$(cat "$f" 2>/dev/null)" in
        200) n200=$((n200 + 1)) ;;
        409) n409=$((n409 + 1)) ;;
    esac
done
check "4 个并发注册只成功 1 个" "1" "$n200"
check "另外 3 个都是 409" "3" "$n409"
rm -f /tmp/vs_reg_*.code

# 5 条并发健康检查
rm -f /tmp/vs_smoke_c*.code
pids=""
i=0
while [ "$i" -lt 5 ]; do
    (
        exec 7<>/dev/tcp/127.0.0.1/"$PORT"
        printf 'GET /api/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n' >&7
        timeout 10 cat <&7 | head -1 | tr -d '\r' | cut -d' ' -f2 >"/tmp/vs_smoke_c$i.code"
        exec 7<&- 7>&-
    ) &
    pids="$pids $!"
    i=$((i + 1))
done
for p in $pids; do wait "$p"; done
ok=0
i=0
while [ "$i" -lt 5 ]; do
    [ "$(cat "/tmp/vs_smoke_c$i.code" 2>/dev/null)" = "200" ] && ok=$((ok + 1))
    i=$((i + 1))
done
check "5 条并发请求都 200" "5" "$ok"
rm -f /tmp/vs_smoke_c*.code

echo
echo "---- 连接回收 ----"
sleep 0.5
# 日志现在带 "[时间戳] [实例名] " 前缀 (见 src/log.cpp), 所以不能再锚在行首
opened=$(grep -c '\[conn\] +' "$LOG")
closed=$(grep -c '\[conn\] -' "$LOG")
check "建立/关闭数量一致" "$opened" "$closed"
[ "$opened" -gt 10 ] && echo "ok   - 确实跑了不少连接 ($opened 条)" || { echo "FAIL - 连接数太少 ($opened)"; fail=1; }

echo
echo "---- 重启服务端后数据还在吗 ----"
kill -TERM "$PID"
wait "$PID"
check "重启前 SIGTERM 退出码" "0" "$?"
grep -q 'caught signal 15' "$LOG" && echo "ok   - signalfd 收到 SIGTERM" || { echo "FAIL - signalfd 没收到信号"; fail=1; }

rm -f "$LOG"
start_server

# 先查"重启前发的会话还在不在" —— 一次登录只留一个会话, 所以要排在重新登录之前
call GET /api/me '' "$TOKEN_A"
check "重启前发的会话令牌依然有效 (会话持久化)" "200" "$(status)"
check "拿回来的还是同一个人" "$USER_A" "$(jstr user)"

call POST /api/login "{\"username\":\"$USER_A\",\"password\":\"hunter2\"}"
check "重启后老账号还能登录 (账号持久化)" "200" "$(status)"
contains "重启后拿到新 token" "$(body)" '"token":"'
TOKEN_A=$(jstr token)

call POST /api/register "{\"username\":\"$USER_A\",\"password\":\"hunter2\"}"
check "重启后重名照样拦住" "409" "$(status)"

echo
echo "---- 多实例: 两个后端进程共享同一份 Redis ----"
# 这一段是这次改动的核心验证。两个完全独立的服务进程, 各自内存里什么都没有
# (房间里的人、信令收件箱、序号全在 Redis), 却要能互相看到、互相发信令。
# 状态要是还在进程内存里, 下面每一条都会失败。
PORT2=$((PORT + 1))
# 第二台故意不带 TURN 环境变量: 顺带验证"没配 TURN 就不下发 turn: 条目"的分支
env -u TURN_URL -u TURN_SECRET ./video_server --port "$PORT2" --workers 2 --web "$WEB" \
    --db "$TEST_DB" --redis "$TEST_REDIS" >>"$LOG" 2>&1 &
PID2=$!
sleep 0.8
kill -0 "$PID2" 2>/dev/null || { echo "FAIL - 第二台实例没起来"; fail=1; }

call POST /api/register "{\"username\":\"$USER_E\",\"password\":\"hunter2\"}"
TOKEN_E=$(jstr token)
CALL_PORT=$PORT2 call POST /api/register "{\"username\":\"$USER_F\",\"password\":\"hunter2\"}"
TOKEN_F=$(jstr token)
[ -n "$TOKEN_E" ] && [ -n "$TOKEN_F" ] && echo "ok   - 两个账号分别在两台实例上注册成功" \
    || { echo "FAIL - 注册失败"; fail=1; }

# 两台实例各自报出自己的名字, 证明真的是两个进程
call GET /api/health
INST1=$(body | sed -n 's/.*"instance":"\([^"]*\)".*/\1/p')
CALL_PORT=$PORT2 call GET /api/health
INST2=$(body | sed -n 's/.*"instance":"\([^"]*\)".*/\1/p')
check "两个端口是同一台机器上的两个实例" "$INST1" "$INST2"

# 没配 TURN 的实例: 只有静态 STUN, 不该有 turn: 条目
CALL_PORT=$PORT2 call GET /api/ice '' "$TOKEN_A"
check "没配 TURN 的实例照样能拿 ICE 配置 200" "200" "$(status)"
contains "同样有 iceServers" "$(body)" '"iceServers"'
lacks "没配 TURN 就不下发 turn: 条目" "$(body)" '"turn:'

# E 在 1 号实例开房间, F 从 2 号实例进同一个房间
call POST /api/rooms/enter '{}' "$TOKEN_E"
check "E 在 1 号实例开房间" "200" "$(status)"
ROOM=$(jstr room)
PID_E=$(jpid true)

CALL_PORT=$PORT2 call POST /api/rooms/enter "{\"room\":\"$ROOM\"}" "$TOKEN_F"
check "F 在 2 号实例进同一个房间" "200" "$(status)"
PID_F=$(jpid true)
check "2 号实例上也看到 2 个人" "2" "$(jcount name)"

call GET '/api/rooms/state?since=0' '' "$TOKEN_E"
check "1 号实例能看到 2 号实例上的人" "2" "$(jcount name)"
contains "认得出哪个是自己" "$(body)" '"me":true'

# 信令跨实例来回走一遍
CALL_PORT=$PORT2 call POST /api/rooms/signal \
    "{\"to\":\"$PID_E\",\"kind\":\"offer\",\"payload\":{\"description\":{\"type\":\"offer\",\"sdp\":\"v=0\\r\\ncross\"}}}" \
    "$TOKEN_F"
contains "F(2 号) 发给 E(1 号) 投递成功" "$(body)" '"delivered":true'
call GET '/api/rooms/state?since=0' '' "$TOKEN_E"
check "E 在 1 号实例上收到了 2 号实例转来的信令" "1" "$(jcount from)"
contains "内容没坏" "$(body)" 'cross'

call POST /api/rooms/signal \
    "{\"to\":\"$PID_F\",\"kind\":\"answer\",\"payload\":{\"description\":{\"type\":\"answer\",\"sdp\":\"v=0\\r\\nback\"}}}" \
    "$TOKEN_E"
CALL_PORT=$PORT2 call GET '/api/rooms/state?since=0' '' "$TOKEN_F"
check "E(1 号) 发给 F(2 号) 也到了" "1" "$(jcount from)"

# 人数上限在跨实例时也要管用
call POST /api/register "{\"username\":\"$USER_G\",\"password\":\"hunter2\"}"
TOKEN_G=$(jstr token)
call POST /api/rooms/enter "{\"room\":\"$ROOM\"}" "$TOKEN_G"
check "第三个人也能进来 (上限是 6)" "200" "$(status)"

# 跨实例离开, 另一台要立刻看得到
CALL_PORT=$PORT2 call POST /api/rooms/leave '' "$TOKEN_F"
call GET /api/rooms/state '' "$TOKEN_E"
check "2 号实例上的人走了, 1 号实例马上就知道" "2" "$(jcount name)"

call POST /api/rooms/leave '' "$TOKEN_G"
call POST /api/rooms/leave '' "$TOKEN_E"

# 离开以后自己的会话里就不该再有房间了。用这个而不是"健康检查里 rooms 归零":
# 前面几节还留着别的房间 (房间 key 有 TTL, 一会儿自己消失), 归零本来就不该成立。
call GET /api/rooms/state '' "$TOKEN_E"
contains "离开后自己的房间号清空了" "$(body)" '"room":""'
check "离开后成员列表也是空的" "0" "$(jcount name)"
CALL_PORT=$PORT2 call GET /api/rooms/state '' "$TOKEN_F"
contains "从 2 号实例离开的人同样是空房间" "$(body)" '"room":""'

kill -TERM "$PID2"
wait "$PID2"
check "第二台实例优雅退出" "0" "$?"
PID2=""

echo
echo "---- 按令牌限流 ----"
# 单起一个实例, 把每个令牌每分钟的额度压到 3 (PER_TOKEN_RPM=3), 验证:
# 额度内放行 / 超额 429 / 计数按令牌分而不是全局 / 删掉 key(模拟窗口到期)后恢复。
PORT3=$((PORT + 2))
PER_TOKEN_RPM=3 PER_TOKEN_WINDOW_SECONDS=60 ./video_server --port "$PORT3" --workers 1 --web "$WEB" \
    --db "$TEST_DB" --redis "$TEST_REDIS" >>"$LOG" 2>&1 &
PID3=$!
sleep 0.8
kill -0 "$PID3" 2>/dev/null || { echo "FAIL - 限流实例没起来"; fail=1; }

RL_USER="rl$SUF"
CALL_PORT=$PORT3 call POST /api/register "{\"username\":\"$RL_USER\",\"password\":\"hunter2\"}"
RL_TOKEN=$(jstr token)
[ -n "$RL_TOKEN" ] && echo "ok   - 限流实例上注册成功" || { echo "FAIL - 注册失败"; fail=1; }

CALL_PORT=$PORT3 call GET /api/me '' "$RL_TOKEN"
check "额度内第 1 次 200" "200" "$(status)"
CALL_PORT=$PORT3 call GET /api/me '' "$RL_TOKEN"
check "额度内第 2 次 200" "200" "$(status)"
CALL_PORT=$PORT3 call GET /api/me '' "$RL_TOKEN"
check "额度内第 3 次 200" "200" "$(status)"
CALL_PORT=$PORT3 call GET /api/me '' "$RL_TOKEN"
check "第 4 次超额 429" "429" "$(status)"
contains "429 带中文提示" "$(body)" '频繁'

# 换个令牌照样有额度: 说明计数是按令牌分的, 不是全局一刀切
CALL_PORT=$PORT3 call POST /api/register "{\"username\":\"${RL_USER}b\",\"password\":\"hunter2\"}"
RL_TOKEN2=$(jstr token)
CALL_PORT=$PORT3 call GET /api/me '' "$RL_TOKEN2"
check "换个令牌照样有额度 (按令牌计数)" "200" "$(status)"

# 删掉计数 key 模拟窗口到期 (等价于 60 秒后自动恢复), 老令牌又能用了
exec 9<>/dev/tcp/"$RHOST"/"$RPORT"
printf 'DEL rl:tok:%s\r\n' "$RL_TOKEN" >&9
timeout 3 head -c 4 <&9 >/dev/null
exec 9<&- 9>&-
CALL_PORT=$PORT3 call GET /api/me '' "$RL_TOKEN"
check "窗口重置后老令牌恢复 200" "200" "$(status)"

kill -TERM "$PID3"
wait "$PID3"
check "限流实例优雅退出" "0" "$?"
PID3=""

echo
echo "---- 收尾 ----"
kill -TERM "$PID"
wait "$PID"
check "最终 SIGTERM 退出码" "0" "$?"
grep -q 'stopped' "$LOG" && echo "ok   - 正常关停" || { echo "FAIL - 没有关停日志"; fail=1; }
PID=""

echo
echo "---- 服务端日志 (最后 25 行) ----"
tail -n 25 "$LOG"
echo
[ "$fail" = 0 ] && echo "==== 全部通过 ====" || echo "==== 有失败 ===="
exit "$fail"
