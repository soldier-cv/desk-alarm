import type { Settings } from '../../../shared/types.js';
import { rows, run } from '../db.js';

const DEFAULTS: Settings = {
  escalateAfterSec: 30,
  repeatEverySec: 120,
  maxRepeatCount: 5,
  quietStartMin: 23 * 60 + 30,
  quietEndMin: 7 * 60,
  sound: 'system',
  autoDowngradeAfter: 2,
  neglectedAfter: 3,
};

// 每个用户一份缓存。原来全局只有一份，多用户后会互相看到对方的设置
const cache = new Map<string, Settings>();

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export async function ensureSettings(userId: string): Promise<void> {
  const entries = Object.entries(DEFAULTS);
  const values = entries.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
  const params = [userId, ...entries.flatMap(([k, v]) => [k, String(v)])];
  await run(
    `INSERT INTO settings (user_id, key, value) VALUES ${values}
     ON CONFLICT (user_id, key) DO NOTHING`,
    params,
  );
}

export async function getSettings(userId: string): Promise<Settings> {
  const hit = cache.get(userId);
  if (hit) return hit;
  const rs = await rows<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE user_id = $1 AND key = ANY($2::text[])`,
    [userId, Object.keys(DEFAULTS)],
  );
  const map = new Map(rs.map((x) => [x.key, x.value]));
  const sound = map.get('sound');
  const out: Settings = {
    escalateAfterSec: num(map.get('escalateAfterSec'), DEFAULTS.escalateAfterSec),
    repeatEverySec: num(map.get('repeatEverySec'), DEFAULTS.repeatEverySec),
    maxRepeatCount: num(map.get('maxRepeatCount'), DEFAULTS.maxRepeatCount),
    quietStartMin: num(map.get('quietStartMin'), DEFAULTS.quietStartMin),
    quietEndMin: num(map.get('quietEndMin'), DEFAULTS.quietEndMin),
    sound: sound === 'system' || sound === 'custom' || sound === 'none' ? sound : DEFAULTS.sound,
    autoDowngradeAfter: num(map.get('autoDowngradeAfter'), DEFAULTS.autoDowngradeAfter),
    neglectedAfter: num(map.get('neglectedAfter'), DEFAULTS.neglectedAfter),
  };
  cache.set(userId, out);
  return out;
}

export async function patchSettings(userId: string, p: Partial<Settings>): Promise<Settings> {
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || !Object.hasOwn(DEFAULTS, k)) continue;
    const key = k as keyof Settings;
    if (key === 'sound') {
      if (v !== 'system' && v !== 'custom' && v !== 'none') continue;
    } else {
      const n = typeof v === 'number' ? v : Number.NaN;
      if (!Number.isFinite(n) || n < 0) continue;
      if ((key === 'quietStartMin' || key === 'quietEndMin') && n >= 24 * 60) continue;
    }
    await run(
      `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
      [userId, key, String(v)],
    );
  }
  cache.delete(userId);
  return getSettings(userId);
}

export function clearSettingsCache(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
}
