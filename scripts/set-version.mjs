/**
 * 把 tag 里的版本号写进客户端的三处声明，供本地打包和 CI 复用。
 *
 * 用法：
 *   node scripts/set-version.mjs v0.2.0
 *   node scripts/set-version.mjs 0.2.0
 *
 * 不传参数时只打印当前版本，不改文件。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);

function read(rel) {
  return readFileSync(new URL(rel, ROOT), 'utf8');
}

function write(rel, text) {
  writeFileSync(new URL(rel, ROOT), text);
}

/** v0.2.0 / V0.2.0 / 0.2.0 都接受，统一成不带前缀的小写 semver */
export function normalizeVersion(raw) {
  const v = String(raw).trim().replace(/^[vV]/, '');
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)) {
    throw new Error(`版本号不合法：${raw}。要形如 v0.2.0 或 0.2.0`);
  }
  return v;
}

const FILES = {
  tauriConf: 'app/src-tauri/tauri.conf.json',
  cargoToml: 'app/src-tauri/Cargo.toml',
  packageJson: 'app/package.json',
};

export function currentVersion() {
  const conf = JSON.parse(read(FILES.tauriConf));
  return conf.version;
}

export function setVersion(raw) {
  const version = normalizeVersion(raw);

  // 只替换 version 那一行，不重新序列化整个文件：
  // JSON.stringify 会把 targets、dmg 这类紧凑写法全部展开，发版 diff 会全是噪音
  const conf = read(FILES.tauriConf);
  const confNext = conf.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  // 已经是目标版本时 replace 原地不动，那是幂等成功而不是"没找到字段"。
  // 判"找没找到"要看解析出的版本号，不能看字符串变没变：
  // 重跑同一个 tag 会走到这条路径，误报会让补包重发直接失败
  if (JSON.parse(conf).version !== version && confNext === conf) {
    throw new Error('tauri.conf.json 里没找到 version 字段');
  }
  if (JSON.parse(confNext).version !== version) throw new Error('tauri.conf.json 写入后校验失败');
  write(FILES.tauriConf, confNext);

  // Cargo.toml 的 version 是 [package] 段里的那一个，
  // 不能全局替换：依赖里也可能出现 version = "0.1.0"
  const toml = read(FILES.cargoToml);
  const next = toml.replace(
    /(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m,
    `$1${version}$2`,
  );
  // 同样按解析值判断，理由同上
  const tomlHasField = /(\[package\][\s\S]*?^version\s*=\s*")[^"]*(")/m.test(toml);
  if (!tomlHasField) throw new Error('Cargo.toml 里没找到 [package] 的 version');
  write(FILES.cargoToml, next);

  const pkg = read(FILES.packageJson);
  const pkgNext = pkg.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(pkg).version !== version && pkgNext === pkg) {
    throw new Error('package.json 里没找到 version 字段');
  }
  write(FILES.packageJson, pkgNext);

  return version;
}

// 直接执行时才走 CLI，被 import 时只导出函数。
// Windows 上 argv[1] 是反斜杠路径，必须走 pathToFileURL，不能自己拼字符串
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = process.argv[2];
  if (!arg) {
    console.log(currentVersion());
  } else {
    try {
      console.log(setVersion(arg));
    } catch (err) {
      console.error(`错误：${err.message}`);
      process.exit(1);
    }
  }
}
