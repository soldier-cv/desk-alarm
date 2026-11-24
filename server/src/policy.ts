import type { NudgeLevel, Pursuit, RecurrenceRule, Settings } from '../../shared/types.js';
import { effectiveImportance } from '../../shared/types.js';

const DAY = 24 * 60 * 60 * 1000;

export function stalenessOf(lastActivityAt: number, nowMs: number): number {
  return Math.max(0, nowMs - lastActivityAt);
}

export function weightOf(p: Pursuit, nowMs: number): number {
  let w = effectiveImportance(p.importance, p.dueAt, nowMs) * 20;

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
  return `今天花 5 分钟做第一步：${p.text}`;
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
