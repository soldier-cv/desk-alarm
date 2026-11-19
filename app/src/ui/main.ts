/**
 * 主窗口，整个应用的脑子：持有 HTTP/WS 连接、AlarmController、本地状态。
 * takeover 和 capture 只负责画和发意图
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import {
  ApiError, Realtime, api, clearToken, dayLabel, getMachineId, getPlatform, hhmm, hostOf,
  lateBy, loadConfig, normalizeBaseUrl, parseInput, probeServer, saveConfig,
  serverNow, switchServer, urgencyOf,
  type AckAction, type AgentScope, type Device, type Dismissal, type Entry, type Overview, type ServerMessage,
} from '../api';
import { relaunch } from '@tauri-apps/plugin-process';
import { AlarmController, dropWeakByEntry, onWeakChange, pushWeak } from '../alarm';
import { THEMES, applyTheme, loadTheme, saveTheme } from '../theme';
import '../styles.css';

/** 与 src-tauri/src/update.rs 的 UpdateInfo 对应 */
interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  source: string;
  mirrorStale: boolean;
  message: string;
  releasePage: string;
}

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * 原生能力调用。用户点了按钮就必须有反馈，原来静默失败看着像按钮坏了。
 * invoke 缺 __TAURI_INTERNALS__ 时会同步抛，只 catch Promise 罩不住，所以先探一下
 */
function hasTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

function native<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!hasTauri()) {
    flash('这个功能只在桌面客户端里可用');
    return Promise.resolve(null);
  }
  return invoke<T>(cmd, args).catch((err: unknown) => {
    flash('操作失败：' + (err instanceof Error ? err.message : String(err)));
    return null;
  });
}

/** 内部触发的原生调用（响铃、接管窗口）。没有桌面能力时安静跳过，不打扰用户 */
function quiet<T = void>(cmd: string, args?: Record<string, unknown>): void {
  if (!hasTauri()) return;
  void invoke<T>(cmd, args).catch(() => { /* 没通知权限就算了，横幅还在 */ });
}

/** 跨窗口事件。浏览器里没有 Tauri 事件系统，emit 一样会同步抛，不能直接调 */
function send(name: string, payload: unknown = {}) {
  if (!hasTauri()) return;
  void emit(name, payload).catch(() => { /* 窗口已关 */ });
}

function on<T>(name: string, fn: (payload: T) => void) {
  if (!hasTauri()) return;
  void listen<T>(name, (ev) => fn(ev.payload)).catch(() => { /* 窗口已关 */ });
}

/* ------------------------------------------------------------ 状态 */

type View = 'today' | 'upcoming' | 'inbox' | 'all' | 'done' | 'dismissed' | 'neglected' | 'dashboard' | 'tokens';

const VIEWS: Record<View, { title: string; sub: string }> = {
  today: { title: '今天', sub: '' },
  upcoming: { title: '即将到来', sub: '未来 7 天' },
  inbox: { title: '收集箱', sub: '没定时间，先存着' },
  all: { title: '全部条目', sub: '' },
  done: { title: '已完成', sub: '保留 7 天后自动清理' },
  dismissed: { title: '已忽略', sub: '弱提示里点了「忽略」的记录，连带你写的理由' },
  neglected: { title: '老是被忽略', sub: '这些提醒可能该删了，或者降成弱提示' },
  dashboard: { title: '开发看板', sub: '服务端总览，仅管理员可见，每 5 秒刷新' },
  tokens: { title: 'Agent 令牌', sub: '给 MCP / Agent 用的访问令牌，每个用户都能签发自己的' },
};

const state = {
  view: 'today' as View,
  entries: [] as Entry[],
  dismissals: [] as Dismissal[],
  devices: [] as Device[],
  selected: null as string | null,
};

let rt: Realtime | null = null;

/** 本地直接改过之后，服务端回来的旧版本不覆盖输入框，谁也不希望打字打到一半被清掉 */
let editingLocal = false;

/** 启动时探测一次；桌面专属的按钮、设备行和自启项都看它 */
let platform: 'web' | 'windows' | 'macos' | 'linux' | 'android' = 'web';
const isDesktop = () => platform === 'windows' || platform === 'macos' || platform === 'linux';

/* ------------------------------------------------------- 强提醒链路 */

const alarm = new AlarmController({
  onNotify: (entry, attempt) => {
    quiet('ping', {
      title: attempt === 1 ? (entry.strength === 'weak' ? '提醒' : 'DeskAlarm') : `DeskAlarm（第 ${attempt} 次）`,
      body: entry.text,
    });
  },

  onShow: (entry) => {
    quiet('show_takeover', { entry, stage: 'banner', muted: false });
  },

  onEscalate: (entry) => {
    // 第 2 步：置顶 + 抖动 + 关不掉
    quiet('show_takeover', { entry, stage: 'escalated', muted: false });
  },

  onRepeat: (entry, attempt) => {
    quiet('show_takeover', { entry, stage: 'escalated', muted: false });
    quiet('ping', { title: `DeskAlarm（第 ${attempt} 次）`, body: entry.text });
  },

  onDismiss: (entry, reason) => {
    send('takeover:dismiss');
    if (reason === 'elsewhere') {
      quiet('ping', { title: 'DeskAlarm', body: '这条已在别的设备上处理掉了' });
    }
    void refresh();
  },
});

/* ---------------------------------------------------------- 登录页 */

