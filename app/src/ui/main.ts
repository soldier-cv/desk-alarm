/**
 * 主窗口：「今日推进」工作台。持有 HTTP/WS 连接、跟进控制器和本地读模型。
 * 服务端是唯一的计时与策略权威，这里只负责呈现和把意图送回去。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { autoUpdateEnabled, initUpdater, onUpdateChange, openAbout, setAutoUpdate, updateBadge } from '../about';
import {
  ApiError, Realtime, api, clearToken, dayLabel, dueLabel, getMachineId, getPlatform,
  hhmm, hostOf, loadConfig, normalizeBaseUrl, noteFollowup, onUnauthorized, parseInput, probeServer,
  saveConfig, serverNow, staleLabel, switchServer,
  versionOf, warmthOf, FREQ_LABEL, IMPORTANCE_LABEL, NATURE_LABEL,
  type CountsResult, type Device, type Followup, type FollowupAction, type FocusResult, type Importance,
  type MyStats, type Overview, type Pursuit, type PursuitStatus, type PursuitView,
  type RecurrenceRule, type ServerMessage, type Settings, type StepState, type Urgency,
} from '../api';
import { actionsFor, effectiveImportance } from '../../../shared/types';
import { buildRecurrence, fieldsFor, ruleFields } from './recurrence-form';
import {
  FollowupController, dropBannerByPursuit, onBannerChange, pushBanner, type Banner,
} from '../alarm';
import { THEMES, applyTheme, loadTheme, saveTheme } from '../theme';
import { openDropdown, openTimePicker } from '../widgets';
import '../styles.css';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: string) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));

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

function quiet<T = void>(cmd: string, args?: Record<string, unknown>): void {
  if (!hasTauri()) return;
  void invoke<T>(cmd, args).catch(() => { /* 没有通知权限就算了，横幅还在 */ });
}

function ringPing(args: Record<string, unknown>) {
  if (loadConfig().settings.sound === 'none') return;
  quiet('ping', args);
}

function send(name: string, payload: unknown = {}) {
  if (!hasTauri()) return;
  void emit(name, payload).catch(() => { /* 窗口已关 */ });
}

/* ------------------------------------------------------------ 状态 */

type View = PursuitView | 'mystats' | 'dashboard' | 'tokens' | 'settings';

const VIEWS: Record<View, { title: string; sub: string }> = {
  today: { title: '今日推进', sub: '' },
  all: { title: '全部推进项', sub: '按权重排序' },
  inbox: { title: '收件箱', sub: '还没明确，先存着' },
  done: { title: '已完成', sub: '推进完成的事项' },
  archived: { title: '归档', sub: '不要了或长期停滞的事项' },
  mystats: { title: '我的推进看板', sub: '只看你自己的推进情况' },
  dashboard: { title: '系统看板', sub: '服务端总览，仅管理员可见，每 5 秒刷新' },
  tokens: { title: 'Agent 令牌', sub: '给 MCP / Agent 用的访问令牌' },
  settings: { title: '设置', sub: '推进节奏、设备安全、用户与日志' },
};

const state = {
  view: 'today' as View,
  focus: null as FocusResult | null,
  pursuits: [] as Pursuit[],
  followups: [] as Followup[],
  devices: [] as Device[],
  counts: null as CountsResult | null,
  selected: null as string | null,
};

let rt: Realtime | null = null;
let linkState: 'connecting' | 'open' | 'closed' = 'closed';
type TakeoverPayload = Record<string, unknown>;
/** 接管窗口的 webview 未必在亮窗时已加载完；它加载完会说一声，这里补发一次 payload */
let lastTakeover: TakeoverPayload | null = null;
listen('takeover:ready', () => {
  if (lastTakeover) void emit('takeover:show', lastTakeover);
});
/** 本机刚处理过的项，别把服务端广播误报成"别的设备处理了" */
const localHandled = new Map<string, number>();
let editingLocal = false;
let platform: 'web' | 'windows' | 'macos' | 'linux' | 'android' = 'web';
const isDesktop = () => platform === 'windows' || platform === 'macos' || platform === 'linux';
let captureImportance: Importance = 1;
const IMP_TITLE = ['', 'P2：默认优先级', 'P1：优先推进', 'P0：最高优先级，截止 24 小时内自动按 P0 排期'];
const ACTION_LABEL: Record<FollowupAction, string> = {
  done: '完成', later: '延期', smaller: '拆小', archive: '归档', reopen: '撤回',
};

function ruleFieldsHtml(freq: string, rf: { byWeekday: string; byMonthday: string; byMonth: string }): string {
  const shown = fieldsFor(freq as Parameters<typeof fieldsFor>[0]);
  const f = freq === 'yearly' ? 'yearly' : freq === 'quarterly' ? 'quarterly' : freq;
  return `
    <div class="rule-grid" style="margin-top:8px">
      ${shown.includes('weekday')
        ? `<label>周几（0=日，逗号分隔）<input class="input" id="f-byday" value="${esc(rf.byWeekday)}"></label>` : ''}
      ${shown.includes('month')
        ? `<label>月份（1-12）<input class="input" id="f-bymonth" type="number" min="1" max="12" value="${esc(rf.byMonth)}"></label>` : ''}
      ${shown.includes('monthday')
        ? `<label>${f === 'yearly' ? '几号' : f === 'quarterly' ? '每季度几号' : '每月几号'}<input class="input" id="f-bymonthday" type="number" min="1" max="31" value="${esc(rf.byMonthday)}"></label>` : ''}
    </div>
    <div class="set-actions"><button class="btn sm" data-act="save-rule">保存重复</button></div>`;
}

const control = new FollowupController({
  onSilent: () => { void refresh(); },
  onNotify: (p, _level, reason, attempt) => {
    ringPing({
      title: p.text,
      body: `${reason}${attempt > 1 ? ` · 第 ${attempt} 次` : ''}`,
    });
  },
  onBanner: (p, level, reason) => pushBanner(p, reason, level),
  onTakeover: (p, level, reason) => {
    const payload: TakeoverPayload = {
      pursuit: p, level, channel: 'takeover', reason,
      serverTs: serverNow(), stage: 'banner', muted: false,
    };
    lastTakeover = payload;
    // Rust 命令签名是 show_takeover(payload)，Tauri 按参数名取键，别把字段摊到顶层
    void invoke('show_takeover', { payload }).catch((err: unknown) => {
      flash('接管窗口启动失败：' + (err instanceof Error ? err.message : String(err)));
    });
  },
  onArchive: (p) => {
    flash(`长期停滞，已自动归档：${p.text}`);
    void refresh();
  },
  onStop: (p, reason) => {
    lastTakeover = null;
    quiet('hide_takeover');
    dropBannerByPursuit(p.id);
    if (reason === 'elsewhere' && Date.now() - (localHandled.get(p.id) ?? 0) > 3000) {
      flash('这条已在别的设备上处理掉了');
    }
    void refresh();
  },
});

/* -------------------------------------------------- 登录 / 初始化 */

