/**
 * Firebase Cloud Messaging 通道。
 *
 * 存在的唯一理由：Android 会在后台杀进程，WebSocket 活不下来。
 * 进程死了之后，只有 FCM 能把进程叫醒。这是 Android 端的命门。
 *
 * 没配 FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY 时，
 * createFcm() 返回一个「永远失败」的空壳，失败原因会写进
 * deliveries.last_error，排查时一眼能看出是配置没到位。
 */
import type { Entry } from '../../../shared/types.js';
import { env } from '../env.js';
import { log } from '../log.js';
import { one } from '../db.js';
import type { SendResult, Transport, TransportName } from './index.js';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

interface TokenRow {
  push_token: string | null;
  transport: string | null;
  push_enabled: boolean;
}

const DEAD_TOKEN_CODES = new Set([
  'UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH', 'THIRD_PARTY_AUTH_ERROR',
]);

/** 服务账号换 access token 的缓存。过期前 5 分钟就不用了 */
let tokenCache: { value: string; at: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && Date.now() - tokenCache.at < 50 * 60_000) {
    return tokenCache.value;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const claim = b64url({
    iss: env.FCM_CLIENT_EMAIL,
    scope: SCOPE,
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSec,
    exp: nowSec + 3600,
  });

  // 私钥在环境变量里是带 \n 的转义形式，先还原
  const pem = env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n');
  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(pem, 'base64url');

  const assertion = `${header}.${claim}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    throw new Error(`换 access token 失败: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string };
  tokenCache = { value: json.access_token, at: Date.now() };
  return json.access_token;
}

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export function createFcm(): Transport {
  const configured = Boolean(
    env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY,
  );

  if (!configured) {
    return {
      name: 'fcm' as TransportName,
      available: () => false,
      send: async (): Promise<SendResult> => ({
        ok: false,
        error: 'FCM 未配置，缺 FCM_PROJECT_ID / FCM_CLIENT_EMAIL / FCM_PRIVATE_KEY',
      }),
    };
  }

  return {
    name: 'fcm' as TransportName,

    /**
     * FCM 是个「盲发」通道，没有在线状态的概念。
     * 只要设备开了推送且有 token，就算可用。发不出去由 FCM 回执说了算，
     * 不在这里判断
     */
    available: () => true,

    async send(deviceId: string, entry: Entry, serverTs: number): Promise<SendResult> {
      const dev = await one<TokenRow>(
        'SELECT push_token, transport, push_enabled FROM devices WHERE id = $1',
        [deviceId],
      );
      if (!dev?.push_token) return { ok: false, error: '设备没有 push token' };
      if (!dev.push_enabled) return { ok: false, error: '设备关闭了推送' };

      const title = entry.strength === 'weak' ? '提醒（可稍后处理）' : '提醒器';
      const body = entry.text.length > 120 ? `${entry.text.slice(0, 118)}…` : entry.text;

      try {
        const tok = await accessToken();
        const res = await fetch(
          `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${tok}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token: dev.push_token,
                // 高优先级才能在锁屏上弹出来而不是静默进通知栏
                android: { priority: 'HIGH', notification: { channel_id: 'deskalarm_alerts' } },
                notification: {
                  title,
                  body,
                  // 弱提示走静默渠道，强提示走响铃渠道，在手机上分开设置音量
                  ...(entry.strength === 'weak'
                    ? { }
                    : { sound: 'default', default_vibrate_timings: true }),
                },
                data: {
                  entryId: entry.id,
                  text: entry.text,
                  strength: entry.strength,
                  serverTs: String(serverTs),
                },
              },
            }),
          },
        );

        const text = await res.text();
        if (res.ok) {
          const json = JSON.parse(text) as { name?: string };
          return { ok: true, messageId: json.name };
        }

        let reason = `FCM ${res.status}`;
        let fatal = false;
        try {
          const err = JSON.parse(text) as {
            error?: { status?: string; message?: string };
          };
          if (err.error?.status) {
            reason = `${err.error.status}: ${err.error.message ?? ''}`;
            fatal = DEAD_TOKEN_CODES.has(err.error.status);
          }
        } catch { /* 不是 JSON 就用原始 text */ }

        log.warn('fcm', { deviceId, reason });
        return { ok: false, error: reason, fatal };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
