/**
 * 桌面端「今日推进」工作台（M3 Navigation Drawer/Rail + 自适应 List-Detail）。
 * 服务端是唯一计时与策略权威，客户端负责低摩擦展示与跟进意图回传。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { autoUpdateEnabled, initUpdater, onUpdateChange, openAbout, setAutoUpdate, updateBadge } from '../about';
import {
  ApiError, Realtime, api, clearToken, dayLabel, dueLabel, getMachineId, getPlatform,
  hhmm, hostOf, importanceForStrength, lateBy, levelForStrength, loadConfig, normalizeBaseUrl, noteFollowup, onUnauthorized,
  parseInput, probeServer, saveConfig, serverNow, staleLabel, switchServer,
  versionOf, warmthOf, FREQ_LABEL, FOLLOWUP_ACTION_LABEL, NATURE_LABEL, rowActions,
  type CountsResult, type Device, type Followup, type FollowupAction, type FocusResult,
  type MyStats, type Pursuit, type PursuitStatus, type PursuitView,
  type ReminderStrength, type ServerMessage, type Settings, type StepEdit, type StepState,
} from '../api';
import { actionsFor } from '../../../shared/types';
import { buildRecurrence, fieldsFor, ruleFields, type Freq } from './recurrence-form';
import { FollowupController } from '../alarm';
import { ICO } from '../icons';
import { THEMES, applyTheme, loadTheme, saveTheme } from '../theme';
import { openConfirmDialog, openDateTimePicker, openDropdown, openSnoozeDialog, openStepsDialog, openTimePicker } from '../widgets';
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

async function nativeOk(cmd: string, args?: Record<string, unknown>): Promise<boolean> {
  if (!hasTauri()) { flash('这个功能只在桌面客户端里可用'); return false; }
  try {
    await invoke(cmd, args);
    return true;
  } catch (err) {
    flash('操作失败：' + (err instanceof Error ? err.message : String(err)));
    return false;
  }
}

function quiet<T = void>(cmd: string, args?: Record<string, unknown>): void {
  if (!hasTauri()) return;
  void invoke<T>(cmd, args).catch(() => {});
}

function ringPing(args: Record<string, unknown>) {
  if (loadConfig().settings.sound === 'none') return;
  quiet('ping', args);
}

function send(name: string, payload: unknown = {}) {
  if (!hasTauri()) return;
  void emit(name, payload).catch(() => {});
}

type View = PursuitView | 'mystats' | 'dashboard' | 'tokens' | 'settings';

const VIEWS: Record<View, { title: string; sub: string }> = {
  today: { title: '今日待办', sub: '今天到期或已逾期，按截止时间从近到远' },
  todo: { title: '全部待办', sub: '所有未完成的推进项' },
  done: { title: '已完成', sub: '已推进收尾的事项' },
  archived: { title: '已归档', sub: '主动结束或超期自动归档的事项' },
  mystats: { title: '推进看板', sub: '连续推进节奏与近 7 天完成情况' },
  dashboard: { title: '系统看板', sub: '服务端总览，仅管理员可见，每 5 秒刷新' },
  tokens: { title: 'Agent 令牌', sub: '签发和管理给 MCP / Agent 使用的访问令牌' },
  settings: { title: '设置', sub: '推进节奏、外观主题、设备、用户与日志' },
};

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const RAIL_KEY = 'deskalarm.rail';

const state = {
  view: 'today' as View,
  focus: null as FocusResult | null,
  pursuits: [] as Pursuit[],
  followups: [] as Followup[],
  devices: [] as Device[],
  counts: null as CountsResult | null,
  selected: null as string | null,
  rail: localStorage.getItem(RAIL_KEY) === '1',
};

let rt: Realtime | null = null;
let linkState: 'connecting' | 'open' | 'closed' = 'closed';

interface TakeoverPayload {
  items: Pursuit[];
  index: number;
  reason: string;
  serverTs: number;
  muted: boolean;
}
let takeoverQueue: Pursuit[] = [];
let takeoverReason = '';
let lastTakeover: TakeoverPayload | null = null;
let takeoverTimer: number | null = null;
let lastWeakDigestAt = 0;
const lastStrongPingAt = new Map<string, number>();

function scheduleTakeover() {
  if (takeoverTimer !== null) clearTimeout(takeoverTimer);
  takeoverTimer = window.setTimeout(() => {
    takeoverTimer = null;
    showTakeover();
  }, 400);
}

function enqueueTakeover(p: Pursuit, reason: string, ring = true) {
  const idx = takeoverQueue.findIndex((x) => x.id === p.id);
  if (idx >= 0) takeoverQueue[idx] = p;
  else takeoverQueue.push(p);
  takeoverReason = reason;
  if (ring) {
    const prev = lastStrongPingAt.get(p.id) ?? 0;
    if (Date.now() - prev > 5_000) {
      lastStrongPingAt.set(p.id, Date.now());
      ringPing({ title: `强提醒：${p.text}`, body: reason });
    }
  }
  scheduleTakeover();
}

function showTakeover() {
  if (!takeoverQueue.length) {
    lastTakeover = null;
    quiet('hide_takeover');
    return;
  }
  lastTakeover = {
    items: [...takeoverQueue],
    index: Math.min(lastTakeover?.index ?? 0, takeoverQueue.length - 1),
    reason: takeoverReason,
    serverTs: serverNow(),
    muted: false,
  };
  void invoke('show_takeover', { payload: lastTakeover }).catch((err: unknown) => {
    flash('接管窗口启动失败：' + (err instanceof Error ? err.message : String(err)));
  });
}

function dropTakeoverItem(id: string) {
  const i = takeoverQueue.findIndex((p) => p.id === id);
  if (i < 0) return false;
  takeoverQueue.splice(i, 1);
  return true;
}

listen('takeover:ready', () => {
  if (lastTakeover) void emit('takeover:show', lastTakeover);
});

const localHandled = new Map<string, number>();
let platform: 'web' | 'windows' | 'macos' | 'linux' | 'android' = 'web';
const isDesktop = () => platform === 'windows' || platform === 'macos' || platform === 'linux';
let captureStrength: ReminderStrength = 'weak';

function selectedWeekdays(raw: string): Set<number> {
  const set = new Set<number>();
  for (const part of raw.split(/[,，\s]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set;
}

function ruleFieldsHtml(
  freq: string,
  rf: { byWeekday: string; byMonthday: string; byMonth: string },
): string {
  const shown = fieldsFor(freq as Freq);
  if (!shown.length) return '';
  const label = freq === 'yearly' ? '几号' : freq === 'quarterly' ? '每季度几号' : '每月几号';
  const pickedDays = selectedWeekdays(rf.byWeekday);
  return `
    ${shown.includes('weekday') ? `
      <div class="wd-chips" id="f-wd-chips">
        ${WEEKDAYS.map((w, i) => `<button type="button" class="wd-chip${pickedDays.has(i) ? ' on' : ''}" data-wd="${i}">周${w}</button>`).join('')}
      </div>
      <input type="hidden" id="f-byday" value="${esc(rf.byWeekday)}">` : ''}
    ${shown.includes('month') || shown.includes('monthday') ? `
      <div class="rule-grid">
        ${shown.includes('month') ? `<label>月份（1-12）<input class="input" id="f-bymonth" type="number" min="1" max="12" value="${esc(rf.byMonth)}"></label>` : ''}
        ${shown.includes('monthday') ? `<label>${label}<input class="input" id="f-bymonthday" type="number" min="1" max="31" value="${esc(rf.byMonthday)}"></label>` : ''}
      </div>` : ''}
    <div class="set-actions"><button type="button" class="btn sm tonal" data-act="save-rule">保存重复规则</button></div>`;
}

const control = new FollowupController({
  onNotify: (p, reason, attempt) => {
    // 刚上线已汇总过的老逾期弱提醒，60 秒内不再重复刷单条通知
    if (p.dueAt !== null && serverNow() - p.dueAt > 60_000 && Date.now() - lastWeakDigestAt < 60_000) {
      return;
    }
    ringPing({
      title: p.text,
      body: `${reason}${attempt > 1 ? ` · 第 ${attempt} 次` : ''}`,
    });
  },
  onTakeover: (p, reason) => {
    enqueueTakeover(p, reason, true);
  },
  onStop: (p, reason) => {
    if (dropTakeoverItem(p.id)) showTakeover();
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
            <span class="login-hint" id="probe">填 host:port 会自动补 http://</span>
            <button type="button" class="btn sm tonal" id="test">测试连接</button>
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
          <button type="button" class="btn sm ghost" id="about-link">关于 / 检查更新</button>
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
    go.textContent = '登录中…';
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
    probe.textContent = '测试中…';
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
            <button type="button" class="btn sm tonal" id="test">测试连接</button>
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
          <button type="button" class="btn sm ghost" id="to-login">已有管理员？去登录</button>
          <button type="button" class="btn sm ghost" id="about-link">关于 / 检查更新</button>
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
    probe.textContent = '测试中…';
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
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const cur = loadTheme();
  const now = THEMES.find((t) => t.id === cur)!;
  const next = THEMES.find((t) => t.id !== cur)!;
  btn.innerHTML = cur === 'dark' ? ICO.sun(18) : ICO.moon(18);
  btn.title = `当前：${now.label}（${now.hint}），点击切到${next.label}`;
  btn.setAttribute('aria-label', btn.title);
}

function toggleTheme() {
  saveTheme(loadTheme() === 'dark' ? 'morandi' : 'dark');
  renderThemeButton();
  send('theme:changed', { theme: loadTheme() });
}

/* ------------------------------------------------------------ 主界面骨架 */

