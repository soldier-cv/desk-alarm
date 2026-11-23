import type { Settings } from '../../../shared/types.js';
import { rows, run } from '../db.js';

const DEFAULTS: Settings = {
  dailyStrongBudget: 2,
  escalateAfterMs: { l2: 7_200_000, l3: 86_400_000, l4: 259_200_000, l5: 604_800_000 },
  quietStartMin: 1410,
  quietEndMin: 420,
  focusAtMin: 480,
  sound: 'system',
};

// 每个用户一份缓存，避免每次 WS 握手都查库
const cache = new Map<string, Settings>();

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function escalation(raw: string | undefined): Settings['escalateAfterMs'] {
  if (!raw) return { ...DEFAULTS.escalateAfterMs };
  try {
    const v = JSON.parse(raw) as Partial<Settings['escalateAfterMs']>;
    return {
      l2: num(String(v.l2), DEFAULTS.escalateAfterMs.l2),
      l3: num(String(v.l3), DEFAULTS.escalateAfterMs.l3),
      l4: num(String(v.l4), DEFAULTS.escalateAfterMs.l4),
      l5: num(String(v.l5), DEFAULTS.escalateAfterMs.l5),
    };
  } catch {
    return { ...DEFAULTS.escalateAfterMs };
  }
}

function defaultsAsPairs(): Array<[string, string]> {
  return [
    ['dailyStrongBudget', String(DEFAULTS.dailyStrongBudget)],
    ['escalateAfterMs', JSON.stringify(DEFAULTS.escalateAfterMs)],
    ['quietStartMin', String(DEFAULTS.quietStartMin)],
    ['quietEndMin', String(DEFAULTS.quietEndMin)],
    ['focusAtMin', String(DEFAULTS.focusAtMin)],
    ['sound', DEFAULTS.sound],
  ];
}

export async function ensureSettings(userId: string): Promise<void> {
  const pairs = defaultsAsPairs();
  const values = pairs.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
  const params = [userId, ...pairs.flatMap(([k, v]) => [k, v])];
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
    dailyStrongBudget: Math.max(0, Math.floor(num(map.get('dailyStrongBudget'), DEFAULTS.dailyStrongBudget))),
    escalateAfterMs: escalation(map.get('escalateAfterMs')),
    quietStartMin: num(map.get('quietStartMin'), DEFAULTS.quietStartMin),
    quietEndMin: num(map.get('quietEndMin'), DEFAULTS.quietEndMin),
    focusAtMin: num(map.get('focusAtMin'), DEFAULTS.focusAtMin),
    sound: sound === 'system' || sound === 'custom' || sound === 'none' ? sound : DEFAULTS.sound,
  };
  cache.set(userId, out);
  return out;
}

/** PATCH 用：只写合法字段。非法值忽略而不是整批报错，避免一个坏字段拖垮整次保存 */
export async function saveSettings(userId: string, patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings(userId);
  const pairs: Array<[string, string]> = [];

  if (typeof patch.dailyStrongBudget === 'number' && Number.isFinite(patch.dailyStrongBudget)) {
    pairs.push(['dailyStrongBudget', String(Math.max(0, Math.floor(patch.dailyStrongBudget)))]);
  }
  if (patch.escalateAfterMs) {
    const merged = { ...current.escalateAfterMs };
    for (const k of ['l2', 'l3', 'l4', 'l5'] as const) {
      const v = patch.escalateAfterMs[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) merged[k] = v;
    }
    pairs.push(['escalateAfterMs', JSON.stringify(merged)]);
  }
  for (const k of ['quietStartMin', 'quietEndMin', 'focusAtMin'] as const) {
    const v = patch[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440) pairs.push([k, String(Math.floor(v))]);
  }
  if (patch.sound === 'system' || patch.sound === 'custom' || patch.sound === 'none') {
    pairs.push(['sound', patch.sound]);
  }

  for (const [key, value] of pairs) {
    await run(
      `INSERT INTO settings (user_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
      [userId, key, value],
    );
  }
  cache.delete(userId);
  return getSettings(userId);
}

/** 旧路由还在用；新代码一律用 saveSettings */
export const patchSettings = saveSettings;

export function clearSettingsCache(userId?: string) {
  if (userId) cache.delete(userId);
  else cache.clear();
}