function renderLogin() {
  const cfg = loadConfig();
  const web = !hasTauri();
  const baseValue = cfg.baseUrl || (web ? location.origin : '');
  document.body.innerHTML = `
  <div class="login">
    <div class="login-card">
      <div class="mark"><i></i></div>
      <h1>DeskAlarm</h1>
      <p>用账号连接你的服务端。每台设备用自己的身份登录，推进项按用户隔离。</p>
      <form id="form">
        <div>
          <label for="base">服务端地址</label>
          <input class="input" id="base" placeholder="http://192.168.1.10:8091" value="${esc(baseValue)}" spellcheck="false" autocomplete="off">
          <div class="login-row">
            <span class="login-hint" id="probe">端口只填对外服务的那一个</span>
            <button type="button" class="btn sm" id="test">测试连接</button>
          </div>
        </div>
        <div class="row">
          <div><label for="user">用户名</label>
            <input class="input" id="user" autocomplete="username" value="${esc(cfg.user?.username ?? '')}"></div>
          <div><label for="code">密码</label>
            <input class="input" id="code" type="password" autocomplete="current-password"></div>
        </div>
        ${web ? '' : `
        <div><label for="name">这台设备叫什么</label>
          <input class="input" id="name" value="${esc(cfg.deviceName)}"></div>`}
        <div class="login-err" id="err"></div>
        <button class="btn solid login-go" id="go">登录</button>
      </form>
      <div class="login-foot">
        DeskAlarm · 把想做却总被搁置的事推进下去
        <div class="login-row" style="margin-top:8px">
          <button type="button" class="btn sm" id="about-link">关于 / 检查更新</button>
        </div>
      </div>
    </div>
  </div>`;

  const err = $<HTMLDivElement>('#err');
  const go = $<HTMLButtonElement>('#go');
  const user = $<HTMLInputElement>('#user');
  const code = $<HTMLInputElement>('#code');
  const base = $<HTMLInputElement>('#base');
  const probe = $<HTMLSpanElement>('#probe');
  const test = $<HTMLButtonElement>('#test');
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
      switchServer(norm);
      base.value = norm;
      const name = web ? '' : ($<HTMLInputElement>('#name')?.value.trim() || '我的笔记本');
      const serverPlatform = web ? 'web' : platform === 'macos' ? 'mac' : platform;
      const r = await api.login(username, code.value, name, serverPlatform);
      saveConfig({ user: r.user, deviceName: name, token: r.token, device: r.device });
      boot();
      if (!web && !r.device) flash('服务端没建设备，实时提醒不可用');
    } catch (e) {
      err.textContent = e instanceof ApiError && e.status === 401
        ? '用户名或密码不对' : '连不上服务端，确认地址和服务是否在跑';
      go.disabled = false;
      go.textContent = '登录';
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
    probe.textContent = r.ok ? `连上了${r.skewMs ? `，时钟差 ${Math.round(r.skewMs / 1000)}s` : ''}` : r.reason;
  });

  $<HTMLFormElement>('#form')!.addEventListener('submit', (ev) => { ev.preventDefault(); void submit(); });
  go.addEventListener('click', () => void submit());
  $<HTMLButtonElement>('#about-link')!.onclick = () => openAbout();
}

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
          <input class="input" id="base" placeholder="http://192.168.1.10:8091" value="${esc(baseValue)}" spellcheck="false" autocomplete="off">
          <div class="login-row">
            <span class="login-hint" id="probe">端口只填对外服务的那一个</span>
            <button type="button" class="btn sm" id="test">测试连接</button>
          </div>
        </div>
        <div><label for="su-user">用户名</label><input class="input" id="su-user" autocomplete="username"></div>
        <div class="row">
          <div><label for="su-pass">密码</label><input class="input" id="su-pass" type="password" autocomplete="new-password"></div>
          <div><label for="su-confirm">确认密码</label><input class="input" id="su-confirm" type="password" autocomplete="new-password"></div>
        </div>
        <div class="login-err" id="err"></div>
        <button class="btn solid login-go" id="go">创建管理员</button>
      </form>
      <div class="login-foot">
        密码至少 8 位，两次输入必须一致。
        <div class="login-row" style="margin-top:8px">
          <button type="button" class="btn sm" id="to-login">服务端已有管理员？去登录</button>
          <button type="button" class="btn sm" id="about-link">关于 / 检查更新</button>
        </div>
      </div>
    </div>
  </div>`;

  const err = $<HTMLDivElement>('#err');
  const go = $<HTMLButtonElement>('#go');
  const base = $<HTMLInputElement>('#base');
  const probe = $<HTMLSpanElement>('#probe');
  const test = $<HTMLButtonElement>('#test');
  $<HTMLInputElement>('#su-user').focus();

  const submit = async () => {
    err.textContent = '';
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { err.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; return; }
    const username = $<HTMLInputElement>('#su-user').value.trim();
    const password = $<HTMLInputElement>('#su-pass').value;
    const confirm = $<HTMLInputElement>('#su-confirm').value;
    if (!username) { err.textContent = '请填用户名'; return; }
    if (password.length < 8) { err.textContent = '密码至少 8 位'; return; }
    if (password !== confirm) { err.textContent = '两次密码不一致'; return; }
    go.disabled = true;
    go.textContent = '创建中…';
    try {
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
    const r = await probeServer(norm);
    test.disabled = false;
    probe.className = `login-hint ${r.ok ? 'ok' : 'bad'}`;
    probe.textContent = r.ok ? '连上了' : r.reason;
  });

  $<HTMLFormElement>('#form').addEventListener('submit', (ev) => { ev.preventDefault(); void submit(); });
  go.addEventListener('click', () => void submit());
  $<HTMLButtonElement>('#to-login')!.onclick = () => renderLogin();
  $<HTMLButtonElement>('#about-link')!.onclick = () => openAbout();
}

/* ------------------------------------------------------------ 主题 */

function renderThemeButton() {
  const btn = $<HTMLButtonElement>('#btn-theme');
  if (!btn) return;
  const cur = loadTheme();
  const next = THEMES.find((t) => t.id !== cur)!;
  const now = THEMES.find((t) => t.id === cur)!;
  btn.textContent = now.label;
  btn.title = `当前：${now.label}（${now.hint}）。点击切到${next.label}`;
}

function toggleTheme() {
  saveTheme(loadTheme() === 'dark' ? 'morandi' : 'dark');
  renderThemeButton();
  send('theme:changed', { theme: loadTheme() });
}

/* ------------------------------------------------------------ 主界面 */

function renderShell() {
  document.body.innerHTML = `
  <div class="app">
    <div class="topbar">
      <span class="logo"><i></i></span>
      <b>今日推进</b>
      <div class="sp"></div>
      <div class="conn no-drag" id="btn-server" title="点击切换服务端"><span class="sdot off" id="sdot"></span><span id="stxt">未连接</span></div>
      <button class="btn sm no-drag" id="btn-theme" title="切换配色"></button>
      ${isDesktop() ? `
      <button class="btn sm no-drag" id="btn-hotkey" title="全局热键 Ctrl+Shift+Space"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Space</kbd> 快速记</button>` : ''}
    </div>

    <div id="banner-host"></div>

    <div class="capture-bar">
      <div class="capture-in">
        <span class="prompt">&gt;</span>
        <input id="cap" placeholder="想到什么就记下来，回车存进收件箱，带时间就设截止">
        <button class="btn sm solid" id="cap-go">记一条</button>
      </div>
      <div class="parse" id="parse" hidden></div>
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
      <button class="icon-btn" id="btn-settings" title="设置" aria-label="设置">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"/></svg>
      </button>
      <button class="icon-btn" id="btn-update" title="检查更新" aria-label="检查更新">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>
      </button>
      <span id="s-server">服务端 -</span>
      <span class="skew">时钟偏差 <span class="mono" id="s-skew">0 ms</span></span>
      <div class="sp"></div>
      <span id="s-lock">设备 在线</span>
      <span>登录为 <b id="s-user">${esc(loadConfig().user?.username ?? '?')}</b></span>
      <button class="btn sm" id="btn-logout">退出登录</button>
    </div>
  </div>`;

  if (isDesktop()) $<HTMLButtonElement>('#btn-hotkey')!.onclick = () => void native('show_capture');
  $<HTMLButtonElement>('#btn-update')!.onclick = () => openAbout();
  $<HTMLButtonElement>('#btn-settings')!.onclick = () => setView('settings');
  $<HTMLElement>('#btn-server')!.onclick = () => openServerPanel();
  renderThemeButton();
  $<HTMLButtonElement>('#btn-theme')!.onclick = () => toggleTheme();
  $<HTMLButtonElement>('#btn-logout')!.onclick = () => {
    rt?.close();
    clearToken();
    location.reload();
  };

  const cap = $<HTMLInputElement>('#cap');
  const parse = $<HTMLDivElement>('#parse');
  const preview = () => {
    const v = cap.value;
    if (!v.trim()) { parse.hidden = true; return; }
    const p = parseInput(v);
    parse.hidden = false;
    parse.innerHTML = `
      <span class="lb">已识别</span>
      <span class="chip ${p.kind === 'text' ? '' : 'hot'}">${esc(p.kindLabel)}</span>
      <span class="chip ${p.remindAt ? 'hot' : ''}">${esc(p.remindAt ? `截止：${p.timeLabel}` : '进收件箱')}</span>
      ${([3, 2, 1] as Importance[]).map((n) =>
        `<button type="button" class="chip ${captureImportance === n ? 'hot' : ''}" data-imp="${n}" title="${IMP_TITLE[n]}">${IMPORTANCE_LABEL[n]}</button>`,
      ).join('')}`;
  };
  cap.addEventListener('input', preview);
  parse.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-imp]');
    if (!b) return;
    captureImportance = Number(b.dataset.imp) as Importance;
    preview();
  });
  cap.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void submitCapture(cap.value); });
  $<HTMLButtonElement>('#cap-go')!.onclick = () => void submitCapture(cap.value);

  $<HTMLElement>('#sidebar').addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (b) setView(b.dataset.view as View);
  });

  $<HTMLElement>('#list').addEventListener('click', onListClick);
  $<HTMLElement>('#editor').addEventListener('click', onEditorClick);
  $<HTMLElement>('#editor').addEventListener('change', onEditorChange);
  $<HTMLElement>('#editor').addEventListener('input', onEditorInput);
  $<HTMLElement>('#editor').addEventListener('keydown', onEditorKeydown);

  onBannerChange(renderBanners);
  renderDeviceStatus();
}

/* -------------------------------------------------------- 跟进横幅 */

function renderBanners(list: Banner[]) {
  const host = $<HTMLElement>('#banner-host');
  if (!host) return;
  if (!list.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="weak-host">${list.map((b) => `
    <div class="weak">
      <div class="weak-l"><b>${esc(b.pursuit.text)}</b><span>${esc(b.reason)}</span></div>
      <div class="weak-acts">
        <button class="btn sm ghost" data-bact="done" data-id="${esc(b.pursuit.id)}">完成</button>
        <button class="btn sm" data-bact="later" data-id="${esc(b.pursuit.id)}">延期</button>
        <button class="btn sm" data-bact="archive" data-id="${esc(b.pursuit.id)}">归档</button>
      </div>
    </div>`).join('')}</div>`;
  host.onclick = (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-bact]');
    if (!b) return;
    const action = b.dataset.bact as FollowupAction;
    if (action === 'later') void askLater(b.dataset.id!);
    else void runFollowup(b.dataset.id!, action);
  };
}

/* -------------------------------------------------- 更新状态（顶栏） */