function renderShell() {
  const u = loadConfig().user;
  document.body.innerHTML = `
  <div class="app${state.rail ? ' rail' : ''}" id="app-shell">
    <aside class="sidebar">
      <div class="sb-brand">
        <span class="sb-logo"></span>
        <b>DeskAlarm</b>
        <span class="sp"></span>
        <button type="button" class="sb-tool-btn sb-collapse" id="btn-rail" title="折叠 / 展开导航栏" aria-label="折叠导航栏">${ICO.panelCollapse(18)}</button>
      </div>

      <button type="button" class="conn-pill" id="btn-server" title="点击切换服务端">
        <span class="sdot off" id="sdot"></span>
        <span class="conn-label" id="stxt">未连接</span>
      </button>

      ${isDesktop() ? `
      <button type="button" class="sb-fab" id="btn-hotkey" title="全局热键 Ctrl+Shift+Space">
        ${ICO.add(18)}<span class="fab-txt">快速记</span><span class="fab-kbd">Ctrl+Shift+Space</span>
      </button>` : ''}

      <div class="sb-scroll" id="sidebar"></div>

      <div class="sb-foot">
        ${u?.role === 'admin' ? `
        <button type="button" class="nav" data-view="dashboard" id="nav-dashboard">
          <span class="nav-ico">${ICO.dashboard(19)}</span><span class="nav-txt">系统看板</span>
        </button>` : ''}
        <button type="button" class="nav" data-view="settings" id="nav-settings">
          <span class="nav-ico">${ICO.settings(19)}</span><span class="nav-txt">设置</span>
        </button>
        <div class="sb-user-row">
          <div class="sb-avatar" title="${esc(u?.username ?? '')}">${esc((u?.username ?? '?').slice(0, 1).toUpperCase())}</div>
          <span class="sb-user-name">${esc(u?.username ?? '?')}</span>
          <div class="sb-tools">
            <button type="button" class="sb-tool-btn" id="btn-theme" title="切换配色"></button>
            <button type="button" class="sb-tool-btn" id="btn-update" title="关于 / 检查更新" aria-label="检查更新">${ICO.update(18)}</button>
            <button type="button" class="sb-tool-btn" id="btn-logout" title="退出登录" aria-label="退出登录">${ICO.logout(18)}</button>
          </div>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <div class="skew-banner" id="skew-banner" hidden>
        ${ICO.alert(16)}
        <span id="skew-banner-txt"></span>
      </div>

      <div class="body wide" id="body-grid">
        <main class="list">
          <div class="list-inner">
            <div class="list-head">
              <div>
                <h1 id="vtitle"></h1>
                <p id="vsub"></p>
              </div>
            </div>

            <div class="capture-bar" id="capture-bar">
              <div class="capture-in">
                <span class="prompt">${ICO.add(18)}</span>
                <input id="cap" placeholder="想到什么就记下来，回车进待办，带时间自动设截止" autocomplete="off">
                <div class="cap-str-seg" id="cap-str-seg">
                  <button type="button" class="on" data-strength="weak" title="到点发通知，未填时间默认 1 天后">弱</button>
                  <button type="button" data-strength="strong" title="到点弹接管窗，未填时间默认 2 小时后">强</button>
                </div>
                <button type="button" class="btn sm solid" id="cap-go">记一条</button>
              </div>
              <div class="parse" id="parse" hidden></div>
            </div>

            <div class="list-scroll" id="list"></div>
          </div>
        </main>
        <aside class="editor" id="editor"></aside>
      </div>
    </div>
  </div>`;

  if (isDesktop()) $<HTMLButtonElement>('#btn-hotkey')!.onclick = () => void native('show_capture');
  $<HTMLButtonElement>('#btn-rail')!.onclick = () => {
    state.rail = !state.rail;
    localStorage.setItem(RAIL_KEY, state.rail ? '1' : '0');
    const shell = $<HTMLElement>('#app-shell');
    shell.classList.toggle('rail', state.rail);
    shell.classList.toggle('drawer-open', !state.rail);
  };
  $<HTMLButtonElement>('#btn-update')!.onclick = () => openAbout();
  $<HTMLElement>('#btn-server')!.onclick = () => openServerPanel();
  renderThemeButton();
  $<HTMLButtonElement>('#btn-theme')!.onclick = () => toggleTheme();
  $<HTMLButtonElement>('#btn-logout')!.onclick = async () => {
    const ok = await openConfirmDialog({
      title: '退出当前账号？',
      detail: '退出后将停止本机实时提醒，下次启动需要重新登录。',
      confirmText: '退出登录',
      danger: true,
    });
    if (!ok) return;
    rt?.close();
    clearToken();
    location.reload();
  };

  const cap = $<HTMLInputElement>('#cap');
  const parse = $<HTMLDivElement>('#parse');
  const capSeg = $<HTMLDivElement>('#cap-str-seg');
  const syncCapSeg = () => {
    capSeg.querySelectorAll<HTMLButtonElement>('[data-strength]').forEach((b) => {
      const on = b.dataset.strength === captureStrength;
      b.classList.toggle('on', on);
      b.classList.toggle('hot', on && captureStrength === 'strong');
    });
  };
  const preview = () => {
    syncCapSeg();
    const v = cap.value;
    if (!v.trim()) { parse.hidden = true; return; }
    const p = parseInput(v);
    parse.hidden = false;
    parse.innerHTML = `
      <span class="lb">已识别</span>
      <span class="chip ${p.kind === 'text' ? '' : 'hot'}">${esc(p.kindLabel)}</span>
      <span class="chip ${p.remindAt ? 'hot' : ''}">${esc(p.remindAt ? `截止：${p.timeLabel}` : '未填时间 · 按强弱给默认截止')}</span>`;
  };
  cap.addEventListener('input', preview);
  capSeg.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-strength]');
    if (!b) return;
    captureStrength = b.dataset.strength as ReminderStrength;
    preview();
    cap.focus();
  });
  cap.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void submitCapture(cap.value); });
  $<HTMLButtonElement>('#cap-go')!.onclick = () => void submitCapture(cap.value);

  document.querySelector('.sidebar')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (b) setView(b.dataset.view as View);
  });

  $<HTMLElement>('#list').addEventListener('click', onListClick);
  $<HTMLElement>('#editor').addEventListener('click', onEditorClick);
  $<HTMLElement>('#editor').addEventListener('change', onEditorChange);
  $<HTMLElement>('#editor').addEventListener('input', onEditorInput);
  $<HTMLElement>('#editor').addEventListener('keydown', onEditorKeydown);

  document.addEventListener('keydown', onGlobalKeydown);
}

function onGlobalKeydown(ev: KeyboardEvent) {
  if (document.querySelector('.md-mask, .dp-pop, .panel-mask, .abt-mask')) return;
  const active = document.activeElement as HTMLElement | null;
  const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
  if (ev.key === 'Escape' && state.selected && !typing) {
    state.selected = null;
    renderAll();
    return;
  }
  if (typing || !state.pursuits.length) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    const ids = state.pursuits.map((p) => p.id);
    const idx = state.selected ? ids.indexOf(state.selected) : -1;
    const next = ev.key === 'ArrowDown'
      ? ids[Math.min(idx + 1, ids.length - 1)]
      : ids[Math.max(idx - 1, 0)];
    if (next) selectPursuit(next);
  }
}

/* -------------------------------------------------- 更新角标与提示 */

