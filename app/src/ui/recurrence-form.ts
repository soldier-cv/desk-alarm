import type { RecurrenceRule } from '../../../shared/types';

export type Freq = RecurrenceRule['freq'] | 'none';

export interface RuleFields {
  byWeekday: string;
  byMonthday: string;
  byMonth: string;
}

export const EMPTY_RULE_FIELDS: RuleFields = { byWeekday: '', byMonthday: '', byMonth: '' };

/** 每个频率只显示自己用得上的字段，避免「每天 + 每月几号」这种互相覆盖的歧义 */
export function fieldsFor(freq: Freq): Array<'weekday' | 'monthday' | 'month'> {
  switch (freq) {
    case 'weekly': return ['weekday'];
    case 'monthly':
    case 'quarterly': return ['monthday'];
    case 'yearly': return ['month', 'monthday'];
    default: return [];
  }
}

export function ruleFields(rule: RecurrenceRule | null): RuleFields {
  if (!rule) return EMPTY_RULE_FIELDS;
  return {
    byWeekday: (rule.byWeekday ?? []).join(','),
    byMonthday: rule.byMonthday?.toString() ?? '',
    byMonth: rule.byMonth?.toString() ?? '',
  };
}

function parseWeekday(raw: string): number[] | undefined {
  const list = [...new Set(raw.split(/[,，\s]+/).filter(Boolean).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  return list.length ? list : undefined;
}

function parseDay(raw: string, min: number, max: number): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export function buildRecurrence(freq: Freq, fields: RuleFields): RecurrenceRule | null {
  if (freq === 'none') return null;
  const rule: RecurrenceRule = { freq };
  if (freq === 'weekly') {
    const byWeekday = parseWeekday(fields.byWeekday);
    if (byWeekday) rule.byWeekday = byWeekday;
    return rule;
  }
  if (freq === 'monthly' || freq === 'quarterly') {
    const byMonthday = parseDay(fields.byMonthday, 1, 31);
    if (byMonthday !== undefined) rule.byMonthday = byMonthday;
    return rule;
  }
  if (freq === 'yearly') {
    const byMonth = parseDay(fields.byMonth, 1, 12);
    const byMonthday = parseDay(fields.byMonthday, 1, 31);
    if (byMonth !== undefined) rule.byMonth = byMonth;
    if (byMonthday !== undefined) rule.byMonthday = byMonthday;
  }
  return rule;
}
