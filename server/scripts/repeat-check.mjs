/**
 * 重复规则日期计算（v2 推进引擎）。每月/每季度/每年的月末钳位最容易错：
 * 1 月 31 日加一个月，setMonth 会溢出到 3 月 3 号
 *
 * 直接 import 编译产物，测的是真实实现不是复刻版。
 * 用法：cd server && npm run repeat
 */
import { nextOccurrence } from '../dist/server/src/policy.js';

const fmt = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const at = (s) => new Date(s).getTime();
const rule = (freq, extra = {}) => ({ freq, ...extra });

const cases = [
  // 每天
  ['2026-02-28T10:00:00', rule('daily'), '2026-03-01'],
  ['2026-12-31T10:00:00', rule('daily'), '2027-01-01'],
  // 每周几：从基准日的次日开始找第一个命中的星期
  ['2026-03-01T10:00:00', rule('weekly'), '2026-03-08'], // 周日无 byWeekday -> 下周同一天
  ['2026-03-01T10:00:00', rule('weekly', { byWeekday: [1] }), '2026-03-02'],
  ['2026-03-01T10:00:00', rule('weekly', { byWeekday: [1, 4] }), '2026-03-02'],
  ['2026-03-02T10:00:00', rule('weekly', { byWeekday: [1, 4] }), '2026-03-05'],
  ['2026-03-06T10:00:00', rule('weekly', { byWeekday: [1, 2, 3, 4, 5] }), '2026-03-09'], // 周五 -> 下周一
  // 每月几号 + 月末钳位
  ['2026-01-31T10:00:00', rule('monthly'), '2026-02-28'],
  ['2028-01-31T10:00:00', rule('monthly'), '2028-02-29'], // 闰年
  ['2026-03-31T10:00:00', rule('monthly'), '2026-04-30'],
  ['2026-01-15T10:00:00', rule('monthly'), '2026-02-15'],
  ['2026-01-05T10:00:00', rule('monthly', { byMonthday: 20 }), '2026-02-20'],
  ['2026-12-31T10:00:00', rule('monthly'), '2027-01-31'], // 跨年
  // 每季度几号 + 季末钳位
  ['2026-01-31T10:00:00', rule('quarterly'), '2026-04-30'],
  ['2026-02-15T10:00:00', rule('quarterly', { byMonthday: 10 }), '2026-05-10'],
  ['2026-11-30T10:00:00', rule('quarterly'), '2027-02-28'],
  // 每年几月几号
  ['2024-02-29T10:00:00', rule('yearly'), '2025-02-28'], // 闰日钳到平年 2/28
  ['2026-03-10T10:00:00', rule('yearly', { byMonth: 6, byMonthday: 15 }), '2026-06-15'],
  ['2026-07-10T10:00:00', rule('yearly', { byMonth: 6, byMonthday: 15 }), '2027-06-15'],
];

let bad = 0;
console.log('重复规则日期计算（v2）\n');
for (const [from, r, want] of cases) {
  const next = nextOccurrence(at(from), r);
  const got = next === null ? '(null)' : fmt(next);
  const pass = got === want;
  if (!pass) bad++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${from.slice(0, 10)} ${r.freq.padEnd(9)} -> ${got}${pass ? '' : `  期望 ${want}`}`);
}

// 时刻保持不变：定的是 9:30，下次还是 9:30
console.log('\n时刻保持');
const at930 = at('2026-01-31T09:30:00');
for (const r of [rule('daily'), rule('weekly', { byWeekday: [2] }), rule('monthly'), rule('quarterly'), rule('yearly')]) {
  const d = new Date(nextOccurrence(at930, r));
  const pass = d.getHours() === 9 && d.getMinutes() === 30;
  if (!pass) bad++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${r.freq.padEnd(9)} 下次仍是 09:30（实际 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}）`);
}

console.log(`\n${'--------------------------------------------'}`);
console.log(bad === 0 ? `全部通过 ${cases.length + 5} 项` : `${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