function renderLogin() {
  const cfg = loadConfig();
  // Web 端没有原生 machine-id，也不建设备行；地址默认就是当前站点，别让用户自己拼
  const web = !hasTauri();
  const baseValue = cfg.baseUrl || (web ? location.origin : '');
  document.body.innerHTML = `
  <div class="login">
    <div class="login-card">
      <div class="mark"><i></i></div>
      <h1>DeskAlarm</h1>
      <p>用账号连接你的服务端。每台设备用自己的身份登录，提醒按用户隔离。</p>
      <form id="form">
        <div>
          <label for="base">服务端地址</label>
          <input class="input" id="base" placeholder="http://192.168.1.10:8787" value="${esc(baseValue)}" spellcheck="false" autocomplete="off">
          <div class="login-row">
            <span class="login-hint" id="probe">端口只填对外服务的那一个</span>
            <button type="button" class="btn sm" id="test">测试连接</button>
          </div>
        </div>
        <div class="row">
          <div>
            <label for="user">用户名</label>
            <input class="input" id="user" autocomplete="username" value="${esc(cfg.user?.username ?? '')}">
          </div>
          <div>
            <label for="code">密码</label>
            <input class="input" id="code" type="password" autocomplete="current-password">
          </div>
        </div>
        ${web ? '' : `
        <div>
          <label for="name">这台设备叫什么</label>
          <input class="input" id="name" value="${esc(cfg.deviceName)}">
        </div>`}
        <div class="login-err" id="err"></div>
        <button class="btn solid login-go" id="go">登录</button>
      </form>
    </div>
  </div>`;

  const err = $<HTMLDivElement>('#err')!;
  const go = $<HTMLButtonElement>('#go')!;
  const user = $<HTMLInputElement>('#user')!;
  const code = $<HTMLInputElement>('#code')!;
  const base = $<HTMLInputElement>('#base')!;
  const probe = $<HTMLSpanElement>('#probe')!;
  const test = $<HTMLButtonElement>('#test')!;
  (user.value ? code : user).focus();

  const submit = async () => {
    err.textContent = '';
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { err.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; return; }
    const username = user.value.trim();
    if (!username) { err.textContent = '请填用户名'; user.focus(); return; }
    if (!code.value) { err.textContent = '请填密码'; code.focus(); return; }
    go.disabled = true;
    go.textContent = '登录中';
    try {
      // 地址要先落盘再请求，否则这次登录还打的是旧地址
      switchServer(norm);
      base.value = norm;
      const name = web ? '' : ($<HTMLInputElement>('#name')?.value.trim() || '我的笔记本');
      const r = await api.login(username, code.value, name, web ? 'web' : 'windows');
      saveConfig({ user: r.user, deviceName: name, token: r.token, device: r.device });
      boot();
      // Web 本来就故意不建设备；桌面端没拿到才需要提醒用户
      if (!web && !r.device) flash('服务端没建设备，实时提醒不可用');
    } catch (e) {
      err.textContent = e instanceof ApiError && e.status === 401
        ? '用户名或密码不对'
        : '连不上服务端，确认地址和服务是否在跑';
      go.disabled = false;
      go.textContent = '登录';
    }
  };

  // 地址填错是新手最常撞的坑，先测一下再让他去猜账号
  test.addEventListener('click', async () => {
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { probe.textContent = '地址格式不对'; probe.className = 'login-hint bad'; return; }
    test.disabled = true;
    probe.textContent = '测试中...';
    probe.className = 'login-hint';
    const r = await probeServer(norm);
    test.disabled = false;
    probe.className = `login-hint ${r.ok ? 'ok' : 'bad'}`;
    probe.textContent = r.ok ? `连上了${r.skewMs ? `，时钟差 ${Math.round(r.skewMs / 1000)}s` : ''}` : r.reason;
  });

  $<HTMLFormElement>('#form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  go.addEventListener('click', () => void submit());
}

/* -------------------------------------------------- 首次管理员初始化 */

function renderSetup() {
  const baseValue = loadConfig().baseUrl;
  document.body.innerHTML = `
  <div class="login">
    <div class="login-card">
      <div class="mark"><i></i></div>
      <h1>初始化管理员</h1>
      <p>这个服务端还没有管理员。创建第一个账号后即可登录使用，此入口只会显示一次。</p>
      <form id="form">
        <div>
          <label for="base">服务端地址</label>
          <input class="input" id="base" placeholder="http://192.168.1.10:8787" value="${esc(baseValue)}" spellcheck="false" autocomplete="off">
          <div class="login-row">
            <span class="login-hint" id="probe">端口只填对外服务的那一个</span>
            <button type="button" class="btn sm" id="test">测试连接</button>
          </div>
        </div>
        <div>
          <label for="su-user">用户名</label>
          <input class="input" id="su-user" autocomplete="username">
        </div>
        <div class="row">
          <div>
            <label for="su-pass">密码</label>
            <input class="input" id="su-pass" type="password" autocomplete="new-password">
          </div>
          <div>
            <label for="su-confirm">确认密码</label>
            <input class="input" id="su-confirm" type="password" autocomplete="new-password">
          </div>
        </div>
        <div class="login-err" id="err"></div>
        <button class="btn solid login-go" id="go">创建管理员</button>
      </form>
      <div class="login-foot">
        密码至少 8 位，两次输入必须一致。
        <div class="login-row" style="margin-top:8px">
          <button type="button" class="btn sm" id="to-login">服务端已有管理员？去登录</button>
        </div>
      </div>
    </div>
  </div>`;

  const err = $<HTMLDivElement>('#err')!;
  const go = $<HTMLButtonElement>('#go')!;
  const base = $<HTMLInputElement>('#base')!;
  const probe = $<HTMLSpanElement>('#probe')!;
  const test = $<HTMLButtonElement>('#test')!;
  $<HTMLInputElement>('#su-user')!.focus();

  const submit = async () => {
    err.textContent = '';
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { err.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; return; }
    const username = $<HTMLInputElement>('#su-user')!.value.trim();
    const password = $<HTMLInputElement>('#su-pass')!.value;
    const confirm = $<HTMLInputElement>('#su-confirm')!.value;
    if (!username) { err.textContent = '请填用户名'; return; }
    if (password.length < 8) { err.textContent = '密码至少 8 位'; return; }
    if (password !== confirm) { err.textContent = '两次密码不一致'; return; }
    go.disabled = true;
    go.textContent = '创建中…';
    try {
      // 地址要先落盘再请求，否则这次初始化还打的是旧地址
      switchServer(norm);
      base.value = norm;
      const machineId = await getMachineId();
      const r = await api.setup({ username, password, confirmPassword: confirm, machineId });
      saveConfig({ token: r.token, user: r.user, device: r.device });
      boot();
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : '连不上服务端，确认地址和服务是否在跑';
      go.disabled = false;
      go.textContent = '创建管理员';
    }
  };

  test.addEventListener('click', async () => {
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { probe.textContent = '地址格式不对'; probe.className = 'login-hint bad'; return; }
    test.disabled = true;
    probe.textContent = '测试中...';
    probe.className = 'login-hint';
    const r = await probeServer(norm);
    test.disabled = false;
    probe.className = `login-hint ${r.ok ? 'ok' : 'bad'}`;
    probe.textContent = r.ok ? '连上了' : r.reason;
  });

  $<HTMLFormElement>('#form')!.addEventListener('submit', (ev) => { ev.preventDefault(); void submit(); });
  go.addEventListener('click', () => void submit());
  $<HTMLButtonElement>('#to-login')!.onclick = () => renderLogin();
}

/* ------------------------------------------------------------ 主题 */

/** 按钮上显示「切过去之后是什么」，比显示当前状态更好懂 */
function renderThemeButton() {
  const btn = $<HTMLButtonElement>('#btn-theme');
  if (!btn) return;
  const cur = loadTheme();
  const next = THEMES.find((t) => t.id !== cur)!;
  const now = THEMES.find((t) => t.id === cur)!;
  btn.textContent = next.label;
  btn.title = `当前：${now.label}（${now.hint}）。点击切到${next.label}`;
}

/* ------------------------------------------------------------ 主界面 */

function renderShell() {
  document.body.innerHTML = `
  <div class="app">
    <div class="topbar">
      <span class="logo"><i></i></span>
      <b>DeskAlarm</b>
      <div class="sp"></div>
      <div class="conn no-drag" id="btn-server" title="点击切换服务端"><span class="sdot off" id="sdot"></span><span id="stxt">未连接</span></div>
      <button class="btn sm no-drag" id="btn-theme" title="切换配色"></button>
      ${isDesktop() ? `
      <button class="btn sm no-drag" id="btn-hotkey" title="全局热键 Ctrl+Shift+Space"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd> 快速记</button>
      <button class="btn sm no-drag" id="btn-test">试响</button>
      <button class="btn sm no-drag" id="btn-update" title="检查更新">更新</button>
      <button class="btn sm no-drag" id="btn-hide">缩到托盘</button>` : ''}
    </div>

    <div id="weak-host"></div>

    <div class="capture-bar">
      <div class="capture-in">
        <span class="prompt">&gt;</span>
        <input id="cap" placeholder="粘一句话、链接或目录，回车进收集箱，填时间就变提醒">
        <button class="btn sm solid" id="cap-go">存为提醒</button>
      </div>
      <div class="parse" id="parse" hidden>
        <span class="lb">已识别</span>
        <span class="chip" id="p-kind"></span>
        <span class="chip" id="p-time"></span>
        <span class="chip" id="p-strength"></span>
        <span class="chip">推送：全部在线设备</span>
      </div>
    </div>

    <div class="body">
      <nav class="sidebar" id="sidebar"></nav>
      <main class="list">
        <div class="list-head">
          <h1 id="vtitle"></h1>
          <p id="vsub"></p>
        </div>
        <div class="list-scroll" id="list"></div>
      </main>
      <aside class="editor" id="editor"></aside>
    </div>

    <div class="statusbar">
      <span id="s-server">服务端 -</span>
      <span class="skew">时钟偏差 <span class="mono" id="s-skew">0 ms</span></span>
      <div class="sp"></div>
      ${isDesktop() ? '<span>开机自启 <b id="s-auto">-</b></span>' : ''}
      <span>登录为 <b id="s-user">${esc(loadConfig().user?.username ?? '?')}</b></span>
      <button class="btn sm" id="btn-logout">退出登录</button>
    </div>
  </div>`;

  if (isDesktop()) {
    $<HTMLButtonElement>('#btn-hide')!.onclick = () => void native('hide_main');
    $<HTMLButtonElement>('#btn-test')!.onclick = () => {
      void native('ping', { title: '试响', body: '能听到声音就说明这台设备没问题' });
    };
    $<HTMLButtonElement>('#btn-hotkey')!.onclick = () => void native('show_capture');
    $<HTMLButtonElement>('#btn-update')!.onclick = () => void checkUpdate();
  }
  // 点连接状态就能换服务端地址，不用翻设置
  $<HTMLElement>('#btn-server')!.onclick = () => openServerPanel();
  renderThemeButton();
  $<HTMLButtonElement>('#btn-theme')!.onclick = () => {
    saveTheme(loadTheme() === 'dark' ? 'morandi' : 'dark');
    renderThemeButton();
    // capture / takeover 是独立窗口，配置变化靠事件通知它们重读
    send('theme:changed', { theme: loadTheme() });
  };
  $<HTMLButtonElement>('#btn-logout')!.onclick = () => {
    rt?.close();
    clearToken();
    location.reload();
  };

  const cap = $<HTMLInputElement>('#cap')!;
  const parse = $<HTMLDivElement>('#parse')!;
  const pKind = $<HTMLSpanElement>('#p-kind')!;
  const pTime = $<HTMLSpanElement>('#p-time')!;
  const pStr = $<HTMLSpanElement>('#p-strength')!;

  const preview = () => {
    const v = cap.value;
    if (!v.trim()) { parse.hidden = true; return; }
    const p = parseInput(v);
    parse.hidden = false;
    pKind.className = `chip ${p.kind === 'text' ? '' : 'hot'}`;
    pKind.textContent = p.kindLabel;
    pTime.className = `chip ${p.remindAt ? 'hot' : ''}`;
    pTime.textContent = p.remindAt ? `提醒：${p.timeLabel}` : '没有时间，进收集箱';
    pStr.className = `chip ${p.strength === 'strong' ? 'hot' : ''}`;
    pStr.textContent = p.strength === 'strong' ? '强提示，会弹全屏' : '弱提示，只出通知';
  };
  cap.addEventListener('input', preview);
  cap.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void submitCapture(cap.value); });
  $<HTMLButtonElement>('#cap-go')!.onclick = () => void submitCapture(cap.value);

  $<HTMLElement>('#sidebar')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (b) setView(b.dataset.view as View);
  });

  $<HTMLElement>('#list')!.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const box = t.closest<HTMLElement>('[data-toggle]');
    const more = t.closest<HTMLElement>('[data-more]');
    const row = t.closest<HTMLElement>('[data-id]');
    if (box) { void toggleDone(box.dataset.toggle!); return; }
    if (more) { void promptSnooze(more.dataset.more!); return; }
    if (row) { state.selected = row.dataset.id!; renderAll(); }
  });

  $<HTMLElement>('#editor')!.addEventListener('click', onEditorClick);
  $<HTMLElement>('#editor')!.addEventListener('input', onEditorInput);

  onWeakChange(renderWeakBanner);
  if (isDesktop()) {
    void native<boolean>('is_autostart_enabled').then((on) => {
      const el = $<HTMLElement>('#s-auto');
      if (el) el.textContent = on === null ? '未知' : on ? '开' : '关';
    });
  }
}