function renderUpdateBadge() {
  const btn = document.getElementById('btn-update');
  if (!btn) return;
  const s = updateBadge();
  btn.classList.toggle('has-update', s.available);
  const title = !s.available ? '关于 / 检查更新' : s.ready ? `安装更新 v${s.version}` : `发现新版本 v${s.version}`;
  btn.title = title;
  btn.setAttribute('aria-label', title);
}
onUpdateChange(renderUpdateBadge);

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
  flashTimer = window.setTimeout(() => el?.classList.remove('on'), 4500);
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

/* ------------------------------------------------------------ 视图与渲染 */

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
  const overdueCount = state.pursuits.filter((p) => p.status !== 'done' && p.status !== 'archived' && p.dueAt !== null && p.dueAt <= serverNow()).length;
  const nav: Array<[View, string, string, number, boolean]> = [
    ['today', '今日待办', ICO.today(19), state.counts?.today ?? 0, overdueCount > 0],
    ['todo', '全部待办', ICO.todo(19), state.counts?.todo ?? 0, false],
    ['mystats', '推进看板', ICO.stats(19), 0, false],
    ['done', '已完成', ICO.done(19), countOf('done'), false],
    ['archived', '已归档', ICO.archive(19), countOf('archived'), false],
  ];
  const host = document.getElementById('sidebar');
  if (!host) return;
  host.innerHTML = `
    ${nav.map(([v, label, icon, n, alert]) => `
      <button type="button" class="nav ${state.view === v ? 'on' : ''}" data-view="${v}" title="${label}">
        <span class="nav-ico">${icon}</span>
        <span class="nav-txt">${label}</span>
        ${n ? `<span class="count${alert ? ' alert' : ''}">${n}</span>` : ''}
      </button>`).join('')}
    <div class="nav-sep"></div>
    <div class="nav-head">协同与设备</div>
    <button type="button" class="nav ${state.view === 'tokens' ? 'on' : ''}" data-view="tokens" title="Agent 令牌">
      <span class="nav-ico">${ICO.token(19)}</span>
      <span class="nav-txt">Agent 令牌</span>
    </button>
    <div class="dev-list">
      ${state.devices.map((d) => `
        <div class="dev-pill" title="${esc(d.platform)} · ${esc(d.lastIp ?? '无 IP')}">
          <span class="sdot ${d.online ? '' : 'off'}"></span>
          <span class="dev-name">${esc(d.name)}</span>
          <span class="dev-st">${d.online ? '在线' : '离线'}</span>
        </div>`).join('') || '<div class="nav-note">暂无在线设备</div>'}
    </div>`;

  document.getElementById('nav-settings')?.classList.toggle('on', state.view === 'settings');
  document.getElementById('nav-dashboard')?.classList.toggle('on', state.view === 'dashboard');
}

function progressHtml(p: Pursuit): string {
  const total = p.steps.length;
  if (!total) return '';
  const done = p.steps.filter((s) => s.state === 'done').length;
  const pct = Math.round((done / total) * 100);
  return `<span class="tag" title="步骤进度 ${done}/${total}">
    <span class="prog"><i style="width:${pct}%"></i></span>
    <span class="mono">${done}/${total}</span>
  </span>`;
}

function rowHtml(p: Pursuit): string {
  const u = warmthOf(p);
  const isDone = p.status === 'done';
  const isArchived = p.status === 'archived';
  const nextStep = p.steps.find((s) => s.state !== 'done');
  const actions = rowActions(p.status);
  const checkAttr = isDone || isArchived
    ? 'class="it-check static"'
    : `class="it-check${p.strength === 'strong' ? ' strong' : ''}" data-follow="done" data-id="${esc(p.id)}" data-step="${esc(nextStep?.id ?? '')}" title="${nextStep ? `完成步骤：${esc(nextStep.text)}` : '标记完成'}"`;

  return `
  <div class="item u-${u}${isDone ? ' done' : ''}${state.selected === p.id ? ' on' : ''}" data-id="${esc(p.id)}" data-u="${u}">
    <button type="button" ${checkAttr}>${ICO.check(13)}</button>
    <div class="it-main">
      <div class="it-time">
        ${u === 'none' ? '' : `<i class="udot ${u}"></i>`}
        <span>${esc(dueLabel(p))} · ${esc(staleLabel(p))}</span>
        ${p.strength === 'strong' ? `<span class="str-badge">${ICO.bolt(11)}强提醒</span>` : ''}
      </div>
      <div class="it-title">${esc(p.text)}</div>
      <div class="it-meta">
        ${progressHtml(p)}
        ${p.nature === 'project' ? `<span class="tag">${NATURE_LABEL[p.nature]}</span>` : ''}
        ${p.url ? `<span class="tag" title="${esc(p.url)}">${ICO.link(12)}${esc(hostOf(p.url))}</span>` : ''}
        ${p.path ? `<span class="tag path" title="${esc(p.path)}">${esc(p.path)}</span>` : ''}
      </div>
    </div>
    <div class="it-act">
      ${!isDone && !isArchived ? `
        <button type="button" class="btn icon-only sm hover-act" data-follow="later" data-id="${esc(p.id)}" title="延期">${ICO.clock(15)}</button>
        <button type="button" class="btn icon-only sm hover-act" data-follow="smaller" data-id="${esc(p.id)}" title="拆小步骤">${ICO.split(15)}</button>` : ''}
      ${actions.map((a) => `<button type="button" class="btn sm ${a === 'done' ? 'tonal' : a === 'archive' ? 'danger' : 'ghost'}" data-follow="${a}" data-id="${esc(p.id)}" ${a === 'done' ? `data-step="${esc(nextStep?.id ?? '')}"` : ''}>${FOLLOWUP_ACTION_LABEL[a]}</button>`).join('')}
      ${isArchived ? `<button type="button" class="btn sm danger" data-del="${esc(p.id)}" title="永久删除">删除</button>` : ''}
    </div>
  </div>`;
}

function groupPursuits(list: Pursuit[]): Array<{ title: string; hot?: boolean; items: Pursuit[] }> {
  if (state.view === 'done' || state.view === 'archived') {
    return [{ title: '', items: list }];
  }
  const now = serverNow();
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  const endTomorrow = new Date(endToday.getTime() + 86_400_000);

  const over: Pursuit[] = [];
  const today: Pursuit[] = [];
  const tomorrow: Pursuit[] = [];
  const later: Pursuit[] = [];

  for (const p of list) {
    if (p.dueAt !== null && p.dueAt <= now) over.push(p);
    else if (p.dueAt !== null && p.dueAt <= endToday.getTime()) today.push(p);
    else if (p.dueAt !== null && p.dueAt <= endTomorrow.getTime()) tomorrow.push(p);
    else later.push(p);
  }

  const out: Array<{ title: string; hot?: boolean; items: Pursuit[] }> = [];
  if (over.length) out.push({ title: '已逾期 · 待处理', hot: true, items: over });
  if (today.length) out.push({ title: '今天到期', items: today });
  if (tomorrow.length) out.push({ title: '明天', items: tomorrow });
  if (later.length) out.push({ title: '更晚或未设截止', items: later });
  return out;
}

function renderList() {
  const box = $<HTMLDivElement>('#list');
  if (state.view === 'dashboard') { renderDashboard(box); return; }
  if (state.view === 'tokens') { renderTokens(box); return; }
  if (state.view === 'settings') { renderSettingsView(box); return; }
  if (state.view === 'mystats') { renderStatsView(box); return; }

  const emptyCopy: Partial<Record<View, [string, string, string]>> = {
    today: [ICO.today(24), '今天很清静', '今天到期或已逾期的推进项会出现在这里。'],
    todo: [ICO.todo(24), '待办是空的', '在上方输入框写一句话，回车立刻开始推进。'],
    done: [ICO.done(24), '还没有已完成的事项', '推完的每一件事都会沉淀在这里。'],
    archived: [ICO.archive(24), '归档是空的', '主动结束或超期自动归档的条目会放在这里。'],
  };
  if (!state.pursuits.length) {
    const [ico, title, detail] = emptyCopy[state.view] ?? [ICO.todo(24), '空的', ''];
    box.innerHTML = `<div class="empty"><div class="empty-ico">${ico}</div><b>${title}</b><p>${detail}</p></div>`;
    return;
  }

  const groups = groupPursuits(state.pursuits);
  box.innerHTML = groups.map((g) => `
    ${g.title ? `<div class="group${g.hot ? ' hot' : ''}"><span>${g.title}</span><span class="g-cnt">${g.items.length}</span><span class="line"></span></div>` : ''}
    ${g.items.map(rowHtml).join('')}`).join('');
}

