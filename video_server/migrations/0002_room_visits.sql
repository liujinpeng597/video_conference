-- 会议历史: 每次进房记一条, 离开时补上 left_at。
--
-- 这里存的是用户名而不是 user_id: 历史是"给自己看的", 按用户名查够用, 也省掉一次
-- 用户表查回 (进房是低频操作, 但少一次查询总是好的)。要做审计级别的记录应该走
-- Kafka 审计事件 (见 events.h / consumer/), 那份是追加日志, 语义更对。
CREATE TABLE IF NOT EXISTS room_visits (
    id        BIGSERIAL   PRIMARY KEY,
    username  TEXT        NOT NULL,
    room      TEXT        NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    left_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS room_visits_user_idx ON room_visits (username, joined_at DESC);