/* -------------------------------------------------------- 弱提示横幅 */

function renderWeakBanner(list: Entry[]) {
  const host = $<HTMLElement>('#weak-host');
  if (!host) return;
  if (list.length === 0) { host.innerHTML = ''; return; }

  host.innerHTML = `<div class="weak-host">${list.map((e) => `
    <div class="weak">
      <div class="weak-l">
        <b>${esc(e.text)}</b>
        ${e.note ? `<span>${esc(e.note)}</span>` : ''}
      </div>
      <div class="weak-acts">
        <button class="btn sm ghost" data-wact="done" data-id="${esc(e.id)}">完成</button>
        <button class="btn sm" data-wact="snooze" data-id="${esc(e.id)}">推迟 10 分钟</button>
        <button class="btn sm" data-wact="ignore" data-id="${esc(e.id)}">忽略</button>
      </div>
      <div class="weak-reason" data-for="${esc(e.id)}" hidden>
        <input class="input" placeholder="为什么不想现在处理？可留空" data-reason="${esc(e.id)}">
        <button class="btn sm solid" data-wact="confirm" data-id="${esc(e.id)}">记下并收起来</button>
        <button class="btn sm" data-wact="cancel">取消</button>
      </div>
    </div>`).join('')}</div>`;

  host.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-wact]');
    if (!b) return;
    const id = b.dataset.id ?? '';
    const act = b.dataset.wact!;
    const panel = id ? host.querySelector<HTMLElement>(`[data-for="${CSS.escape(id)}"]`) : null;
    const input = id ? host.querySelector<HTMLInputElement>(`[data-reason="${CSS.escape(id)}"]`) : null;

    if (act === 'done') { void weakDone(id); return; }
    if (act === 'snooze') { void weakSnooze(id); return; }
    if (act === 'ignore') { if (panel) panel.hidden = false; input?.focus(); return; }
    if (act === 'cancel') { if (panel) panel.hidden = true; return; }
    if (act === 'confirm') { void weakDismiss(id, input?.value.trim() || undefined); }
  };
}

async function weakDone(id: string) {
  dropWeakByEntry(id);
  const sent = rt?.ack(id, 'done') ?? false;
  if (!sent) { try { await api.done(id); } catch { /* 下次同步会纠正 */ } }
  void refresh();
}

async function weakSnooze(id: string) {
  dropWeakByEntry(id);
  const to = serverNow() + 10 * 60_000;
  const sent = rt?.ack(id, 'snooze', to) ?? false;
  if (!sent) { try { await api.snooze(id, { to }); } catch { /* ignore */ } }
  void refresh();
}

/**
 * 忽略。和「完成」语义不同：条目不关掉，只留一条带理由的记录。
 * 累计到阈值会自动降级并提示「该删了」
 */
async function weakDismiss(id: string, reason?: string) {
  dropWeakByEntry(id);
  const sent = rt?.dismiss(id, reason) ?? false;
  if (!sent) {
    try {
      const r = await api.dismiss(id, reason);
      if (r.suggestion) flash(r.suggestion);
    } catch { /* ignore */ }
  }
  void refresh();
}

// 版本比较与「镜像落后就改用 GitHub」在 Rust 侧做（update.rs），这里只管交互
/** 启动时后台查一次，一天最多一次。有新版本只提示，不自动安装 */
function autoCheckUpdate() {
  const KEY = 'deskalarm.lastUpdateCheck';
  const last = Number(localStorage.getItem(KEY) ?? 0);
  if (Date.now() - last < 24 * 3600_000) return;
  localStorage.setItem(KEY, String(Date.now()));
  if (!hasTauri()) return;
  void invoke<UpdateInfo>('check_update')
    .then((info) => {
      if (info?.available) flash(`发现新版本 v${info.latestVersion}，点顶栏「更新」安装`);
    })
    .catch(() => { /* 后台检查失败不该打扰用户 */ });
}

async function checkUpdate() {
  const btn = $<HTMLButtonElement>('#btn-update');
  if (!btn) return;
  if (!hasTauri()) {
    flash('检查更新只在客户端里能用');
    return;
  }

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    const info = await invoke<UpdateInfo>('check_update');
    if (!info) return;

    if (!info.available) {
      flash(info.message || '当前已是最新版本');
      return;
    }

    btn.textContent = '下载中…';
    flash(info.message);
    const done = await invoke<string>('install_update');
    // install 成功意味着新版已就位，重启才生效；失败时 Rust 那边已经给了原因
    flash(done || '更新已安装');
    await relaunch();
  } catch (err) {
    flash('检查更新失败：' + (err instanceof Error ? err.message : String(err)));
  } finally {
    btn.disabled = false;
    btn.textContent = label ?? '更新';
  }
}

/** 一次性的提示条 */
let flashTimer: number | null = null;
function flash(text: string) {
  let el = document.querySelector<HTMLElement>('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    el.className = 'flash';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('on');
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => el?.classList.remove('on'), 6000);
}

/** webview 里 navigator.clipboard 有时不可用，退回到选中文本复制 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* ------------------------------------------------------------ 渲染 */

let dashboardTimer: number | null = null;

function setView(v: View) {
  state.view = v;
  state.selected = null;
  if (dashboardTimer !== null) {
    clearInterval(dashboardTimer);
    dashboardTimer = null;
  }
  if (v === 'dashboard') {
    void refresh();
    dashboardTimer = window.setInterval(() => void refresh(), 5_000);
  } else {
    void refresh();
  }
}

function counts() {
  const live = state.entries.filter((e) => e.status !== 'done');
  const t = new Date(serverNow());
  t.setHours(0, 0, 0, 0);
  t.setDate(t.getDate() + 1);
  const cut = t.getTime();
  return {
    today: live.filter((e) => e.remindAt !== null && e.remindAt < cut).length,
    up: live.filter((e) => e.remindAt !== null && e.remindAt >= cut).length,
    inbox: live.filter((e) => e.remindAt === null).length,
    all: live.length,
    done: state.entries.filter((e) => e.status === 'done').length,
  };
}

function renderSidebar() {
  const c = counts();
  const nav: Array<[View, string, number]> = [
    ['today', '今天', c.today],
    ['upcoming', '即将到来', c.up],
    ['inbox', '收集箱', c.inbox],
    ['all', '全部条目', c.all],
    ['done', '已完成', c.done],
  ];
  const me = loadConfig().device;
  const others = state.devices.filter((d) => d.id !== me?.id);
  const bad = state.entries.filter((e) => e.status === 'missed').length;

  $<HTMLElement>('#sidebar')!.innerHTML = `
    ${nav.map(([v, label, n]) => `
      <button class="nav ${state.view === v ? 'on' : ''}" data-view="${v}">${label}
        <span class="count ${v === 'today' && bad > 0 ? 'alert' : ''}">${n}</span>
      </button>`).join('')}
    <div class="nav-sep"></div>
    <div class="nav-head">弱提示</div>
    <button class="nav ${state.view === 'dismissed' ? 'on' : ''}" data-view="dismissed">已忽略<span class="count">${state.dismissals.length}</span></button>
    <button class="nav ${state.view === 'neglected' ? 'on' : ''}" data-view="neglected">老是被忽略</button>
    <button class="nav ${state.view === 'tokens' ? 'on' : ''}" data-view="tokens">Agent 令牌</button>
    ${isDesktop() ? `
    <div class="nav-sep"></div>
    <div class="nav-head">推送设备</div>
    <div class="dev-list">
      <div class="nav static">
        <span class="sdot"></span>${esc(me?.name ?? '本机')}<span class="count">本机</span>
      </div>
      ${others.map((d) => `
        <div class="nav static" title="${esc(d.platform)} · ${esc(d.transport.toUpperCase())}">
          <span class="sdot ${d.online ? '' : d.pushReady ? 'off' : 'alert'}"></span>${esc(d.name)}
          <span class="count">${d.online ? '在线' : d.pushReady ? d.transport.toUpperCase() : '未配推送'}</span>
        </div>`).join('')}
      ${others.length === 0 ? '<div class="nav-note">还没有别的设备登录。同一账号在多台设备登录后，这里会列出来。</div>' : ''}
    </div>` : ''}
    <div class="sp"></div>
    ${loadConfig().user?.role === 'admin' ? `
    <button class="nav ${state.view === 'dashboard' ? 'on' : ''}" data-view="dashboard">开发看板</button>
    <div class="nav-sep"></div>` : ''}
    ${isDesktop() ? `<button class="nav" id="btn-autostart"><span class="sdot ${loadConfig().settings.sound === 'none' ? 'off' : ''}"></span>开机自启<span class="count" id="auto-state">-</span></button>` : ''}`;

  const auto = document.querySelector<HTMLButtonElement>('#btn-autostart');
  if (auto) {
    auto.onclick = async () => {
      const el = $<HTMLSpanElement>('#auto-state')!;
      const cur = el.dataset.on === '1';
      const now = await native<boolean>('set_autostart', { enable: !cur });
      if (now === null) { el.textContent = '失败'; return; }
      el.dataset.on = now ? '1' : '0';
      el.textContent = now ? '开' : '关';
    };
    void native<boolean>('is_autostart_enabled').then((on) => {
      const el = $<HTMLSpanElement>('#auto-state');
      if (!el) return;
      // 读不到就别显示「关」，那是在说一个不确定的事
      if (on === null) { el.textContent = '未知'; return; }
      el.dataset.on = on ? '1' : '0';
      el.textContent = on ? '开' : '关';
    });
  }
}