/* ------------------------------------------------------------ 动态详情面板 */

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
    box.innerHTML = '';
    return;
  }

  const freq = p.recurrence?.freq ?? 'none';
  const rf = ruleFields(p.recurrence);
  const ruleFieldsShown = fieldsFor(freq);
  const due = p.dueAt === null ? '未设截止' : `${dayLabel(p.dueAt)} ${hhmm(p.dueAt)}`;
  const nextStep = p.steps.find((s) => s.state !== 'done');
  const footActions = (['later', 'smaller', 'reopen', 'archive'] as FollowupAction[])
    .filter((a) => actionsFor(p.status).includes(a));

  box.innerHTML = `
    <div class="ed-head">
      <b>推进详情</b>
      <span class="ed-saved" id="ed-saved"></span>
      <button type="button" class="btn icon-only sm" data-act="close-editor" title="收起详情 (Esc)" aria-label="收起详情">${ICO.close(16)}</button>
    </div>
    <div class="ed-body">
      <div class="fld"><label for="f-text">事项内容</label>
        <textarea class="ed-title-input" id="f-text" rows="2">${esc(p.text)}</textarea></div>

      <div class="fld"><label>提醒类型</label>
        <div class="seg">
          <button type="button" data-strength="weak" class="${p.strength === 'weak' ? 'on' : ''}" title="到点发通知，未填时间默认 1 天后">弱提醒</button>
          <button type="button" data-strength="strong" class="${p.strength === 'strong' ? 'on hot' : ''}" title="到点弹接管窗，未填时间默认 2 小时后">${ICO.bolt(13)}强提醒</button>
        </div></div>

      <div class="fld"><label>截止时间</label>
        <div class="when-wrap">
          <button type="button" class="input when-btn" id="f-when">
            <span class="mono">${esc(due)}</span><span class="when-edit">修改</span>
          </button>
          ${p.dueAt !== null ? `<button type="button" class="btn icon-only sm ghost" data-act="clear-due" title="清除截止">${ICO.close(14)}</button>` : ''}
        </div></div>

      <div class="fld"><label>步骤清单${p.steps.length ? `（${p.steps.filter((s) => s.state === 'done').length}/${p.steps.length}）` : ''}</label>
        <div class="steps">
          ${p.steps.length ? p.steps.map((s) => `
            <div class="step ${s.state === 'done' ? 'done' : ''}">
              <input type="checkbox" data-step="${esc(s.id)}" ${s.state === 'done' ? 'checked' : ''} title="标记完成">
              <input class="step-text" data-step-text="${esc(s.id)}" value="${esc(s.text)}" aria-label="步骤文字">
              <button type="button" class="step-del" data-step-del="${esc(s.id)}" title="删除步骤" aria-label="删除步骤">${ICO.close(14)}</button>
            </div>`).join('')
            : '<div class="hint">拆成 2–3 个可立刻动手的小步，推进阻力会小很多。</div>'}
        </div>
        <div class="add-step">
          <input class="input" id="new-step" placeholder="加一个步骤，回车添加">
          <button type="button" class="btn sm tonal" data-act="add-step">添加</button>
        </div></div>

      <div class="fld"><label for="f-note">备注与上下文</label>
        <textarea class="input ed-textarea" id="f-note" rows="3" placeholder="补充背景、链接或关键线索">${esc(p.note ?? '')}</textarea></div>

      <div class="fld"><label>性质</label>
        <div class="seg">${(['one_off', 'project'] as const).map((n) =>
          `<button type="button" data-nature="${n}" class="${p.nature === n ? 'on' : ''}">${NATURE_LABEL[n]}</button>`,
        ).join('')}</div></div>

      <div class="fld"><label>重复规则</label>
        <button type="button" class="input trigger" id="f-freq" data-v="${freq}">
          <span class="trigger-label">${FREQ_LABEL[freq]}</span>
          <span class="trigger-arrow">${ICO.chevronDown(15)}</span></button>
        <div id="f-rule-extra" ${ruleFieldsShown.length === 0 ? 'hidden' : ''}>${ruleFieldsHtml(freq, rf)}</div></div>

      <div class="fld"><label>跟进历史</label>
        ${state.followups.length ? `<div class="fu-list">${state.followups.map((f) => `
          <div class="fu-row"><span class="mono">${esc(new Date(f.at).toLocaleString('zh-CN'))}</span>
            <span class="tag">${f.level === 4 ? '强提醒' : '弱提醒'}</span><b>${esc(FOLLOWUP_ACTION_LABEL[f.action] ?? f.action)}</b>
            ${f.note ? `<span>${esc(f.note)}</span>` : ''}</div>`).join('')}</div>`
          : '<div class="hint">还没有跟进记录。</div>'}</div>
    </div>

    <div class="ed-foot">
      ${actionsFor(p.status).includes('done') ? `
        <button type="button" class="btn solid" data-act="follow-done" data-step="${esc(nextStep?.id ?? '')}">${ICO.check(15)}${nextStep ? '完成一步' : '完成'}</button>` : ''}
      ${footActions.map((a) => `<button type="button" class="btn ${a === 'archive' ? 'danger' : 'tonal'}" data-act="follow-${a}">${FOLLOWUP_ACTION_LABEL[a]}</button>`).join('')}
      <button type="button" class="btn ghost" data-act="clone">${ICO.clone(14)}克隆</button>
      ${p.status === 'archived' ? `<button type="button" class="btn danger" data-act="delete">${ICO.trash(14)}删除</button>` : ''}
    </div>`;

  const when = $<HTMLButtonElement>('#f-when');
  if (when) when.onclick = () => openWhenPicker(p, when);
  const freqBtn = $<HTMLButtonElement>('#f-freq');
  if (freqBtn) freqBtn.onclick = (ev) => {
    const items = (Object.keys(FREQ_LABEL) as Array<keyof typeof FREQ_LABEL>)
      .map((v) => ({ value: v, label: FREQ_LABEL[v] }));
    openDropdown(ev.currentTarget as HTMLElement, items, freqBtn.dataset.v ?? freq, (v) => {
      const key = v as Freq;
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
      if (key === 'none' || key === 'daily') {
        void api.update(p.id, { recurrence: buildRecurrence(key, current), version: versionOf(p) })
          .then(refresh).catch((err) => flashConflict(err, p.id));
      }
    });
  };
}

function renderAll() {
  if (!document.getElementById('list')) return;
  const isFullPage = state.view === 'settings' || state.view === 'mystats' ||
    state.view === 'dashboard' || state.view === 'tokens';
  const showCapture = state.view === 'today' || state.view === 'todo';
  const capBar = document.getElementById('capture-bar');
  if (capBar) capBar.hidden = !showCapture;

  const hasDetail = !isFullPage && Boolean(findPursuit(state.selected));
  $<HTMLElement>('#body-grid')!.classList.toggle('wide', !hasDetail);

  const v = VIEWS[state.view];
  $<HTMLElement>('#vtitle')!.textContent = v.title;
  $<HTMLElement>('#vsub')!.textContent = v.sub;

  const listTop = document.querySelector<HTMLElement>('.list-scroll')?.scrollTop ?? 0;
  const editorTop = document.querySelector<HTMLElement>('.ed-body')?.scrollTop ?? 0;
  renderSidebar();
  renderList();
  if (!hasDetail) $<HTMLElement>('#editor')!.innerHTML = '';
  else renderEditor();
  const listBox = document.querySelector<HTMLElement>('.list-scroll');
  if (listBox) listBox.scrollTop = listTop;
  const editorBox = document.querySelector<HTMLElement>('.ed-body');
  if (editorBox) editorBox.scrollTop = editorTop;
  renderSkew();
}

