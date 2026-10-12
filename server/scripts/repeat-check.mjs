/**
 * 重复提醒的日期计算。月末钳位是最容易错的地方：
 * 1 月 31 日加一个月，setMonth 会溢出到 3 月 3 号
 *
 * 直接 import 编译产物，测的是真实实现不是复刻版。
 * 用法：cd server && node scripts/repeat-check.mjs
 */
import { nextOccurrence } from '../dist/server/src/repo/entries.js';

const fmt = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const at = (s) => new Date(s).getTime();

const cases = [
  // 月末钳位
  ['2026-01-31T10:00:00', 'monthly', '2026-02-28'], // 平年 2 月只有 28 天
  ['2028-01-31T10:00:00', 'monthly', '2028-02-29'], // 闰年
  ['2026-03-31T10:00:00', 'monthly', '2026-04-30'],
  ['2026-01-15T10:00:00', 'monthly', '2026-02-15'], // 非月末不受影响
  ['2026-12-31T10:00:00', 'monthly', '2027-01-31'], // 跨年
  ['2026-08-31T10:00:00', 'monthly', '2026-09-30'],
  ['2026-05-31T10:00:00', 'monthly', '2026-06-30'],
  // 日与周
  ['2026-02-28T10:00:00', 'daily', '2026-03-01'], // 平年 2 月末跨月
  ['2026-12-31T10:00:00', 'daily', '2027-01-01'], // 跨年
  ['2026-03-01T10:00:00', 'weekly', '2026-03-08'],
  // 不重复时原样返回
  ['2026-01-31T10:00:00', 'none', '2026-01-31'],
];

let bad = 0;
console.log('重复提醒日期计算\n');
for (const [from, rule, want] of cases) {
  const got = fmt(nextOccurrence(at(from), rule).getTime());
  const pass = got === want;
  if (!pass) bad++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${from.slice(0, 10)} ${rule.padEnd(8)} -> ${got}${pass ? '' : `  期望 ${want}`}`);
}

// 时刻必须保持不变：用户定的是 9:30，下次还是 9:30，不是 0:00
console.log('\n时刻保持');
const at930 = at('2026-01-31T09:30:00');
for (const rule of ['daily', 'weekly', 'monthly']) {
  const d = nextOccurrence(at930, rule);
  const pass = d.getHours() === 9 && d.getMinutes() === 30;
  if (!pass) bad++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${rule.padEnd(8)} 下次仍是 09:30（实际 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}）`);
}

console.log(`\n${'--------------------------------------------'}`);
console.log(bad === 0 ? `全部通过 ${cases.length + 3} 项` : `${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);