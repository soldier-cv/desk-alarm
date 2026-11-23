import type { NudgeLevel, Pursuit, RecurrenceRule, Settings } from '../../shared/types.js';

const DAY = 24 * 60 * 60 * 1000;

export function stalenessOf(lastActivityAt: number, nowMs: number): number {
  return Math.max(0, nowMs - lastActivityAt);
}

export function weightOf(p: Pursuit, nowMs: number): number {
  let w = p.importance * 20;

  if (p.dueAt !== null) {
    const delta = p.dueAt - nowMs;
    if (delta < 0) w += 60;
    else if (delta <= DAY) w += 40;
    else if (delta <= 3 * DAY) w += 20;
  }

  w += Math.min(Math.floor(stalenessOf(p.lastActivityAt, nowMs) / DAY) * 8, 40);

  if (p.commitment !== null && p.commitment.date !== undefined && p.commitment.date !== null) {
    w += 25;
  }
  if (p.progress > 0 && p.progress < 1) w += 15;

  return w;
}

export function levelFor(stalenessMs: number, s: Settings): NudgeLevel {
  if (stalenessMs >= s.escalateAfterMs.l5) return 5;
  if (stalenessMs >= s.escalateAfterMs.l4) return 4;
  if (stalenessMs >= s.escalateAfterMs.l3) return 3;
  if (stalenessMs >= s.escalateAfterMs.l2) return 2;
  return 1;
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
  const nowMs = Date.now();
  if (p.stalenessMs >= 7 * DAY) return '拖了太久，要么定个时间要么放手';
  if (p.dueAt !== null && p.dueAt < nowMs) return '已逾期，优先处理';
  if (p.commitment !== null && p.commitment.date !== undefined && p.commitment.date !== null) {
    return '有承诺在身，别失约';
  }
  if (p.stalenessMs >= 3 * DAY) return `已停滞 ${Math.floor(p.stalenessMs / DAY)} 天，该推进了`;
  if (p.progress > 0 && p.progress < 1) return `已完成 ${Math.round(p.progress * 100)}%，趁热打铁`;
  return `重要性 ${p.importance}，排入今日聚焦`;
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