function renderDashboard(box: HTMLElement) {
  if (!box.querySelector('.dash')) {
    box.innerHTML = `
      <div class="dash">
        <div class="dash-grid">
          <section class="dash-card"><h3>服务健康</h3><div id="dash-health" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>调度器</h3><div id="dash-sched" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>条目状态</h3><div id="dash-entries" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>投递状态</h3><div id="dash-deliveries" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>设备</h3><div id="dash-devices" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>用户</h3><div id="dash-users" class="dash-body">读取中…</div></section>
        </div>
        <div class="dash-err" id="dash-err"></div>
        <div class="dash-foot">上次更新 <span id="dash-at">-</span> · 每 5 秒自动刷新</div>
      </div>`;
  }
  void loadOverview();
}

function put(id: string, html: string) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

async function loadOverview() {
  try {
    const o = await api.overview();
    put('dash-health', `
      <div>数据库 <b class="${o.db.ok ? 'ok' : 'danger'}">${o.db.ok ? '正常' : '异常'}</b></div>
      <div>运行时长 ${Math.round(o.uptimeMs / 60000)} 分钟</div>
      <div>服务端时间 ${new Date(o.serverTs).toLocaleTimeString('zh-CN')}</div>`);
    put('dash-sched', `
      <div>扫描间隔 ${o.scheduler.tickMs} ms · 轮转 ${o.scheduler.rotateMs} ms</div>
      <div>累计 tick <b>${o.scheduler.ticks}</b> · 轮转中 ${o.scheduler.rotating ? '是' : '否'}</div>
      <div>上次 ${o.scheduler.lastTickAt ? new Date(o.scheduler.lastTickAt).toLocaleTimeString('zh-CN') : '-'}</div>`);
    put('dash-entries', `
      <div>全部 <b>${o.entries.total}</b> · 待处理 ${o.entries.pending} · 逾期 ${o.entries.missed}</div>
      <div>收集箱 ${o.entries.inbox} · 已完成 ${o.entries.done}</div>
      <div>被反复忽略 ${o.entries.neglected}</div>`);
    const states = Object.entries(o.deliveries.byState).map(([k, v]) => `${k} ${v}`).join(' · ') || '无';
    const errs = o.deliveries.recentErrors;
    put('dash-deliveries', `
      <div>${esc(states)}</div>
      <div>最近失败 ${errs.length} 条</div>
      ${errs.slice(0, 3).map((e) => `<div class="dash-err-line" title="${esc(e.error)}">${esc(e.entryId)} → ${esc(e.deviceId)}</div>`).join('')}`);
    const plats = Object.entries(o.devices.byPlatform).map(([k, v]) => `${k} ${v}`).join(' · ') || '无';
    put('dash-devices', `<div>总数 <b>${o.devices.total}</b> · 在线 ${o.devices.online}</div><div>${esc(plats)}</div>`);
    put('dash-users', `<div>总数 <b>${o.users.total}</b></div>`);
    put('dash-at', new Date(o.serverTs).toLocaleTimeString('zh-CN'));
    put('dash-err', '');
  } catch (e) {
    put('dash-err', `<div class="dash-err-line">${esc(e instanceof Error ? e.message : String(e))}</div>`);
  }
}

function renderTokens(box: HTMLElement) {
  if (!box.querySelector('.tokens')) {
    box.innerHTML = `
      <div class="tokens">
        <div class="dash-grid">
          <section class="dash-card">
            <h3>我的 Agent 令牌</h3>
            <div id="tk-list" class="agent-list">读取中…</div>
          </section>
          <section class="dash-card">
            <h3>签发新令牌</h3>
            <div class="fld"><label>名称</label><input class="input" id="tk-name" spellcheck="false" placeholder="如「Claude Code」"></div>
            <div class="fld"><label>权限</label><select class="input" id="tk-scope"><option value="write">读写</option><option value="read">只读</option></select></div>
            <div class="fld">
              <label>绑定 machine-id（可选）</label>
              <input class="input mono" id="tk-mid" spellcheck="false" placeholder="留空则不绑定设备">
              <div class="hint">桌面端默认填本机 id，可以清空；云端 agent 留空即可。</div>
            </div>
            <div class="login-row">
              <span class="login-hint" id="tk-hint">令牌只显示一次，复制后妥善保存</span>
              <button type="button" class="btn sm solid" id="tk-issue">签发</button>
            </div>
            <div class="mid-row" style="margin-top:8px">
              <input class="input mono mid-val" id="tk-plain" readonly spellcheck="false" placeholder="新令牌（仅显示一次）">
              <button type="button" class="btn sm" id="tk-copy">复制</button>
            </div>
          </section>
        </div>
      </div>`;

    void getMachineId().then((id) => {
      const el = box.querySelector<HTMLInputElement>('#tk-mid');
      if (el && id && !el.value) el.value = id;
    });

    const hint = box.querySelector<HTMLSpanElement>('#tk-hint')!;
    box.querySelector<HTMLButtonElement>('#tk-issue')!.onclick = async (ev) => {
      const name = box.querySelector<HTMLInputElement>('#tk-name')!.value.trim();
      if (!name) { hint.textContent = '先给令牌起个名字'; return; }
      const scope = box.querySelector<HTMLSelectElement>('#tk-scope')!.value as AgentScope;
      const machineId = box.querySelector<HTMLInputElement>('#tk-mid')!.value.trim();
      const btn = ev.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      hint.textContent = '签发中…';
      try {
        const r = await api.issueAgentToken({ name, scope, ...(machineId ? { machineId } : {}) });
        box.querySelector<HTMLInputElement>('#tk-plain')!.value = r.plain;
        hint.textContent = '已签发，令牌只显示这一次';
        void loadAgentTokens(box);
      } catch (e) {
        hint.textContent = e instanceof Error ? e.message : '签发失败';
      } finally {
        btn.disabled = false;
      }
    };

    box.querySelector<HTMLButtonElement>('#tk-copy')!.onclick = async () => {
      const plain = box.querySelector<HTMLInputElement>('#tk-plain')!.value;
      if (!plain) { hint.textContent = '还没有令牌可复制'; return; }
      const ok = await copyText(plain);
      hint.textContent = ok ? '已复制令牌' : '复制失败，请手动选中';
    };
  }
  void loadAgentTokens(box);
}

