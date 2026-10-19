/**
 * normalizeBaseUrl 的测试。这个函数决定用户填的地址去打哪，
 * 出错就是连错机器，或者被 scheme 注入。改动请先跑这个。
 *
 * 用法：node app/scripts/url-check.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// api.ts 是浏览器模块，直接 import 会因为 localStorage 报错。
// 抽出 normalizeBaseUrl 单独剥掉 TS 注解再跑，比正则扒整份源码可靠
const src = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
const m = src.match(/export function normalizeBaseUrl[\s\S]*?\n}/);
if (!m) {
  console.error('在 api.ts 里找不到 normalizeBaseUrl');
  process.exit(1);
}

const stripped = m[0]
  .replace('export function', 'function')
  .replace(/: string/g, '')
  .replace(/\): string \{/, ') {');

const dir = mkdtempSync(join(tmpdir(), 'deskalarm-url-'));
const file = join(dir, 'fn.mjs');
writeFileSync(file, `${stripped}\nexport { normalizeBaseUrl };`);
// Windows 上绝对路径必须转成 file:// URL 才能被 ESM loader 接受
const { normalizeBaseUrl } = await import(pathToFileURL(file).href);

const cases = [
  // 正常输入
  ['127.0.0.1:8787', 'http://127.0.0.1:8787'],
  ['192.168.1.10:8787', 'http://192.168.1.10:8787'],
  ['https://desk.example.com', 'https://desk.example.com'],
  // 容错：空格、缺协议、结尾斜杠、大小写
  ['  192.168.1.10:8787/  ', 'http://192.168.1.10:8787'],
  ['HTTPS://Desk.Example.COM/', 'https://desk.example.com'],
  ['desk.example.com/path', 'http://desk.example.com'],
  // 必须拒绝
  ['', ''],
  ['ftp://x.com', ''],
  ['javascript:alert(1)', ''],
  ['file:///c:/windows', ''],
  ['http://', ''],
  ['not a url', ''],
  ['://broken', ''],
];

let bad = 0;
console.log('服务端地址规范化\n');
for (const [input, want] of cases) {
  const got = normalizeBaseUrl(input);
  const pass = got === want;
  if (!pass) bad++;
  const shown = got || '（拒绝）';
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${JSON.stringify(input).padEnd(30)} -> ${shown}${pass ? '' : `  期望 ${want || '（拒绝）'}`}`);
}

console.log(`\n${'--------------------------------------------'}`);
console.log(bad === 0 ? `全部通过 ${cases.length} 项` : `${cases.length - bad} 过 / ${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);