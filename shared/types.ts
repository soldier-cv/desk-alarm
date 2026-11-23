/**
 * 前后端共享契约。服务端与客户端都从这里 import。
 * 这是 agent-first 推进引擎的领域模型，改动这里等于改接口，两端同时编译才能发现不一致。
 */

/* ============================================================ 身份（沿用） */

export type Platform = 'windows' | 'android' | 'ios' | 'mac' | 'linux' | 'web';
export type Role = 'admin' | 'user';
export type AgentScope = 'read' | 'write';

export interface User {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  createdAt: number;
}

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

export interface Device {
  id: string;
  name: string;
  platform: Platform;
  isSelf: boolean;
  transport: TransportName;
  pushEnabled: boolean;
  online: boolean;
  lastIp: string | null;
  lastSeenAt: number;
  createdAt: number;
}

/* ============================================================ 推进项领域模型 */

/**
 * 推进项的性质。project 指有多个步骤、需要跨天推进的事；one_off 是一次性；
 * recurring 是周期性的。它决定引擎用哪条循环处理。
 */
export type PursuitNature = 'one_off' | 'recurring' | 'project';

/** 显式重要性，不靠措辞猜。3 = 最高，由用户或 agent 标记 */
export type Importance = 0 | 1 | 2 | 3;

/** 启动所需精力。引擎用它匹配用户当前状态（情境闸门） */
export type Energy = 'low' | 'medium' | 'high';

export type PursuitStatus = 'inbox' | 'active' | 'paused' | 'done' | 'archived';
export type StepState = 'todo' | 'doing' | 'done';

/**
 * 跟进动作。这是用户/agent 对一次跟催的回答，会实时改写后续策略。
 * later=改天、smaller=拆小、archive=不要了、partial=推了一点、ignored=没理。
 */
export type FollowupAction = 'done' | 'partial' | 'later' | 'smaller' | 'archive' | 'ignored';

/** 打扰等级。L1 静默 → L5 归档，连续谱替代旧的强/弱二分 */
export type NudgeLevel = 1 | 2 | 3 | 4 | 5;
export type NudgeChannel = 'in_app' | 'notification' | 'takeover';

export type EntryKind = 'text' | 'link' | 'path' | 'image' | 'audio';

/**
 * 通用重复规则。interval 配合 freq 表达「每 3 天」「每 2 周」。
 * byWeekday 0=周日…6=周六；byMonthday 1..31（月末钳位在引擎里做）。
 */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'workdays' | 'interval';
  interval?: number;
  byWeekday?: number[];
  byMonthday?: number;
  byMonth?: number;
  /** 农历/节气等扩展留空位，先不实现语义 */
  calendar?: 'lunar' | 'solar';
}

/** 触发情境。命中时才推，未命中则攒到合适时机 */
export interface PursuitContext {
  timeWindow?: { startMin: number; endMin: number };
  place?: string;
  device?: string;
  calendarEvent?: string;
}

export interface Commitment {
  date?: number;
  public?: boolean;
  partner?: string;
}

export interface Pursuit {
  id: string;
  userId: string;
  text: string;
  note: string | null;
  kind: EntryKind;
  url: string | null;
  path: string | null;

  nature: PursuitNature;
  importance: Importance;
  energy: Energy;
  dueAt: number | null;
  recurrence: RecurrenceRule | null;
  context: PursuitContext | null;
  commitment: Commitment | null;

  status: PursuitStatus;
  importanceSort: number;
  /** 乐观锁版本。写请求必须带回，否则服务端拒绝 */
  version: number;

  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  lastActivityAt: number;

  /** 派生量，读时算，不入库 */
  progress: number;
  stalenessMs: number;
  weight: number;
  steps: Step[];
  deviceIds: string[];
  source: 'app' | 'mcp';
}

export interface Step {
  id: string;
  pursuitId: string;
  text: string;
  position: number;
  state: StepState;
  doneAt: number | null;
  createdAt: number;
}

export interface Followup {
  id: number;
  pursuitId: string;
  userId: string;
  at: number;
  level: NudgeLevel;
  action: FollowupAction;
  note: string | null;
}

export interface Nudge {
  id: number;
  pursuitId: string;
  userId: string;
  at: number;
  level: NudgeLevel;
  channel: NudgeChannel;
  reason: string;
}

/* ============================================================ 引擎读模型 */

/** 今日聚焦里的一项：推进项 + 引擎给出的理由 */
export interface FocusItem {
  pursuit: Pursuit;
  reason: string;
  suggestedNextStep: string | null;
}

export interface FocusResult {
  serverTs: number;
  items: FocusItem[];
  /** 今天还剩多少次强打扰额度 */
  budgetLeft: number;
}

