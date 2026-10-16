-- 会议录制: 元数据在 PG, 视频字节在对象存储 (blob 层)。
--
-- 为什么不把视频塞进 PG: 一段几分钟的录制就是几十 MB, 塞进库里会让备份/恢复(唯一丢不起的
-- 那份数据)跟着一起变重变慢。字节走对象存储, 库里只留一行元数据, 两边各自管各自的。
-- 对象键 (object_key) 在应用层生成: 用户名 + 随机串 + .webm —— 用户名本来就只允许
-- [a-z0-9_] 且长度受限, 所以拼出来的键不会带出目录穿越。
CREATE TABLE IF NOT EXISTS recordings (
    id         BIGSERIAL PRIMARY KEY,
    username   TEXT        NOT NULL,
    room       TEXT        NOT NULL,
    object_key TEXT        NOT NULL,
    bytes      BIGINT      NOT NULL DEFAULT 0,
    seconds    INT         NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 列表 / 过期清理都按 "某人的、最新的在前" 走
CREATE INDEX IF NOT EXISTS recordings_user_time ON recordings (username, created_at DESC);
