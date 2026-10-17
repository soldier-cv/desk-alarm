import type { Settings } from '../../../shared/types.js';
import { rows, run } from '../db.js';

const DEFAULTS: Settings = {
  escalateAfterSec: 30,
  repeatEverySec: 120,
  quietStartMin: 23 * 60 + 30,
  quietEndMin: 7 * 60,
  sound: 'system',
  autoDowngradeAfter: 2,
  neglectedAfter: 3,
};

let cache: Settings | null = null;

/**
 * 0 是合法值（quietStartMin=0 就是零点整），不能用 `||` 兜底，
 * 否则用户把静音开始设成 0 点会被悄悄改回 23:30
 */
function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const rs = await rows<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [Object.keys(DEFAULTS)],
  );
  const map = new Map(rs.map((x) => [x.key, x.value]));
  const sound = map.get('sound');
  cache = {
    escalateAfterSec: num(map.get('escalateAfterSec'), DEFAULTS.escalateAfterSec),
    repeatEverySec: num(map.get('repeatEverySec'), DEFAULTS.repeatEverySec),
    quietStartMin: num(map.get('quietStartMin'), DEFAULTS.quietStartMin),
    quietEndMin: num(map.get('quietEndMin'), DEFAULTS.quietEndMin),
    sound: sound === 'system' || sound === 'custom' || sound === 'none' ? sound : DEFAULTS.sound,
    autoDowngradeAfter: num(map.get('autoDowngradeAfter'), DEFAULTS.autoDowngradeAfter),
    neglectedAfter: num(map.get('neglectedAfter'), DEFAULTS.neglectedAfter),
  };
  return cache;
}

/** 只认已知键。原来是把 body 里每个键都写进库，拼错一个键就多一行垃圾数据 */
export async function patchSettings(p: Partial<Settings>): Promise<Settings> {
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || !Object.hasOwn(DEFAULTS, k)) continue;
    const key = k as keyof Settings;
    if (key === 'sound') {
      if (v !== 'system' && v !== 'custom' && v !== 'none') continue;
    } else {
      const n = typeof v === 'number' ? v : Number.NaN;
      if (!Number.isFinite(n) || n < 0) continue;
      // 静音时段是 0:00 起算的分钟数，跨过一天就没有意义了
      if ((key === 'quietStartMin' || key === 'quietEndMin') && n >= 24 * 60) continue;
    }
    await run(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, String(v)],
    );
  }
  cache = null;
  return getSettings();
}
