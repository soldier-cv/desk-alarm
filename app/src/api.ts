/**
 * 客户端与服务端的通信层。HTTP 负责增删改，WS 只送触发与跨端广播。
 * 领域操作全部走服务端引擎，本地不判断「该不该响」。
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AddStepRequest, AgentScope, AgentToken, CreatePursuitRequest, Device, Followup,
  FollowupAction, FollowupRequest, FocusResult, Importance, LoginResponse, MyStats,
  NudgeLevel, Overview, Pursuit, PursuitStatus, Role, ServerMessage, Settings, Step, StepState,
  UpdatePursuitRequest, UpdateStepRequest, User,
} from '../../shared/types';

export type {
  AddStepRequest, AgentScope, AgentToken, ClientMessage, Commitment, CreatePursuitRequest,
  Device, Energy, EntryKind, Followup, FollowupAction, FollowupPrompt, FollowupRequest,
  FocusItem, FocusResult, Importance, LoginResponse, MyStats, Nudge, NudgeChannel,
  NudgeLevel, Overview, Platform, Pursuit, PursuitContext, PursuitNature, PursuitStatus,
  ReminderStrength,
  RecurrenceRule, Role, ServerMessage, Settings, Step, StepState, TransportName,
  UpdatePursuitRequest, UpdateStepRequest, User,
} from '../../shared/types';

export {
  importanceForStrength, levelForStrength, strengthOfImportance, strengthOfLevel,
} from '../../shared/types';

export type PursuitView = 'today' | 'all' | 'inbox' | 'done' | 'archived';
export type Urgency = 'none' | 'soon' | 'close' | 'due' | 'over';

export interface CountsResult {
  counts: Partial<Record<PursuitStatus, number>>;
  pendingFollowup: number;
}

const LS_KEY = 'deskalarm.config';

let skewCache: number | null = null;
let machineIdCache: string | null = null;
let platformCache: ClientPlatform | null = null;

export type ClientPlatform = 'web' | 'windows' | 'macos' | 'linux' | 'android';

function inTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

export async function getPlatform(): Promise<ClientPlatform> {
  if (platformCache !== null) return platformCache;
  if (!inTauri()) return (platformCache = 'web');
  try {
    const p = await invoke<string>('platform');
    platformCache = (p === 'windows' || p === 'macos' || p === 'linux' || p === 'android') ? p : 'web';
  } catch {
    platformCache = 'web';
  }
  return platformCache;
}

export async function getMachineId(): Promise<string> {
  if (!inTauri()) return '';
  if (machineIdCache !== null) return machineIdCache;
  try {
    machineIdCache = (await invoke<string>('machine_id')) ?? '';
  } catch {
    machineIdCache = '';
  }
  return machineIdCache;
}

export interface Config {
  baseUrl: string;
  user: User | null;
  deviceName: string;
  token: string;
  device: Device | null;
  deviceId: string;
  serverSkewMs: number;
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  archiveAfterDays: 30,
  quietStartMin: 23 * 60 + 30,
  quietEndMin: 7 * 60,
  focusAtMin: 9 * 60,
  sound: 'system',
};

export const DEFAULT_CONFIG: Config = {
  baseUrl: '',
  user: null,
  deviceName: '我的笔记本',
  token: '',
  device: null,
  deviceId: '',
  serverSkewMs: 0,
  settings: DEFAULT_SETTINGS,
};

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<Config>;
    const s: Partial<Settings> = parsed.settings ?? {};
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      settings: { ...DEFAULT_SETTINGS, ...s },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(c: Partial<Config>): Config {
  const next = { ...loadConfig(), ...c };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  if (c.serverSkewMs !== undefined) skewCache = c.serverSkewMs;
  return next;
}

/**
 * 有 scheme 的交给 URL 解析，不能补 http://：
 * 否则 ftp://x.com 会被补成 http://ftp，scheme 注入就进来了
 */
