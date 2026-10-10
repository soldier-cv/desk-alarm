import { randomBytes } from 'node:crypto';

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}
function int(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

export const env = {
  PORT: int('PORT', 8787),
  HOST: str('HOST', '0.0.0.0'),

  /** SQLite 文件路径。已弃用，保留只为迁移期读旧库 */
  DB_PATH: str('DB_PATH', './data/deskalarm.db'),

  /* ---------------- PostgreSQL ---------------- */
  PGHOST: str('PGHOST', '127.0.0.1'),
  PGPORT: int('PGPORT', 5432),
  PGDATABASE: str('PGDATABASE', 'general_db'),
  /**
   * 自己的 schema。共用的库里往 public 塞表会和别的项目撞名，
   * 所以所有表都建在这一层，通过 search_path 隔离
   */
  PGSCHEMA: str('PGSCHEMA', 'desk_alarm'),
  PGUSER: str('PGUSER', 'desk_alarm'),
  PGPASSWORD: str('PGPASSWORD', ''),
  PG_POOL_MAX: int('PG_POOL_MAX', 10),

  /** 登录口令。首次部署必须改掉 */
  PASSCODE: str('DESKALARM_PASSCODE', 'deskalarm'),

  /** 会话有效期，默认 90 天 */
  SESSION_TTL_MS: int('SESSION_TTL_MS', 90 * 24 * 60 * 60 * 1000),

  /** 调度器扫描间隔 */
  TICK_MS: int('TICK_MS', 1000),

  /**
   * 投递轮转间隔。调度器只负责写 outbox，投出去由轮转器做。
   * 故意比 TICK 慢一点，让同一批投递集中发生
   */
  ROTATE_MS: int('ROTATE_MS', 400),

  /** 超过这个时间还没确认的触发，客户端下次上线作为「漏掉的提醒」补发 */
  MISSED_AFTER_MS: int('MISSED_AFTER_MS', 60_000),

  /**
   * 投递重试。超过这个时间还在 pending 的就放弃，
   * 留给设备上线时的 missed 补发。防止坏 token 无限重试
   */
  DELIVERY_RETRY_MS: int('DELIVERY_RETRY_MS', 120_000),
  DELIVERY_MAX_ATTEMPTS: int('DELIVERY_MAX_ATTEMPTS', 5),

  /** Firebase。没配就走不了 FCM，Android 设备会一直排队到超时 */
  FCM_PROJECT_ID: str('FCM_PROJECT_ID', ''),
  FCM_CLIENT_EMAIL: str('FCM_CLIENT_EMAIL', ''),
  FCM_PRIVATE_KEY: str('FCM_PRIVATE_KEY', ''),

  /** MCP 的独立 token。不配就复用登录 token */
  MCP_TOKEN: str('MCP_TOKEN', ''),

  LOG_LEVEL: str('LOG_LEVEL', 'info'),
};

export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** 口令比较用定长比较，避免通过响应时间猜口令 */
export function passcodeMatches(input: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(env.PASSCODE);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