function renderUpdateBadge() {
  const btn = $<HTMLButtonElement>('#btn-update');
  if (!btn) return;
  const s = updateBadge();
  btn.classList.toggle('has-update', s.available);
  const title = !s.available ? '检查更新' : s.ready ? `安装 v${s.version}` : `下载更新 v${s.version}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
}
onUpdateChange(renderUpdateBadge);

/* ------------------------------------------------------------ 提示 */

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

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

function countOf(s: PursuitStatus): number {
  return state.counts?.counts?.[s] ?? 0;
}

function countAll(): number {
  const counts = state.counts?.counts;
  return counts ? Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
}

function renderSidebar() {
  const nav: Array<[View, string, number]> = [
    ['today', '今日', (state.focus?.items.length ?? 0) || countOf('active')],
    ['inbox', '收件箱', countOf('inbox')],
    ['all', '全部', countAll()],
    ['done', '已完成', countOf('done')],
    ['archived', '归档', countOf('archived')],
  ];
  $<HTMLElement>('#sidebar').innerHTML = `
    ${nav.map(([v, label, n]) => `
      <button class="nav ${state.view === v ? 'on' : ''}" data-view="${v}">${label}
        <span class="count">${n}</span>
      </button>`).join('')}
    <div class="nav-sep"></div>
    <div class="nav-head">我的</div>
    <button class="nav ${state.view === 'mystats' ? 'on' : ''}" data-view="mystats">推进看板</button>
    <button class="nav ${state.view === 'tokens' ? 'on' : ''}" data-view="tokens">Agent 令牌</button>
    <div class="nav-sep"></div>
    <div class="nav-head">设备</div>
    ${state.devices.map((d) => `
      <div class="nav static" title="${esc(d.platform)} · ${esc(d.transport.toUpperCase())}">
        <span class="sdot ${d.online ? '' : 'off'}"></span>${esc(d.name)}
        <span class="count">${d.online ? '在线' : '离线'}</span>
      </div>`).join('') || '<div class="nav-note">还没有推送设备。</div>'}
    <div class="sp"></div>
    ${loadConfig().user?.role === 'admin' ? `
    <button class="nav ${state.view === 'dashboard' ? 'on' : ''}" data-view="dashboard">系统看板</button>` : ''}`;
}

function natureIcon(n: Pursuit['nature']): string {
  return n === 'project' ? '◫' : '·';
}

function progressHtml(p: Pursuit): string {
  const total = p.steps.length;
  const done = p.steps.filter((s) => s.state === 'done').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  return `<span class="prog" title="${done}/${total} 步"><i style="width:${pct}%"></i></span><span class="mono">${done}/${total}</span>`;
}

function focusHtml(): string {
  const f = state.focus;
  if (state.view !== 'today') return '';
  if (!f || !f.items.length) {
    return `<div class="focus-card"><div class="focus-head"><b>今日聚焦</b></div>
      <div class="focus-empty">今天没有需要强推的事。安静推进就好。</div></div>`;
  }
  return `<div class="focus-card">
    <div class="focus-head"><b>今日聚焦</b>
      <span>今日剩余强打扰额度 <b class="mono">${f.budgetLeft}</b></span></div>
    ${f.items.map((it) => {
      const p = it.pursuit;
      return `<div class="focus-item ${state.selected === p.id ? 'on' : ''}" data-id="${esc(p.id)}">
        <div class="fi-top">
          <span class="fi-nature" title="${NATURE_LABEL[p.nature]}">${natureIcon(p.nature)}</span>
          <b class="fi-title">${esc(p.text)}</b>
        </div>
        <div class="fi-reason">${esc(it.reason)}</div>
        ${it.suggestedNextStep ? `<div class="fi-next">下一步：${esc(it.suggestedNextStep)}</div>` : ''}
        <div class="fi-acts">
          <button class="btn sm solid" data-focus-act="done" data-id="${esc(p.id)}">完成</button>
          <button class="btn sm" data-focus-act="smaller" data-id="${esc(p.id)}">拆小</button>
          <button class="btn sm" data-focus-act="later" data-id="${esc(p.id)}">延期</button>
          <button class="btn sm" data-focus-act="archive" data-id="${esc(p.id)}">归档</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function rowHtml(p: Pursuit): string {
  const u = warmthOf(p);
  const eff = effectiveImportance(p.importance, p.dueAt, serverNow());
  const boosted = eff > p.importance;
  const impLabel = IMPORTANCE_LABEL[eff] + (boosted ? '↑' : '');
  const primary = p.status === 'archived'
    ? '<span class="tag">已归档</span>'
    : p.status === 'done'
      ? `<button class="btn sm" data-follow="reopen" data-id="${esc(p.id)}">撤回</button>`
      : `<button class="btn sm" data-follow="done" data-id="${esc(p.id)}">完成</button>`;
  return `
  <div class="item u-${u}${state.selected === p.id ? ' on' : ''}" data-id="${esc(p.id)}">
    <div class="p-imp" title="${boosted ? '截止 24 小时内，自动按 P0 排期' : `重要性 ${IMPORTANCE_LABEL[p.importance]}`}">${impLabel}</div>
    <div>
      <div class="it-time">${u === 'none' ? '' : `<i class="udot ${u}"></i>`}
        <span>${esc(dueLabel(p))} · ${esc(staleLabel(p))}</span></div>
      <div class="it-title">${esc(p.text)}</div>
      <div class="it-meta">
        <span class="tag" title="${NATURE_LABEL[p.nature]}">${natureIcon(p.nature)} ${NATURE_LABEL[p.nature]}</span>
        ${progressHtml(p)}
        ${p.url ? `<span class="tag host" title="${esc(p.url)}">${esc(hostOf(p.url))}</span>` : ''}
        ${p.path ? `<span class="tag path" title="${esc(p.path)}">${esc(p.path)}</span>` : ''}
      </div>
    </div>
    <div class="it-act">${primary}</div>
  </div>`;
}

function renderList() {
  const box = $<HTMLDivElement>('#list');
  if (state.view === 'dashboard') { renderDashboard(box); return; }
  if (state.view === 'tokens') { renderTokens(box); return; }
  if (state.view === 'settings') { renderSettingsView(box); return; }
  if (state.view === 'mystats') { renderStatsView(box); return; }

  const emptyCopy: Partial<Record<View, [string, string]>> = {
    today: ['今天没有待推进的事', '上面记一条，或去收件箱看看。'],
    inbox: ['收件箱是空的', '想到什么就先记下来，之后再明确。'],
    all: ['还没有推进项', '在上面记一条就能开始。'],
    done: ['还没有完成的推进项', '推完的事会出现在这里。'],
    archived: ['归档是空的', '不要了或长期停滞的会放这里。'],
  };
  const [title, detail] = emptyCopy[state.view] ?? ['空的', ''];
  const list = state.pursuits.length
    ? state.pursuits.map(rowHtml).join('')
    : `<div class="empty"><b>${title}</b><p>${detail}</p></div>`;
  box.innerHTML = focusHtml() + list;
}

/* ------------------------------------------------------------ 详情面板 */

function findPursuit(id: string | null): Pursuit | undefined {
  if (!id) return undefined;
  return state.pursuits.find((p) => p.id === id)
    ?? state.focus?.items.find((i) => i.pursuit.id === id)?.pursuit;
}

function renderEditor() {
  const box = $<HTMLElement>('#editor');
  const p = findPursuit(state.selected);
  const focused = document.activeElement as HTMLElement | null;
  if (p && focused && box.contains(focused) &&
      (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) return;

  if (!p) {
    box.innerHTML = `<div class="ed-head">推进详情</div>
      <div class="ed-empty"><b>没有选中的推进项</b>
        <p>点左边任意一条来拆解步骤、改重要性和排期。</p></div>`;
    return;
  }

  const freq = p.recurrence?.freq ?? 'none';
  const rf = ruleFields(p.recurrence);
  const ruleFieldsShown = fieldsFor(freq);
  const due = p.dueAt === null ? '没有截止' : `${dayLabel(p.dueAt)} ${hhmm(p.dueAt)}`;
  box.innerHTML = `
    <div class="ed-head">推进详情</div>
    <div class="ed-body">
      <div class="fld"><label for="f-text">事项</label>
        <textarea class="input ed-textarea" id="f-text" rows="2">${esc(p.text)}</textarea></div>

      <div class="fld"><label>步骤清单</label>
        <div class="steps">
          ${p.steps.length ? p.steps.map((s) => `
            <label class="step ${s.state === 'done' ? 'done' : ''}">
              <input type="checkbox" data-step="${esc(s.id)}" ${s.state === 'done' ? 'checked' : ''}>
              <span>${esc(s.text)}</span></label>`).join('')
            : '<div class="hint">还没有步骤。拆小之后推进会更顺。</div>'}
        </div>
        <div class="add-step">
          <input class="input" id="new-step" placeholder="加一个步骤，回车">
          <button class="btn sm" data-act="add-step">添加</button>
        </div>
      </div>

      <div class="fld"><label for="f-note">备注</label>
        <textarea class="input ed-textarea" id="f-note" rows="3" placeholder="相关背景、上下文">${esc(p.note ?? '')}</textarea></div>

      <div class="fld"><label>重要性</label>
        <div class="seg">${([3, 2, 1] as Importance[]).map((n) =>
          `<button data-imp="${n}" class="${p.importance === n ? 'on' : ''}" title="${IMP_TITLE[n]}">${IMPORTANCE_LABEL[n]}</button>`,
        ).join('')}</div>
        ${effectiveImportance(p.importance, p.dueAt, serverNow()) > p.importance
          ? '<div class="hint">截止 24 小时内，排期自动按 P0 计算（不改动你选的值）</div>' : ''}</div>

      <div class="fld"><label>性质</label>
        <div class="seg">${(['one_off', 'project'] as const).map((n) =>
          `<button data-nature="${n}" class="${p.nature === n ? 'on' : ''}">${NATURE_LABEL[n]}</button>`,
        ).join('')}</div></div>

      <div class="fld"><label>截止</label>
        <button type="button" class="input when-btn" id="f-when">
          <span class="mono">${esc(due)}</span><span class="when-edit">点击修改</span></button>
        <button type="button" class="btn sm" data-act="clear-due" style="margin-top:6px">清除截止</button></div>

      <div class="fld"><label>重复规则</label>
        <button type="button" class="input sm trigger" id="f-freq" data-v="${freq}">
          <span class="trigger-label">${FREQ_LABEL[freq]}</span>
          <span class="trigger-arrow">⌄</span></button>
        <div id="f-rule-extra" ${ruleFieldsShown.length === 0 ? 'hidden' : ''}>${ruleFieldsHtml(freq, rf)}</div></div>

      <div class="fld"><label>跟进历史</label>
        ${state.followups.length ? `<div class="fu-list">${state.followups.map((f) => `
          <div class="fu-row"><span class="mono">${esc(new Date(f.at).toLocaleString('zh-CN'))}</span>
            <span class="tag">L${f.level}</span><b>${esc(f.action)}</b>
            ${f.note ? `<span>${esc(f.note)}</span>` : ''}</div>`).join('')}</div>`
          : '<div class="hint">还没有跟进记录。</div>'}
      </div>
    </div>
    <div class="ed-foot">
      ${actionsFor(p.status).map((a) =>
        `<button class="btn ${a === 'done' ? 'solid' : a === 'archive' ? 'danger sp-left' : ''}" data-act="follow-${a}">${ACTION_LABEL[a]}</button>`,
      ).join('')}
      <button class="btn sp-left" data-act="clone">克隆</button>
    </div>`;

  const when = $<HTMLButtonElement>('#f-when');
  if (when) when.onclick = () => openWhenPicker(p, when);
  const freqBtn = $<HTMLButtonElement>('#f-freq');
  if (freqBtn) freqBtn.onclick = (ev) => {
    const items = (Object.keys(FREQ_LABEL) as Array<keyof typeof FREQ_LABEL>)
      .map((v) => ({ value: v, label: FREQ_LABEL[v] }));
    openDropdown(ev.currentTarget as HTMLElement, items, freq, (v) => {
      const key = v as keyof typeof FREQ_LABEL;
      const current = {
        byWeekday: $<HTMLInputElement>('#f-byday')?.value ?? rf.byWeekday,
        byMonthday: $<HTMLInputElement>('#f-bymonthday')?.value ?? rf.byMonthday,
        byMonth: $<HTMLInputElement>('#f-bymonth')?.value ?? rf.byMonth,
      };
      freqBtn.dataset.v = v;
      const label = freqBtn.querySelector<HTMLElement>('.trigger-label');
      if (label) label.textContent = FREQ_LABEL[key];
      const extra = $<HTMLElement>('#f-rule-extra');
      if (extra) {
        extra.innerHTML = ruleFieldsHtml(v, current);
        extra.hidden = fieldsFor(key).length === 0;
      }
    });
  };
}

function renderAll() {
  if (!$('#list')) return;
  const wide = state.view === 'settings' || state.view === 'mystats' ||
    state.view === 'dashboard' || state.view === 'tokens';
  $<HTMLElement>('.body')!.classList.toggle('wide', wide);
  const v = VIEWS[state.view];
  $<HTMLElement>('#vtitle')!.textContent = v.title;
  $<HTMLElement>('#vsub')!.textContent =
    state.view === 'today'
      ? `${state.focus?.items.length ?? 0} 项聚焦 · 剩余强打扰额度 ${state.focus?.budgetLeft ?? 0}`
      : v.sub;
  const listTop = document.querySelector<HTMLElement>('.list-scroll')?.scrollTop ?? 0;
  const editorTop = document.querySelector<HTMLElement>('.ed-body')?.scrollTop ?? 0;
  renderSidebar();
  renderList();
  if (wide) $<HTMLElement>('#editor')!.innerHTML = '';
  else renderEditor();
  const listBox = document.querySelector<HTMLElement>('.list-scroll');
  if (listBox) listBox.scrollTop = listTop;
  const editorBox = document.querySelector<HTMLElement>('.ed-body');
  if (editorBox) editorBox.scrollTop = editorTop;
  renderSkew();
}

function tickUrgency() {
  const box = $<HTMLDivElement>('#list');
  if (!box) return;
  for (const p of state.pursuits) {
    const row = box.querySelector<HTMLElement>(`.item[data-id="${CSS.escape(p.id)}"]`);
    if (!row) continue;
    const u = warmthOf(p);
    if (row.dataset.u === u) continue;
    row.dataset.u = u;
    row.classList.remove('u-none', 'u-soon', 'u-close', 'u-due', 'u-over');
    row.classList.add(`u-${u}`);
    const t = row.querySelector<HTMLElement>('.it-time');
    if (t) {
      t.innerHTML = `${u === 'none' ? '' : `<i class="udot ${u}"></i>`}<span>${esc(`${dueLabel(p)} · ${staleLabel(p)}`)}</span>`;
    }
  }
}

/* ------------------------------------------------------------ 设置页 */

const CLOSE_KEY = 'deskalarm.closeBehavior';
const LOG_KEY = 'deskalarm.logPolicy';
const DEFAULT_LOG_POLICY: LogPolicy = { level: 'info', enabled: true, retentionDays: 7 };

interface LogPolicy { level: 'debug' | 'info' | 'warn' | 'error'; enabled: boolean; retentionDays: number }

function closeBehavior(): 'quit' | 'tray' {
  return localStorage.getItem(CLOSE_KEY) === 'quit' ? 'quit' : 'tray';
}

function localLogPolicy(): LogPolicy {
  try {
    return { ...DEFAULT_LOG_POLICY, ...(JSON.parse(localStorage.getItem(LOG_KEY) ?? '{}') as Partial<LogPolicy>) };
  } catch { return { ...DEFAULT_LOG_POLICY }; }
}

function renderDeviceStatus() {
  const el = $<HTMLElement>('#s-lock');
  if (!el) return;
  const mine = loadConfig().device?.id;
  // 服务端按实时通道判在线；设备行里的 online 是登录时的旧值，不能拿来显示当前状态
  const online = mine ? linkState === 'open' : false;
  el.textContent = online ? '设备 在线' : '设备 离线';
  el.title = mine ? '本机推送设备：实时通道连着就算在线' : '本机还没有注册推送设备';
}

const hhmmOfMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minOfHhmm = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function renderSettingsView(box: HTMLElement) {
  if (box.querySelector('.settings')) return;
  const admin = loadConfig().user?.role === 'admin';
  const s = loadConfig().settings;
  box.innerHTML = `
  <div class="settings">
    <section class="set-card">
      <h2>常规</h2>
      <div class="set-row"><div><b>主题</b><small>当前 <span id="set-theme"></span></small></div>
        <button class="btn sm" id="set-theme-btn"></button></div>
      <div class="set-row"><div><b>关闭主窗口</b><small>点标题栏 X 时做什么</small></div>
        <button type="button" class="input sm trigger" id="set-close" data-v="tray"><span class="trigger-label">隐藏到托盘</span><span class="trigger-arrow">⌄</span></button></div>
      ${isDesktop() ? `<div class="set-row"><div><b>开机自启</b><small>随系统登录，静默进托盘</small></div>
        <input type="checkbox" class="switch" id="set-auto"></div>` : ''}
      <div class="set-row"><div><b>自动检查更新</b><small>可选。开启后启动时和每 30 分钟检查一次，只提示不安装</small></div>
        <input type="checkbox" class="switch" id="set-auto-update"></div>
      <div class="set-row"><div><b>关于 / 更新</b><small>项目简介、版本信息，检查与安装最新版</small></div>
        <button class="btn sm" id="set-about">打开</button></div>
    </section>

    <section class="set-card" id="set-pace">
      <h2>推进节奏</h2>
      <div class="set-grid">
        <label>每日强打扰额度<input class="input" id="set-budget" type="number" min="0" max="20" value="${s.dailyStrongBudget}"></label>
        <label>L2 停滞阈值（小时）<input class="input" id="set-l2" type="number" min="0" value="${Math.round(s.escalateAfterMs.l2 / 3600000)}"></label>
        <label>L3 停滞阈值（小时）<input class="input" id="set-l3" type="number" min="0" value="${Math.round(s.escalateAfterMs.l3 / 3600000)}"></label>
        <label>L4 停滞阈值（小时）<input class="input" id="set-l4" type="number" min="0" value="${Math.round(s.escalateAfterMs.l4 / 3600000)}"></label>
        <label>L5 停滞阈值（小时）<input class="input" id="set-l5" type="number" min="0" value="${Math.round(s.escalateAfterMs.l5 / 3600000)}"></label>
        <label>每日聚焦时刻<button type="button" class="input sm trigger" id="set-focus-at" data-v="${hhmmOfMin(s.focusAtMin)}"><span class="trigger-label">${hhmmOfMin(s.focusAtMin)}</span><span class="trigger-arrow">◷</span></button></label>
        <label>静音开始<button type="button" class="input sm trigger" id="set-quiet-start" data-v="${hhmmOfMin(s.quietStartMin)}"><span class="trigger-label">${hhmmOfMin(s.quietStartMin)}</span><span class="trigger-arrow">◷</span></button></label>
        <label>静音结束<button type="button" class="input sm trigger" id="set-quiet-end" data-v="${hhmmOfMin(s.quietEndMin)}"><span class="trigger-label">${hhmmOfMin(s.quietEndMin)}</span><span class="trigger-arrow">◷</span></button></label>
        <label>声音<button type="button" class="input sm trigger" id="set-sound" data-v="${s.sound}"><span class="trigger-label">${s.sound === 'none' ? '静音' : s.sound === 'custom' ? '自定义' : '系统提示音'}</span><span class="trigger-arrow">⌄</span></button></label>
      </div>
      <div class="set-actions"><button class="btn solid sm" id="set-save">保存推进设置</button><span id="set-msg" class="hint"></span></div>
    </section>

    <section class="set-card">
      <h2>测试跟进表现</h2>
      <div class="hint" style="margin-bottom:10px">按当前设置实际走一次跟进链路，确认各等级表现符合预期。</div>
      <div class="set-actions">
        ${([2, 3, 4, 5] as const).map((n) => `<button class="btn sm" data-test-level="${n}">测试 L${n}</button>`).join('')}
      </div>
    </section>

    <section class="set-card">
      <h2>设备</h2>
      <div class="set-row"><div><b>试响</b><small>确认这台设备能出声</small></div>
        <button class="btn sm" id="set-ping">试响</button></div>
      <div id="set-devices" class="dev-table"></div>
    </section>

    ${admin ? `<section class="set-card">
      <h2>用户管理</h2>
      <div class="set-grid">
        <label>用户名<input class="input" id="usr-name" autocomplete="off"></label>
        <label>密码（至少 8 位）<input class="input" id="usr-pass" type="password" autocomplete="new-password"></label>
        <label>确认密码<input class="input" id="usr-pass2" type="password" autocomplete="new-password"></label>
      </div>
      <div class="set-actions"><button class="btn solid sm" id="usr-add">创建用户</button><span id="usr-msg" class="hint"></span></div>
      <div id="set-users" class="user-table"></div>
    </section>` : ''}

    <section class="set-card">
      <h2>本地日志</h2>
      <div class="set-grid">
        <label>级别<button type="button" class="input sm trigger" id="log-level" data-v="info"><span class="trigger-label">info</span><span class="trigger-arrow">⌄</span></button></label>
        <label>保留天数<input class="input" id="log-days" type="number" min="1" max="90"></label>
      </div>
      <div class="set-row"><div><b>写入本地文件</b><small>应用数据目录下的 logs 文件夹</small></div>
        <input type="checkbox" class="switch" id="log-enabled"></div>
      <div class="set-actions"><button class="btn sm" id="log-save">保存日志设置</button><span id="log-msg" class="hint"></span></div>
    </section>
  </div>`;

  const now = THEMES.find((t) => t.id === loadTheme())!;
  $<HTMLElement>('#set-theme').textContent = now.label;
  $<HTMLButtonElement>('#set-theme-btn').textContent = `切换到${THEMES.find((t) => t.id !== loadTheme())!.label}`;
  $<HTMLButtonElement>('#set-theme-btn').onclick = () => {
    toggleTheme();
    const t = THEMES.find((x) => x.id === loadTheme())!;
    $<HTMLElement>('#set-theme').textContent = t.label;
    $<HTMLButtonElement>('#set-theme-btn').textContent = `切换到${THEMES.find((x) => x.id !== loadTheme())!.label}`;
  };
  $<HTMLButtonElement>('#set-close').onclick = (ev) => {
    openDropdown(ev.currentTarget as HTMLElement, [
      { value: 'quit', label: '退出程序' }, { value: 'tray', label: '隐藏到托盘' },
    ], closeBehavior(), (v) => {
      const b = $<HTMLButtonElement>('#set-close');
      b.dataset.v = v;
      b.querySelector<HTMLElement>('.trigger-label')!.textContent = v === 'quit' ? '退出程序' : '隐藏到托盘';
      localStorage.setItem(CLOSE_KEY, v);
      void native('set_close_behavior', { behavior: v });
    });
  };
  const autoUpdate = $<HTMLInputElement>('#set-auto-update');
  autoUpdate.checked = autoUpdateEnabled();
  autoUpdate.onchange = () => setAutoUpdate(autoUpdate.checked);
  for (const id of ['set-quiet-start', 'set-quiet-end', 'set-focus-at'] as const) {
    $<HTMLButtonElement>(`#${id}`).onclick = (ev) => {
      const b = ev.currentTarget as HTMLElement;
      openTimePicker(b, b.dataset.v || '00:00', (v) => {
        b.dataset.v = v;
        b.querySelector<HTMLElement>('.trigger-label')!.textContent = v;
      });
    };
  }
  $<HTMLButtonElement>('#set-sound').onclick = (ev) => {
    const b = ev.currentTarget as HTMLElement;
    openDropdown(b, [
      { value: 'system', label: '系统提示音' }, { value: 'custom', label: '自定义' }, { value: 'none', label: '静音' },
    ], b.dataset.v ?? 'system', (v) => {
      b.dataset.v = v;
      b.querySelector<HTMLElement>('.trigger-label')!.textContent =
        v === 'none' ? '静音' : v === 'custom' ? '自定义' : '系统提示音';
    });
  };
  $<HTMLButtonElement>('#log-level').onclick = (ev) => {
    const b = ev.currentTarget as HTMLElement;
    openDropdown(b, [
      { value: 'debug', label: 'debug' }, { value: 'info', label: 'info' },
      { value: 'warn', label: 'warn' }, { value: 'error', label: 'error' },
    ], b.dataset.v ?? 'info', (v) => {
      b.dataset.v = v;
      b.querySelector<HTMLElement>('.trigger-label')!.textContent = v;
    });
  };
  renderUpdateBadge();
  const auto = $<HTMLInputElement>('#set-auto');
  if (auto) {
    void native<boolean>('is_autostart_enabled').then((on) => { if (on !== null) auto.checked = on; });
    auto.onchange = () => void native('set_autostart', { enable: auto.checked });
  }
  $<HTMLButtonElement>('#set-about').onclick = () => openAbout();
  $<HTMLButtonElement>('#set-ping').onclick = () => void native('ping', { title: '试响', body: '能听到声音就说明这台设备没问题' });
  $<HTMLButtonElement>('#set-save').onclick = () => void saveSettingsForm();
  $<HTMLButtonElement>('#log-save').onclick = () => void saveLogPolicy();
  box.querySelectorAll<HTMLElement>('[data-test-level]').forEach((b) => {
    b.onclick = () => testFollowup(Number(b.dataset.testLevel) as 2 | 3 | 4 | 5);
  });
  if (admin) {
    $<HTMLButtonElement>('#usr-add').onclick = () => void addUser();
    $<HTMLElement>('#set-users').addEventListener('click', (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-user]');
      if (!b) return;
      const id = b.dataset.user!;
      const act = b.dataset.act;
      if (act === 'del' && !window.confirm('确定删除这个用户？他的数据会一起删掉。')) return;
      const req = act === 'del' ? api.deleteUser(id)
        : api.updateUser(id, { disabled: act === 'disable' });
      void req.then(reloadUsers).catch((e) => {
        $<HTMLElement>('#usr-msg').textContent = msgOf(e);
      });
    });
    void reloadUsers();
  }
  void reloadPageData();
}

