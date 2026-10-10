-- =============================================================
-- DeskAlarm 服务端表结构 (PostgreSQL 13+)
--
-- 几条贯穿全局的约定：
--   1. 时间统一用 timestamptz，API 层转 epoch 毫秒，前端不碰时区
--   2. fired_at 只由调度器写，这是整个系统唯一决定「响没响」的地方
--   3. status 不入库，全部读时推导，理由见 repo/entries.ts
--   4. 单用户部署，user 字段全部省略。真要多用户时在这里加，
--      鉴权模型要一起改，不是只加列
--   5. 所有表建在 PGSCHEMA 指定的 schema 里（默认 desk_alarm）。
--      共用的库往 public 塞表会和别的项目撞名。连接时用
--      search_path 指向这里，所以下面的 SQL 全不带 schema 前缀
--
-- gen_random_uuid() 从 PostgreSQL 13 起是内核函数，
-- 不需要 pgcrypto 扩展。共用库里装扩展经常没权限，索性不用。
-- =============================================================

-- ---------------------------------------------------------------- 设备
CREATE TABLE IF NOT EXISTS devices (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  platform      text NOT NULL,                    -- windows | android | ios | mac | linux
  is_self       boolean NOT NULL DEFAULT false,

  -- 推送通道。桌面端进程常驻走 ws，手机进程会被杀，只能靠 fcm
  transport     text NOT NULL DEFAULT 'ws',
  push_token    text,
  push_enabled  boolean NOT NULL DEFAULT true,

  online        boolean NOT NULL DEFAULT false,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_devices_online ON devices(online) WHERE online;

COMMENT ON COLUMN devices.transport IS
  'ws=长连接(桌面) fcm=Firebase(安卓) webpush=浏览器。决定到点时走哪条投递路径';

-- ------------------------------------------------------------ 登录会话
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  device_id   text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_device ON sessions(device_id);

-- ---------------------------------------------------------------- 条目
CREATE TABLE IF NOT EXISTS entries (
  id            text PRIMARY KEY DEFAULT 'e_' || replace(gen_random_uuid()::text, '-', ''),
  text          text NOT NULL,
  kind          text NOT NULL DEFAULT 'text',       -- text | link | path
  url           text,
  path          text,
  note          text,

  remind_at     timestamptz,
  repeat        text NOT NULL DEFAULT 'none',       -- none | daily | weekly | monthly

  -- 强度和静音豁免是两个正交的维度，合成一个字段就没法表达
  -- 「服药」要 strong 且 bypass_quiet，「站起来走走」要 weak 且不豁免
  strength      text NOT NULL DEFAULT 'strong',     -- strong | weak
  bypass_quiet  boolean NOT NULL DEFAULT false,     -- 静音时段也照响

  -- 来源。agent 建的条目要能一眼认出来
  source        text NOT NULL DEFAULT 'app',        -- app | mcp

  fired_at      timestamptz,
  done_at       timestamptz,
  done_device   text,
  snooze_count  integer NOT NULL DEFAULT 0,
  dismiss_count integer NOT NULL DEFAULT 0,

  version       integer NOT NULL DEFAULT 1,         -- 乐观锁
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 调度器的主查询：到点了、还没响过、也没完成
-- 不依赖任何 status 列
CREATE INDEX IF NOT EXISTS ix_entries_due
  ON entries (remind_at)
  WHERE fired_at IS NULL AND done_at IS NULL AND remind_at IS NOT NULL;

-- 列表查询的常用顺序
CREATE INDEX IF NOT EXISTS ix_entries_list ON entries (done_at, remind_at);
CREATE INDEX IF NOT EXISTS ix_entries_text ON entries USING gin (to_tsvector('simple', text));

-- 同一个 token 重复提交时幂等，agent 重试不会造出两条一样的提醒
CREATE TABLE IF NOT EXISTS idempotency (
  key          text PRIMARY KEY,
  entry_id     text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- 推送范围
-- 没有行 = 推给全部在线设备；有行 = 只推给列出的设备
CREATE TABLE IF NOT EXISTS entry_devices (
  entry_id  text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  device_id text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, device_id)
);
CREATE INDEX IF NOT EXISTS ix_entry_devices_device ON entry_devices(device_id);

-- ------------------------------------------------------ 触发投递
-- 一条提醒响过一次 = 一行。同时充当事务性 outbox：
-- 投递成功与否只改这一行的状态，不影响 entries
CREATE TABLE IF NOT EXISTS deliveries (
  id             bigserial PRIMARY KEY,
  entry_id       text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  device_id      text NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

  -- 本次触发的标识。跨端去重、轮转、outbox 重试都靠它
  fire_key       text NOT NULL,

  state          text NOT NULL DEFAULT 'pending',   -- pending | delivered | acked
  transport      text,                              -- 实际走的那条通道
  attempts       integer NOT NULL DEFAULT 0,
  last_error     text,
  last_attempt_at timestamptz,

  fired_at       timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  delivered_at   timestamptz,
  acked_at       timestamptz,
  ack_action     text,                              -- done | snooze | silence

  -- 同一次触发对同一设备只可能有一条。fired_at 可空时
  -- PostgreSQL 的 NULL 不参与唯一约束，固定用 'pending' 兜底
  UNIQUE (entry_id, device_id, fire_key)
);

-- 调度器刚写完、还没投出去的
CREATE INDEX IF NOT EXISTS ix_deliveries_pending
  ON deliveries (fire_key) WHERE state = 'pending';
-- 轮转器按这个把 pending 改 delivered
CREATE INDEX IF NOT EXISTS ix_deliveries_sweep
  ON deliveries (state, delivered_at) WHERE state = 'delivered';
-- 跨端去重：这条提醒响过了吗
CREATE INDEX IF NOT EXISTS ix_deliveries_entry ON deliveries (entry_id);

-- ------------------------------------------------------ 弱提示忽略
-- 忽略和完成必须分开记：
--   done      = 我做完了
--   dismissed = 我看到了，故意不处理
-- 分开才有下面那个「被忽略 N 次」的判断
CREATE TABLE IF NOT EXISTS dismissals (
  id          bigserial PRIMARY KEY,
  entry_id    text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  device_id   text NOT NULL,
  device_name text NOT NULL,
  reason      text,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_dismissals_entry ON dismissals (entry_id, at DESC);
CREATE INDEX IF NOT EXISTS ix_dismissals_at ON dismissals (at DESC);

-- ---------------------------------------------------------------- 设置
CREATE TABLE IF NOT EXISTS settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('escalateAfterSec', '30'),
  ('repeatEverySec',   '120'),
  ('quietStartMin',    '1410'),   -- 23:30
  ('quietEndMin',      '420'),    -- 07:00
  ('sound',            'system')
ON CONFLICT (key) DO NOTHING;