export function normalizeBaseUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `http://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (!u.hostname) return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export function switchServer(baseUrl: string) {
  saveConfig({ baseUrl, token: '', user: null, device: null, deviceId: '', serverSkewMs: 0 });
}

export async function probeServer(baseUrl: string): Promise<{ ok: boolean; reason: string; skewMs: number }> {
  const norm = normalizeBaseUrl(baseUrl);
  if (!norm) return { ok: false, reason: '地址格式不对，需要 http:// 或 https:// 开头', skewMs: 0 };
  // AbortSignal.timeout 在旧安卓 WebView 上没有，手动建 controller 才不会误报「连不上」
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const started = Date.now();
    const r = await fetch(`${norm}/healthz`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, reason: `服务端返回 ${r.status}`, skewMs: 0 };
    const j = await r.json();
    if (!j?.ok) return { ok: false, reason: '那个地址上没有 DeskAlarm 服务', skewMs: 0 };
    return { ok: true, reason: '', skewMs: j.serverTs - (Date.now() + (Date.now() - started) / 2) };
  } catch (e) {
    const timedOut = ctrl.signal.aborted || (e instanceof Error && e.name === 'AbortError');
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: timedOut ? '连接超时，确认手机和服务端在同一网络' : `连不上：${detail}`, skewMs: 0 };
  } finally {
    clearTimeout(timer);
  }
}

export function clearToken() {
  saveConfig({ token: '', user: null, device: null, deviceId: '' });
}

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;
let unauthorizedFired = false;

export function onUnauthorized(fn: UnauthorizedHandler) { unauthorizedHandler = fn; }
function resetUnauthorized() { unauthorizedFired = false; }

export function serverNow(): number {
  if (skewCache === null) skewCache = loadConfig().serverSkewMs;
  return Date.now() + skewCache;
}

/* ---------------------------------------------------------------- HTTP */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public current?: Pursuit) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cfg = loadConfig();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, { ...init, headers });
  const text = await res.text();
  let json: { error?: string; message?: string; current?: Pursuit } = {};
  if (text) {
    try { json = JSON.parse(text); } catch { /* 网关的 HTML 错误页不是 JSON */ }
  }
  if (!res.ok) {
    if (res.status === 401 && cfg.token && json.error === 'UNAUTHORIZED') {
      clearToken();
      if (!unauthorizedFired) {
        unauthorizedFired = true;
        unauthorizedHandler?.();
      }
    }
    throw new ApiError(res.status, json.error ?? 'UNKNOWN', json.message ?? res.statusText, json.current);
  }
  return json as T;
}

/** 写请求必须带回乐观锁版本，统一从这里取，避免各处手抄字段 */
export function versionOf(p: Pursuit): number {
  return p.version;
}

/** 服务端还没有跟进历史路由，会话内先记住本机做过的和广播收到的动作 */
const followupLog = new Map<string, Followup[]>();

export function noteFollowup(pursuitId: string, action: FollowupAction, level: NudgeLevel = 2, note: string | null = null) {
  const list = followupLog.get(pursuitId) ?? [];
  // 本机动作会收到服务端广播，同一个动作记两次只会让历史变吵
  if (list[0] && list[0].action === action && serverNow() - list[0].at < 2000) return;
  list.unshift({
    id: -Date.now(), pursuitId, userId: loadConfig().user?.id ?? '',
    at: serverNow(), level, action, note,
  });
  followupLog.set(pursuitId, list.slice(0, 50));
}

export function cachedFollowups(pursuitId: string): Followup[] {
  return [...(followupLog.get(pursuitId) ?? [])];
}

export const api = {
  setupStatus: () => req<{ needed: boolean }>('/setup/status'),

  setup: (body: { username: string; password: string; confirmPassword: string; machineId?: string }) =>
    req<LoginResponse>('/setup', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => { resetUnauthorized(); return r; }),

  login: async (username: string, password: string, deviceName: string, platform: string = 'windows') => {
    const machineId = await getMachineId();
    const r = await req<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username, password, deviceName, platform, machineId, transport: 'ws',
      }),
    });
    resetUnauthorized();
    saveConfig({ user: r.user });
    return r;
  },

  focus: () => req<FocusResult>('/focus'),

  pursuits: (view: PursuitView) => {
    const status = view === 'today' ? 'active' : view === 'all' ? '' : view;
    return req<{ pursuits: Pursuit[] }>(`/pursuits${status ? `?status=${status}` : ''}`);
  },

  /** 服务端没有独立的 counts 路由，侧栏数字直接从全量列表算 */
  counts: async (): Promise<CountsResult> => {
    const { pursuits } = await req<{ pursuits: Pursuit[] }>('/pursuits');
    const counts: Partial<Record<PursuitStatus, number>> = {};
    for (const p of pursuits) counts[p.status] = (counts[p.status] ?? 0) + 1;
    return { counts, pendingFollowup: 0 };
  },

  create: (body: CreatePursuitRequest) =>
    req<{ pursuit: Pursuit }>('/pursuits', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: UpdatePursuitRequest) =>
    req<{ pursuit: Pursuit }>(`/pursuits/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  followup: (id: string, body: FollowupRequest) =>
    req<{ pursuit: Pursuit }>(`/pursuits/${id}/followup`, { method: 'POST', body: JSON.stringify(body) }),

  addStep: (id: string, body: AddStepRequest) =>
    req<{ step: Step; pursuit: Pursuit }>(`/pursuits/${id}/steps`, { method: 'POST', body: JSON.stringify(body) }),

  updateStep: (id: string, body: UpdateStepRequest) =>
    req<{ step: Step; pursuit: Pursuit }>(`/steps/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  /** 服务端暂未暴露跟进历史路由；拿不到时退回会话内记录 */
  followups: (id: string) => req<{ followups: Followup[] }>(`/pursuits/${id}/followups`)
    .catch(() => ({ followups: cachedFollowups(id) })),

  settings: () => req<{ settings: Settings }>('/settings'),

  patchSettings: (p: Partial<Settings>) =>
    req<{ settings: Settings }>('/settings', { method: 'PATCH', body: JSON.stringify(p) }),

  myStats: () => req<MyStats>('/stats/me'),

  devices: () => req<{ devices: Device[] }>('/devices'),

  pingDevice: (id: string) => req<{ ok: boolean; via?: string; error?: string }>(
    `/devices/${id}/ping`, { method: 'POST' }),

  setPushEnabled: (id: string, pushEnabled: boolean) =>
    req<{ device: Device }>(`/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ pushEnabled }) }),

  agentTokens: () => req<{ tokens: AgentToken[] }>('/agent-tokens'),

  issueAgentToken: (body: { name: string; machineId?: string; scope?: AgentScope; days?: number }) =>
    req<{ token: AgentToken; plain: string }>('/agent-tokens', { method: 'POST', body: JSON.stringify(body) }),

  revokeAgentToken: (id: string) => req<{ ok: true }>(`/agent-tokens/${id}`, { method: 'DELETE' }),

  users: () => req<{ users: User[] }>('/admin/users'),

  createUser: (body: { username: string; password: string; confirmPassword: string }) =>
    req<{ user: User }>('/admin/users', { method: 'POST', body: JSON.stringify(body) }),

  updateUser: (id: string, body: { role?: Role; disabled?: boolean; password?: string }) =>
    req<{ user: User }>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  deleteUser: (id: string) => req<{ ok: true }>(`/admin/users/${id}`, { method: 'DELETE' }),

  overview: () => req<Overview>('/admin/overview'),
};