async function saveSettingsForm() {
  const msg = $<HTMLElement>('#set-msg');
  const val = (id: string) => $<HTMLInputElement>(`#${id}`).value;
  const hrs = (id: string) => Math.max(0, Number(val(id))) * 3_600_000;
  const patch: Partial<Settings> = {
    dailyStrongBudget: Math.max(0, Number(val('set-budget'))),
    escalateAfterMs: {
      l2: hrs('set-l2'), l3: hrs('set-l3'), l4: hrs('set-l4'), l5: hrs('set-l5'),
    },
    quietStartMin: minOfHhmm($<HTMLButtonElement>('#set-quiet-start').dataset.v ?? '23:30'),
    quietEndMin: minOfHhmm($<HTMLButtonElement>('#set-quiet-end').dataset.v ?? '07:00'),
    focusAtMin: minOfHhmm($<HTMLButtonElement>('#set-focus-at').dataset.v ?? '09:00'),
    sound: ($<HTMLButtonElement>('#set-sound').dataset.v ?? 'system') as Settings['sound'],
  };
  msg.textContent = '保存中…';
  try {
    const r = await api.patchSettings(patch);
    saveConfig({ settings: r.settings });
    msg.textContent = '已保存';
  } catch (e) { msg.textContent = msgOf(e); }
}

