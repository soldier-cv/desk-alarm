/**
 * 客户端与服务端的通信层。HTTP 走增删改，WS 收触发与跨端广播。
 * 触发权威在服务端，本地预判只让提示早一点出现，最终以 serverTs 为准
 */
import type {
  AckAction, CreateEntryRequest, Device, Dismissal, Entry, MissedFire,
  RepeatRule, ServerMessage, Settings, Strength, TransportName,
} from '../../shared/types';

export type { AckAction, Device, Dismissal, Entry, MissedFire, RepeatRule, ServerMessage, Settings, Strength, TransportName };

const LS_KEY = 'deskalarm.config';

export interface Config {
  baseUrl: string;
  passcode: string;
  deviceName: string;
  /** 设备指纹。服务端靠它判断是重连还是新设备 */
  deviceId: string;
  token: string;
  device: Device | null;
  /** 上次收到 welcome 的服务端时刻，用来算本机时钟偏差 */
  serverSkewMs: number;
  settings: Settings;
}

const DEFAULT_SETTINGS: Settings = {
  escalateAfterSec: 30,
  repeatEverySec: 120,
  quietStartMin: 23 * 60 + 30,
  quietEndMin: 7 * 60,
  sound: 'system',
  autoDowngradeAfter: 2,
  neglectedAfter: 3,
};

export const DEFAULT_CONFIG: Config = {
  baseUrl: 'http://127.0.0.1:8787',
  passcode: '',
  deviceName: '我的笔记本',
  deviceId: `dev_${Math.random().toString(36).slice(2, 14)}`,
  token: '',
  device: null,
  serverSkewMs: 0,
  settings: DEFAULT_SETTINGS,
};

