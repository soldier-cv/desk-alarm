import { describe, expect, it } from 'vitest';
import { parseInput } from './api';

const now = new Date(2026, 10, 27, 10, 0, 0).getTime();
const clockOf = (ts: number | null) => {
  if (ts === null) return null;
  const d = new Date(ts);
  return { day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
};

describe('中文时间点解析', () => {
  it('下午 / 晚上按 12 小时制换算，过点则顺延一天', () => {
    expect(clockOf(parseInput('下午5点测试', now).remindAt)).toMatchObject({ hour: 17, minute: 0 });
    expect(clockOf(parseInput('下午5:30测试', now).remindAt)).toMatchObject({ hour: 17, minute: 30 });
    expect(clockOf(parseInput('晚上8点交材料', now).remindAt)).toMatchObject({ hour: 20, minute: 0 });
    expect(clockOf(parseInput('上午9点开会', now).remindAt)).toMatchObject({ day: 28, hour: 9 });
  });

  it('日期词叠加时段照常识别', () => {
    expect(clockOf(parseInput('明天下午5点开会', now).remindAt)).toMatchObject({ day: 28, hour: 17 });
    expect(clockOf(parseInput('后天上午10点复盘', now).remindAt)).toMatchObject({ day: 29, hour: 10 });
  });

  it('半小时写法的分钟数也能识别', () => {
    expect(clockOf(parseInput('下午5点半见', now).remindAt)).toMatchObject({ hour: 17, minute: 30 });
  });

  it('原有相对时长与日期格式不受影响', () => {
    expect(clockOf(parseInput('半小时后喝水', now).remindAt)).toMatchObject({ hour: 10, minute: 30 });
    expect(clockOf(parseInput('明天15:00交周报', now).remindAt)).toMatchObject({ day: 28, hour: 15 });
    expect(parseInput('随手记一条', now).remindAt).toBeNull();
  });
});
