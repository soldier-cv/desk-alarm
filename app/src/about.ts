/**
 * 关于 / 更新面板。更新渠道是写死在客户端里的公开发布地址，
 * 跟用户自搭服务端的登录态无关，所以登录页也能检查、下载、安装。
 */
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { relaunch } from '@tauri-apps/plugin-process';
import type { ClientPlatform } from './api';
import './about.css';

const AUTO_UPDATE_KEY = 'deskalarm.autoUpdate';
const UPDATE_RESULT_KEY = 'deskalarm.updateResult';
const AUTO_INTERVAL_MS = 30 * 60_000;

const RELEASES = [
  { label: 'Gitee 发行版', url: 'https://gitee.com/huaxudong/desk-alarm/releases' },
  { label: 'GitHub Releases', url: 'https://github.com/soldier-cv/desk-alarm/releases' },
];

interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  source: string;
  sourceUrl: string;
  mirrorStale: boolean;
  message: string;
  releasePage: string;
}
interface UpdateResult { at: number; available: boolean; version: string; message: string }

let platform: ClientPlatform = 'web';
let notify: (msg: string) => void = () => {};
let downloadedVersion: string | null = null;
let lastSourceUrl = '';
let autoTimer: number | null = null;
let overlay: HTMLElement | null = null;
let statusEl: HTMLElement | null = null;
let actionBtn: HTMLButtonElement | null = null;
let versionEl: HTMLElement | null = null;
const listeners = new Set<() => void>();

function hasTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}
function isAndroid(): boolean { return platform === 'android'; }
function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}
function msgOf(e: unknown): string { return e instanceof Error ? e.message : String(e); }

function lastResult(): UpdateResult | null {
  try { return JSON.parse(localStorage.getItem(UPDATE_RESULT_KEY) ?? 'null') as UpdateResult | null; }
  catch { return null; }
}
function saveResult(r: UpdateResult | null): void {
  if (r) localStorage.setItem(UPDATE_RESULT_KEY, JSON.stringify(r));
  else localStorage.removeItem(UPDATE_RESULT_KEY);
  emitChange();
}
function emitChange(): void { for (const cb of listeners) cb(); }

export function onUpdateChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function updateBadge() {
  const r = lastResult();
  return {
    available: !!r?.available,
    ready: !!r?.available && downloadedVersion === r.version,
    version: r?.version ?? '',
  };
}

export function autoUpdateEnabled(): boolean {
  return localStorage.getItem(AUTO_UPDATE_KEY) === 'on';
}
export function setAutoUpdate(on: boolean): void {
  localStorage.setItem(AUTO_UPDATE_KEY, on ? 'on' : 'off');
  syncAutoTimer();
  if (on) void checkUpdate();
}
function syncAutoTimer(): void {
  if (autoTimer !== null) { clearInterval(autoTimer); autoTimer = null; }
  if (hasTauri() && autoUpdateEnabled() && !isAndroid()) {
    autoTimer = window.setInterval(() => void checkUpdate(true), AUTO_INTERVAL_MS);
  }
}

export function initUpdater(p: ClientPlatform, notifier: (msg: string) => void): void {
  platform = p;
  notify = notifier;
  if (!hasTauri() || !autoUpdateEnabled()) return;
  void invalidateStale();
  void checkUpdate(true);
  syncAutoTimer();
}

function versionNewer(a: string, b: string): boolean {
  const parse = (s: string) => s.replace(/^[vV]/, '').split('.').map((p) => parseInt(p, 10) || 0);
  const x = parse(a), y = parse(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const l = x[i] ?? 0, r = y[i] ?? 0;
    if (l !== r) return l > r;
  }
  return false;
}

async function invalidateStale(): Promise<void> {
  const r = lastResult();
  if (!r?.available || !hasTauri()) return;
  try {
    const cur = await getVersion();
    if (!versionNewer(r.version, cur)) {
      downloadedVersion = null;
      saveResult({ ...r, available: false, message: `当前已是最新版本 v${cur}` });
    }
  } catch { /* 拿不到版本就保留原样 */ }
}

function renderUpdateUI(): void {
  const r = lastResult();
  if (statusEl) {
    statusEl.textContent = !hasTauri() ? '检查更新只在客户端里可用'
      : !r ? '尚未检查'
      : !r.available ? `上次检查 ${new Date(r.at).toLocaleString('zh-CN')}：${r.message || '已是最新'}`
      : downloadedVersion === r.version ? `v${r.version} 已下载，点「安装」开始安装`
      : `发现 v${r.version}，点「下载」开始`;
  }
  if (actionBtn) {
    actionBtn.hidden = !hasTauri() || !r?.available;
    if (r?.available) {
      actionBtn.textContent = !isAndroid() && downloadedVersion === r.version
        ? `安装 v${r.version}`
        : isAndroid() ? `下载并安装 v${r.version}` : `下载 v${r.version}`;
    }
  }
}

async function checkUpdate(quiet = false): Promise<void> {
  if (!hasTauri()) { if (!quiet) notify('检查更新只在客户端里能用'); return; }
  const checkBtn = overlay?.querySelector<HTMLButtonElement>('#abt-check') ?? null;
  if (statusEl) statusEl.textContent = '检查中…';
  if (actionBtn) actionBtn.hidden = true;
  if (checkBtn) checkBtn.disabled = true;
  try {
    const info = await invoke<UpdateInfo>('check_update');
    if (!info) return;
    lastSourceUrl = info.sourceUrl || '';
    const prev = lastResult();
    if (!info.available || (prev && prev.version !== info.latestVersion)) downloadedVersion = null;
    saveResult({ at: Date.now(), available: info.available, version: info.latestVersion, message: info.message });
    if (!quiet) notify(info.available ? `发现新版本 v${info.latestVersion}，可在「关于」里下载` : (info.message || '当前已是最新版本'));
  } catch (e) {
    if (statusEl) statusEl.textContent = '检查失败：' + msgOf(e);
    if (!quiet) notify('检查更新失败：' + msgOf(e));
  } finally {
    if (checkBtn) checkBtn.disabled = false;
    renderUpdateUI();
  }
}

