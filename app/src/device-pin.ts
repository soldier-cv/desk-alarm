/**
 * 本机 PIN。只存加盐 PBKDF2 哈希在 localStorage，不入库、不传服务端、不留明文。
 * 每个设备（浏览器 profile / Tauri 安装）各存各的，所以手机和电脑、以及同一账号下
 * 的多台电脑天然互不相同；换账号登录同一台设备也仍用同一个本机 PIN。
 */
const PIN_KEY = 'localPinV1';
const ITERATIONS = 120_000;

interface PinRecord {
  v: 1;
  salt: string;
  hash: string;
  iterations: number;
}

function subtle(): SubtleCrypto {
  // 非安全上下文（局域网 IP + http 直接打开网页）拿不到 Web Crypto
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器环境不支持本机 PIN，请用桌面客户端设置');
  return globalThis.crypto.subtle;
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function loadPin(): PinRecord | null {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as PinRecord;
    if (r?.v !== 1 || !r.salt || !r.hash || typeof r.iterations !== 'number') return null;
    return r;
  } catch {
    return null;
  }
}

export function hasDevicePin(): boolean {
  return loadPin() !== null;
}

export async function setDevicePin(pin: string): Promise<void> {
  if (!/^\d{6}$/.test(pin)) throw new Error('PIN 需要 6 位数字');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, ITERATIONS);
  const rec: PinRecord = { v: 1, salt: b64(salt), hash: b64(hash), iterations: ITERATIONS };
  localStorage.setItem(PIN_KEY, JSON.stringify(rec));
}

export async function verifyDevicePin(pin: string): Promise<boolean> {
  const rec = loadPin();
  if (!rec) return false;
  const got = await derive(pin, unb64(rec.salt), rec.iterations);
  const want = unb64(rec.hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

export function clearDevicePin(): void {
  localStorage.removeItem(PIN_KEY);
}