function testFollowup(level: 2 | 3 | 4 | 5) {
  const now = serverNow();
  const fake: Pursuit = {
    id: `test-${level}-${now}`, userId: '', text: `L${level} 跟进测试：这件事已经停了一阵子`,
    note: null, kind: 'text', url: null, path: null,
    nature: 'project', importance: 2, dueAt: null,
    recurrence: null, context: null, commitment: null,
    status: 'active', importanceSort: 0, version: 1, createdAt: now, updatedAt: now,
    completedAt: null, lastActivityAt: now - 4 * 86400_000,
    progress: 0.3, stalenessMs: 4 * 86400_000, weight: 40,
    steps: [{ id: 't1', pursuitId: `test-${level}-${now}`, text: '先把第一步做了', position: 0, state: 'todo', doneAt: null, createdAt: now }],
    deviceIds: [], source: 'app',
  };
  control.fire(fake, level, '这是测试，不会改你的数据', 'in_app');
  flash(`L${level} 跟进已触发`);
}

async function loadSettingsForm() {
  try {
    const { settings } = await api.settings();
    saveConfig({ settings });
  } catch { /* 读不到就保留本地缓存 */ }
}

function renderDeviceRows() {
  const box = $<HTMLElement>('#set-devices');
  if (!box) return;
  box.innerHTML = state.devices.map((d) => `
    <div class="dev-row">
      <b>${esc(d.name)}</b><span class="mono">${esc(d.lastIp ?? '—')}</span>
      <span>${d.online ? '在线' : '离线'}</span><span class="hint">${esc(d.platform)}</span>
    </div>`).join('');
}

async function reloadUsers() {
  const box = $<HTMLElement>('#set-users');
  if (!box) return;
  try {
    const { users } = await api.users();
    const me = loadConfig().user?.id;
    box.innerHTML = users.map((u) => `
      <div class="dev-row">
        <b>${esc(u.username)}</b><span>${u.role === 'admin' ? '管理员' : '普通用户'}</span>
        <span>${u.disabled ? '已禁用' : '正常'}</span>
        ${u.id === me ? '<span class="hint">自己</span>' : `
          <button class="btn sm" data-user="${esc(u.id)}" data-act="${u.disabled ? 'disable' : 'enable'}">${u.disabled ? '启用' : '禁用'}</button>
          <button class="btn sm danger" data-user="${esc(u.id)}" data-act="del">删除</button>`}
      </div>`).join('');
  } catch (e) { $<HTMLElement>('#usr-msg').textContent = msgOf(e); }
}

async function addUser() {
  const msg = $<HTMLElement>('#usr-msg');
  const username = $<HTMLInputElement>('#usr-name').value.trim();
  const password = $<HTMLInputElement>('#usr-pass').value;
  const confirmPassword = $<HTMLInputElement>('#usr-pass2').value;
  if (!username || password.length < 8) { msg.textContent = '用户名必填，密码至少 8 位'; return; }
  if (password !== confirmPassword) { msg.textContent = '两次密码不一致'; return; }
  try {
    await api.createUser({ username, password, confirmPassword });
    $<HTMLInputElement>('#usr-name').value = '';
    $<HTMLInputElement>('#usr-pass').value = '';
    $<HTMLInputElement>('#usr-pass2').value = '';
    msg.textContent = '已创建';
    void reloadUsers();
  } catch (e) { msg.textContent = msgOf(e); }
}