export function loadConfig(): Config {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(c: Partial<Config>) {
  const next = { ...loadConfig(), ...c };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return next;
}

/**
 * 规范化用户填的服务端地址。容错：多余空格、漏协议、结尾斜杠。
 * CSP 是白名单，地址填错要在这里就被拒，而不是等到连不上
 */
export function normalizeBaseUrl(input: string): string {
  const s = input.trim();
  if (!s) return '';
  // 带 scheme 就原样交给 URL 解析，不能补 http://：
  // 否则 ftp://x.com 会被补成 http://ftp，scheme 注入就进来了
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

/** 换服务端地址。清掉旧会话：旧 token 对新地址无效 */
export function switchServer(baseUrl: string) {
  saveConfig({ baseUrl, token: '', device: null, serverSkewMs: 0 });
}

/** 探测地址是否真的是 DeskAlarm 服务端，顺便同步时钟偏差 */
export async function probeServer(baseUrl: string): Promise<{ ok: boolean; reason: string; skewMs: number }> {
  const norm = normalizeBaseUrl(baseUrl);
  if (!norm) return { ok: false, reason: '地址格式不对，需要 http:// 或 https:// 开头', skewMs: 0 };
  try {
    const started = Date.now();
    const r = await fetch(`${norm}/healthz`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return { ok: false, reason: `服务端返回 ${r.status}`, skewMs: 0 };
    const j = await r.json();
    if (!j?.ok) return { ok: false, reason: '那个地址上没有 DeskAlarm 服务', skewMs: 0 };
    // 单程时延的一半是估算，只用来让倒计时别差太多
    return { ok: true, reason: '', skewMs: j.serverTs - (Date.now() + (Date.now() - started) / 2) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error && e.name === 'TimeoutError' ? '连接超时' : '连不上', skewMs: 0 };
  }
}

export function clearToken() {
  saveConfig({ token: '', device: null });
}

/** 服务端权威时间。所有「到点了吗」的判断都用它，不用本机 Date.now() */
export function serverNow(): number {
  return Date.now() + loadConfig().serverSkewMs;
}

/* ---------------------------------------------------------------- HTTP */

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/**
 * content-type 只在真的有 body 时才带。
 * 服务端虽然容忍空 body，但带上也没意义，而且有些网关会拦
 */
async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cfg = loadConfig();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;

  const res = await fetch(`${cfg.baseUrl}/api/v1${path}`, { ...init, headers });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'UNKNOWN', json.message ?? res.statusText);
  return json as T;
}

export const api = {
  login: (passcode: string, deviceName: string, platform: string = 'windows') =>
    req<{ token: string; device: Device }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        passcode, deviceName, platform,
        deviceId: loadConfig().deviceId,
        transport: 'ws',
      }),
    }),

  entries: (view: string) => req<{ entries: Entry[]; dismissals?: Dismissal[] }>(`/entries?view=${view}`),

  dismissed: () => req<{ dismissals: Dismissal[] }>('/entries?view=dismissed'),

  neglected: () => req<{ entries: Entry[] }>('/neglected'),

  create: (body: CreateEntryRequest) =>
    req<{ entry: Entry }>('/entries', { method: 'POST', body: JSON.stringify(body) }),

  update: (id: string, body: Partial<CreateEntryRequest> & { version: number }) =>
    req<{ entry: Entry }>(`/entries/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  remove: (id: string) => req<{ ok: true }>(`/entries/${id}`, { method: 'DELETE' }),

  done: (id: string) => req<{ entry: Entry }>(`/entries/${id}/done`, { method: 'POST' }),

  snooze: (id: string, body: { minutes?: number; to?: number }) =>
    req<{ entry: Entry }>(`/entries/${id}/snooze`, { method: 'POST', body: JSON.stringify(body) }),

  /**
   * 弱提示的忽略。和 done 语义不同：
   * done 是「我做完了」，dismiss 是「我看到了，故意不处理」
   */
  dismiss: (id: string, reason?: string) =>
    req<{ entry: Entry; dismissCount: number; suggestion: string | null }>(
      `/entries/${id}/dismiss`, { method: 'POST', body: JSON.stringify({ reason }) }),

  rearm: (id: string) => req<{ entry: Entry }>(`/entries/${id}/rearm`, { method: 'POST' }),

  devices: () => req<{ devices: Device[] }>('/devices'),

  pingDevice: (id: string) => req<{ ok: boolean; via?: string; error?: string }>(
    `/devices/${id}/ping`, { method: 'POST' }),

  setPushEnabled: (id: string, pushEnabled: boolean) =>
    req<{ device: Device }>(`/devices/${id}`, { method: 'PATCH', body: JSON.stringify({ pushEnabled }) }),

  settings: () => req<{ settings: Settings }>('/settings'),

  patchSettings: (p: Partial<Settings>) =>
    req<{ settings: Settings }>('/settings', { method: 'PATCH', body: JSON.stringify(p) }),

  missed: () => req<{ missed: MissedFire[] }>('/missed'),
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
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      // welcome 顺带校正本机时钟偏差
      if (msg.t === 'welcome') {
        saveConfig({
          serverSkewMs: msg.serverTs - Date.now(),
          settings: { ...loadConfig().settings, ...msg.settings },
        });
      }
      this.onMessage(msg);
    };

    ws.onclose = () => {
      this.onStatus('closed');
      this.clearTimers();
      if (this.closed) return;
      // 指数退避，最长 30 秒。服务端重启后能自动接回来
      const wait = Math.min(this.backoff, 30_000);
      this.backoff *= 2;
      this.reconnectTimer = window.setTimeout(() => this.connect(), wait);
    };

    ws.onerror = () => ws.close();
  }

  /** 确认走 WS，让正在响铃的设备零延迟停铃 */
  ack(entryId: string, action: AckAction, snoozeTo?: number): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: 'entry.ack', entryId, action, at: Date.now(), snoozeTo }));
    return true;
  }

  /** 弱提示的忽略 */
  dismiss(entryId: string, reason?: string): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ t: 'entry.dismiss', entryId, reason, at: Date.now() }));
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

/**
 * 粘贴内容的自动识别。和服务端规则一致，服务端还会再兜一层。
 * 这里的识别只是给用户看，确认过的以服务端存的为准
 */
export interface Parsed {
  kind: 'text' | 'link' | 'path';
  kindLabel: string;
  remindAt: number | null;
  timeLabel: string;
  strength: Strength;
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

  const rel = s.match(/(\d+)\s*(分钟|分|小时|时)后/);
  const abs = s.match(/(今天|明天|后天|大后天|周[一二三四五六日天])[^\d]{0,4}(\d{1,2})\s*[:：点]\s*(\d{2})?/);
  const clock = s.match(/^\s*(\d{1,2})[:：](\d{2})\s*$/);
  const urgent = /(一定要|必须|别忘|不要忘|重要|紧急|马上|立刻)/.test(s);

  if (rel) {
    const n = Number(rel[1]);
    const mins = /小时|时/.test(rel[2]) ? n * 60 : n;
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
    // 说「明天15点」但现在已经 17 点了，那这个时刻已经过了，推到后天
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

  // 只有明确说了「一定要」才给强提示，否则默认弱。理由见 docs/requirements.md
  if (out.remindAt !== null) out.strength = urgent ? 'strong' : 'weak';
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
  const t = new Date(now.getTime() + 86400_000);
  if (same(d, t)) return '明天';
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

/**
 * 离到点有多近。列表里唯一的颜色梯度，超过 24 小时无色。
 * 四级而非连续渐变：连续变化会变成噪声。各档阈值见 docs/requirements.md
 */
export type Urgency = 'none' | 'soon' | 'close' | 'due' | 'over';

export function urgencyOf(
  e: Pick<Entry, 'status' | 'remindAt' | 'firedAt'>,
  now = serverNow(),
): Urgency {
  if (e.status === 'done' || e.remindAt === null) return 'none';
  if (e.status === 'missed') return 'over';
  const ms = e.remindAt - now;
  // 到点但调度器还没触发的（最多 1 秒）也算 due
  if (ms <= 15 * 60_000) return 'due';
  if (ms <= 60 * 60_000) return 'close';
  if (ms <= 24 * 60 * 60_000) return 'soon';
  return 'none';
}

/** 是否落在静音时段。跨零点要单独处理 */
export function inQuietHours(s: Settings, at = serverNow()): boolean {
  const d = new Date(at);
  const m = d.getHours() * 60 + d.getMinutes();
  const { quietStartMin: a, quietEndMin: b } = s;
  if (a === b) return false;
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** 要不要响。weak 不响；静音时段内除非 bypassQuiet；不定时不响 */
export function shouldRing(e: Pick<Entry, 'strength' | 'bypassQuiet' | 'remindAt'>, s: Settings): boolean {
  if (e.remindAt === null) return false;
  if (e.strength === 'weak') return false;
  if (inQuietHours(s) && !e.bypassQuiet) return false;
  return true;
}