function tickUrgency() {
  const box = document.getElementById('list');
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
      t.innerHTML = `${u === 'none' ? '' : `<i class="udot ${u}"></i>`}<span>${esc(`${dueLabel(p)} · ${staleLabel(p)}`)}</span>${p.strength === 'strong' ? `<span class="str-badge">${ICO.bolt(11)}强提醒</span>` : ''}`;
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

const hhmmOfMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const minOfHhmm = (v: string) => {
  const [h, m] = v.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function renderSettingsView(box: HTMLElement) {
  const existing = box.querySelector('.settings');
  if (existing && existing.childElementCount) return;
  const admin = loadConfig().user?.role === 'admin';
  const s = loadConfig().settings;
  const cb = closeBehavior();
  box.innerHTML = `
  <div class="settings">
    <section class="set-card">
      <h2>常规与外观</h2>
      <div class="set-row"><div><b>配色主题</b><small>当前：<span id="set-theme"></span></small></div>
        <button type="button" class="btn sm tonal" id="set-theme-btn"></button></div>
      <div class="set-row"><div><b>服务端地址</b><small>${esc(loadConfig().baseUrl || '未配置')} · 换地址会清掉当前登录</small></div>
        <button type="button" class="btn sm tonal" id="set-server">切换服务端</button></div>
      <div class="set-row"><div><b>关闭主窗口</b><small>点击标题栏关闭按钮时的行为</small></div>
        <button type="button" class="input trigger" style="width:168px" id="set-close" data-v="${cb}"><span class="trigger-label">${cb === 'quit' ? '退出程序' : '隐藏到托盘'}</span><span class="trigger-arrow">${ICO.chevronDown(15)}</span></button></div>
      ${isDesktop() ? `<div class="set-row"><div><b>开机自启</b><small>随系统登录静默进托盘</small></div>
        <input type="checkbox" class="switch" id="set-auto"></div>` : ''}
      <div class="set-row"><div><b>自动检查更新</b><small>开启后启动时和每 30 分钟检查一次，只提示不自动安装</small></div>
        <input type="checkbox" class="switch" id="set-auto-update"></div>
      <div class="set-row"><div><b>关于 / 更新</b><small>版本信息、发行版地址与在线升级</small></div>
        <button type="button" class="btn sm ghost" id="set-about">打开关于</button></div>
    </section>

    <section class="set-card" id="set-pace">
      <h2>推进节奏（所有设备同步生效）</h2>
      <div class="set-grid">
        <label>逾期多少天自动归档<input class="input" id="set-archive-days" type="number" min="1" value="${s.archiveAfterDays}"></label>
        <label>每日聚焦时刻<button type="button" class="input trigger" id="set-focus-at" data-v="${hhmmOfMin(s.focusAtMin)}"><span class="trigger-label mono">${hhmmOfMin(s.focusAtMin)}</span><span class="trigger-arrow">${ICO.clock(15)}</span></button></label>
        <label>静音开始<button type="button" class="input trigger" id="set-quiet-start" data-v="${hhmmOfMin(s.quietStartMin)}"><span class="trigger-label mono">${hhmmOfMin(s.quietStartMin)}</span><span class="trigger-arrow">${ICO.clock(15)}</span></button></label>
        <label>静音结束<button type="button" class="input trigger" id="set-quiet-end" data-v="${hhmmOfMin(s.quietEndMin)}"><span class="trigger-label mono">${hhmmOfMin(s.quietEndMin)}</span><span class="trigger-arrow">${ICO.clock(15)}</span></button></label>
        <label>提示音<button type="button" class="input trigger" id="set-sound" data-v="${s.sound}"><span class="trigger-label">${s.sound === 'none' ? '静音' : s.sound === 'custom' ? '自定义' : '系统提示音'}</span><span class="trigger-arrow">${ICO.chevronDown(15)}</span></button></label>
      </div>
      <div class="set-actions"><button type="button" class="btn solid sm" id="set-save">保存推进设置</button><span id="set-msg" class="hint"></span></div>
    </section>

    <section class="set-card">
      <h2>提醒与设备自检</h2>
      <div class="set-row">
        <div><b>测试强 / 弱提醒表现</b><small>强提醒弹出不可关闭接管窗，弱提醒发送系统通知（不改真实数据）</small></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn sm tonal" data-test-strength="weak">测试弱提醒</button>
          <button type="button" class="btn sm tonal-hot" data-test-strength="strong">${ICO.bolt(13)}测试强提醒</button>
          <button type="button" class="btn sm ghost" id="set-ping">试响</button>
        </div>
      </div>
      <div id="set-devices" class="dev-table"></div>
    </section>

    ${admin ? `<section class="set-card">
      <h2>用户管理</h2>
      <div class="set-grid">
        <label>用户名<input class="input" id="usr-name" autocomplete="off"></label>
        <label>密码（至少 8 位）<input class="input" id="usr-pass" type="password" autocomplete="new-password"></label>
        <label>确认密码<input class="input" id="usr-pass2" type="password" autocomplete="new-password"></label>
      </div>
      <div class="set-actions"><button type="button" class="btn solid sm" id="usr-add">创建用户</button><span id="usr-msg" class="hint"></span></div>
      <div id="set-users" class="dev-table"></div>
    </section>` : ''}

    <section class="set-card">
      <h2>本地日志</h2>
      <div class="set-grid">
        <label>级别<button type="button" class="input trigger" id="log-level" data-v="info"><span class="trigger-label">info</span><span class="trigger-arrow">${ICO.chevronDown(15)}</span></button></label>
        <label>保留天数<input class="input" id="log-days" type="number" min="1" max="90" value="7"></label>
      </div>
      <div class="set-row"><div><b>写入本地文件</b><small>按天写入应用数据目录下的 logs 文件夹</small></div>
        <input type="checkbox" class="switch" id="log-enabled"></div>
      <div class="set-actions">
        <button type="button" class="btn sm tonal" id="log-save">保存日志设置</button>
        <button type="button" class="btn sm ghost" id="log-open">打开日志目录</button>
        <span id="log-msg" class="hint"></span>
      </div>
    </section>
  </div>`;

  const paintThemeRow = () => {
    const t = THEMES.find((x) => x.id === loadTheme())!;
    const other = THEMES.find((x) => x.id !== loadTheme())!;
    $<HTMLElement>('#set-theme').textContent = `${t.label}（${t.hint}）`;
    $<HTMLButtonElement>('#set-theme-btn').textContent = `切换到${other.label}`;
  };
  paintThemeRow();
  $<HTMLButtonElement>('#set-theme-btn').onclick = () => { toggleTheme(); paintThemeRow(); };
  $<HTMLButtonElement>('#set-server').onclick = () => openServerPanel();
  $<HTMLButtonElement>('#set-close').onclick = (ev) => {
    openDropdown(ev.currentTarget as HTMLElement, [
      { value: 'tray', label: '隐藏到托盘' }, { value: 'quit', label: '退出程序' },
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
  const auto = document.getElementById('set-auto') as HTMLInputElement | null;
  if (auto) {
    void native<boolean>('is_autostart_enabled').then((on) => { if (on !== null) auto.checked = on; });
    auto.onchange = () => void native('set_autostart', { enable: auto.checked });
  }
  $<HTMLButtonElement>('#set-about').onclick = () => openAbout();
  $<HTMLButtonElement>('#set-ping').onclick = () => void native('ping', { title: '试响', body: '能听到声音就说明这台设备通知正常' });
  $<HTMLButtonElement>('#set-save').onclick = () => void saveSettingsForm();
  $<HTMLButtonElement>('#log-save').onclick = () => void saveLogPolicy();
  $<HTMLButtonElement>('#log-open').onclick = () => void nativeOk('open_logs_dir');
  box.querySelectorAll<HTMLElement>('[data-test-strength]').forEach((b) => {
    b.onclick = () => testFollowup(b.dataset.testStrength === 'strong' ? 'strong' : 'weak');
  });
  if (admin) {
    $<HTMLButtonElement>('#usr-add').onclick = () => void addUser();
    $<HTMLElement>('#set-users').addEventListener('click', async (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-user]');
      if (!b) return;
      const id = b.dataset.user!;
      const act = b.dataset.act;
      if (act === 'del') {
        const ok = await openConfirmDialog({
          title: '删除这个用户？',
          detail: '该用户的全部推进项、设备和会话都会被一并删除且无法恢复。',
          confirmText: '永久删除',
          danger: true,
        });
        if (!ok) return;
      }
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
  const patch: Partial<Settings> = {
    archiveAfterDays: Math.max(1, Number(val('set-archive-days'))),
    quietStartMin: minOfHhmm($<HTMLButtonElement>('#set-quiet-start').dataset.v ?? '23:30'),
    quietEndMin: minOfHhmm($<HTMLButtonElement>('#set-quiet-end').dataset.v ?? '07:00'),
    focusAtMin: minOfHhmm($<HTMLButtonElement>('#set-focus-at').dataset.v ?? '09:00'),
    sound: ($<HTMLButtonElement>('#set-sound').dataset.v ?? 'system') as Settings['sound'],
  };
  msg.textContent = '保存中…';
  try {
    const r = await api.patchSettings(patch);
    saveConfig({ settings: r.settings });
    msg.textContent = '已保存，所有设备同步生效';
  } catch (e) { msg.textContent = msgOf(e); }
}

function testFollowup(strength: 'strong' | 'weak') {
  const now = serverNow();
  const id = `test-${strength}-${now}`;
  const fake: Pursuit = {
    id, userId: '', text: `${strength === 'strong' ? '强' : '弱'}提醒测试：核对今日核心交付物`,
    note: '这是本地模拟测试，不会修改服务端任何记录。', kind: 'text', url: null, path: null,
    nature: 'project', strength, importance: importanceForStrength(strength), dueAt: now,
    recurrence: null, context: null, commitment: null,
    status: 'active', importanceSort: 0, version: 1, createdAt: now, updatedAt: now,
    completedAt: null, lastActivityAt: now,
    progress: 0.3, stalenessMs: 0, weight: 0,
    steps: [
      { id: 't0', pursuitId: id, text: '已完成的准备步骤', position: 0, state: 'done', doneAt: now, createdAt: now },
      { id: 't1', pursuitId: id, text: '先完成当前最关键的第一步', position: 1, state: 'todo', doneAt: null, createdAt: now },
    ],
    deviceIds: [], source: 'app',
  };
  control.fire(fake, levelForStrength(strength), '这是测试，不会改你的数据', 'in_app');
  flash(`${strength === 'strong' ? '强' : '弱'}提醒已触发`);
}

async function loadSettingsForm() {
  try {
    const { settings } = await api.settings();
    saveConfig({ settings });
  } catch { /* 保留本地缓存 */ }
}

function renderDeviceRows() {
  const box = document.getElementById('set-devices');
  if (!box) return;
  box.innerHTML = state.devices.map((d) => `
    <div class="dev-row">
      <span class="sdot ${d.online ? '' : 'off'}"></span>
      <b>${esc(d.name)}</b><span class="mono">${esc(d.lastIp ?? '—')}</span>
      <span>${d.online ? '在线' : '离线'}</span><span class="hint">${esc(d.platform)}</span>
    </div>`).join('') || '<div class="hint" style="padding:10px 0">暂无设备记录</div>';
}

async function reloadUsers() {
  const box = document.getElementById('set-users');
  if (!box) return;
  try {
    const { users } = await api.users();
    const me = loadConfig().user?.id;
    box.innerHTML = users.map((u) => `
      <div class="dev-row">
        <b>${esc(u.username)}</b><span>${u.role === 'admin' ? '管理员' : '普通用户'}</span>
        <span>${u.disabled ? '已禁用' : '正常'}</span>
        ${u.id === me ? '<span class="hint">当前账号</span>' : `
          <button type="button" class="btn sm tonal" data-user="${esc(u.id)}" data-act="${u.disabled ? 'enable' : 'disable'}">${u.disabled ? '启用' : '禁用'}</button>
          <button type="button" class="btn sm danger" data-user="${esc(u.id)}" data-act="del">删除</button>`}
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
  const b = document.getElementById('log-level') as HTMLButtonElement | null;
  if (b) {
    b.dataset.v = p.level;
    b.querySelector<HTMLElement>('.trigger-label')!.textContent = p.level;
  }
  const days = document.getElementById('log-days') as HTMLInputElement | null;
  if (days) days.value = String(p.retentionDays);
  const enabled = document.getElementById('log-enabled') as HTMLInputElement | null;
  if (enabled) enabled.checked = p.enabled;
  localStorage.setItem(LOG_KEY, JSON.stringify(p));
}

async function saveLogPolicy() {
  const msg = $<HTMLElement>('#log-msg');
  const p: LogPolicy = {
    level: ($<HTMLButtonElement>('#log-level').dataset.v ?? DEFAULT_LOG_POLICY.level) as LogPolicy['level'],
    retentionDays: Number($<HTMLInputElement>('#log-days').value) || DEFAULT_LOG_POLICY.retentionDays,
    enabled: $<HTMLInputElement>('#log-enabled').checked,
  };
  const ok = await nativeOk('set_log_policy', {
    level: p.level, enabled: p.enabled, retentionDays: p.retentionDays,
  });
  msg.textContent = ok ? '已保存' : '保存失败';
  if (ok) localStorage.setItem(LOG_KEY, JSON.stringify(p));
}

async function reloadPageData() {
  await Promise.allSettled([loadSettingsForm(), loadLogPolicy(), loadStats(), renderDeviceRows()]);
}

/* ------------------------------------------------------------ 推进看板 */

function renderStatsView(box: HTMLElement) {
  if (!box.querySelector('.stats')) {
    box.innerHTML = `
      <div class="stats">
        <div class="stat-hero" id="stat-hero">读取中…</div>
        <div class="stat-grid" id="stat-grid"></div>
        <h2 class="stat-title">最近 7 天推进走势</h2>
        <div class="bars" id="stat-days"></div>
      </div>`;
  }
  void loadStats();
}

async function loadStats() {
  const hero = document.getElementById('stat-hero');
  if (!hero) return;
  try {
    const s: MyStats = await api.myStats();
    hero.innerHTML = `
      <div><span class="big">${s.streakDays}</span><span class="unit">天连续推进</span></div>
      <div><span class="big">${s.completedThisWeek}</span><span class="unit">本周完成</span></div>
      <div><span class="big">${s.completedTotal}</span><span class="unit">累计完成</span></div>`;
    $<HTMLElement>('#stat-grid').innerHTML = ([
      ['今日待办', s.today.focus, ''],
      ['今日完成', s.today.done, 'ok'],
      ['待跟进', s.today.pendingFollowup, 'warn'],
    ] as Array<[string, number, string]>).map(([label, value, tone]) => `
      <div class="stat-card ${tone}"><span>${label}</span><b>${value}</b></div>`).join('');
    const max = Math.max(1, ...s.days.map((d) => Math.max(d.focus, d.done, d.pending)));
    $<HTMLElement>('#stat-days').innerHTML = s.days.map((d) => `
      <div class="bar-col" title="${esc(d.day)}：聚焦 ${d.focus}，完成 ${d.done}，待跟进 ${d.pending}">
        <div class="bar-track">
          <i class="bar-done" style="height:${Math.round((d.done / max) * 100)}%"></i>
          <i class="bar-miss" style="height:${Math.round((d.pending / max) * 100)}%"></i>
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
          <section class="dash-card"><h3>今日提醒分布</h3><div id="dash-deliveries" class="dash-body">读取中…</div></section>
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
      <div>已完成 ${o.pursuits.done ?? 0} · 归档 ${o.pursuits.archived ?? 0} · 暂停 ${o.pursuits.paused ?? 0}</div>`);
    const counts = `弱提醒 ${o.nudgesToday[2] ?? 0} · 强提醒 ${o.nudgesToday[4] ?? 0}`;
    put('dash-deliveries', `<div>今日提醒次数</div><div><b>${esc(counts)}</b></div>`);
    const plats = Object.entries(o.devices.byPlatform).map(([k, v]) => `${k} ${v}`).join(' · ') || '无';
    put('dash-devices', `<div>总数 <b>${o.devices.total}</b> · 在线 ${o.devices.online}</div><div>${esc(plats)}</div>`);
    put('dash-users', `<div>总数 <b>${o.users.total}</b></div>`);
    put('dash-at', new Date(o.serverTs).toLocaleTimeString('zh-CN'));
    put('dash-err', '');
  } catch (e) {
    put('dash-err', `<div>${esc(msgOf(e))}</div>`);
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
            <div class="mid-row" style="margin-top:10px">
              <input class="input mono mid-val" id="tk-plain" readonly placeholder="新令牌（仅显示一次）">
              <button type="button" class="btn sm tonal" id="tk-copy">复制</button></div>
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
          <div class="agent-item">
            <span><b>${esc(t.name)}</b> <span class="oc-muted mono">${esc(t.prefix)}… · ${t.scope}</span></span>
            <button type="button" class="btn sm danger" data-revoke="${esc(t.id)}">撤销</button>
          </div>`).join('')
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

/* ------------------------------------------------------------ 选中与排期 */

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
  }).catch(() => {});
}

function openWhenPicker(p: Pursuit, anchor: HTMLElement) {
  openDateTimePicker({
    initial: p.dueAt,
    now: serverNow(),
    anchor,
    title: '修改截止时间',
    onPick: (at) => {
      const cur = findPursuit(p.id) ?? p;
      void api.update(cur.id, { dueAt: at, version: versionOf(cur) })
        .then(refresh).catch((err) => flashConflict(err, p.id));
    },
  });
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
    state.pursuits = [...r.pursuits].sort((a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.importanceSort - b.importanceSort);
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
      strength: captureStrength,
      nature: 'one_off',
    });
    const cap = document.getElementById('cap') as HTMLInputElement | null;
    if (cap) { cap.value = ''; $<HTMLElement>('#parse').hidden = true; }
    captureStrength = 'weak';
    document.querySelectorAll<HTMLButtonElement>('#cap-str-seg [data-strength]').forEach((b) => {
      b.classList.toggle('on', b.dataset.strength === 'weak');
      b.classList.remove('hot');
    });
    flash(p.remindAt ? '已记下并设好截止' : '已记入待办');
    void refresh();
  } catch (e) {
    flash('保存失败：' + msgOf(e));
  }
}

function askLater(id: string) {
  const p = findPursuit(id);
  const now = serverNow();
  openSnoozeDialog({
    title: `延期「${(p?.text ?? '').slice(0, 20)}」`,
    now,
    onPick: (to) => void runFollowup(id, 'later', { to }),
    onCustom: () => {
      openDateTimePicker({
        initial: p?.dueAt ?? now + 3600_000,
        now,
        modal: true,
        title: '选择延期后的截止时间',
        onPick: (to) => void runFollowup(id, 'later', { to }),
      });
    },
  });
}

async function runFollowup(id: string, action: FollowupAction, extra: Record<string, unknown> = {}) {
  if (id.startsWith('test-')) {
    control.acknowledge(action);
    if (dropTakeoverItem(id)) showTakeover();
    flash('测试提醒已处理（不会改你的数据）');
    return;
  }
  const p = findPursuit(id);
  if (!p && !extra.silent) { flash('这条已经不在了'); return; }
  if (p && !actionsFor(p.status).includes(action)) {
    flash('当前状态不允许这个操作');
    void refresh();
    return;
  }
  const version = p ? versionOf(p) : 0;
  if (action === 'smaller' && !extra.stepEdits) {
    const initial: StepEdit[] = p?.steps.length
      ? p.steps.map((s) => ({ id: s.id, text: s.text }))
      : [{ text: p?.text ?? '' }];
    const edits = await openStepsDialog(initial);
    if (!edits) return;
    extra.stepEdits = edits;
  }
  if (action === 'later' && !extra.to) { askLater(id); return; }

  const body = {
    action, version,
    ...(extra.note ? { note: String(extra.note) } : {}),
    ...(extra.to ? { to: Number(extra.to) } : {}),
    ...(Array.isArray(extra.steps) ? { steps: extra.steps as string[] } : {}),
    ...(Array.isArray(extra.stepEdits) ? { stepEdits: extra.stepEdits as StepEdit[] } : {}),
    ...(extra.stepId ? { stepId: String(extra.stepId) } : {}),
  };
  try {
    localHandled.set(id, Date.now());
    await api.followup(id, body);
    noteFollowup(id, action);
    control.acknowledge(action);
    if (dropTakeoverItem(id)) showTakeover();
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
    flash('已克隆，步骤已重置、截止已清空');
    state.selected = r.pursuit.id;
    void refresh();
  } catch (e) {
    flash('克隆失败：' + msgOf(e));
  }
}

async function confirmAndDelete(id: string) {
  const ok = await openConfirmDialog({
    title: '永久删除这条归档记录？',
    detail: '删除后将无法恢复。',
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  void api.deletePursuit(id)
    .then(() => {
      if (state.selected === id) state.selected = null;
      flash('已删除');
      void refresh();
    })
    .catch((e) => flash(msgOf(e)));
}

function onListClick(ev: Event) {
  const t = ev.target as HTMLElement;
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) { void confirmAndDelete(del.dataset.del!); return; }
  const fa = t.closest<HTMLElement>('[data-follow]');
  if (fa) {
    void runFollowup(fa.dataset.id!, fa.dataset.follow as FollowupAction,
      fa.dataset.step ? { stepId: fa.dataset.step } : {});
    return;
  }
  const row = t.closest<HTMLElement>('[data-id]');
  if (row) selectPursuit(row.dataset.id!);
}

function onEditorClick(ev: Event) {
  const t = (ev.target as HTMLElement).closest<HTMLElement>(
    '[data-act],[data-strength],[data-nature],[data-step-del],[data-wd]',
  );
  const p = findPursuit(state.selected);
  if (!t) return;
  if (t.dataset.act === 'close-editor') {
    state.selected = null;
    renderAll();
    return;
  }
  if (!p) return;

  const savePatch = (patch: Record<string, unknown>) => {
    const cur = findPursuit(p.id) ?? p;
    void api.update(cur.id, { ...patch, version: versionOf(cur) })
      .then(() => {
        const badge = document.getElementById('ed-saved');
        if (badge) badge.textContent = '已保存';
        void refresh();
      }).catch((err) => flashConflict(err, p.id));
  };

  if (t.dataset.strength) { savePatch({ strength: t.dataset.strength }); return; }
  if (t.dataset.nature) { savePatch({ nature: t.dataset.nature }); return; }
  if (t.dataset.wd !== undefined) {
    t.classList.toggle('on');
    const days = [...document.querySelectorAll<HTMLElement>('#f-wd-chips .wd-chip.on')]
      .map((c) => c.dataset.wd!)
      .join(',');
    const hidden = document.getElementById('f-byday') as HTMLInputElement | null;
    if (hidden) hidden.value = days;
    return;
  }
  if (t.dataset.stepDel) {
    void api.deleteStep(t.dataset.stepDel).then(refresh).catch((e) => flash(msgOf(e)));
    return;
  }

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
    case 'clone': void runClone(p.id); return;
    case 'delete': void confirmAndDelete(p.id); return;
    case 'save-rule': {
      const freq = ($<HTMLButtonElement>('#f-freq').dataset.v ?? 'none') as Freq;
      const fields = {
        byWeekday: ($<HTMLInputElement>('#f-byday')?.value ?? '').trim(),
        byMonthday: ($<HTMLInputElement>('#f-bymonthday')?.value ?? '').trim(),
        byMonth: ($<HTMLInputElement>('#f-bymonth')?.value ?? '').trim(),
      };
      savePatch({ recurrence: buildRecurrence(freq, fields) });
      return;
    }
    case 'follow-done':
      void runFollowup(p.id, 'done', t.dataset.step ? { stepId: t.dataset.step } : {});
      return;
    case 'follow-later': askLater(p.id); return;
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
  if (!p) return;
  if (t.dataset.stepText) {
    t.blur();
    const text = t.value.trim();
    if (!text) { void refresh(); return; }
    void api.updateStep(t.dataset.stepText, { text })
      .then(refresh).catch((e) => flash(msgOf(e)));
    return;
  }
  if (t.dataset.step) {
    const stateName: StepState = t.checked ? 'done' : 'todo';
    void api.updateStep(t.dataset.step, { state: stateName })
      .then(refresh).catch((e) => flash(msgOf(e)));
  }
}

function onEditorKeydown(ev: KeyboardEvent) {
  if (ev.key !== 'Enter') return;
  const t = ev.target as HTMLInputElement;
  if (t.dataset.stepText) { ev.preventDefault(); t.blur(); return; }
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
  const badge = document.getElementById('ed-saved');
  if (badge) badge.textContent = '保存中…';
  const w = window as unknown as Record<string, number>;
  clearTimeout(w.__pursuitDeb);
  w.__pursuitDeb = window.setTimeout(() => {
    const cur = findPursuit(id);
    if (!cur) return;
    void api.update(id, { [key]: key === 'note' ? (value || null) : value, version: versionOf(cur) })
      .then(() => {
        const b = document.getElementById('ed-saved');
        if (b) b.textContent = '已保存';
        void refresh();
      }).catch((err) => flashConflict(err, id));
  }, 500);
}

function flashConflict(err: unknown, pursuitId: string) {
  if (err instanceof ApiError && err.status === 409) {
    flash('这条刚在别的设备上改过，已刷新为最新内容');
  } else {
    flash('保存失败，请检查服务端连接');
  }
  void refresh().then(() => { state.selected = pursuitId; });
}

function setLink(s: 'connecting' | 'open' | 'closed') {
  const dot = document.getElementById('sdot');
  const txt = document.getElementById('stxt');
  const conn = document.getElementById('btn-server');
  if (!dot || !txt || !conn) return;
  linkState = s;
  dot.className = `sdot ${s === 'open' ? '' : s === 'connecting' ? 'warn' : 'alert'}`;
  txt.textContent = s === 'open' ? '已连接' : s === 'connecting' ? '连接中…' : '已断开';
  conn.title = s === 'closed'
    ? `已断开，正在自动重连 · ${loadConfig().baseUrl}（点击切换）`
    : `已连至 ${loadConfig().baseUrl}（点击切换服务端）`;
  const mine = loadConfig().device?.id;
  const self = state.devices.find((d) => d.id === mine);
  if (self) self.online = s === 'open';
  renderSidebar();
}

const SKEW_MAX_AUTO = 10_000;

function renderSkew() {
  const banner = document.getElementById('skew-banner');
  const txt = document.getElementById('skew-banner-txt');
  if (!banner || !txt) return;
  const ms = loadConfig().serverSkewMs;
  if (Math.abs(ms) > SKEW_MAX_AUTO) {
    banner.hidden = false;
    txt.textContent = `本机时钟与服务端偏差 ${ms > 0 ? '+' : ''}${Math.round(ms / 1000)} 秒，倒计时可能有误差，建议开启系统自动校时。`;
  } else {
    banner.hidden = true;
  }
}

function openServerPanel() {
  const existing = document.querySelector('.panel-mask');
  if (existing) { existing.remove(); return; }
  const cfg = loadConfig();
  const skewStr = Math.abs(cfg.serverSkewMs) < 1000
    ? `${cfg.serverSkewMs} ms`
    : `${cfg.serverSkewMs > 0 ? '+' : ''}${Math.round(cfg.serverSkewMs / 1000)} s`;

  const host = document.createElement('div');
  host.className = 'panel-mask';
  host.innerHTML = `
    <div class="panel" role="dialog" aria-modal="true">
      <div class="panel-head"><b>服务端与本机设备</b><div class="sp"></div>
        <button type="button" class="btn icon-only sm" id="sp-close" aria-label="关闭">${ICO.close(16)}</button></div>
      <form class="panel-body">
        <label class="fld"><span>服务端地址</span>
          <input class="input" id="sp-url" spellcheck="false" autocomplete="off" value="${esc(cfg.baseUrl)}"></label>
        <div class="login-row">
          <span class="login-hint" id="sp-hint">同一账号的设备填同一个地址，就看同一份推进项</span>
          <button type="button" class="btn sm tonal" id="sp-test">测试连接</button></div>
        <div class="srv-meta"><span>当前时钟偏差</span><span class="mono">${esc(skewStr)}</span></div>
        <div class="panel-err" id="sp-err"></div>
        <button class="btn solid panel-submit" type="submit">切换到此服务端</button>
        <div class="mid-block">
          <span class="mid-title">本机 machine-id</span>
          <div class="mid-row">
            <input class="input mono mid-val" id="sp-mid" readonly value="读取中…">
            <button type="button" class="btn sm tonal" id="sp-copy">复制</button></div>
          <div class="login-hint">签发 Agent 令牌时可选绑定这个 id。</div>
        </div>
      </form>
    </div>`;
  document.body.appendChild(host);

  const close = () => host.remove();
  const q = <T extends HTMLElement>(sel: string) => host.querySelector<T>(sel)!;
  const hint = q<HTMLSpanElement>('#sp-hint');
  const err = q<HTMLDivElement>('#sp-err');
  const url = q<HTMLInputElement>('#sp-url');
  const form = q<HTMLFormElement>('form.panel-body');
  const setHint = (text: string, kind: '' | 'ok' | 'bad' = '') => {
    hint.textContent = text;
    hint.className = `login-hint ${kind}`;
  };
  q<HTMLButtonElement>('#sp-close').onclick = close;
  host.addEventListener('click', (ev) => { if (ev.target === host) close(); });
  void getMachineId().then((id) => { q<HTMLInputElement>('#sp-mid').value = id || '非桌面客户端，无 machine-id'; });
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
    setHint('测试中…');
    const r = await probeServer(norm);
    btn.disabled = false;
    setHint(r.ok ? '连上了' : r.reason, r.ok ? 'ok' : 'bad');
  };
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const norm = normalizeBaseUrl(url.value);
    if (!norm) { setHint('地址格式不对，需要 http:// 或 https:// 开头', 'bad'); return; }
    if (norm === loadConfig().baseUrl) { close(); return; }
    switchServer(norm);
    err.textContent = '已切换，正在重新登录…';
    rt?.close();
    location.reload();
  });
  url.focus();
  url.select();
}

/* ------------------------------------------------------ 跨窗口事件 */

function wireEvents() {
  if (!hasTauri()) return;
  listen<{ pursuitId: string; action: FollowupAction; note?: string; to?: number; steps?: string[]; stepEdits?: StepEdit[]; stepId?: string }>(
    'takeover:action', async (ev) => {
      const { pursuitId, action, note, to, steps, stepEdits, stepId } = ev.payload;
      await runFollowup(pursuitId, action, {
        ...(note ? { note } : {}), ...(to ? { to } : {}),
        ...(steps ? { steps } : {}), ...(stepEdits ? { stepEdits } : {}),
        ...(stepId ? { stepId } : {}),
      });
    },
  );
  listen('takeover:next', () => {
    if (!lastTakeover) return;
    lastTakeover = {
      ...lastTakeover,
      index: Math.min(lastTakeover.index + 1, lastTakeover.items.length - 1),
    };
    void emit('takeover:show', lastTakeover);
  });
  listen<{ pursuitId: string; url: string }>('takeover:open-url', async (ev) => {
    quiet('open_external', { url: ev.payload.url });
  });
  listen<{ text: string; dueAt: number | null; kind: string; strength: ReminderStrength }>(
    'capture:submit', async (ev) => {
      const { text, dueAt, kind, strength } = ev.payload;
      try {
        await api.create({
          text, kind: kind as 'text' | 'link' | 'path', dueAt, strength,
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
  void loadDevices();

  if (!loadConfig().device) window.setInterval(() => void refresh(), 10_000);

  renderUpdateBadge();
  tickUrgency();
  window.setInterval(tickUrgency, 20_000);
}

function applyDevices(devices: Device[]) {
  state.devices = devices ?? [];
  const mine = loadConfig().device?.id;
  const self = state.devices.find((d) => d.id === mine);
  if (self) self.online = linkState === 'open';
  renderSidebar();
  if (document.getElementById('set-devices')) renderDeviceRows();
}

function loadDevices() {
  return api.devices()
    .then((r) => applyDevices(r.devices))
    .catch(() => {});
}

function notifyWeakDigest(count: number, oldestDueAt: number, sample: string) {
  if (count <= 0) return;
  lastWeakDigestAt = Date.now();
  const late = lateBy(oldestDueAt);
  const body = `最早一条已逾期 ${late || '片刻'} · ${sample.slice(0, 36)}`;
  ringPing({ title: `有 ${count} 条提醒已逾期未处理`, body });
  flash(`有 ${count} 条提醒已逾期未处理（${body}）`);
}

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome': {
      const overdue = msg.overdue ?? [];
      const strongOver = overdue.filter((p) => p.strength === 'strong');
      const weakOver = overdue.filter((p) => p.strength === 'weak');
      if (strongOver.length > 0) {
        strongOver.forEach((p, i) => enqueueTakeover(p, '上线补发：有逾期未处理的强提醒', i === 0));
      }
      if (weakOver.length > 0) {
        notifyWeakDigest(weakOver.length, weakOver[0].dueAt ?? serverNow(), weakOver[0].text);
      } else if (msg.missed.length && strongOver.length === 0) {
        flash(`上线补发 ${msg.missed.length} 条跟进，已同步到列表`);
      }
      if (msg.devices) applyDevices(msg.devices);
      else void loadDevices();
      void refresh();
      break;
    }
    case 'pursuit.overdue_digest':
      notifyWeakDigest(msg.count, msg.oldestDueAt, msg.sample);
      void refresh();
      break;
    case 'devices.changed':
      applyDevices(msg.devices);
      break;
    case 'pursuit.created':
    case 'pursuit.updated':
    case 'pursuit.stepped':
      void refresh();
      break;
    case 'pursuit.followed':
      noteFollowup(msg.pursuit.id, msg.action, levelForStrength(msg.pursuit.strength));
      control.dismissedElsewhere(msg.pursuit.id);
      if (dropTakeoverItem(msg.pursuit.id)) showTakeover();
      void refresh();
      break;
    case 'pursuit.deleted':
      if (dropTakeoverItem(msg.pursuitId)) showTakeover();
      void refresh();
      break;
    case 'pursuit.focused':
      state.focus = { serverTs: serverNow(), items: msg.items };
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

void countAll;
applyTheme(loadTheme());
onUnauthorized(() => { rt?.close(); location.reload(); });

(async () => {
  platform = await getPlatform();
  initUpdater(platform, flash);
  const cfg = loadConfig();
  if (!cfg.token && !cfg.baseUrl) { renderSetup(); return; }
  try {
    if ((await api.setupStatus()).needed) { renderSetup(); return; }
  } catch { /* 连不上走登录/启动 */ }
  if (cfg.token) boot();
  else renderLogin();
})();