async function loadLogPolicy() {
  const p = await native<LogPolicy>('get_log_policy');
  if (!p) return;
  const b = $<HTMLButtonElement>('#log-level');
  if (b) {
    b.dataset.v = p.level;
    b.querySelector<HTMLElement>('.trigger-label')!.textContent = p.level;
  }
  const days = $<HTMLInputElement>('#log-days');
  if (days) days.value = String(p.retentionDays);
  const enabled = $<HTMLInputElement>('#log-enabled');
  if (enabled) enabled.checked = p.enabled;
  localStorage.setItem(LOG_KEY, JSON.stringify(p));
}

async function saveLogPolicy() {
  const msg = $<HTMLElement>('#log-msg');
  const p: LogPolicy = {
    level: ($<HTMLButtonElement>('#log-level').dataset.v ?? 'info') as LogPolicy['level'],
    retentionDays: Number($<HTMLInputElement>('#log-days').value),
    enabled: $<HTMLInputElement>('#log-enabled').checked,
  };
  const ok = await native('set_log_policy', {
    level: p.level, enabled: p.enabled, retentionDays: p.retentionDays,
  });
  msg.textContent = ok === null ? '保存失败' : '已保存';
  if (ok !== null) localStorage.setItem(LOG_KEY, JSON.stringify(p));
}

async function reloadPageData() {
  await Promise.allSettled([loadSettingsForm(), loadLogPolicy(), loadStats(), renderDeviceRows()]);
}

/* ------------------------------------------------------------ 推进看板 */

function renderStatsView(box: HTMLElement) {
  if (box.querySelector('.stats')) return;
  box.innerHTML = `
    <div class="stats">
      <div class="stat-hero" id="stat-hero">读取中…</div>
      <div class="stat-grid" id="stat-grid"></div>
      <h2 class="stat-title">最近 7 天</h2>
      <div class="bars" id="stat-days"></div>
    </div>`;
  void loadStats();
}

async function loadStats() {
  const hero = document.getElementById('stat-hero');
  if (!hero) return;
  try {
    const s: MyStats = await api.myStats();
    hero.innerHTML = `
      <div><span class="big">${s.streakDays}</span><span class="unit">天连续推进</span></div>
      <div><span class="big">${s.completedThisWeek}</span><span class="unit">本周完成</span></div>`;
    $<HTMLElement>('#stat-grid').innerHTML = ([
      ['今日聚焦', s.today.focus, ''],
      ['今日完成', s.today.done, 'ok'],
      ['待跟进', s.today.pendingFollowup, 'warn'],
    ] as Array<[string, number, string]>).map(([label, value, tone]) => `
      <div class="stat-card ${tone}"><span>${label}</span><b>${value}</b></div>`).join('');
    const max = Math.max(1, ...s.days.map((d) => Math.max(d.focus, d.done, d.pending)));
    $<HTMLElement>('#stat-days').innerHTML = s.days.map((d) => `
      <div class="bar-col" title="${esc(d.day)}：聚焦 ${d.focus}，完成 ${d.done}，待跟进 ${d.pending}">
        <div class="bar-track">
          <i class="bar-done" style="height:${Math.round(d.done / max * 100)}%"></i>
          <i class="bar-miss" style="height:${Math.round(d.pending / max * 100)}%"></i>
        </div>
        <span>${esc(d.day.slice(5))}</span>
      </div>`).join('');
  } catch (e) {
    hero.textContent = msgOf(e);
  }
}

/* ------------------------------------------------------------ 系统看板 */

function renderDashboard(box: HTMLElement) {
  if (!box.querySelector('.dash')) {
    box.innerHTML = `
      <div class="dash">
        <div class="dash-hero" id="dash-hero"></div>
        <h2 class="dash-section">推进概况</h2>
        <div class="dash-grid">
          <section class="dash-card"><h3>推进项状态</h3><div id="dash-entries" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>打扰分布</h3><div id="dash-deliveries" class="dash-body">读取中…</div></section>
        </div>
        <h2 class="dash-section">运行环境</h2>
        <div class="dash-grid">
          <section class="dash-card"><h3>服务健康</h3><div id="dash-health" class="dash-body">读取中…</div></section>
          <section class="dash-card"><h3>引擎循环</h3><div id="dash-sched" class="dash-body">读取中…</div></section>
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
    put('dash-hero', `
      <div class="dash-kpi"><span>进行中</span><b>${o.pursuits.active ?? 0}</b></div>
      <div class="dash-kpi"><span>收件箱</span><b>${o.pursuits.inbox ?? 0}</b></div>
      <div class="dash-kpi warn"><span>停滞</span><b>${o.engine.stalled}</b></div>
      <div class="dash-kpi"><span>设备 / 在线</span><b>${o.devices.total}<small> / ${o.devices.online}</small></b></div>
      <div class="dash-kpi"><span>用户</span><b>${o.users.total}</b></div>`);
    put('dash-health', `
      <div>数据库 <b class="${o.db.ok ? 'ok' : 'danger'}">${o.db.ok ? '正常' : '异常'}</b></div>
      <div>运行时长 ${Math.round(o.uptimeMs / 60000)} 分钟</div>
      <div>服务端时间 ${new Date(o.serverTs).toLocaleTimeString('zh-CN')}</div>`);
    put('dash-sched', `
      <div>扫描间隔 ${o.engine.tickMs} ms · 累计 tick ${o.engine.ticks}</div>
      <div>活跃 ${o.engine.active} · 停滞 ${o.engine.stalled}</div>
      <div>上次 ${o.engine.lastTickAt ? new Date(o.engine.lastTickAt).toLocaleTimeString('zh-CN') : '-'}</div>`);
    put('dash-entries', `
      <div>进行中 ${o.pursuits.active ?? 0} · 收件箱 ${o.pursuits.inbox ?? 0}</div>
      <div>已完成 ${o.pursuits.done ?? 0} · 归档 ${o.pursuits.archived ?? 0}</div>
      <div>暂停 ${o.pursuits.paused ?? 0}</div>`);
    const levels = ([1, 2, 3, 4, 5] as const).map((n) => `L${n} ${o.nudgesToday[n] ?? 0}`).join(' · ');
    put('dash-deliveries', `<div>今日各等级打扰次数</div><div>${esc(levels)}</div>`);
    const plats = Object.entries(o.devices.byPlatform).map(([k, v]) => `${k} ${v}`).join(' · ') || '无';
    put('dash-devices', `<div>总数 <b>${o.devices.total}</b> · 在线 ${o.devices.online}</div><div>${esc(plats)}</div>`);
    put('dash-users', `<div>总数 <b>${o.users.total}</b></div>`);
    put('dash-at', new Date(o.serverTs).toLocaleTimeString('zh-CN'));
    put('dash-err', '');
  } catch (e) {
    put('dash-err', `<div class="dash-err-line">${esc(msgOf(e))}</div>`);
  }
}

/* ------------------------------------------------------------ Agent 令牌 */

function renderTokens(box: HTMLElement) {
  if (!box.querySelector('.tokens')) {
    box.innerHTML = `
      <div class="tokens">
        <div class="dash-grid">
          <section class="dash-card">
            <h3>我的 Agent 令牌</h3><div id="tk-list" class="agent-list">读取中…</div>
          </section>
          <section class="dash-card">
            <h3>签发新令牌</h3>
            <div class="fld"><label>名称</label><input class="input" id="tk-name" placeholder="如「Claude Code」"></div>
            <div class="fld"><label>权限</label><select class="input" id="tk-scope"><option value="write">读写</option><option value="read">只读</option></select></div>
            <div class="fld"><label>绑定 machine-id（可选）</label>
              <input class="input mono" id="tk-mid" placeholder="留空则不绑定设备"></div>
            <div class="login-row">
              <span class="login-hint" id="tk-hint">令牌只显示一次，复制后妥善保存</span>
              <button type="button" class="btn sm solid" id="tk-issue">签发</button></div>
            <div class="mid-row" style="margin-top:8px">
              <input class="input mono mid-val" id="tk-plain" readonly placeholder="新令牌（仅显示一次）">
              <button type="button" class="btn sm" id="tk-copy">复制</button></div>
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
      const scope = box.querySelector<HTMLSelectElement>('#tk-scope')!.value as 'read' | 'write';
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
        hint.textContent = msgOf(e);
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
          <div class="agent-item"><span>${esc(t.name)} <span class="oc-muted">${esc(t.prefix)}… · ${t.scope}</span></span>
            <button type="button" class="btn sm" data-revoke="${esc(t.id)}">撤销</button></div>`).join('')
      : '<div class="login-hint">还没有 Agent 令牌</div>';
    list.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((b) => {
      b.onclick = async () => {
        try {
          await api.revokeAgentToken(b.dataset.revoke!);
          void loadAgentTokens(box);
        } catch (e) {
          const hint = box.querySelector<HTMLSpanElement>('#tk-hint');
          if (hint) hint.textContent = msgOf(e);
        }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="login-hint bad">${esc(msgOf(e))}</div>`;
  }
}

/* ------------------------------------------------------------ 选择 / 日期 */

function selectPursuit(id: string) {
  const p = findPursuit(id);
  if (p && !state.pursuits.some((x) => x.id === id)) state.pursuits.push(p);
  state.selected = id;
  state.followups = [];
  renderAll();
  void api.followups(id).then((r) => {
    if (state.selected !== id) return;
    state.followups = r.followups;
    renderEditor();
  }).catch(() => { /* 历史读不到不影响其它操作 */ });
}

let whenPop: HTMLElement | null = null;
let whenOut: ((ev: MouseEvent) => void) | null = null;

function closeWhenPicker() {
  if (whenOut) document.removeEventListener('mousedown', whenOut);
  whenOut = null;
  whenPop?.remove();
  whenPop = null;
}

