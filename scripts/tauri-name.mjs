/**
 * 输出一份只含 productName 的最小配置，给 `tauri build --config` 用。
 *
 * 打包器自己会读 tauri.conf.json，这里显式再喂一次，让产物名不依赖
 * 它内部的读取路径（Windows runner 上见过中文被读成空的说法）。
 * 但要注意：真正让 Release 附件丢前缀的是 GitHub 附件名的 ASCII 限制，
 * 处理在上传那一步，不是这里。
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

// JSON.stringify 输出 UTF-8 且不带 BOM
process.stdout.write(JSON.stringify({ productName: name }));
