/**
 * 前后端共享契约。服务端与客户端都从这里 import。
 * 改动这里等于改接口，两端同时编译才能发现不一致。
 */

export type EntryKind = 'text' | 'link' | 'path';
export type EntryStatus = 'inbox' | 'pending' | 'done' | 'missed';
export type RepeatRule = 'none' | 'daily' | 'weekly' | 'monthly';
export type Platform = 'windows' | 'android' | 'ios' | 'mac' | 'linux' | 'web';

export type Role = 'admin' | 'user';

export type AgentScope = 'read' | 'write';

export interface AgentToken {
  id: string;
  name: string;
  prefix: string;
  scope: AgentScope;
  machineId: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface User {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  hasPin: boolean;
  createdAt: number;
}

/**
 * 提醒强度。
 *
 * strong 走全屏接管，关不掉，会重复响
 * weak   只出通知和细横幅，点一下就展开，可以「忽略」并写理由
 *
 * 全都在喊等于全都听不见，所以默认不强。
 */
export type Strength = 'weak' | 'strong';

/** 确认动作。任何一台设备确认后，全部设备立刻停铃。 */
export type AckAction = 'done' | 'snooze' | 'silence';

/** 弱提示的「忽略」。和 done 分开记，这是整套设计的关键。 */
export type DismissAction = 'dismiss';

export type TransportName = 'ws';

export interface Entry {
  id: string;
  text: string;
  kind: EntryKind;
  url: string | null;
  path: string | null;
  note: string | null;
  /** epoch ms，null 表示不定时，留在收集箱 */
  remindAt: number | null;
  repeat: RepeatRule;
  status: EntryStatus;
  strength: Strength;
  /** 静音时段也照响。服药这类硬提醒才开 */
  bypassQuiet: boolean;
  /** @deprecated 老客户端字段，等价于 bypassQuiet */
  hard: boolean;
  /**
   * 服务端唯一权威的触发时刻。null 表示还没响过。
   * 客户端本地预判提前响，但以这个字段为准做最终校正。
   */
  firedAt: number | null;
  doneAt: number | null;
  /** 在哪台设备上完成的，用于跨端去重展示 */
  doneDevice: string | null;
  snoozeCount: number;
  /** 被弱提示忽略过几次。>=2 会自动降级，>=3 会提示该删了 */
  dismissCount: number;
  /** app=客户端建的，mcp=agent 建的 */
  source: 'app' | 'mcp';
  /** 推送范围。['*'] 表示全部在线设备 */
  devices: string[];
  /** 乐观锁，改动时带上，服务端发现版本落后就拒绝 */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** 弱提示被忽略的记录 */
export interface Dismissal {
  id: number;
  entryId: string;
  deviceId: string;
  deviceName: string;
  /** 用户写的理由。空字符串表示没写 */
  reason: string | null;
  at: number;
  /** 冗余带上原文，省一次查表 */
  text?: string;
}

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  /** 是否是本机 */
  isSelf: boolean;
  /** 这台设备走哪条投递通道 */
  transport: TransportName;
  pushEnabled: boolean;
  online: boolean;
  /** 有没有配好推送凭据。Android 上没配 token 就等于收不到 */
  pushReady: boolean;
  locked: boolean;
  lockReason: 'manual' | 'system' | null;
  /** 最近一次登录的 IP，只在本人设备列表展示 */
  lastIp: string | null;
  lastSeenAt: number;
  createdAt: number;
}

export interface Settings {
  /** 首次提示后多久升级为全屏接管（秒）。weak 强度不升级 */
  escalateAfterSec: number;
  /** 重复提醒间隔（秒），0 表示不重复 */
  repeatEverySec: number;
  /** 静音时段，分钟数。跨零点时 end < start */
  quietStartMin: number;
  quietEndMin: number;
  sound: 'system' | 'custom' | 'none';
  /** 被忽略几次后自动降级为弱提示 */
  autoDowngradeAfter: number;
  /** 提醒被忽略几次后，界面上提示该删了 */
  neglectedAfter: number;
}

/* ================= HTTP ================= */

export interface LoginRequest {
  username: string;
  password: string;
  deviceName: string;
  platform: Platform;
  /** OS 级 machine-id，不可变。Web 端不传，服务端就不建设备行 */
  machineId?: string;
  transport?: TransportName;
  /** 兼容旧客户端上报的推送 token，当前版本不使用 */
  pushToken?: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  device: Device | null;
}

/** 我的看板：按单用户数据算，admin 看板另走 /admin/overview */
export interface EntryCounts {
  today: number;
  up: number;
  inbox: number;
  all: number;
  done: number;
  missed: number;
  dismissed: number;
}

export interface MyStats {
  streakDays: number;
  today: { due: number; done: number; missed: number };
  week: { due: number; onTime: number; rate: number };
  dismissed: number;
  days: Array<{ day: string; due: number; done: number; missed: number }>;
}

export interface CreateEntryRequest {
  text: string;
  kind?: EntryKind;
  url?: string | null;
  path?: string | null;
  note?: string | null;
  /** ISO 字符串或 epoch ms，null 表示不定时 */
  remindAt?: number | string | null;
  repeat?: RepeatRule;
  strength?: Strength;
  bypassQuiet?: boolean;
  devices?: string[];
}

export interface UpdateEntryRequest {
  text?: string;
  note?: string | null;
  remindAt?: number | string | null;
  repeat?: RepeatRule;
  strength?: Strength;
  bypassQuiet?: boolean;
  devices?: string[];
  version: number;
}

export interface SnoozeRequest {
  /** 相对分钟数，或给绝对时刻 */
  minutes?: number;
  to?: number | string;
}

export interface DismissRequest {
  reason?: string;
}

export interface ApiError {
  error: string;
  message: string;
  current?: Entry;
}

/* ================= WebSocket ================= */

export type ClientMessage =
  | { t: 'ping'; at: number }
  | { t: 'entry.ack'; entryId: string; action: AckAction; at: number; snoozeTo?: number }
  | { t: 'entry.dismiss'; entryId: string; reason?: string; at: number }
  | { t: 'entry.ping'; entryId: string; at: number };

export type ServerMessage =
  | { t: 'welcome'; serverTs: number; deviceId: string; missed: MissedFire[]; settings: Settings }
  | { t: 'pong'; at: number }
  | { t: 'entry.created'; entry: Entry }
  | { t: 'entry.updated'; entry: Entry }
  | { t: 'entry.deleted'; entryId: string }
  /** 到点了，该响铃。serverTs 是服务端的权威时刻，客户端用它校正本地时钟偏差。 */
  | {
      t: 'entry.fired';
      entry: Entry;
      serverTs: number;
      repeat: RepeatRule;
      strength: Strength;
      /** 投递通道，目前只有 ws */
      transport: TransportName;
    }
  /** 弱提示。客户端只弹横幅，不进接管窗口 */
  | { t: 'entry.weak'; entry: Entry; serverTs: number }
  /** 别的设备已经处理过了，立刻停铃，不要再响 */
  | {
      t: 'entry.acked';
      entryId: string;
      deviceId: string;
      deviceName: string;
      action: AckAction | DismissAction;
    }
  | { t: 'entry.downgraded'; entry: Entry; dismissCount: number; reason: string }
  | { t: 'devices.changed'; devices: Device[] }
  | { t: 'settings.changed'; settings: Settings };

/** 客户端上线时补发的漏掉的提醒 */
export interface MissedFire {
  entry: Entry;
  firedAt: number;
  /** firedAt 与现在相差多少毫秒 */
  lateByMs: number;
}

/* ================= 开发看板 ================= */

export interface Overview {
  serverTs: number;
  uptimeMs: number;
  db: { ok: boolean };
  scheduler: {
    tickMs: number;
    rotateMs: number;
    ticks: number;
    lastTickAt: number | null;
    lastRotateAt: number | null;
    rotating: boolean;
  };
  entries: {
    total: number;
    pending: number;
    missed: number;
    inbox: number;
    done: number;
    neglected: number;
  };
  deliveries: {
    byState: Record<string, number>;
    byTransport: Record<string, number>;
    recentErrors: Array<{ entryId: string; deviceId: string; error: string; at: number }>;
  };
  devices: { total: number; online: number; byPlatform: Record<string, number> };
  users: { total: number };
}