async function loadAgentTokens(box: HTMLElement) {
  const list = box.querySelector<HTMLElement>('#tk-list');
  if (!list) return;
  try {
    const { tokens } = await api.agentTokens();
    list.innerHTML = tokens.length
      ? tokens.map((t) => `
          <div class="agent-item">
            <span>${esc(t.name)} <span class="oc-muted">${esc(t.prefix)}… · ${t.scope} · ${new Date(t.createdAt).toLocaleString('zh-CN')}</span></span>
            <button type="button" class="btn sm" data-revoke="${esc(t.id)}">撤销</button>
          </div>`).join('')
      : '<div class="login-hint">还没有 Agent 令牌</div>';
    list.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api.revokeAgentToken(b.dataset.revoke!);
          void loadAgentTokens(box);
        } catch (e) {
          const hint = box.querySelector<HTMLSpanElement>('#tk-hint');
          if (hint) hint.textContent = e instanceof Error ? e.message : '撤销失败';
        }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="login-hint bad">${esc(e instanceof Error ? e.message : '读取令牌失败')}</div>`;
  }
}

function renderList() {
  const box = $<HTMLDivElement>('#list')!;

  if (state.view === 'dashboard') {
    renderDashboard(box);
    return;
  }
  if (state.view === 'tokens') {
    renderTokens(box);
    return;
  }

  // 已忽略是一张独立的表，不是条目列表
  if (state.view === 'dismissed') {
    if (state.dismissals.length === 0) {
      box.innerHTML = `<div class="empty"><b>还没有忽略过任何提醒</b>
        <p>弱提示里点「忽略」会出现在这里，连带你当时写的理由。</p></div>`;
      return;
    }
    box.innerHTML = state.dismissals.map((d) => `
      <div class="item">
        <div class="cbox static"></div>
        <div>
          <div class="it-time">${new Date(d.at).toLocaleString('zh-CN')}</div>
          <div class="it-title">${esc(d.text ?? '')}</div>
          <div class="it-meta">
            <span class="tag elsewhere">${esc(d.deviceName)} 忽略了</span>
            <span class="tag">${d.reason ? `理由：${esc(d.reason)}` : '没写理由'}</span>
          </div>
        </div>
        <div class="it-act">
          <button class="btn sm" data-more="${esc(d.entryId)}">再提醒我</button>
        </div>
      </div>`).join('');
    return;
  }

  const items = state.entries;
  if (items.length === 0) {
    const copy: Partial<Record<View, [string, string]>> = {
      today: ['这一段没有待办', '换个分类看看，或者在上面粘一条。'],
      upcoming: ['未来 7 天是空的', '想到什么就先记在收集箱，需要的时候再定时间。'],
      inbox: ['收集箱是空的', '直接在上面粘一句话、链接或目录，先存下来。'],
      all: ['还没有任何条目', '在上面粘一句话、链接或目录就能建一条。'],
      done: ['还没有完成的条目', '处理完的会留在这里 7 天。'],
      neglected: ['没有被反复忽略的提醒', '说明目前的提醒强度定得还挺准。'],
    };
    const [b, p] = copy[state.view] ?? ['空的', ''];
    box.innerHTML = `<div class="empty"><b>${b}</b><p>${p}</p></div>`;
    return;
  }

  const groups: Array<[string, Entry[], boolean]> = [];
  if (state.view === 'today' || state.view === 'all' || state.view === 'neglected') {
    groups.push(['已逾期', items.filter((e) => e.status === 'missed'), true]);
    groups.push(['已提醒', items.filter((e) => e.status === 'pending' && e.remindAt !== null), false]);
    groups.push(['收集箱 · 不定时', items.filter((e) => e.remindAt === null && e.status !== 'done'), false]);
  } else {
    groups.push([VIEWS[state.view].title, items, false]);
  }

  box.innerHTML = groups
    .filter(([, arr]) => arr.length > 0)
    .map(([label, arr, hot]) => `
      <div class="group ${hot ? 'hot' : ''}">${label}<div class="line"></div><span class="mono">${arr.length}</span></div>
      ${arr.map(rowHtml).join('')}`)
    .join('');
}

/** 重复提醒的标签。none 不显示 */
const REPEAT_LABEL: Record<string, string> = { daily: '每天', weekly: '每周', monthly: '每月' };

function rowHtml(e: Entry): string {
  const missed = e.status === 'missed';
  const done = e.status === 'done';
  const nameOf = (id: string) => state.devices.find((x) => x.id === id)?.name ?? id;

  // 标签要克制：一行里堆五六个标签，用户就一个都看不见了。
  // 只留会影响行为的那些，其余放进 title
  let meta = '';
  if (e.url) meta += `<span class="tag host" title="${esc(e.url)}">${esc(hostOf(e.url))}</span>`;
  if (e.path) meta += `<span class="tag path" title="${esc(e.path)}">${esc(e.path)}</span>`;
  if (e.repeat !== 'none') {
    meta += `<span class="tag">${REPEAT_LABEL[e.repeat] ?? e.repeat}</span>`;
  }
  // 强提示是稀缺的，值得标出来；弱提示是常态，标了只会变成噪声。
  // 逾期行已经有火色的时间，再叠一个「还没处理」就是重复喊同一件事
  if (e.strength === 'strong' && !missed) meta += '<span class="tag due">强提示</span>';
  if (e.bypassQuiet) meta += '<span class="tag">绕过静音</span>';
  if (e.dismissCount > 0) meta += `<span class="tag due">被忽略 ${e.dismissCount} 次</span>`;
  if (done && e.doneDevice) meta += `<span class="tag elsewhere">已在「${esc(e.doneDevice)}」完成</span>`;

  const pushHint = e.devices[0] === '*'
    ? '推给全部在线设备'
    : `仅推送到：${e.devices.map(nameOf).join(' / ')}`;

  const u = urgencyOf(e);
  const label = timeLabel(e);
  // 逾期时长单独包一层，tick 只换它；整行重写会冲掉用户选中的文字
  const timeText = missed ? missedTimeHtml(e) : esc(label);

  return `
  <div class="item${done ? ' done' : ''}${u === 'none' ? '' : ` u-${u}`}${state.selected === e.id ? ' on' : ''}"
       data-id="${esc(e.id)}" data-u="${u}" data-tl="${esc(label)}" title="${esc(pushHint)}">
    <div class="cbox" data-toggle="${esc(e.id)}" role="checkbox" aria-checked="${done ? 'true' : 'false'}"
         aria-label="${done ? '标记为未完成' : '完成'}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4"><path d="M4 12.5l5 5L20 6.5"/></svg>
    </div>
    <div>
      <div class="it-time">${u === 'none' ? '' : `<i class="udot ${u}"></i>`}<span class="it-time-text">${timeText}</span></div>
      <div class="it-title">${esc(e.text)}</div>
      <div class="it-meta">${meta}</div>
    </div>
    <div class="it-act">
      <button class="btn sm" data-more="${esc(e.id)}">推迟</button>
    </div>
  </div>`;
}

/** 逾期时长锚在「应到时间」，firedAt 是补火时刻，重启后会把它冲成刚过 */
function lateText(e: Entry): string {
  return e.remindAt === null ? '' : lateBy(e.remindAt);
}

function missedTimeHtml(e: Entry): string {
  return `${dayLabel(e.remindAt!)} ${hhmm(e.remindAt!)} · <span class="late-time">${esc(lateText(e))}</span> 还没处理`;
}

/** 时间行文案。一小时内报「还有 X 分钟」，临近时差多少比几点钟有用 */
function timeLabel(e: Entry): string {
  if (e.status === 'missed') {
    return `${dayLabel(e.remindAt!)} ${hhmm(e.remindAt!)} · ${lateText(e)} 还没处理`;
  }
  const u = urgencyOf(e);
  if (e.remindAt === null) return '收集箱 · 不定时';
  if (u === 'due' || u === 'close') {
    const m = Math.max(1, Math.round((e.remindAt - serverNow()) / 60_000));
    return m < 60 ? `还有 ${m} 分钟` : `还有 ${Math.round(m / 60)} 小时`;
  }
  return `${dayLabel(e.remindAt)} ${hhmm(e.remindAt)}`;
}

/**
 * 临近度随时间自己走，事件刷新不推进它，所以每 20 秒原地更新行：
 * 不改列表整体 innerHTML，滚动位置和选中态不丢
 */
function tickUrgency() {
  const box = document.querySelector<HTMLElement>('.list-scroll');
  if (!box || state.entries.length === 0) return;

  for (const e of state.entries) {
    if (e.status === 'done' || e.remindAt === null) continue;
    const row = box.querySelector<HTMLElement>(`[data-id="${CSS.escape(e.id)}"]`);
    if (!row) continue;

    const u = urgencyOf(e);
    if (e.status === 'missed') {
      if (row.dataset.u !== 'over') {
        row.dataset.u = 'over';
        row.dataset.tl = '';
        row.classList.remove('u-soon', 'u-close', 'u-due');
        row.classList.add('u-over');
        const t = row.querySelector<HTMLElement>('.it-time');
        // 刚从非逾期切过来时还没有时长 span，这一次得整行补上
        if (t && !t.querySelector('.late-time')) {
          t.innerHTML = `<i class="udot over"></i><span class="it-time-text">${missedTimeHtml(e)}</span>`;
        }
      }
      // 只换时长这一段，整行重写会冲掉用户选中的文字
      const lt = row.querySelector<HTMLElement>('.late-time');
      if (lt) {
        const next = lateText(e);
        if (lt.textContent !== next) lt.textContent = next;
      }
      continue;
    }

    const label = timeLabel(e);
    if (row.dataset.u === u && row.dataset.tl === label) continue;

    row.dataset.u = u;
    row.dataset.tl = label;
    row.classList.remove('u-soon', 'u-close', 'u-due', 'u-over');
    if (u !== 'none') row.classList.add(`u-${u}`);

    const timeEl = row.querySelector('.it-time');
    if (timeEl) timeEl.innerHTML = `${u === 'none' ? '' : `<i class="udot ${u}"></i>`}<span class="it-time-text">${esc(label)}</span>`;
  }
}

function renderEditor() {
  const box = $<HTMLElement>('#editor')!;
  const e = state.entries.find((x) => x.id === state.selected);

  // 用户正在这个输入框里打字时不要重画，否则光标和没提交的字都会丢。
  // 条目已经不在了（删掉/换视图）则一定要重画成空状态
  const focused = document.activeElement as HTMLElement | null;
  if (e && editingLocal && focused && box.contains(focused) && focused.id === 'f-t') return;

  if (!e) {
    box.innerHTML = `
      <div class="ed-head">编辑条目</div>
      <div class="ed-empty">
        <b>没有选中的条目</b>
        <p>点左边任意一条来设置强度、时间、推送设备和备注。</p>
      </div>`;
    return;
  }

  const me = loadConfig().device;
  const all = e.devices[0] === '*';
  const rep = [['', '不重复'], ['daily', '每天'], ['weekly', '每周'], ['monthly', '每月']];
  const others = state.devices.filter((d) => d.id !== me?.id);
  const d = new Date(e.remindAt ?? serverNow());
  const pad = (n: number) => String(n).padStart(2, '0');
  const s = loadConfig().settings;

  box.innerHTML = `
    <div class="ed-head">编辑条目</div>
    <div class="ed-body">
      <div class="fld">
        <label for="f-t">内容</label>
        <textarea class="input ed-textarea" id="f-t" rows="2">${esc(e.text)}</textarea>
      </div>

      <div class="fld">
        <label>提醒强度</label>
        <div class="seg">
          <button data-s="weak" class="${e.strength === 'weak' ? 'on' : ''}">弱提示</button>
          <button data-s="strong" class="${e.strength === 'strong' ? 'on hot' : ''}">强提示</button>
        </div>
        <div class="hint">${e.strength === 'strong'
          ? `会弹全屏接管窗口，${s.escalateAfterSec} 秒不处理就关不掉，之后每 ${Math.max(1, Math.round(s.repeatEverySec / 60))} 分钟再响一次`
          : '只出通知和顶部细横幅，可以「忽略」并写理由。不会打断手上的事'}</div>
        ${e.dismissCount >= s.autoDowngradeAfter && e.strength === 'weak'
          ? `<div class="hint warn">已经被忽略 ${e.dismissCount} 次${e.dismissCount >= s.neglectedAfter ? '，建议直接删掉' : ''}</div>`
          : ''}
      </div>

      <div class="fld">
        <label>提醒时间</label>
        <div class="seg">
          <button data-w="none" class="${e.remindAt === null ? 'on' : ''}">不定时</button>
          <button data-w="1h" class="${e.remindAt !== null ? 'on' : ''}">${e.remindAt === null ? '1 小时后' : '已定时'}</button>
        </div>
        ${e.remindAt !== null ? `
        <div class="date-row">
          <input class="input" type="date" id="f-d" value="${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}">
          <input class="input" type="time" id="f-tm" value="${pad(d.getHours())}:${pad(d.getMinutes())}">
        </div>
        <label class="quiet-row">
          <input type="checkbox" id="f-bq" ${e.bypassQuiet ? 'checked' : ''}>静音时段也照响
        </label>
        <div class="hint">服药这类硬提醒才勾。每天 ${Math.floor(s.quietStartMin / 60)}:${pad(s.quietStartMin % 60)} 到次日 ${Math.floor(s.quietEndMin / 60)}:${pad(s.quietEndMin % 60)} 之间默认不响。</div>
        ` : '<div class="hint">不定时的条目只留在收集箱，不会响铃。</div>'}
      </div>

      <div class="fld">
        <label>重复</label>
        <div class="seg">${rep.map(([v, l]) =>
          `<button data-r="${v}" class="${(e.repeat || 'none') === (v || 'none') ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>

      <div class="fld">
        <label>推送到</label>
        <div class="dev-pick">
          <div class="dev-opt ${all ? 'on' : ''}" data-all="1">
            <input type="checkbox" ${all ? 'checked' : ''}>
            <div class="nm"><b>全部在线设备</b><span>${state.devices.filter((x) => x.online).length} 台在线，离线的会排队补发</span></div>
          </div>
          ${others.map((x) => `
            <div class="dev-opt ${e.devices.includes(x.id) ? 'on' : ''}" data-dev="${esc(x.id)}">
              <input type="checkbox" ${e.devices.includes(x.id) ? 'checked' : ''}>
              <div class="nm"><b>${esc(x.name)}</b><span>${esc(x.platform)} · ${x.transport.toUpperCase()} · ${x.online ? '在线' : x.pushReady ? '离线' : '没配推送'}</span></div>
            </div>`).join('')}
        </div>
        <div class="hint">条目在所有设备同步，只有响铃按这个范围发。</div>
      </div>

      <div class="fld">
        <label for="f-n">备注</label>
        <textarea class="input ed-textarea" id="f-n" rows="3" placeholder="提醒时一起显示的内容">${esc(e.note ?? '')}</textarea>
      </div>
    </div>
    <div class="ed-foot">
      <button class="btn solid" data-do="done">完成</button>
      <button class="btn" data-do="tomorrow">推迟</button>
      <button class="btn danger sp-left" data-do="del">删除</button>
    </div>`;
}

function renderAll() {
  if (!$('#list')) return;
  const c = counts();
  const v = VIEWS[state.view];
  $<HTMLElement>('#vtitle')!.textContent = v.title;
  $<HTMLElement>('#vsub')!.textContent =
    state.view === 'today'
      ? `${c.today} 条需要处理，${state.entries.filter((e) => e.status === 'missed').length} 条已逾期`
      : v.sub;
  renderSidebar();
  renderList();
  if (state.view === 'dashboard' || state.view === 'tokens') $<HTMLElement>('#editor')!.innerHTML = '';
  else renderEditor();
  renderSkew();
}

function setLink(s: 'connecting' | 'open' | 'closed') {
  const dot = $<HTMLElement>('#sdot');
  const txt = $<HTMLElement>('#stxt');
  const srv = $<HTMLElement>('#s-server');
  const conn = $<HTMLElement>('#btn-server');
  if (!dot || !txt) return;

  dot.className = `sdot ${s === 'open' ? '' : s === 'connecting' ? 'warn' : 'alert'}`;
  txt.textContent = s === 'open' ? '已连接' : s === 'connecting' ? '连接中' : '已断开';
  // 断了要让用户知道会自动重连，否则只会以为程序坏了
  conn.title = s === 'closed'
    ? `已断开，正在自动重连。点击切换服务端（${loadConfig().baseUrl}）`
    : `点击切换服务端（${loadConfig().baseUrl}）`;
  if (srv) srv.textContent = `服务端 ${loadConfig().baseUrl}`;
}

const SKEW_MAX_AUTO = 10_000;

function renderSkew() {
  const skew = $<HTMLElement>('#s-skew');
  if (!skew) return;
  const ms = loadConfig().serverSkewMs;
  skew.textContent = Math.abs(ms) < 1000 ? `${ms} ms` : `${ms > 0 ? '+' : ''}${Math.round(ms / 1000)} s`;
  // 差出十秒以上，倒计时和「还有 X 分钟」会明显不准，得让人知道
  const box = skew.parentElement;
  if (box) box.classList.toggle('warn', Math.abs(ms) > SKEW_MAX_AUTO);
  skew.title = Math.abs(ms) > SKEW_MAX_AUTO
    ? '本机时钟和服务端差得比较多，倒计时可能有偏差。建议开启系统自动校时'
    : '本机时钟与服务端的偏差，由 welcome 消息算出';
}

/**
 * 切换服务端。换地址等于换一台机器：旧会话的 token 对新地址无效，
 * 所以清掉重新登录，别让用户以为地址没生效
 */
function openServerPanel() {
  if (document.querySelector('.panel-mask')) { document.querySelector('.panel-mask')!.remove(); return; }

  const host = document.createElement('div');
  host.className = 'panel-mask';
  host.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <b>服务端与本机设备</b>
        <div class="sp"></div>
        <button class="btn sm" id="sp-close">关闭</button>
      </div>
      <div class="panel-body">
        <label class="fld">
          <span>地址</span>
          <input class="input" id="sp-url" spellcheck="false" autocomplete="off"
                 value="${esc(loadConfig().baseUrl)}">
        </label>
        <div class="login-row">
          <span class="login-hint" id="sp-hint">同一账号的设备填同一个地址，就看同一份提醒</span>
          <button type="button" class="btn sm" id="sp-test">测试连接</button>
        </div>
        <div class="panel-err" id="sp-err"></div>
        <div class="mid-block">
          <span class="mid-title">本机 machine-id</span>
          <div class="mid-row">
            <input class="input mono mid-val" id="sp-mid" readonly spellcheck="false" value="读取中…">
            <button type="button" class="btn sm" id="sp-copy">复制</button>
          </div>
          <div class="login-hint">签发 Agent 令牌时可选绑定这个 id，绑定后 agent 只能以本机身份调用 MCP。</div>
        </div>
        ${loadConfig().user?.role === 'admin' ? `
        <div class="mid-block">
          <span class="mid-title">用户管理（管理员）</span>
          <div class="mid-row">
            <input class="input" id="sp-u-name" spellcheck="false" placeholder="用户名">
            <input class="input" id="sp-u-pass" type="password" placeholder="密码（至少 8 位）">
            <select class="input" id="sp-u-role">
              <option value="user">普通用户</option>
              <option value="admin">管理员</option>
            </select>
          </div>
          <div class="login-row">
            <span class="login-hint" id="sp-u-hint">不同用户之间的数据完全隔离</span>
            <button type="button" class="btn sm" id="sp-u-add">创建用户</button>
          </div>
          <div id="sp-u-list" class="agent-list"></div>
        </div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(host);

  const close = () => host.remove();
  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const hint = q<HTMLSpanElement>('#sp-hint');
  const err = q<HTMLDivElement>('#sp-err');
  const url = q<HTMLInputElement>('#sp-url');
  const form = q<HTMLFormElement>('.panel-body');

  const setHint = (text: string, kind: '' | 'ok' | 'bad' = '') => {
    hint.textContent = text;
    hint.className = `login-hint ${kind}`;
  };

  q<HTMLButtonElement>('#sp-close').onclick = close;
  host.addEventListener('click', (ev) => { if (ev.target === host) close(); });

  const mid = q<HTMLInputElement>('#sp-mid');
  void getMachineId().then((id) => { mid.value = id || '不是桌面客户端，没有 machine-id'; });
  q<HTMLButtonElement>('#sp-copy').onclick = async () => {
    const id = await getMachineId();
    if (!id) { setHint('拿不到 machine-id', 'bad'); return; }
    const ok = await copyText(id);
    setHint(ok ? '已复制 machine-id' : '复制失败，请手动选中', ok ? 'ok' : 'bad');
  };

  const uList = host.querySelector<HTMLDivElement>('#sp-u-list');
  if (uList) {
    const uHint = q<HTMLSpanElement>('#sp-u-hint');
    const me = loadConfig().user?.id;

    async function loadUsers() {
      try {
        const { users } = await api.users();
        uList!.innerHTML = users.map((u) => `
          <div class="agent-item">
            <span>${esc(u.username)} <span class="oc-muted">${u.role === 'admin' ? '管理员' : '用户'}${u.disabled ? ' · 已禁用' : ''}</span></span>
            <span>
              ${u.id === me ? '' : `<button type="button" class="btn sm" data-toggle="${esc(u.id)}" data-disabled="${u.disabled}">${u.disabled ? '启用' : '禁用'}</button>`}
              ${u.id === me ? '' : `<button type="button" class="btn sm" data-del="${esc(u.id)}">删除</button>`}
            </span>
          </div>`).join('');
        uList!.querySelectorAll<HTMLButtonElement>('[data-toggle]').forEach((b) => {
          b.onclick = async () => {
            await api.updateUser(b.dataset.toggle!, { disabled: b.dataset.disabled !== 'true' });
            await loadUsers();
          };
        });
        uList!.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
          b.onclick = async () => {
            if (!window.confirm('确认删除这个用户？他名下的提醒和设备会一起清掉。')) return;
            await api.deleteUser(b.dataset.del!);
            await loadUsers();
          };
        });
      } catch (e) {
        uHint.textContent = e instanceof Error ? e.message : '读取用户失败';
      }
    }
    void loadUsers();

    q<HTMLButtonElement>('#sp-u-add').onclick = async () => {
      const username = q<HTMLInputElement>('#sp-u-name').value.trim();
      const password = q<HTMLInputElement>('#sp-u-pass').value;
      const role = q<HTMLSelectElement>('#sp-u-role').value as 'user' | 'admin';
      if (!username || password.length < 8) { uHint.textContent = '用户名必填，密码至少 8 位'; return; }
      try {
        await api.createUser({ username, password, role });
        q<HTMLInputElement>('#sp-u-name').value = '';
        q<HTMLInputElement>('#sp-u-pass').value = '';
        uHint.textContent = '已创建';
        await loadUsers();
      } catch (e) {
        uHint.textContent = e instanceof Error ? e.message : '创建失败';
      }
    };
  }

  q<HTMLButtonElement>('#sp-test').onclick = async (ev) => {
    const norm = normalizeBaseUrl(url.value);
    if (!norm) { setHint('地址格式不对，需要 http:// 或 https:// 开头', 'bad'); return; }
    const btn = ev.currentTarget as HTMLButtonElement;
    btn.disabled = true;
    setHint('测试中...');
    const r = await probeServer(norm);
    btn.disabled = false;
    setHint(r.ok ? '连上了' : r.reason, r.ok ? 'ok' : 'bad');
  };

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn solid panel-submit';
  submitBtn.type = 'submit';
  submitBtn.textContent = '切换到此服务端';
  form.appendChild(submitBtn);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const norm = normalizeBaseUrl(url.value);
    if (!norm) { setHint('地址格式不对，需要 http:// 或 https:// 开头', 'bad'); return; }
    if (norm === loadConfig().baseUrl) { close(); return; }
    // 换地址等于换机器，旧 token 对新地址无效，清掉重新登录
    switchServer(norm);
    err.textContent = '已切换，正在重新登录...';
    rt?.close();
    location.reload();
  });

  url.focus();
  url.select();
}

/* ------------------------------------------------------------ 操作 */

async function refresh() {
  if (state.view === 'dashboard' || state.view === 'tokens') {
    renderAll();
    return;
  }
  try {
    if (state.view === 'dismissed') {
      const [d, devs] = await Promise.all([api.dismissed(), api.devices()]);
      state.dismissals = d.dismissals;
      state.devices = devs.devices;
    } else if (state.view === 'neglected') {
      const [n, devs] = await Promise.all([api.neglected(), api.devices()]);
      state.entries = n.entries;
      state.devices = devs.devices;
    } else {
      const [e, d] = await Promise.all([api.entries(state.view), api.devices()]);
      state.entries = e.entries;
      state.devices = d.devices;
    }
    if (state.selected && !state.entries.find((x) => x.id === state.selected)) {
      state.selected = null;
    }
    renderAll();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      clearToken();
      location.reload();
    }
  }
}

async function submitCapture(raw: string) {
  const text = raw.trim();
  if (!text) return;
  const p = parseInput(text);
  try {
    await api.create({
      text,
      kind: p.kind,
      url: p.kind === 'link' ? text : null,
      path: p.kind === 'path' ? text : null,
      remindAt: p.remindAt,
      strength: p.strength,
    });
    const cap = $<HTMLInputElement>('#cap');
    if (cap) { cap.value = ''; $<HTMLElement>('#parse')!.hidden = true; }
    if (p.remindAt !== null) setView('today');
    void refresh();
  } catch {
    send('capture:result', { ok: false, message: '保存失败，检查服务端连接' });
  }
}

async function toggleDone(id: string) {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return;
  try {
    if (e.status === 'done') {
      await api.update(id, { remindAt: e.remindAt, version: e.version });
    } else {
      // 走 WS 让所有设备同时停铃
      if (!(rt?.ack(id, 'done') ?? false)) await api.done(id);
    }
    void refresh();
  } catch { /* 列表会自己同步回来 */ }
}

/**
 * 行上的「推迟」。按钮叫推迟就该让用户选推迟多久，
 * 原来点一下直接跳到明天同一时间，和按钮上的字对不上
 */
const SNOOZE_CHOICES: Array<[string, number]> = [
  ['10 分钟', 10],
  ['30 分钟', 30],
  ['1 小时', 60],
  ['明天同一时间', -1],
];

async function promptSnooze(id: string) {
  const base = state.entries.find((x) => x.id === id);
  const pick = await chooseSnooze(base);
  if (pick === null) return;

  if (pick === 'rearm') {
    try { await api.rearm(id); } catch { flash('操作失败，检查服务端连接'); }
    void refresh();
    return;
  }

  try {
    await api.snooze(id, { to: pick });
    void refresh();
  } catch {
    flash('推迟失败，检查服务端连接');
  }
}

function chooseSnooze(base: Entry | undefined): Promise<'rearm' | number | null> {
  return new Promise((resolve) => {
    // 已完成/被忽略过的条目，先给一个「重新提醒」的入口
    const canRearm = base?.status === 'done' || (base?.dismissCount ?? 0) > 0;
    const host = document.createElement('div');
    host.className = 'panel-mask';
    host.innerHTML = `
      <div class="panel panel-sm" role="dialog" aria-modal="true">
        <div class="panel-head"><b>推迟到什么时候</b></div>
        <div class="panel-body">
          <div class="snooze-opts">
            ${SNOOZE_CHOICES.map(([label, min]) => `
              <button class="nav" data-min="${min}">${label}</button>`).join('')}
            ${canRearm ? '<button class="nav" data-rearm="1">现在就再提醒一次</button>' : ''}
          </div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const done = (v: 'rearm' | number | null) => {
      host.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); done(null); } };
    document.addEventListener('keydown', onKey);
    host.addEventListener('click', (ev) => {
      if (ev.target === host) { done(null); return; }
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-min],[data-rearm]');
      if (!b) return;
      if (b.dataset.rearm) { done('rearm'); return; }
      const min = Number(b.dataset.min);
      if (min < 0) {
        const d = new Date(base?.remindAt ?? serverNow());
        d.setDate(d.getDate() + 1);
        done(d.getTime());
      } else {
        done(serverNow() + min * 60_000);
      }
    });
    host.querySelector<HTMLElement>('.snooze-opts .nav')!.focus();
  });
}

