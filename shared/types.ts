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
 * 推进项的性质。是否重复完全由 recurrence 决定，不再用 nature 表达。
 */
export type PursuitNature = 'one_off' | 'project';

/** 重要性：3=P0 最高，2=P1，1=P2 默认 */
export type Importance = 1 | 2 | 3;

export type PursuitStatus = 'inbox' | 'active' | 'paused' | 'done' | 'archived';
export type StepState = 'todo' | 'doing' | 'done';

/**
 * 跟进动作。这是用户/agent 对一次跟催的回答，会实时改写后续策略。
 * later=延期、smaller=拆小、archive=归档、ignored=忽略；partial 只在历史记录里保留。
 */
export type FollowupAction = 'done' | 'later' | 'smaller' | 'archive' | 'reopen';

/** 提醒强弱。2=弱提醒（通知），4=强提醒（接管弹窗），不再有 L1/L3/L5 */
export type NudgeLevel = 2 | 4;
export type ReminderStrength = 'strong' | 'weak';
export type NudgeChannel = 'in_app' | 'notification' | 'takeover';

export const WEAK_LEVEL: NudgeLevel = 2;
export const STRONG_LEVEL: NudgeLevel = 4;

/** 星标 0/1 是弱提醒，2/3 是强提醒；措辞不参与判定 */
export function strengthOfImportance(i: Importance): ReminderStrength {
  return i >= 2 ? 'strong' : 'weak';
}

export function strengthOfLevel(level: NudgeLevel): ReminderStrength {
  return level === STRONG_LEVEL ? 'strong' : 'weak';
}

export function levelForStrength(strength: ReminderStrength): NudgeLevel {
  return strength === 'strong' ? STRONG_LEVEL : WEAK_LEVEL;
}

/** 兼容旧列：强提醒存 3，弱提醒存 0 */
export function importanceForStrength(strength: ReminderStrength): Importance {
  return strength === 'strong' ? 3 : 0;
}

/** 没填截止时间时的默认值：强 2 小时、弱 1 天 */
export function defaultDueMs(strength: ReminderStrength, now: number): number {
  return now + (strength === 'strong' ? 2 * 60 * 60_000 : 24 * 60 * 60_000);
}

export type EntryKind = 'text' | 'link' | 'path' | 'image' | 'audio';

/**
 * 重复规则。每个频率只带自己用得上的字段，避免「每天 + 每月几号」这类歧义。
 * byWeekday 0=周日…6=周六；byMonthday 1..31 月末钳位；byMonth 1..12。
 */
export interface RecurrenceRule {
  freq: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  byWeekday?: number[];
  byMonthday?: number;
  byMonth?: number;
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
  /** 提醒强弱；内部仍沿用 importance 列存储（0/1 弱、2/3 强），前端不再暴露重要性概念 */
  strength: ReminderStrength;
  importance: Importance;
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
}

/** 跟进入口：引擎对一条待办给出的下一步动作建议 */
export interface FollowupPrompt {
  pursuit: Pursuit;
  strength: ReminderStrength;
  question: string;
  actions: FollowupAction[];
}

/* ============================================================ 设置 */

export interface Settings {
  /** 截止过了多少天自动归档，强弱一视同仁 */
  archiveAfterDays: number;
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
  strength?: ReminderStrength;
  importance?: Importance;
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
  strength?: ReminderStrength;
  importance?: Importance;
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
  /** later 延期时给的新时间；smaller 拆小时可带 agent 拆好的步骤 */
  to?: number | string;
  steps?: string[];
  /** done 时只完成这一条步骤，还有未完成步骤则整条保持 active 并重排截止时间 */
  stepId?: string;
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
  | { t: 'pursuit.focused'; items: FocusItem[] }
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

/* ========================================================== 领域规则（前后端共用） */

/** 所有合法跟进动作。界面、服务端、Agent API、MCP 都从这里取，避免分叉 */
export const FOLLOWUP_ACTIONS: readonly FollowupAction[] = ['done', 'later', 'smaller', 'archive', 'reopen'];

/** 某状态下允许的动作。已完成只能撤回或归档；归档后没有任何跟进动作 */
export function actionsFor(status: PursuitStatus): FollowupAction[] {
  if (status === 'archived') return [];
  if (status === 'done') return ['archive', 'reopen'];
  return ['done', 'later', 'smaller', 'archive'];
}

export const P0: Importance = 3;

/** 一天内到期按 P0 排期；只派生、不写回用户配置 */
export function effectiveImportance(importance: Importance, dueAt: number | null, nowMs: number): Importance {
  if (dueAt !== null && dueAt - nowMs <= 24 * 3600_000) return Math.max(importance, P0) as Importance;
  return importance;
}
