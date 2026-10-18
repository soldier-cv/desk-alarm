/**
 * 输出一份只含 productName 的最小配置，给 `tauri build --config` 用。
 *
 * 为什么要多这一份：CI runner 上 tauri 读 tauri.conf.json 时，
 * 无 BOM 的 UTF-8 中文 productName 会被读成空字符串，
 * 产物名就变成 "_0.2.0_x64-setup.exe"（前缀丢了）。
 * 由 Node 显式读一遍再以 JSON 传给 CLI，打包器拿到的就是正确的名字。
 *
 * 用法：node scripts/tauri-name.mjs
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const conf = JSON.parse(readFileSync(new URL('app/src-tauri/tauri.conf.json', ROOT), 'utf8'));

const name = String(conf.productName ?? '').trim();
if (!name) {
  console.error('tauri.conf.json 里没有 productName');
  process.exit(1);
}

// JSON.stringify 输出的就是 UTF-8，且没有 BOM
process.stdout.write(JSON.stringify({ productName: name }));