async function downloadApk(r: UpdateResult): Promise<void> {
  if (!lastSourceUrl) {
    if (statusEl) statusEl.textContent = '下载地址已失效，请重新检查更新';
    return;
  }
  if (actionBtn) actionBtn.disabled = true;
  if (statusEl) statusEl.textContent = '开始下载，请在通知栏查看进度…';
  try {
    await invoke('plugin:apk-installer|download_and_install', {
      url: lastSourceUrl,
      name: `deskalarm_${r.version.replace(/^v/, '')}_android-universal.apk`,
    });
    if (statusEl) statusEl.textContent = '下载完成，请在系统安装器中确认安装';
    if (actionBtn) actionBtn.hidden = true;
  } catch (e) {
    const msg = msgOf(e);
    const text = msg.includes('NEED_INSTALL_PERMISSION') ? '请先允许「安装未知应用」后重试' : '安装失败：' + msg;
    if (statusEl) statusEl.textContent = text;
    notify(text);
  } finally {
    if (actionBtn) actionBtn.disabled = false;
  }
}

async function downloadDesktop(): Promise<void> {
  if (actionBtn) { actionBtn.disabled = true; actionBtn.textContent = '下载中…'; }
  try {
    const version = await invoke<string>('download_update');
    if (!version) return;
    downloadedVersion = version;
    notify(`v${version} 下载完成，点「安装」开始安装`);
  } catch (e) {
    const msg = msgOf(e);
    if (msg.includes('已是最新')) {
      const r = lastResult();
      if (r) saveResult({ ...r, available: false, message: msg });
    }
    notify('下载失败：' + msg);
  } finally {
    if (actionBtn) actionBtn.disabled = false;
    renderUpdateUI();
  }
}

async function installDesktop(): Promise<void> {
  const prev = lastResult();
  if (prev) saveResult({ ...prev, available: false });
  downloadedVersion = null;
  if (actionBtn) { actionBtn.disabled = true; actionBtn.textContent = '安装中…'; }
  try {
    const done = await invoke<string>('install_update');
    notify(done || '更新已安装，重启后生效');
    await relaunch();
  } catch (e) {
    if (prev) saveResult(prev);
    notify('安装失败：' + msgOf(e));
  } finally {
    if (actionBtn) actionBtn.disabled = false;
    renderUpdateUI();
  }
}

async function onAction(): Promise<void> {
  const r = lastResult();
  if (!r?.available || !hasTauri()) return;
  if (isAndroid()) return void downloadApk(r);
  if (downloadedVersion === r.version) return void installDesktop();
  await downloadDesktop();
}

function onKey(e: KeyboardEvent): void { if (e.key === 'Escape') closeAbout(); }

function closeAbout(): void {
  if (!overlay) return;
  overlay.remove();
  overlay = null; statusEl = null; actionBtn = null; versionEl = null;
  document.removeEventListener('keydown', onKey);
}

export function openAbout(): void {
  closeAbout();
  overlay = document.createElement('div');
  overlay.className = 'abt-mask';
  overlay.innerHTML = `
    <div class="abt-card" role="dialog" aria-modal="true" aria-label="关于 DeskAlarm">
      <div class="abt-head">
        <div class="abt-mark"><i></i></div>
        <div><b>关于 DeskAlarm</b><small id="abt-ver">版本 —</small></div>
        <button class="abt-x" id="abt-close" aria-label="关闭">×</button>
      </div>
      <div class="abt-body">
        <p class="abt-desc">把「想做却总被搁置的事」变成可推进的项：随手记下、设个期限，服务端按节奏发出从轻到强的提醒，直到你推进它或主动放弃。数据只存在你自己的服务端，按用户隔离。</p>
        <div class="abt-links">
          ${RELEASES.map((r) => `<a href="${r.url}" target="_blank" rel="noreferrer" data-url="${r.url}">${esc(r.label)}</a>`).join('')}
        </div>
        <div class="abt-update">
          <div class="abt-sec-title">应用更新</div>
          <div class="abt-status" id="abt-status">尚未检查</div>
          <div class="abt-acts">
            <button class="btn ghost" id="abt-check">检查更新</button>
            <button class="btn solid" id="abt-act" hidden></button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  versionEl = overlay.querySelector('#abt-ver')!;
  statusEl = overlay.querySelector('#abt-status')!;
  actionBtn = overlay.querySelector('#abt-act')!;
  overlay.querySelector('#abt-close')!.addEventListener('click', closeAbout);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAbout(); });
  overlay.querySelectorAll<HTMLAnchorElement>('a[data-url]').forEach((a) => {
    a.addEventListener('click', (e) => {
      if (hasTauri() && !isAndroid()) {
        e.preventDefault();
        void invoke('open_external', { url: a.dataset.url });
      }
    });
  });
  overlay.querySelector('#abt-check')!.addEventListener('click', () => void checkUpdate());
  actionBtn.addEventListener('click', () => void onAction());
  document.addEventListener('keydown', onKey);

  if (hasTauri()) {
    void getVersion().then((v) => { if (versionEl) versionEl.textContent = `版本 v${v}`; })
      .catch(() => { if (versionEl) versionEl.textContent = '版本未知'; });
  }
  renderUpdateUI();
}

onUpdateChange(() => renderUpdateUI());
