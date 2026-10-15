-- 初始 schema: 账号与会话。
-- 文件名格式 NNNN_描述.sql, 按字典序执行; 已执行过的记录在 schema_migrations 表,
-- 进程启动时跳过。

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL   PRIMARY KEY,
    username      TEXT        NOT NULL,
    username_lc   TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT        PRIMARY KEY,
    user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT        NOT NULL CHECK (kind IN ('session', 'remember')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_idx ON auth_tokens (user_id);
CREATE INDEX IF NOT EXISTS auth_tokens_expires_idx ON auth_tokens (expires_at);