function onEditorClick(ev: Event) {
  const t = (ev.target as HTMLElement)
    .closest<HTMLElement>('[data-s],[data-w],[data-r],[data-all],[data-dev],[data-do]');
  const e = state.entries.find((x) => x.id === state.selected);
  if (!t || !e) return;

  // 用最新的 version：render 之后别的设备可能已经改过，用旧版本号会被 409 顶回来
  const save = (patch: Record<string, unknown>) => {
    const cur = state.entries.find((x) => x.id === e.id) ?? e;
    return api.update(cur.id, { ...patch, version: cur.version })
      .then(refresh)
      .catch((err) => flashConflict(err, e.id));
  };

  const s = t.dataset.s;
  if (s) { void save({ strength: s }); return; }

  const w = t.dataset.w;
  if (w === 'none') { void save({ remindAt: null }); return; }
  if (w === '1h') { void save({ remindAt: serverNow() + 3600_000 }); return; }

  const r = t.dataset.r;
  if (r !== undefined) { void save({ repeat: r || 'none' }); return; }

  if (t.dataset.all) { void save({ devices: ['*'] }); return; }

  const dev = t.dataset.dev;
  if (dev) {
    const next = e.devices[0] === '*'
      ? state.devices.filter((x) => x.online && x.id !== dev).map((x) => x.id)
      : e.devices.includes(dev)
        ? e.devices.filter((x) => x !== dev)
        : [...e.devices, dev];
    void save({ devices: next.length ? next : ['*'] });
    return;
  }

  const doWhat = t.dataset.do;
  if (doWhat === 'done') { void toggleDone(e.id); return; }
  if (doWhat === 'del') { void confirmDelete(e); return; }
  if (doWhat === 'tomorrow') { void promptSnooze(e.id); return; }
}