function openWhenPicker(p: Pursuit, anchor: HTMLElement) {
  closeWhenPicker();
  const now = serverNow();
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const selected = new Date(p.dueAt ?? now + 3600_000);
  let hh = selected.getHours(), mm = selected.getMinutes();
  let viewY = selected.getFullYear(), viewM = selected.getMonth();

  const pop = document.createElement('div');
  pop.className = 'dp-pop';
  document.body.appendChild(pop);
  whenPop = pop;

  const commit = (at: number) => {
    const cur = findPursuit(p.id) ?? p;
    void api.update(cur.id, { dueAt: at, version: versionOf(cur) })
      .then(refresh).catch((err) => flashConflict(err, p.id));
    closeWhenPicker();
  };
  const atTime = (d: Date, h: number, m: number) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };

  const render = () => {
    const lead = new Date(viewY, viewM, 1).getDay();
    const total = new Date(viewY, viewM + 1, 0).getDate();
    const cells: string[] = [];
    for (let i = 0; i < lead; i++) cells.push('<span></span>');
    for (let d = 1; d <= total; d++) {
      const key = `${viewY}-${pad(viewM + 1)}-${pad(d)}`;
      const on = key === dateKey(selected);
      const isToday = key === dateKey(new Date(now));
      cells.push(`<button class="dp-day${on ? ' on' : ''}${isToday ? ' today' : ''}" data-day="${key}">${d}</button>`);
    }
    pop.innerHTML = `
      <div class="dp-quick">
        <button data-dp="today9">今天 9:00</button><button data-dp="today18">今晚 18:00</button>
        <button data-dp="tomorrow9">明早 9:00</button><button data-dp="tomorrow18">明晚 18:00</button>
        <button data-dp="week">下周一 9:00</button><button data-dp="hour">1 小时后</button>
      </div>
      <div class="dp-month">
        <button class="btn sm" data-dp="prev" aria-label="上个月">‹</button>
        <b>${viewY} 年 ${viewM + 1} 月</b>
        <button class="btn sm" data-dp="next" aria-label="下个月">›</button>
      </div>
      <div class="dp-grid">
        ${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span class="dp-w">${w}</span>`).join('')}
        ${cells.join('')}
      </div>
      <div class="dp-time">
        <button type="button" class="input dp-time-btn" id="dp-time-btn" data-v="${pad(hh)}:${pad(mm)}">
          <span class="trigger-label">${pad(hh)}:${pad(mm)}</span><span class="trigger-arrow">◷</span></button>
      </div>
      <div class="dp-foot">
        <button class="btn sm" data-dp="cancel">取消</button>
        <button class="btn solid sm" data-dp="ok">确定</button></div>`;
  };

  pop.addEventListener('click', (ev) => {
    const tb = (ev.target as HTMLElement).closest<HTMLElement>('#dp-time-btn');
    if (tb) {
      openTimePicker(tb, tb.dataset.v ?? '09:00', (v) => {
        tb.dataset.v = v;
        tb.querySelector<HTMLElement>('.trigger-label')!.textContent = v;
        const [h, m] = v.split(':').map(Number);
        hh = h; mm = m;
      });
      return;
    }
  });

  pop.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const day = t.closest<HTMLElement>('[data-day]');
    if (day) {
      const [y, m, d] = day.dataset.day!.split('-').map(Number);
      selected.setFullYear(y, m - 1, d);
      render();
      return;
    }
    const b = t.closest<HTMLElement>('[data-dp]');
    if (!b) return;
    const act = b.dataset.dp;
    if (!act) return;
    if (act === 'prev' || act === 'next') {
      viewM += act === 'next' ? 1 : -1;
      if (viewM < 0) { viewM = 11; viewY--; }
      if (viewM > 11) { viewM = 0; viewY++; }
      render();
      return;
    }
    if (act === 'cancel') { closeWhenPicker(); return; }
    if (act === 'ok') { commit(atTime(selected, hh, mm).getTime()); return; }
    const base = new Date(now);
    if (act === 'tomorrow9' || act === 'tomorrow18') base.setDate(base.getDate() + 1);
    if (act === 'week') {
      let delta = (8 - base.getDay()) % 7 || 7;
      base.setDate(base.getDate() + delta);
    }
    if (act === 'hour') commit(now + 3600_000);
    else {
      const hour = act.endsWith('18') ? 18 : 9;
      const at = atTime(base, hour, 0);
      commit(at.getTime() <= now ? at.getTime() + 86400_000 : at.getTime());
    }
  });

  render();
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 288))}px`;
  pop.style.top = `${Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 370))}px`;
  whenOut = (ev) => { if (!pop.contains(ev.target as Node) && ev.target !== anchor) closeWhenPicker(); };
  setTimeout(() => document.addEventListener('mousedown', whenOut!), 0);
}

/* ------------------------------------------------------------ 操作 */

let refreshGen = 0;

async function refresh() {
  const gen = ++refreshGen;
  const view = state.view;
  const [counts, focus] = await Promise.all([
    api.counts().catch(() => null),
    api.focus().catch(() => null),
  ]);
  if (gen !== refreshGen) return;
  if (counts) state.counts = counts;
  if (focus) state.focus = focus;

  if (view === 'settings' || view === 'mystats' || view === 'dashboard' || view === 'tokens') {
    renderAll();
    return;
  }
  try {
    const r = await api.pursuits(view as PursuitView);
    if (gen !== refreshGen || state.view !== view) return;
    state.pursuits = [...r.pursuits].sort((a, b) => b.weight - a.weight);
    if (state.selected && !findPursuit(state.selected)) state.selected = null;
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
      dueAt: p.remindAt,
      importance: captureImportance,
      nature: 'one_off',
    });
    const cap = $<HTMLInputElement>('#cap');
    if (cap) { cap.value = ''; $<HTMLElement>('#parse').hidden = true; }
    captureImportance = 1;
    flash('已记下');
    void refresh();
  } catch (e) {
    flash('保存失败：' + msgOf(e));
  }
}