/* -------------------------------------------------------- WebSocket */

type Handler = (msg: ServerMessage) => void;
type StatusHandler = (state: 'connecting' | 'open' | 'closed') => void;

export class Realtime {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private hbTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;

  constructor(private onMessage: Handler, private onStatus: StatusHandler) {}

  connect() {
    const cfg = loadConfig();
    if (!cfg.token) return;
    if (!cfg.device) return;
    this.closed = false;
    this.onStatus('connecting');

    const wsUrl = `${cfg.baseUrl.replace(/^http/, 'ws')}/api/v1/stream?token=${encodeURIComponent(cfg.token)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 1000;
      this.onStatus('open');
      this.hbTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'ping', at: Date.now() }));
      }, 20_000);
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'welcome') {
        saveConfig({
          serverSkewMs: msg.serverTs - Date.now(),
          deviceId: msg.deviceId,
          settings: { ...loadConfig().settings, ...msg.settings },
        });
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      this.onStatus('closed');
      this.clearTimers();
      if (this.closed) return;
      const wait = Math.min(this.backoff, 30_000);
      this.backoff *= 2;
      this.reconnectTimer = window.setTimeout(() => this.connect(), wait);
    };

    ws.onerror = () => ws.close();
  }

  /** 跟进动作走 WS，让正在接管的设备立刻收起来 */
  followup(pursuitId: string, action: FollowupAction, version: number, note?: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({
      t: 'pursuit.followup', pursuitId, action, note, at: Date.now(), version,
    }));
    return true;
  }

  step(stepId: string, state: StepState): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: 'pursuit.step', stepId, state, at: Date.now() }));
    return true;
  }

  private clearTimers() {
    if (this.hbTimer !== null) { clearInterval(this.hbTimer); this.hbTimer = null; }
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  close() {
    this.closed = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }
}

/* ------------------------------------------------------------ 解析 */

export interface Parsed {
  kind: 'text' | 'link' | 'path';
  kindLabel: string;
  remindAt: number | null;
  timeLabel: string;
  /** 解析结果只给默认值，强弱由用户在捕获窗直接选 */
  strength: 'strong' | 'weak';
}

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function cnNumber(s: string): number | null {
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  if (s === '两') return 2;
  if (s === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGIT[s[1]];
  if (/^[二三四五六七八九]十$/.test(s)) return CN_DIGIT[s[0]] * 10;
  if (/^[二三四五六七八九]十[一二三四五六七八九]$/.test(s)) {
    return CN_DIGIT[s[0]] * 10 + CN_DIGIT[s[2]];
  }
  return CN_DIGIT[s] ?? null;
}

export function parseInput(raw: string, now = serverNow()): Parsed {
  const s = raw.trim();
  const out: Parsed = {
    kind: 'text', kindLabel: '普通文本',
    remindAt: null, timeLabel: '没有时间，进收集箱',
    strength: 'weak',
  };
  if (!s) return out;

  if (/^(https?:\/\/|www\.)\S+/i.test(s)) { out.kind = 'link'; out.kindLabel = '链接'; }
  else if (/^[a-zA-Z]:\\|^\/\//.test(s)) { out.kind = 'path'; out.kindLabel = '目录路径'; }

  const explicit = /(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?)?/g;
  const shortDate = /(?:^|[^\d])(\d{1,2})[-/月.](\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?)?/g;
  const pickDate = (pattern: RegExp, withYear: boolean) => {
    let past: Date | null = null;
    for (const m of s.matchAll(pattern)) {
      const y = withYear ? Number(m[1]) : new Date(now).getFullYear();
      const d = new Date(y, Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), 0, 0);
      if (d.getTime() > now) return d;
      if (!past || d.getTime() > past.getTime()) past = d;
    }
    return past;
  };
  const dated = pickDate(explicit, true) ?? pickDate(shortDate, false);
  const rel = s.match(/(半|\d+|[零〇一二两三四五六七八九十]+)\s*(分钟|分|小时|时|钟头)\s*(之?后)?/);
  const abs = s.match(/(今天|明天|后天|大后天|周[一二三四五六日天])[^\d]{0,4}(\d{1,2})\s*[:：点]\s*(\d{2})?/);
  const clock = s.match(/^\s*(\d{1,2})[:：](\d{2})\s*$/);

  if (dated) {
    const p = (n: number) => String(n).padStart(2, '0');
    out.remindAt = dated.getTime();
    out.timeLabel = `${dated.getFullYear()}-${p(dated.getMonth() + 1)}-${p(dated.getDate())} ${p(dated.getHours())}:${p(dated.getMinutes())}`;
  } else if (rel) {
    const raw = cnNumber(rel[1]) ?? NaN;
    const unitIsHour = /小时|时|钟头/.test(rel[2]);
    const mins = Math.round(raw * (unitIsHour ? 60 : 1));
    out.remindAt = now + mins * 60_000;
    out.timeLabel = mins >= 60 ? `${(mins / 60).toFixed(mins % 60 ? 1 : 0)} 小时后` : `${mins} 分钟后`;
  } else if (abs) {
    const d = new Date(now);
    const dayWord = abs[1];
    if (dayWord === '明天') d.setDate(d.getDate() + 1);
    else if (dayWord === '后天') d.setDate(d.getDate() + 2);
    else if (dayWord === '大后天') d.setDate(d.getDate() + 3);
    else if (dayWord.startsWith('周')) {
      const map: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
      const want = map[dayWord[1]] ?? 0;
      let delta = want - d.getDay();
      if (delta <= 0) delta += 7;
      d.setDate(d.getDate() + delta);
    }
    d.setHours(Number(abs[2]), Number(abs[3] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    out.remindAt = d.getTime();
    out.timeLabel = `${dayWord} ${String(abs[2]).padStart(2, '0')}:${String(abs[3] ?? '00').padStart(2, '0')}`;
  } else if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    out.remindAt = d.getTime();
    out.timeLabel = `今天 ${clock[1]}:${clock[2]}`;
  }

  // 强弱由用户直接选，不由措辞推断；没填时间由服务端按最终选的强弱补默认值
  if (out.remindAt === null) out.timeLabel = '没填时间，按提醒类型给默认值';
  return out;
}

/* ---------------------------------------------------------- 展示工具 */

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export function hhmm(ts: number | null): string {
  if (ts === null) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function dayLabel(ts: number | null): string {
  if (ts === null) return '';
  const now = new Date(serverNow());
  const d = new Date(ts);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, now)) return '今天';
  if (same(d, new Date(now.getTime() + 86400_000))) return '明天';
  if (same(d, new Date(now.getTime() + 2 * 86400_000))) return '后天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function lateBy(ts: number): string {
  const ms = serverNow() - ts;
  if (ms < 0) return '';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚过';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

/** 截止与停滞共同决定「暖度」。安静是常态，只有逾期或久滞才上色 */
export function warmthOf(p: Pursuit, now = serverNow()): Urgency {
  if (p.status === 'done' || p.status === 'archived') return 'none';
  if (p.dueAt !== null) {
    const ms = p.dueAt - now;
    if (ms <= 0) return 'over';
    if (ms <= 15 * 60_000) return 'due';
    if (ms <= 60 * 60_000) return 'close';
    if (ms <= 24 * 60 * 60_000) return 'soon';
  }
  return 'none';
}

export function dueLabel(p: Pursuit): string {
  if (p.dueAt === null) return '没有截止';
  if (p.dueAt <= serverNow()) return `逾期 ${lateBy(p.dueAt)}`;
  return `${dayLabel(p.dueAt)} ${hhmm(p.dueAt)}`;
}

export function staleLabel(p: Pursuit): string {
  const ms = Math.max(0, serverNow() - p.lastActivityAt);
  if (ms < 60_000) return '刚刚推进过';
  const h = ms / 3_600_000;
  if (h < 24) return `停滞 ${Math.floor(h)} 小时`;
  return `停滞 ${Math.floor(h / 24)} 天`;
}

export function inQuietHours(s: Settings, at = serverNow()): boolean {
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  const { quietStartMin: a, quietEndMin: b } = s;
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

export const NATURE_LABEL: Record<Pursuit['nature'], string> = {
  one_off: '一次性', recurring: '周期性', project: '项目',
};

export const ENERGY_LABEL: Record<Pursuit['energy'], string> = {
  low: '低', medium: '中', high: '高',
};

export const FOLLOWUP_ACTION_LABEL: Record<FollowupAction, string> = {
  done: '完成', partial: '推了一点（未完成）', later: '延期',
  smaller: '拆小', archive: '归档', ignored: '忽略',
};

/** 用户常用逗号分隔，别让多个步骤挤成一条 */
export function parseSteps(value: string): string[] {
  return value.split(/\r?\n|[,，;；]/).map((s) => s.trim()).filter(Boolean);
}
