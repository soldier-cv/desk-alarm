import type { Pursuit, RecurrenceRule, Settings } from '../../shared/types.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 强提醒逾期复催槽位：0=到点，1=+15m，2=+1h，之后每 2h 递增 */
export function strongRenudgeSlot(overdueMs: number): number {
  if (overdueMs < 15 * MIN) return 0;
  if (overdueMs < 60 * MIN) return 1;
  if (overdueMs < 180 * MIN) return 2;
  return 2 + Math.floor((overdueMs - 60 * MIN) / (120 * MIN));
}

/** 弱提醒单条复催槽位：0=到点，1=+30m（更久后交由用户级 3h 汇总） */
export function weakSingleSlot(overdueMs: number): number {
  return overdueMs >= 30 * MIN ? 1 : 0;
}

export const WEAK_DIGEST_INTERVAL_MS = 3 * HOUR;

export function overdueDurationText(overdueMs: number): string {
  const min = Math.floor(Math.max(0, overdueMs) / MIN);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

export function stalenessOf(lastActivityAt: number, nowMs: number): number {
  return Math.max(0, nowMs - lastActivityAt);
}

export function inQuietHours(s: Settings, atMs = Date.now()): boolean {
  const d = new Date(atMs);
  const min = d.getHours() * 60 + d.getMinutes();
  const start = s.quietStartMin;
  const end = s.quietEndMin;
  return start <= end ? min >= start && min < end : min >= start || min < end;
}

export function suggestNextStep(p: Pursuit): string | null {
  const next = p.steps.find((s) => s.state !== 'done');
  if (next) return next.text;
  return `今天花 5 分钟做第一步：${p.text}`;
}

export function focusReason(p: Pursuit): string {
  if (p.dueAt === null) return '还没定截止时间，点开定一个';
  const nowMs = Date.now();
  if (p.dueAt < nowMs) return '已逾期，优先处理';
  if (p.dueAt - nowMs <= DAY) return '快到点了，先准备一下';
  const next = p.steps.find((s) => s.state !== 'done');
  return next ? `下一步：${next.text}` : `截止 ${new Date(p.dueAt).toLocaleString('zh-CN')}`;
}

function setDayClamped(d: Date, day: number): void {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(Math.max(1, day), last));
}

function yearlyAt(base: Date, year: number, month: number, day: number): Date {
  const d = new Date(year, month, 1, base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds());
  setDayClamped(d, day);
  return d;
}

/** 下一次发生时间。每个频率只认自己的字段，规则不会互相叠加 */
export function nextOccurrence(fromMs: number, rule: RecurrenceRule): number | null {
  const base = new Date(fromMs);
  const d = new Date(fromMs);

  switch (rule.freq) {
    case 'daily':
      d.setDate(d.getDate() + 1);
      break;
    case 'weekly': {
      const wanted = rule.byWeekday?.length ? new Set(rule.byWeekday) : null;
      if (!wanted) {
        d.setDate(d.getDate() + 7);
        break;
      }
      d.setDate(d.getDate() + 1);
      let guard = 0;
      while (!wanted.has(d.getDay()) && guard++ < 7) d.setDate(d.getDate() + 1);
      break;
    }
    case 'monthly': {
      const day = rule.byMonthday ?? base.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 1);
      setDayClamped(d, day);
      break;
    }
    case 'quarterly': {
      const day = rule.byMonthday ?? base.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + 3);
      setDayClamped(d, day);
      break;
    }
    case 'yearly': {
      const month = rule.byMonth !== undefined ? rule.byMonth - 1 : base.getMonth();
      const day = rule.byMonthday ?? base.getDate();
      let candidate = yearlyAt(base, base.getFullYear(), month, day);
      if (candidate.getTime() <= fromMs) candidate = yearlyAt(base, base.getFullYear() + 1, month, day);
      return candidate.getTime();
    }
  }

  return d.getTime();
}