async function askLater(id: string) {
  const p = findPursuit(id);
  const now = serverNow();
  const at = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const host = document.createElement('div');
  host.className = 'panel-mask';
  host.innerHTML = `
    <div class="panel panel-sm" role="dialog" aria-modal="true">
      <div class="panel-head"><b>延期「${esc((p?.text ?? '').slice(0, 24))}」</b></div>
      <div class="panel-body">
        <div class="snooze-opts">
          <button class="nav" data-to="${at(1)}">明天 9:00</button>
          <button class="nav" data-to="${at(3)}">3 天后 9:00</button>
          <button class="nav" data-to="${at(7)}">下周 9:00</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(host);
  const done = (to?: number) => {
    host.remove();
    if (to) void runFollowup(id, 'later', { to });
  };
  host.addEventListener('click', (ev) => {
    if (ev.target === host) { done(); return; }
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-to]');
    if (b) done(Number(b.dataset.to));
  });
}

async function runFollowup(id: string, action: FollowupAction, extra: Record<string, unknown> = {}) {
  const p = findPursuit(id);
  if (!p && !extra.silent) { flash('这条已经不在了'); return; }
  if (p && !actionsFor(p.status).includes(action)) {
    flash('当前状态不允许这个操作');
    void refresh();
    return;
  }
  const version = p ? versionOf(p) : 0;
  if (action === 'smaller' && !extra.steps) {
    const next = p?.steps.find((s) => s.state !== 'done')?.text ?? p?.text ?? '';
    const value = window.prompt('把这件事拆成 2-3 个能立刻动手的小步骤，用换行分隔', next);
    if (value === null) return;
    const steps = value.split(/\r?\n|；|;/).map((s) => s.trim()).filter(Boolean);
    if (!steps.length) return;
    extra.steps = steps;
  }
  if (action === 'later' && !extra.to) { await askLater(id); return; }

  const body = { action, version, ...(extra.note ? { note: String(extra.note) } : {}),
    ...(extra.to ? { to: Number(extra.to) } : {}),
    ...(Array.isArray(extra.steps) ? { steps: extra.steps as string[] } : {}) };
  try {
    localHandled.set(id, Date.now());
    // 跟进只有 HTTP 一条写入路径；WS 再发一次会用同一个 version 触发乐观锁冲突
    await api.followup(id, body);
    noteFollowup(id, action);
    control.acknowledge(action);
    dropBannerByPursuit(id);
    void refresh();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      flash('这条刚在别的设备上改过，已刷新为最新内容');
      void refresh();
    } else {
      flash('跟进失败：' + msgOf(e));
    }
  }
}

async function runClone(id: string) {
  try {
    const r = await api.clone(id);
    flash('已克隆，步骤状态已重置、截止已清空');
    state.selected = r.pursuit.id;
    void refresh();
  } catch (e) {
    flash('克隆失败：' + msgOf(e));
  }
}

function onListClick(ev: Event) {
  const t = ev.target as HTMLElement;
  const fa = t.closest<HTMLElement>('[data-follow]');
  if (fa) { void runFollowup(fa.dataset.id!, fa.dataset.follow as FollowupAction); return; }
  const f = t.closest<HTMLElement>('[data-focus-act]');
  if (f) { void runFollowup(f.dataset.id!, f.dataset.focusAct as FollowupAction); return; }
  const row = t.closest<HTMLElement>('[data-id]');
  if (row) selectPursuit(row.dataset.id!);
}

function onEditorClick(ev: Event) {
  const t = (ev.target as HTMLElement).closest<HTMLElement>(
    '[data-act],[data-imp],[data-nature]',
  );
  const p = findPursuit(state.selected);
  if (!t || !p) return;
  const savePatch = (patch: Record<string, unknown>) => {
    const cur = findPursuit(p.id) ?? p;
    void api.update(cur.id, { ...patch, version: versionOf(cur) })
      .then(refresh).catch((err) => flashConflict(err, p.id));
  };

  if (t.dataset.imp !== undefined) { savePatch({ importance: Number(t.dataset.imp) }); return; }
  if (t.dataset.nature) { savePatch({ nature: t.dataset.nature }); return; }

  const act = t.dataset.act;
  if (!act) return;
  switch (act) {
    case 'add-step': {
      const input = $<HTMLInputElement>('#new-step');
      const text = input?.value.trim();
      if (!text) return;
      void api.addStep(p.id, { text }).then(refresh).catch((e) => flash(msgOf(e)));
      return;
    }
    case 'clear-due': savePatch({ dueAt: null }); return;
    case 'save-rule': {
      const freq = $<HTMLButtonElement>('#f-freq').dataset.v ?? 'none';
      const fields = {
        byWeekday: $<HTMLInputElement>('#f-byday')?.value?.trim() ?? '',
        byMonthday: $<HTMLInputElement>('#f-bymonthday')?.value?.trim() ?? '',
        byMonth: $<HTMLInputElement>('#f-bymonth')?.value?.trim() ?? '',
      };
      savePatch({ recurrence: buildRecurrence(freq as Parameters<typeof buildRecurrence>[0], fields) });
      return;
    }
    case 'clone': void runClone(p.id); return;
    case 'follow-later': void askLater(p.id); return;
    case 'follow-done':
    case 'follow-smaller':
    case 'follow-archive':
    case 'follow-reopen':
      void runFollowup(p.id, act.slice(7) as FollowupAction);
      return;
  }
}

function onEditorChange(ev: Event) {
  const t = ev.target as HTMLInputElement;
  const p = findPursuit(state.selected);
  if (!p || !t.dataset.step) return;
  const stateName: StepState = t.checked ? 'done' : 'todo';
  void api.updateStep(t.dataset.step, { state: stateName })
    .then(refresh).catch((e) => flash(msgOf(e)));
}

function onEditorKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Enter') return;
  const t = ev.target as HTMLInputElement;
  if (t.id !== 'new-step') return;
  ev.preventDefault();
  const p = findPursuit(state.selected);
  if (!p || !t.value.trim()) return;
  void api.addStep(p.id, { text: t.value.trim() }).then(refresh).catch((e) => flash(msgOf(e)));
}

function onEditorInput(ev: Event) {
  const t = ev.target as HTMLInputElement | HTMLTextAreaElement;
  const p = findPursuit(state.selected);
  if (!p || (t.id !== 'f-text' && t.id !== 'f-note')) return;
  const id = p.id;
  const value = t.value;
  const key = t.id === 'f-text' ? 'text' : 'note';
  const w = window as unknown as Record<string, number>;
  clearTimeout(w.__pursuitDeb);
  w.__pursuitDeb = window.setTimeout(() => {
    const cur = findPursuit(id);
    if (!cur) return;
    editingLocal = true;
    void api.update(id, { [key]: key === 'note' ? (value || null) : value, version: versionOf(cur) })
      .then(refresh).catch((err) => flashConflict(err, id))
      .finally(() => { editingLocal = false; });
  }, 500);
}

function flashConflict(err: unknown, pursuitId: string) {
  if (err instanceof ApiError && err.status === 409) {
    flash('这条刚在别的设备上改过，已刷新为最新内容');
  } else {
    flash('保存失败，检查服务端连接');
  }
  void refresh().then(() => { state.selected = pursuitId; });
}

function setLink(s: 'connecting' | 'open' | 'closed') {
  const dot = $<HTMLElement>('#sdot');
  const txt = $<HTMLElement>('#stxt');
  const srv = $<HTMLElement>('#s-server');
  const conn = $<HTMLElement>('#btn-server');
  if (!dot || !txt) return;
  linkState = s;
  dot.className = `sdot ${s === 'open' ? '' : s === 'connecting' ? 'warn' : 'alert'}`;
  txt.textContent = s === 'open' ? '已连接' : s === 'connecting' ? '连接中' : '已断开';
  conn.title = s === 'closed'
    ? `已断开，正在自动重连。点击切换服务端（${loadConfig().baseUrl}）`
    : `点击切换服务端（${loadConfig().baseUrl}）`;
  if (srv) srv.textContent = `服务端 ${loadConfig().baseUrl}`;
  const mine = loadConfig().device?.id;
  const self = state.devices.find((d) => d.id === mine);
  if (self) self.online = s === 'open';
  renderSidebar();
  renderDeviceStatus();
}

const SKEW_MAX_AUTO = 10_000;

function renderSkew() {
  const skew = $<HTMLElement>('#s-skew');
  if (!skew) return;
  const ms = loadConfig().serverSkewMs;
  skew.textContent = Math.abs(ms) < 1000 ? `${ms} ms` : `${ms > 0 ? '+' : ''}${Math.round(ms / 1000)} s`;
  const box = skew.parentElement;
  if (box) box.classList.toggle('warn', Math.abs(ms) > SKEW_MAX_AUTO);
  skew.title = Math.abs(ms) > SKEW_MAX_AUTO
    ? '本机时钟和服务端差得比较多，倒计时可能有偏差。建议开启系统自动校时'
    : '本机时钟与服务端的偏差，由 welcome 消息算出';
}

function openServerPanel() {
  if (document.querySelector('.panel-mask')) { document.querySelector('.panel-mask')!.remove(); return; }
  const host = document.createElement('div');
  host.className = 'panel-mask';
  host.innerHTML = `
    <div class="panel">
      <div class="panel-head"><b>服务端与本机设备</b><div class="sp"></div>
        <button class="btn sm" id="sp-close">关闭</button></div>
      <div class="panel-body">
        <label class="fld"><span>地址</span>
          <input class="input" id="sp-url" spellcheck="false" autocomplete="off" value="${esc(loadConfig().baseUrl)}"></label>
        <div class="login-row">
          <span class="login-hint" id="sp-hint">同一账号的设备填同一个地址，就看同一份推进项</span>
          <button type="button" class="btn sm" id="sp-test">测试连接</button></div>
        <div class="panel-err" id="sp-err"></div>
        <div class="mid-block">
          <span class="mid-title">本机 machine-id</span>
          <div class="mid-row">
            <input class="input mono mid-val" id="sp-mid" readonly value="读取中…">
            <button type="button" class="btn sm" id="sp-copy">复制</button></div>
          <div class="login-hint">签发 Agent 令牌时可选绑定这个 id。</div>
        </div>
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
  void getMachineId().then((id) => { q<HTMLInputElement>('#sp-mid').value = id || '不是桌面客户端，没有 machine-id'; });
  q<HTMLButtonElement>('#sp-copy').onclick = async () => {
    const id = await getMachineId();
    if (!id) { setHint('拿不到 machine-id', 'bad'); return; }
    const ok = await copyText(id);
    setHint(ok ? '已复制 machine-id' : '复制失败，请手动选中', ok ? 'ok' : 'bad');
  };
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
    switchServer(norm);
    err.textContent = '已切换，正在重新登录...';
    rt?.close();
    location.reload();
  });
  url.focus();
  url.select();
}

/* ------------------------------------------------------ 跨窗口事件 */

function wireEvents() {
  if (!hasTauri()) return;
  listen<{ pursuitId: string; action: FollowupAction; version?: number; note?: string; to?: number; steps?: string[] }>(
    'takeover:action', async (ev) => {
      const { pursuitId, action, note, to, steps } = ev.payload;
      control.acknowledge(action);
      await runFollowup(pursuitId, action, {
        ...(note ? { note } : {}), ...(to ? { to } : {}), ...(steps ? { steps } : {}),
      });
    },
  );
  listen<{ pursuitId: string; url: string }>('takeover:open-url', async (ev) => {
    const { pursuitId, url } = ev.payload;
    control.acknowledge('done');
    await runFollowup(pursuitId, 'done');
    quiet('open_external', { url });
  });
  listen<{ text: string; dueAt: number | null; kind: string; importance: number }>(
    'capture:submit', async (ev) => {
      const { text, dueAt, kind, importance } = ev.payload;
      try {
        await api.create({
          text, kind: kind as 'text' | 'link' | 'path', dueAt,
          importance: importance as Importance,
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
  if (hasTauri()) {
    if (isDesktop()) void native('set_close_behavior', { behavior: closeBehavior() });
    void native('log_event', { level: 'info', message: '客户端启动' });
  }
  rt = new Realtime(onRealtime, setLink);
  rt.connect();
  void refresh();

  if (!loadConfig().device) window.setInterval(() => void refresh(), 10_000);

  renderUpdateBadge();
  tickUrgency();
  window.setInterval(tickUrgency, 20_000);
}

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome':
      if (msg.missed.length) flash(`上线补发 ${msg.missed.length} 条跟进，已同步到列表`);
      void refresh();
      break;
    case 'devices.changed':
      state.devices = msg.devices;
      const mine = loadConfig().device?.id;
      const self = state.devices.find((d) => d.id === mine);
      if (self) self.online = linkState === 'open';
      renderSidebar();
      renderDeviceStatus();
      if ($('#set-devices')) renderDeviceRows();
      break;
    case 'pursuit.created':
    case 'pursuit.updated':
    case 'pursuit.stepped':
      control.dismissedElsewhere(msg.pursuit.id);
      dropBannerByPursuit(msg.pursuit.id);
      void refresh();
      break;
    case 'pursuit.followed':
      noteFollowup(msg.pursuit.id, msg.action);
      control.dismissedElsewhere(msg.pursuit.id);
      dropBannerByPursuit(msg.pursuit.id);
      void refresh();
      break;
    case 'pursuit.deleted':
      dropBannerByPursuit(msg.pursuitId);
      void refresh();
      break;
    case 'pursuit.focused':
      state.focus = { serverTs: serverNow(), items: msg.items, budgetLeft: msg.budgetLeft };
      renderAll();
      break;
    case 'pursuit.nudge':
      control.fire(msg.pursuit, msg.level, msg.reason, msg.channel);
      void refresh();
      break;
    case 'settings.changed':
      saveConfig({ settings: msg.settings });
      void refresh();
      break;
    default:
      break;
  }
}

applyTheme(loadTheme());
onUnauthorized(() => { rt?.close(); location.reload(); });

(async () => {
  platform = await getPlatform();
  initUpdater(platform, flash);
  const cfg = loadConfig();
  if (!cfg.token && !cfg.baseUrl) { renderSetup(); return; }
  try {
    if ((await api.setupStatus()).needed) { renderSetup(); return; }
  } catch { /* 连不上就走原来的登录/启动流程 */ }
  if (cfg.token) boot();
  else renderLogin();
})();
