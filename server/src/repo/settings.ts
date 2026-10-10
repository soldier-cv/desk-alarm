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

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  const rs = await rows<{ key: string; value: string }>(
    `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
    [Object.keys(DEFAULTS)],
  );
  const map = new Map(rs.map((x) => [x.key, x.value]));
  cache = {
    escalateAfterSec: Number(map.get('escalateAfterSec')) || DEFAULTS.escalateAfterSec,
    repeatEverySec: Number(map.get('repeatEverySec')) || DEFAULTS.repeatEverySec,
    quietStartMin: Number(map.get('quietStartMin')) || DEFAULTS.quietStartMin,
    quietEndMin: Number(map.get('quietEndMin')) || DEFAULTS.quietEndMin,
    sound: (map.get('sound') as Settings['sound']) || DEFAULTS.sound,
    autoDowngradeAfter: Number(map.get('autoDowngradeAfter')) || DEFAULTS.autoDowngradeAfter,
    neglectedAfter: Number(map.get('neglectedAfter')) || DEFAULTS.neglectedAfter,
  };
  return cache;
}

export async function patchSettings(p: Partial<Settings>): Promise<Settings> {
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    await run(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [k, String(v)],
    );
  }
  cache = null;
  return getSettings();
}