/** 编辑器底部的推迟，和行上的「推迟」走同一套选择 */
async function snoozeEntry(e: Entry) {
  await promptSnooze(e.id);
}

/** 删除不可撤销，二次确认。焦点落在「取消」上，回车不会误删 */
async function confirmDelete(e: Entry) {
  const ok = await ask(`删除「${e.text.slice(0, 30)}${e.text.length > 30 ? '…' : ''}」？`, '删了找不回来', '删除');
  if (!ok) return;
  try {
    await api.remove(e.id);
    state.selected = null;
    void refresh();
  } catch {
    flash('删除失败，检查服务端连接');
  }
}

/** 轻量确认框，走统一的面板样式，不弹系统对话框 */
function ask(title: string, detail: string, confirmLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'panel-mask';
    host.innerHTML = `
      <div class="panel panel-sm" role="dialog" aria-modal="true">
        <div class="panel-body">
          <div class="confirm-title">${esc(title)}</div>
          <div class="confirm-detail">${esc(detail)}</div>
          <div class="confirm-acts">
            <button class="btn" data-confirm="no">取消</button>
            <button class="btn danger" data-confirm="yes">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(host);

    const done = (v: boolean) => {
      host.remove();
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); done(false); }
    };
    document.addEventListener('keydown', onKey);
    host.addEventListener('click', (ev) => {
      if (ev.target === host) { done(false); return; }
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-confirm]');
      if (b) done(b.dataset.confirm === 'yes');
    });
    // 焦点必须在模态里，回车要有明确落点，不能落到底下那个删除按钮上。
    // 默认停在「取消」：确认删除需要用户主动点一下
    host.querySelector<HTMLElement>('[data-confirm="no"]')!.focus();
  });
}

/**
 * 版本冲突不是错误，是别的设备先改了。提示一句并重新取一次最新值，
 * 让用户看到冲突后的真实内容，而不是自己刚输入的那份
 */
function flashConflict(err: unknown, entryId: string) {
  if (err instanceof ApiError && err.status === 409) {
    flash('这条刚在别的设备上改过，已刷新为最新内容');
  } else {
    flash('保存失败，检查服务端连接');
  }
  void refresh().then(() => {
    if (entryId) state.selected = entryId;
  });
}

function onEditorInput(ev: Event) {
  const t = ev.target as HTMLInputElement | HTMLTextAreaElement;
  const e = state.entries.find((x) => x.id === state.selected);
  if (!e) return;
  const w = window as unknown as Record<string, number>;

  // 输入框的 value 在触发时取一次就够了，version 要等真正发出前再取
  const id = e.id;
  const save = (build: () => Record<string, unknown> | null) => {
    const cur = state.entries.find((x) => x.id === id);
    if (!cur) return;
    const patch = build();
    if (!patch) return;
    editingLocal = true;
    api.update(id, { ...patch, version: cur.version })
      .then(refresh)
      .catch((err) => flashConflict(err, id))
      .finally(() => { editingLocal = false; });
  };

  if (t.id === 'f-t') {
    const value = t.value;
    clearTimeout(w.__deb);
    w.__deb = window.setTimeout(() => save(() => ({ text: value })), 400);
  }

  if (t.id === 'f-n') {
    const value = t.value;
    clearTimeout(w.__deb);
    w.__deb = window.setTimeout(() => save(() => ({ note: value || null })), 400);
  }

  if (t.id === 'f-tm' || t.id === 'f-d' || t.id === 'f-bq') {
    const bq = $<HTMLInputElement>('#f-bq')?.checked ?? false;
    const ds = $<HTMLInputElement>('#f-d')?.value;
    const ts = $<HTMLInputElement>('#f-tm')?.value;
    clearTimeout(w.__deb2);
    w.__deb2 = window.setTimeout(() => save(() => {
      const patch: Record<string, unknown> = { bypassQuiet: bq };
      if (ds && ts) {
        const at = new Date(`${ds}T${ts}`).getTime();
        // 日期框里打了一半（比如 2026-1）不该被当成一个有效时刻存进去
        if (Number.isNaN(at)) return null;
        patch.remindAt = at;
      }
      return patch;
    }), 500);
  }
}

/* ------------------------------------------------------ 跨窗口事件 */

function wireEvents() {
  // Tauri 事件在浏览器里会直接 reject，Web 端没有这些窗口/托盘事件
  if (!hasTauri()) return;
  listen<{ entryId: string; action: AckAction; snoozeTo?: number }>(
    'takeover:action', async (ev) => {
      const { entryId, action, snoozeTo } = ev.payload;
      if (!alarm.acknowledge(action, snoozeTo)) return;
      const sent = rt?.ack(entryId, action, snoozeTo) ?? false;
      if (!sent) {
        try {
          if (action === 'done') await api.done(entryId);
          else if (action === 'snooze' && snoozeTo) await api.snooze(entryId, { to: snoozeTo });
        } catch { /* 下次同步会纠正 */ }
      }
    },
  );

  listen<{ entryId: string; url: string }>('takeover:open-url', async (ev) => {
    const { entryId, url } = ev.payload;
    alarm.acknowledge('done');
    const sent = rt?.ack(entryId, 'done') ?? false;
    if (!sent) { try { await api.done(entryId); } catch { /* ignore */ } }
    quiet('open_external', { url });
  });

  listen<{ text: string; remindAt: number | null; kind: string; strength: string }>(
    'capture:submit', async (ev) => {
      const { text, remindAt, kind, strength } = ev.payload;
      try {
        await api.create({
          text, kind: kind as never, remindAt, strength: strength as never,
          url: kind === 'link' ? text : null,
          path: kind === 'path' ? text : null,
        });
        send('capture:result', { ok: true });
        void refresh();
      } catch (err) {
        send('capture:result', { ok: false, message: err instanceof Error ? err.message : '保存失败' });
      }
    },
  );

  listen('tray:capture', () => quiet('show_capture'));
  listen('hotkey:capture', () => quiet('show_capture'));
  listen('tray:quit', () => rt?.close());
}

/* ------------------------------------------------------------ 启动 */

function boot() {
  renderShell();
  wireEvents();
  setLink('connecting');
  rt = new Realtime(onRealtime, setLink);
  rt.connect();
  void refresh();

  // Web 没有设备行、不建 WS，只能靠轮询感知服务端变化
  if (!loadConfig().device) {
    window.setInterval(() => void refresh(), 10_000);
  }

  autoCheckUpdate();

  // 临近梯度随时间自己往前走，事件刷新不会推进它
  tickUrgency();
  window.setInterval(tickUrgency, 20_000);
}

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome': {
      // 上线补发。漏掉的强提示进响铃队列，弱提示进横幅
      for (const m of msg.missed) {
        quiet('ping', {
          title: '补发提醒',
          body: `${Math.max(1, Math.round(m.lateByMs / 60_000))} 分钟前就该响：${m.entry.text}`,
        });
        if (!alarm.fire(m.entry)) pushWeak(m.entry);
      }
      void refresh();
      break;
    }
    case 'entry.created':
    case 'entry.updated':
      // 服务端已经收紧了 fired_at，本地预判按 0 处理
      if (alarm.current?.id === msg.entry.id) alarm.dismissedElsewhere();
      dropWeakByEntry(msg.entry.id);
      void refresh();
      break;
    case 'entry.deleted':
      dropWeakByEntry(msg.entryId);
      void refresh();
      break;
    case 'entry.fired':
      // 触发事件只有服务端能发，本地不做权威计时
      if (!alarm.fire(msg.entry)) pushWeak(msg.entry);
      void refresh();
      break;
    case 'entry.acked':
      if (alarm.current?.id === msg.entryId) alarm.dismissedElsewhere();
      dropWeakByEntry(msg.entryId);
      void refresh();
      break;
    case 'entry.downgraded':
      // 服务端把条目自动降级了，告诉用户一句
      flash(`${msg.reason}：${msg.entry.text}`);
      void refresh();
      break;
    case 'devices.changed':
      state.devices = msg.devices;
      renderAll();
      break;
    case 'settings.changed':
      saveConfig({ settings: msg.settings });
      renderAll();
      break;
    default:
      break;
  }
}

// 先挂主题再渲染，否则会先闪一帧暗色再跳到浅色
applyTheme(loadTheme());

(async () => {
  // 首屏先定平台，桌面专属按钮才不会闪一下又消失
  platform = await getPlatform();
  const cfg = loadConfig();
  // 全新安装还没有地址，没法问服务端；直接给初始化页，让用户填地址并建管理员
  if (!cfg.token && !cfg.baseUrl) { renderSetup(); return; }
  try {
    if ((await api.setupStatus()).needed) { renderSetup(); return; }
  } catch { /* 连不上就走原来的登录/启动流程 */ }
  if (cfg.token) boot();
  else renderLogin();
})();

