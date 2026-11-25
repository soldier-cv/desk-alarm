import { describe, expect, it } from 'vitest';
import { actionsFor, effectiveImportance } from '../../shared/types';
import type { PursuitStatus } from '../../shared/types';

describe('状态 × 可用动作', () => {
  const cases: Array<[PursuitStatus, string[]]> = [
    ['inbox', ['done', 'later', 'smaller', 'archive']],
    ['active', ['done', 'later', 'smaller', 'archive']],
    ['paused', ['done', 'later', 'smaller', 'archive']],
    ['done', ['archive', 'reopen']],
    ['archived', []],
  ];

  for (const [status, expected] of cases) {
    it(`${status} 只能点 ${expected.join('/') || '（无）'}`, () => {
      expect(actionsFor(status)).toEqual(expected);
    });
  }

  it('任何状态都不给已删除的 partial / 推进别名', () => {
    for (const status of cases.map(([s]) => s)) {
      expect(actionsFor(status)).not.toContain('partial');
    }
  });
});

describe('临期自动按 P0 排期但改回用户配置', () => {
  const now = 1_800_000_000_000;

  it('默认 P2 在 24 小时内到期时按 P0', () => {
    expect(effectiveImportance(1, now + 60_000, now)).toBe(3);
  });

  it('超过 24 小时保持原值', () => {
    expect(effectiveImportance(1, now + 25 * 3600_000, now)).toBe(1);
    expect(effectiveImportance(2, now + 3 * 24 * 3600_000, now)).toBe(2);
  });

  it('已逾期也算临期，但用户选的 P0 不变', () => {
    expect(effectiveImportance(2, now - 60_000, now)).toBe(3);
    expect(effectiveImportance(3, now - 60_000, now)).toBe(3);
  });

  it('没有截止就完全按用户配置', () => {
    expect(effectiveImportance(1, null, now)).toBe(1);
  });
});
