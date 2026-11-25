import type { Pursuit, RecurrenceRule, Settings } from '../../shared/types.js';

const DAY = 24 * 60 * 60 * 1000;

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
  if (p.nature === 'project') return '把这件事拆成 2-3 个能立刻动手的小步骤';
  if (p.nature === 'one_off') return `今天花 5 分钟做第一步：${p.text}`;
  return `花几分钟推进一下：${p.text}`;
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

export function nextOccurrence(fromMs: number, rule: RecurrenceRule): number | null {
  const step = Math.max(1, Math.floor(rule.interval ?? 1));
  const d = new Date(fromMs);

  switch (rule.freq) {
    case 'daily':
      d.setDate(d.getDate() + step);
      break;
    case 'weekly':
      d.setDate(d.getDate() + 7 * step);
      break;
    case 'monthly': {
      const day = d.getDate();
      d.setDate(1);
      d.setMonth(d.getMonth() + step);
      setDayClamped(d, day);
      break;
    }
    case 'yearly': {
      const month = d.getMonth();
      const day = d.getDate();
      const year = d.getFullYear() + step;
      const last = new Date(year, month + 1, 0).getDate();
      d.setFullYear(year, month, Math.min(day, last));
      break;
    }
    case 'interval':
      d.setDate(d.getDate() + step);
      break;
    case 'workdays':
      for (let i = 0; i < step; i++) {
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      }
      break;
  }

  if (rule.byMonthday !== undefined) setDayClamped(d, rule.byMonthday);

  if (rule.byWeekday && rule.byWeekday.length > 0) {
    const wanted = new Set(rule.byWeekday);
    let guard = 0;
    while (!wanted.has(d.getDay()) && guard++ < 14) d.setDate(d.getDate() + 1);
  }

  if (rule.byMonth !== undefined) {
    const wanted = ((rule.byMonth % 12) + 12) % 12;
    let guard = 0;
    while (d.getMonth() !== wanted && guard++ < 24) d.setMonth(d.getMonth() + 1);
    if (rule.byMonthday !== undefined) setDayClamped(d, rule.byMonthday);
  }

  return d.getTime();
}