/** 跟进入口：引擎对一条停滞项给出的下一步动作建议 */
export interface FollowupPrompt {
  pursuit: Pursuit;
  level: NudgeLevel;
  question: string;
  actions: FollowupAction[];
}

/* ============================================================ 设置 */

export interface Settings {
  /** 每天 L4/L5 强打扰上限。配额制从根上避免全都喊 */
  dailyStrongBudget: number;
  /** 各等级的触发阈值（停滞毫秒数），索引 0 对应 L2 */
  escalateAfterMs: { l2: number; l3: number; l4: number; l5: number };
  /** 静音时段，分钟数，跨零点时 end < start */
  quietStartMin: number;
  quietEndMin: number;
  /** 每天聚焦推送的本地时刻（分钟） */
  focusAtMin: number;
  sound: 'system' | 'custom' | 'none';
}

/* ============================================================ 统计（看板 → 推进反馈） */

export interface MyStats {
  serverTs: number;
  /** 本周推进完成数，替代旧的准时率 */
  completedThisWeek: number;
  /** 当前连续推进天数，断了可以修复不清零 */
  streakDays: number;
  /** 今日：聚焦数、完成数、待跟进数 */
  today: { focus: number; done: number; pendingFollowup: number };
  days: Array<{ day: string; focus: number; done: number; pending: number }>;
  /** 各性质推进项数量 */
  byNature: Record<PursuitNature, number>;
}

/* ============================================================ HTTP */

export interface CreatePursuitRequest {
  text: string;
  kind?: EntryKind;
  url?: string | null;
  path?: string | null;
  note?: string | null;
  nature?: PursuitNature;
  importance?: Importance;
  energy?: Energy;
  dueAt?: number | string | null;
  recurrence?: RecurrenceRule | null;
  context?: PursuitContext | null;
  commitment?: Commitment | null;
  status?: PursuitStatus;
  steps?: string[];
  deviceIds?: string[];
}

export interface UpdatePursuitRequest {
  text?: string;
  note?: string | null;
  importance?: Importance;
  energy?: Energy;
  nature?: PursuitNature;
  dueAt?: number | string | null;
  recurrence?: RecurrenceRule | null;
  context?: PursuitContext | null;
  commitment?: Commitment | null;
  status?: PursuitStatus;
  deviceIds?: string[];
  version: number;
}

export interface AddStepRequest { text: string }
export interface UpdateStepRequest { text?: string; state?: StepState }

export interface FollowupRequest {
  action: FollowupAction;
  note?: string;
  /** later 时给的新时间；smaller 时可带 agent 拆好的步骤 */
  to?: number | string;
  steps?: string[];
  version: number;
}

export interface ApiError {
  error: string;
  message: string;
  current?: Pursuit;
}

/* ============================================================ WebSocket */

export type ClientMessage =
  | { t: 'ping'; at: number }
  | { t: 'pursuit.followup'; pursuitId: string; action: FollowupAction; note?: string; at: number; version: number }
  | { t: 'pursuit.step'; stepId: string; state: StepState; at: number };

export type TransportName = 'ws';

export type ServerMessage =
  | { t: 'welcome'; serverTs: number; deviceId: string; settings: Settings; missed: Nudge[] }
  | { t: 'pong'; at: number }
  | { t: 'devices.changed'; devices: Device[] }
  | { t: 'pursuit.created'; pursuit: Pursuit }
  | { t: 'pursuit.updated'; pursuit: Pursuit }
  | { t: 'pursuit.deleted'; pursuitId: string }
  | { t: 'pursuit.focused'; items: FocusItem[]; budgetLeft: number }
  | { t: 'pursuit.nudge'; pursuit: Pursuit; level: NudgeLevel; channel: NudgeChannel; reason: string; serverTs: number }
  | { t: 'pursuit.stepped'; pursuit: Pursuit }
  | { t: 'pursuit.followed'; pursuit: Pursuit; action: FollowupAction }
  | { t: 'settings.changed'; settings: Settings };

/* ============================================================ 登录契约（沿用） */

export interface LoginRequest {
  username: string;
  password: string;
  deviceName: string;
  platform: Platform;
  machineId?: string;
  transport?: TransportName;
  pushToken?: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  device: Device | null;
}

export interface Overview {
  serverTs: number;
  uptimeMs: number;
  db: { ok: boolean };
  engine: {
    tickMs: number;
    ticks: number;
    lastTickAt: number | null;
    active: number;
    stalled: number;
  };
  pursuits: Record<PursuitStatus, number>;
  nudgesToday: Record<NudgeLevel, number>;
  devices: { total: number; online: number; byPlatform: Record<string, number> };
  users: { total: number };
}
