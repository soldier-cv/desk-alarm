-- =============================================================
-- DeskAlarm v2: agent-first 推进引擎表结构 (PostgreSQL 13+)
--
-- 全局约定：
--   1. 时间统一 timestamptz，API 层转 epoch 毫秒，前端不碰时区
--   2. nudges 是唯一的打扰账本 + 投递 outbox：引擎写 pending，轮转器投递
--   3. 派生量（progress/staleness/weight）读时算，不入库
--   4. 多用户、数据完全隔离：所有业务表都带 user_id
--   5. 设备身份是 OS 级 machine-id，唯一且不可变；归属随登录用户切换
--   6. 所有表建在 PGSCHEMA 指定的 schema 里，靠 search_path 隔离
--
-- gen_random_uuid() 从 PostgreSQL 13 起是内核函数，不需要 pgcrypto
-- =============================================================

-- ---------------------------------------------------------------- 用户
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY DEFAULT 'u_' || replace(gen_random_uuid()::text, '-', ''),
  username      text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user',   -- admin | user
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users (lower(username));

-- ---------------------------------------------------------------- 设备
CREATE TABLE IF NOT EXISTS devices (
  id            text PRIMARY KEY DEFAULT 'd_' || replace(gen_random_uuid()::text, '-', ''),
  machine_id    text NOT NULL UNIQUE,
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  platform      text NOT NULL,
  is_self       boolean NOT NULL DEFAULT false,
  transport     text NOT NULL DEFAULT 'ws',
  push_enabled  boolean NOT NULL DEFAULT true,
  last_ip       text,
  online        boolean NOT NULL DEFAULT false,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS ix_devices_online ON devices(online) WHERE online;

-- ------------------------------------------------------------ 登录会话
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id   text REFERENCES devices(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'user',    -- user | dashboard | agent
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_device ON sessions(device_id);

-- ---------------------------------------------------------- Agent 令牌
CREATE TABLE IF NOT EXISTS agent_tokens (
  id           text PRIMARY KEY DEFAULT 'at_' || replace(gen_random_uuid()::text, '-', ''),
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id   text,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  prefix       text NOT NULL,
  scope        text NOT NULL DEFAULT 'write',   -- read | write
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX IF NOT EXISTS ix_agent_tokens_user ON agent_tokens(user_id);

-- ---------------------------------------------------------------- 推进项
CREATE TABLE IF NOT EXISTS pursuits (
  id              text PRIMARY KEY DEFAULT 'p_' || replace(gen_random_uuid()::text, '-', ''),
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text            text NOT NULL,
  note            text,
  kind            text NOT NULL DEFAULT 'text',
  url             text,
  path            text,

  importance      integer NOT NULL DEFAULT 1,        -- 1=P2 默认, 2=P1, 3=P0
  due_at          timestamptz,
  recurrence      jsonb,
  context         jsonb,
  commitment      jsonb,

  status          text NOT NULL DEFAULT 'active',    -- inbox|active|paused|done|archived
  importance_sort integer NOT NULL DEFAULT 0,
  source          text NOT NULL DEFAULT 'app',       -- app | mcp

  last_activity_at timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_pursuits_user_status ON pursuits(user_id, status);
CREATE INDEX IF NOT EXISTS ix_pursuits_active ON pursuits(user_id, last_activity_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_pursuits_due ON pursuits(user_id, due_at) WHERE due_at IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS ix_pursuits_text ON pursuits USING gin (to_tsvector('simple', text));

-- ---------------------------------------------------------------- 微步骤
CREATE TABLE IF NOT EXISTS steps (
  id          text PRIMARY KEY DEFAULT 's_' || replace(gen_random_uuid()::text, '-', ''),
  pursuit_id  text NOT NULL REFERENCES pursuits(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        text NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  state       text NOT NULL DEFAULT 'todo',     -- todo | doing | done
  done_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_steps_pursuit ON steps(pursuit_id, position);

-- ---------------------------------------------------------------- 跟进历史
CREATE TABLE IF NOT EXISTS followups (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pursuit_id  text NOT NULL REFERENCES pursuits(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  level       integer NOT NULL,
  action      text NOT NULL,   -- done|later|smaller|archive|reopen
  note        text
);
CREATE INDEX IF NOT EXISTS ix_followups_pursuit ON followups(pursuit_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_followups_user ON followups(user_id, at DESC);

-- ------------------------------------------- 打扰账本 + 投递 outbox
CREATE TABLE IF NOT EXISTS nudges (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pursuit_id      text NOT NULL REFERENCES pursuits(id) ON DELETE CASCADE,
  device_id       text REFERENCES devices(id) ON DELETE CASCADE,
  fire_key        text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now(),

  level           integer NOT NULL,
  channel         text NOT NULL,        -- in_app | notification | takeover
  reason          text NOT NULL,

  state           text NOT NULL DEFAULT 'pending',  -- pending | delivered | acked | skipped
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz,

  delivered_at    timestamptz,
  acked_at        timestamptz,
  ack_action      text,

  UNIQUE (pursuit_id, device_id, fire_key)
);
CREATE INDEX IF NOT EXISTS ix_nudges_pending ON nudges(fire_key) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ix_nudges_user_day ON nudges(user_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_nudges_pursuit ON nudges(pursuit_id);

-- -------------------------------------------------------- 推送范围
CREATE TABLE IF NOT EXISTS pursuit_devices (
  pursuit_id text NOT NULL REFERENCES pursuits(id) ON DELETE CASCADE,
  device_id  text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (pursuit_id, device_id)
);
CREATE INDEX IF NOT EXISTS ix_pursuit_devices_device ON pursuit_devices(device_id);

-- -------------------------------------------------------- 幂等
CREATE TABLE IF NOT EXISTS idempotency (
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key         text NOT NULL,
  pursuit_id  text NOT NULL REFERENCES pursuits(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ---------------------------------------------------------------- 设置
CREATE TABLE IF NOT EXISTS settings (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text NOT NULL,
  value   text NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- 幂等升级：旧库移除已废弃的 pursuits.nature 列
ALTER TABLE pursuits DROP COLUMN IF EXISTS nature;
