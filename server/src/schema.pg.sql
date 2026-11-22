-- =============================================================
-- DeskAlarm 服务端表结构 (PostgreSQL 13+)
--
-- 全局约定：
--   1. 时间统一 timestamptz，API 层转 epoch 毫秒，前端不碰时区
--   2. fired_at 只由调度器写，这是整个系统唯一决定「响没响」的地方
--   3. status 读时推导，不入库，理由见 repo/entries.ts
--   4. 多用户、数据完全隔离：所有业务表都带 user_id
--   5. 设备身份是 OS 级 machine-id，唯一且不可变；设备归属随登录用户切换
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
-- 用户名大小写不敏感，但展示保留原样
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_username ON users (lower(username));

-- ---------------------------------------------------------------- 设备
CREATE TABLE IF NOT EXISTS devices (
  id            text PRIMARY KEY DEFAULT 'd_' || replace(gen_random_uuid()::text, '-', ''),
  machine_id    text NOT NULL UNIQUE,          -- OS 级机器指纹，不随浏览器/缓存变化
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  platform      text NOT NULL,                 -- windows | android | ios | mac | linux | web
  is_self       boolean NOT NULL DEFAULT false,
  transport     text NOT NULL DEFAULT 'ws',
  push_token    text,
  push_enabled  boolean NOT NULL DEFAULT true,
  online        boolean NOT NULL DEFAULT false,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_devices_user ON devices(user_id);
CREATE INDEX IF NOT EXISTS ix_devices_online ON devices(online) WHERE online;

COMMENT ON COLUMN devices.machine_id IS
  'OS 级 machine-id：Windows MachineGuid / Linux /etc/machine-id / Android ro.serialno';

-- ------------------------------------------------------------ 登录会话
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Web / 看板不记录指纹：device_id 可空
  device_id   text REFERENCES devices(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'user',    -- user | mcp | dashboard
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_device ON sessions(device_id);

-- ---------------------------------------------------------- Agent 令牌
-- 与登录会话完全分开：agent 拿它调 MCP，登录 token 调不了 MCP。
-- 令牌只存哈希，明文只在签发时返回一次
CREATE TABLE IF NOT EXISTS agent_tokens (
  id           text PRIMARY KEY DEFAULT 'at_' || replace(gen_random_uuid()::text, '-', ''),
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id   text,                            -- 可空：云端 agent 没有机器指纹
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

-- ---------------------------------------------------------------- 条目
CREATE TABLE IF NOT EXISTS entries (
  id            text PRIMARY KEY DEFAULT 'e_' || replace(gen_random_uuid()::text, '-', ''),
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          text NOT NULL,
  kind          text NOT NULL DEFAULT 'text',
  url           text,
  path          text,
  note          text,

  remind_at     timestamptz,
  repeat        text NOT NULL DEFAULT 'none',

  strength      text NOT NULL DEFAULT 'weak',
  bypass_quiet  boolean NOT NULL DEFAULT false,
  source        text NOT NULL DEFAULT 'app',

  fired_at      timestamptz,
  done_at       timestamptz,
  done_device   text,
  snooze_count  integer NOT NULL DEFAULT 0,
  dismiss_count integer NOT NULL DEFAULT 0,

  version       integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_entries_due
  ON entries (remind_at)
  WHERE fired_at IS NULL AND done_at IS NULL AND remind_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_entries_user_list ON entries (user_id, done_at, remind_at);
CREATE INDEX IF NOT EXISTS ix_entries_text ON entries USING gin (to_tsvector('simple', text));

-- 同用户重复提交幂等
CREATE TABLE IF NOT EXISTS idempotency (
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  entry_id   text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- -------------------------------------------------------- 推送范围
CREATE TABLE IF NOT EXISTS entry_devices (
  entry_id  text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, device_id)
);
CREATE INDEX IF NOT EXISTS ix_entry_devices_device ON entry_devices(device_id);

-- ------------------------------------------------------ 触发投递
CREATE TABLE IF NOT EXISTS deliveries (
  id              bigserial PRIMARY KEY,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id        text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  device_id       text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

  fire_key        text NOT NULL,
  state           text NOT NULL DEFAULT 'pending',   -- pending | delivered | acked
  transport       text,
  attempts        integer NOT NULL DEFAULT 0,
  last_error      text,
  last_attempt_at timestamptz,

  fired_at        timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  acked_at        timestamptz,
  ack_action      text,

  UNIQUE (entry_id, device_id, fire_key)
);
CREATE INDEX IF NOT EXISTS ix_deliveries_pending
  ON deliveries (fire_key) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS ix_deliveries_sweep
  ON deliveries (state, delivered_at) WHERE state = 'delivered';
CREATE INDEX IF NOT EXISTS ix_deliveries_entry ON deliveries (entry_id);
CREATE INDEX IF NOT EXISTS ix_deliveries_user ON deliveries (user_id);

-- ------------------------------------------------------ 弱提示忽略
CREATE TABLE IF NOT EXISTS dismissals (
  id          bigserial PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id    text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  device_id   text,
  device_name text NOT NULL,
  reason      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dismissals_entry ON dismissals (entry_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_dismissals_user ON dismissals (user_id, at DESC);

-- ---------------------------------------------------------------- 设置
CREATE TABLE IF NOT EXISTS settings (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text NOT NULL,
  value   text NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- =============================================================
-- 增量列。migrate() 每次开机都会跑这段，必须幂等。
-- =============================================================
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_ip text;
