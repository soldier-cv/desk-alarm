import { describe, expect, it } from 'vitest';
import { buildRecurrence, fieldsFor, ruleFields, type Freq } from './recurrence-form';

const blank = { byWeekday: '', byMonthday: '', byMonth: '' };

describe('重复规则字段收敛', () => {
  it('每个频率只显示自己的字段', () => {
    expect(fieldsFor('none')).toEqual([]);
    expect(fieldsFor('daily')).toEqual([]);
    expect(fieldsFor('weekly')).toEqual(['weekday']);
    expect(fieldsFor('monthly')).toEqual(['monthday']);
    expect(fieldsFor('quarterly')).toEqual(['monthday']);
    expect(fieldsFor('yearly')).toEqual(['month', 'monthday']);
  });

  it('不重复丢掉所有已填字段', () => {
    expect(buildRecurrence('none', { byWeekday: '1', byMonthday: '2', byMonth: '3' })).toBeNull();
  });

  it('每天不带任何附加字段', () => {
    expect(buildRecurrence('daily', { ...blank, byMonthday: '2' })).toEqual({ freq: 'daily' });
  });

  it('每周几只收周几，去重并过滤非法值', () => {
    expect(buildRecurrence('weekly', { ...blank, byWeekday: '1,4,1,9' })).toEqual({
      freq: 'weekly', byWeekday: [1, 4],
    });
    expect(buildRecurrence('weekly', blank)).toEqual({ freq: 'weekly' });
  });

  it('每月/每季度只收几号', () => {
    expect(buildRecurrence('monthly', { ...blank, byMonthday: '31' })).toEqual({
      freq: 'monthly', byMonthday: 31,
    });
    expect(buildRecurrence('quarterly', { ...blank, byMonthday: '0' })).toEqual({ freq: 'quarterly' });
  });

  it('每年收月份和几号', () => {
    expect(buildRecurrence('yearly', { byWeekday: '1', byMonth: '6', byMonthday: '15' })).toEqual({
      freq: 'yearly', byMonth: 6, byMonthday: 15,
    });
  });

  it('ruleFields 回填时不带其它频率的字段', () => {
    expect(ruleFields({ freq: 'weekly', byWeekday: [0, 5] })).toEqual({
      byWeekday: '0,5', byMonthday: '', byMonth: '',
    });
    expect(ruleFields(null)).toEqual(blank);
  });

  it('所有频率都在中文标签表里有对应项', () => {
    const freqs: Freq[] = ['none', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
    expect(freqs.every((f) => fieldsFor(f).length >= 0)).toBe(true);
  });
});
