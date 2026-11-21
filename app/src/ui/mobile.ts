/**
 * 安卓端专用界面。和桌面端共用 api / alarm / theme / 解析规则，
 * 只是布局按手机重做：顶部状态 + 三个页签（随手记 / 今天 / 设置）。
 * 桌面那套三栏布局在窄屏上被挤烂，所以单独出这一份。
 */
import { invoke } from '@tauri-apps/api/core';
import {
  ApiError, Realtime, api, clearToken, dayLabel, getMachineId, getPlatform, hhmm, hostOf,
  loadConfig, normalizeBaseUrl, parseInput, probeServer, saveConfig, serverNow, switchServer,
  type AckAction, type Entry, type ServerMessage, type Settings, type User,
} from '../api';
import { AlarmController, pushWeak } from '../alarm';
import { applyTheme, loadTheme, saveTheme, THEMES } from '../theme';
import '../styles-mobile.css';

const app = document.getElementById('app')!;

type View = 'capture' | 'today' | 'settings';
type ListKind = 'today' | 'inbox' | 'all';

let platform = 'android';
let view: View = 'capture';
let listKind: ListKind = 'today';
let rt: Realtime | null = null;
let entries: Entry[] = [];
let counts = { today: 0, up: 0, inbox: 0, all: 0, done: 0, missed: 0, dismissed: 0 };

const alarm = new AlarmController({
  onNotify: (e) => notify(e.text, '到点了'),
  onShow: (e) => notify(e.text, '提醒 · 需要处理'),
  onEscalate: (e) => notify(e.text, '还没处理？'),
  onRepeat: (e, n) => notify(e.text, `重复提醒 ${n}`),
  onDismiss: () => { void refresh(); },
});

function hasTauri(): boolean {
  return typeof (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

function notify(title: string, body: string) {
  if (!hasTauri()) return;
  void invoke('ping', { title, body }).catch(() => { /* 通知失败不影响流程 */ });
}

let toastTimer: number | null = null;
function toast(msg: string) {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('on');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('on'), 2600);
}

function urgency(e: Entry): '' | 'due' | 'close' | 'over' {
  if (e.status === 'done' || e.remindAt === null) return '';
  if (e.status === 'missed') return 'over';
  const ms = e.remindAt - serverNow();
  if (ms <= 15 * 60_000) return 'due';
  if (ms <= 60 * 60_000) return 'close';
  return '';
}

/* ------------------------------------------------------------ 骨架 */

function shell(): string {
  return `
  <div class="m-top">
    <span class="logo"><i></i></span>
    <b>DeskAlarm</b>
    <span class="sp"></span>
    <span class="m-conn" id="conn"><span class="dot"></span><span id="conn-txt">未连接</span></span>
  </div>
  <section class="m-view" id="v-capture"></section>
  <section class="m-view" id="v-today"></section>
  <section class="m-view" id="v-settings"></section>
  <nav class="m-nav">
    <button data-view="capture" class="on"><span class="ico">✎</span>随手记</button>
    <button data-view="today"><span class="ico">☰</span>今天</button>
    <button data-view="settings"><span class="ico">⚙</span>设置</button>
  </nav>`;
}

function setView(v: View) {
  view = v;
  document.querySelectorAll<HTMLElement>('.m-view').forEach((el) => el.classList.remove('on'));
  document.getElementById(`v-${v}`)?.classList.add('on');
  document.querySelectorAll<HTMLElement>('.m-nav button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === v);
  });
  if (v === 'today') void loadList();
  if (v === 'settings') renderSettings();
}

function setConn(state: 'connecting' | 'open' | 'closed') {
  const el = document.getElementById('conn');
  const txt = document.getElementById('conn-txt');
  if (!el || !txt) return;
  el.className = `m-conn ${state}`;
  txt.textContent = state === 'open' ? '已连接' : state === 'connecting' ? '连接中' : '已断开';
}

/* ------------------------------------------------------------ 随手记 */

function renderCapture() {
  const host = document.getElementById('v-capture')!;
  host.innerHTML = `
  <div class="cap-wrap">
    <div class="cap-card">
      <label>写一句话、链接或目录。带时间就提醒，不带就进收集箱</label>
      <textarea class="cap-input" id="cap" placeholder="例如：明天 15:00 交周报&#10;例如：记得买牛奶&#10;例如：https://example.com" autocomplete="off"></textarea>
      <div class="cap-parse" id="parse"></div>
      <div class="cap-row">
        <button class="btn solid block" id="save">存为提醒</button>
      </div>
      <div class="cap-tip">识别规则：明确时间（明天 15:00 / 3 小时后 / 10-1 15点）→ 到点提醒；写「一定要」才用强提醒，否则只在通知栏轻提醒。</div>
    </div>
  </div>`;

  const input = document.getElementById('cap') as HTMLTextAreaElement;
  const parse = document.getElementById('parse')!;
  const preview = () => {
    const p = parseInput(input.value);
    if (!input.value.trim()) { parse.innerHTML = ''; return; }
    parse.innerHTML = `
      <span class="chip ${p.kind === 'text' ? '' : 'hot'}">${esc(p.kindLabel)}</span>
      <span class="chip ${p.remindAt !== null ? 'hot' : ''}">${esc(p.timeLabel)}</span>
      <span class="chip ${p.strength === 'strong' ? 'hot' : ''}">${p.strength === 'strong' ? '强提醒' : '轻提醒'}</span>`;
  };
  input.addEventListener('input', preview);
  document.getElementById('save')!.onclick = () => void saveCapture();
}

async function saveCapture() {
  const input = document.getElementById('cap') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) { toast('先写点什么'); return; }
  const p = parseInput(text);
  try {
    await api.create({
      text, kind: p.kind,
      url: p.kind === 'link' ? text : null,
      path: p.kind === 'path' ? text : null,
      remindAt: p.remindAt,
      strength: p.strength,
    });
    input.value = '';
    document.getElementById('parse')!.innerHTML = '';
    toast(p.remindAt !== null ? '已设提醒' : '已存进收集箱');
    void refresh();
    if (p.remindAt !== null) setView('today');
  } catch (e) {
    toast('保存失败：' + (e instanceof Error ? e.message : '请检查连接'));
  }
}

/* ------------------------------------------------------------ 列表 */

function renderListHead() {
  const host = document.getElementById('v-today')!;
  host.innerHTML = `
  <div class="list-tabs">
    <button data-kind="today" class="${listKind === 'today' ? 'on' : ''}">今天</button>
    <button data-kind="inbox" class="${listKind === 'inbox' ? 'on' : ''}">收集箱 <span id="ci">${counts.inbox || ''}</span></button>
    <button data-kind="all" class="${listKind === 'all' ? 'on' : ''}">全部</button>
  </div>
  <div class="list-scroll" id="list-scroll"></div>`;
  host.querySelectorAll<HTMLElement>('.list-tabs button').forEach((b) => {
    b.onclick = () => { listKind = b.dataset.kind as ListKind; renderListHead(); void loadList(); };
  });
}

function renderEntries() {
  const box = document.getElementById('list-scroll');
  if (!box) return;
  if (!entries.length) {
    box.innerHTML = `<div class="empty">这里还没有条目。<br>去「随手记」写一条吧。</div>`;
    return;
  }
  box.innerHTML = entries.map((e) => {
    const u = urgency(e);
    const when = e.remindAt === null ? '收集箱 · 无时间' : `${dayLabel(e.remindAt)} ${hhmm(e.remindAt)}`;
    const late = e.status === 'missed' && e.firedAt ? ` · 迟了 ${Math.max(1, Math.round((serverNow() - e.firedAt) / 60_000))} 分钟` : '';
    const desc = e.url ? hostOf(e.url) : e.path ?? '';
    return `<div class="entry ${u}" data-id="${esc(e.id)}">
      <div class="row1">
        <div class="txt ${e.status === 'done' ? 'done' : ''}">${esc(e.text)}</div>
      </div>
      <div class="meta">
        <span class="${u === 'due' || u === 'over' ? 'hot' : ''}">${esc(when)}${esc(late)}</span>
        ${e.strength === 'strong' ? '<span>强提醒</span>' : ''}
        ${desc ? `<span>${esc(desc)}</span>` : ''}
      </div>
      ${e.status !== 'done' ? `<div class="acts">
        <button class="btn" data-act="done">完成</button>
        <button class="btn" data-act="snooze">稍后</button>
        <button class="btn" data-act="silence">静音</button>
      </div>` : ''}
    </div>`;
  }).join('');

  box.querySelectorAll<HTMLElement>('.entry').forEach((row) => {
    const id = row.dataset.id!;
    row.querySelectorAll<HTMLElement>('.acts button').forEach((btn) => {
      btn.onclick = () => void act(id, btn.dataset.act as AckAction);
    });
  });
}

async function loadList() {
  try {
    const r = await api.entries(listKind);
    entries = r.entries ?? [];
    renderEntries();
  } catch {
    toast('加载失败，请检查服务端连接');
  }
}

async function act(id: string, action: AckAction) {
  try {
    if (action === 'snooze') {
      const to = serverNow() + 10 * 60_000;
      if (rt?.ack(id, 'snooze', to)) { /* WS 即时停铃 */ }
      await api.snooze(id, { to });
    } else if (action === 'silence') {
      if (rt?.ack(id, 'silence')) { /* noop */ }
      await api.dismiss(id, 'silence');
    } else {
      if (rt?.ack(id, 'done')) { /* noop */ }
      await api.done(id);
    }
    toast(action === 'done' ? '已完成' : action === 'snooze' ? '10 分钟后再提醒' : '已静音');
    void refresh();
  } catch (e) {
    toast('操作失败：' + (e instanceof Error ? e.message : '请重试'));
  }
}

/* ------------------------------------------------------------ 设置 */

function renderSettings() {
  const host = document.getElementById('v-settings')!;
  const cfg = loadConfig();
  const u = cfg.user;
  const s = cfg.settings;
  const mm = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  host.innerHTML = `<div class="set-scroll">
    <div class="set-group">
      <div class="who">
        <div class="avatar">${esc((u?.username ?? '?').slice(0, 1).toUpperCase())}</div>
        <div><div style="font-weight:600">${esc(u?.username ?? '未登录')}</div>
        <div class="set-val">${u?.role === 'admin' ? '管理员' : '普通用户'}</div></div>
      </div>
    </div>
    <div class="set-group">
      <h3>连接</h3>
      <div class="set-field">
        <label>服务端地址</label>
        <input id="base" value="${esc(cfg.baseUrl)}" placeholder="http://192.168.1.10:8091" autocomplete="off">
        <div class="probe" id="probe"></div>
      </div>
      <button class="btn block" id="test">测试连接</button>
    </div>
    <div class="set-group">
      <h3>提醒偏好</h3>
      <div class="set-row"><div><div class="lbl">强提醒升级等待</div><div class="sub">多久没处理就升级</div></div>
        <span class="set-val">${s.escalateAfterSec} 秒</span></div>
      <div class="set-row"><div><div class="lbl">重复提醒间隔</div><div class="sub">0 表示不重复</div></div>
        <span class="set-val">${s.repeatEverySec} 秒</span></div>
      <div class="set-row"><div><div class="lbl">静音时段</div><div class="sub">强提醒也不响</div></div>
        <span class="set-val">${mm(s.quietStartMin)} – ${mm(s.quietEndMin)}</span></div>
      <div class="set-row"><div><div class="lbl">提示音</div></div>
        <span class="set-val">${s.sound === 'none' ? '关闭' : s.sound === 'custom' ? '自定义' : '系统'}</span></div>
      <button class="btn block" id="reload" style="margin-top:12px">保存并重新加载偏好</button>
    </div>
    <div class="set-group">
      <h3>外观</h3>
      <div class="set-row"><div><div class="lbl">主题</div></div>
        <select id="theme" class="m-select">
          ${THEMES.map((t) => `<option value="${t.id}" ${loadTheme() === t.id ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}
        </select></div>
    </div>
    <div class="set-group">
      <h3>应用更新</h3>
      <div class="set-row"><div><div class="lbl">当前版本</div><div class="sub">检查并安装最新版</div></div>
        <span class="set-val" id="curver">v—</span></div>
      <div class="set-row"><div><div class="lbl" id="upd-status">检查结果会显示在这里</div></div></div>
      <button class="btn block" id="check-upd" style="margin-top:8px">检查更新</button>
      <button class="btn solid block" id="do-upd" style="margin-top:8px;display:none">下载并安装</button>
    </div>
    <div class="set-group">
      <button class="btn block" id="ping">试响一次（确认能通知）</button>
      <button class="btn block" id="logout" style="margin-top:10px">退出登录</button>
    </div>
  </div>`;

  document.getElementById('test')!.onclick = async () => {
    const v = (document.getElementById('base') as HTMLInputElement).value;
    const probe = document.getElementById('probe')!;
    probe.textContent = '测试中…'; probe.className = 'probe';
    const r = await probeServer(v);
    probe.textContent = r.ok ? '已连上，时钟偏差 ' + Math.round(r.skewMs) + ' ms' : r.reason;
    probe.className = 'probe ' + (r.ok ? 'ok' : 'bad');
    if (r.ok) saveConfig({ serverSkewMs: r.skewMs });
  };
  document.getElementById('reload')!.onclick = async () => {
    try { const r = await api.settings(); saveConfig({ settings: r.settings }); toast('偏好已更新'); }
    catch { toast('读取失败'); }
  };
  document.getElementById('theme')!.onchange = (ev) => {
    saveTheme((ev.target as HTMLSelectElement).value as 'dark' | 'morandi');
  };
  let pendingApk: { url: string; name: string } | null = null;
  const statusEl = document.getElementById('upd-status')!;
  document.getElementById('check-upd')!.onclick = async () => {
    statusEl.textContent = '检查中…';
    try {
      const r = await invoke<{ available: boolean; currentVersion: string; latestVersion: string; sourceUrl: string; message: string }>('check_update');
      document.getElementById('curver')!.textContent = 'v' + r.currentVersion;
      if (!r.available) { statusEl.textContent = r.message || '当前已是最新版本'; pendingApk = null; return; }
      statusEl.textContent = '发现新版本 v' + r.latestVersion + '，可下载安装';
      pendingApk = {
        url: r.sourceUrl,
        name: 'deskalarm_' + r.latestVersion.replace(/^v/, '') + '_android-universal.apk',
      };
      (document.getElementById('do-upd') as HTMLElement).style.display = 'flex';
    } catch (e) {
      statusEl.textContent = '检查失败：' + (e instanceof Error ? e.message : String(e));
    }
  };
  document.getElementById('do-upd')!.onclick = async () => {
    if (!pendingApk) return;
    statusEl.textContent = '开始下载，请在通知栏查看进度…';
    try {
      await invoke('plugin:apk-installer|download_and_install', pendingApk);
      statusEl.textContent = '下载完成，请在系统安装器中确认安装';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      statusEl.textContent = msg === 'NEED_INSTALL_PERMISSION' ? '请先允许「安装未知应用」后重试' : '安装失败：' + msg;
    }
  };
  document.getElementById('ping')!.onclick = () => { notify('试响', '如果你看到这条通知，说明手机通知正常'); toast('已发通知'); };
  document.getElementById('logout')!.onclick = () => {
    rt?.close(); clearToken(); location.reload();
  };
}

/* ------------------------------------------------------------ 实时 / 刷新 */

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome':
      saveConfig({ serverSkewMs: msg.serverTs - Date.now(), settings: { ...loadConfig().settings, ...msg.settings } });
      for (const m of msg.missed) {
        notify('补发提醒', `${m.entry.text}`);
        if (!alarm.fire(m.entry)) pushWeak(m.entry);
      }
      void refresh();
      break;
    case 'entry.fired':
      if (!alarm.fire(msg.entry)) pushWeak(msg.entry);
      void refresh();
      break;
    case 'entry.weak':
      pushWeak(msg.entry);
      break;
    case 'entry.created':
    case 'entry.updated':
    case 'entry.deleted':
    case 'entry.acked':
    case 'entry.downgraded':
      alarm.dismissedElsewhere();
      void refresh();
      break;
    case 'devices.changed':
      void refresh();
      break;
    default:
      break;
  }
}

async function refresh() {
  try {
    const c = await api.counts();
    counts = c.counts;
    const ci = document.getElementById('ci');
    if (ci) ci.textContent = counts.inbox ? String(counts.inbox) : '';
    if (view === 'today') await loadList();
  } catch { /* 静默 */ }
}

function connect() {
  rt?.close();
  rt = new Realtime(onRealtime, setConn);
  rt.connect();
}

/* ------------------------------------------------------------ 登录 / 初始化 */

function renderAuth(needed: boolean) {
  const host = document.getElementById('app')!;
  const cfg = loadConfig();
  host.innerHTML = `
  <div class="auth">
    <div class="auth-card">
      <div class="mark"><i></i></div>
      <h1>${needed ? '初始化管理员' : 'DeskAlarm'}</h1>
      <p>${needed ? '这个服务端还没有管理员。创建第一个账号后即可登录使用，此入口只显示一次。' : '用账号连接你的服务端。每台设备用自己的身份登录，提醒按用户隔离。'}</p>
      <div class="fld"><label>服务端地址</label>
        <input id="base" value="${esc(cfg.baseUrl || 'http://192.168.1.10:8091')}" autocomplete="off" spellcheck="false"></div>
      <div class="probe" id="probe"></div>
      <div class="fld"><label>用户名</label><input id="user" autocomplete="username"></div>
      <div class="fld"><label>密码</label><input id="pass" type="password" autocomplete="${needed ? 'new-password' : 'current-password'}"></div>
      ${needed ? '<div class="fld"><label>确认密码</label><input id="confirm" type="password" autocomplete="new-password"></div>' : ''}
      <div class="fld"><label>这台设备叫什么</label><input id="dev" value="${esc(cfg.deviceName || '我的手机')}" autocomplete="off"></div>
      <div class="err" id="err"></div>
      <button class="btn solid" id="go">${needed ? '创建管理员' : '登录'}</button>
      ${needed ? '<div class="foot">服务端已有管理员？<a id="to-login">去登录</a></div>' : ''}
    </div>
  </div>`;

  const err = document.getElementById('err')!;
  const base = document.getElementById('base') as HTMLInputElement;
  document.getElementById('to-login')?.addEventListener('click', () => renderAuth(false));
  document.getElementById('go')!.onclick = async () => {
    err.textContent = '';
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { err.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; return; }
    const username = (document.getElementById('user') as HTMLInputElement).value.trim();
    const password = (document.getElementById('pass') as HTMLInputElement).value;
    const deviceName = (document.getElementById('dev') as HTMLInputElement).value.trim() || '我的手机';
    if (!username) { err.textContent = '请填用户名'; return; }
    if (password.length < 8) { err.textContent = '密码至少 8 位'; return; }
    const probeEl = document.getElementById('probe')!;
    probeEl.textContent = '连接中…'; probeEl.className = 'probe';
    const pr = await probeServer(norm);
    probeEl.textContent = pr.ok ? '已连上' : pr.reason;
    probeEl.className = 'probe ' + (pr.ok ? 'ok' : 'bad');
    if (!pr.ok) return;
    if (cfg.baseUrl !== norm) switchServer(norm);
    saveConfig({ deviceName, serverSkewMs: pr.skewMs });
    try {
      if (needed) {
        const confirm = (document.getElementById('confirm') as HTMLInputElement).value;
        if (confirm !== password) { err.textContent = '两次密码不一致'; return; }
        const machineId = await getMachineId();
        const r = await api.setup({ username, password, confirmPassword: confirm, machineId });
        saveConfig({ token: r.token, user: r.user, device: r.device });
      } else {
        const r = await api.login(username, password, deviceName, platform);
        saveConfig({ token: r.token, user: r.user, device: r.device });
      }
      boot();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_SETUP') { renderAuth(false); return; }
      err.textContent = '登录失败：' + (e instanceof Error ? e.message : '请重试');
    }
  };
}

/* ------------------------------------------------------------ 启动 */

async function boot() {
  app.innerHTML = shell();
  applyTheme(loadTheme());
  document.querySelectorAll<HTMLElement>('.m-nav button').forEach((b) => {
    b.onclick = () => setView(b.dataset.view as View);
  });
  renderCapture();
  renderListHead();
  setView('capture');
  connect();
  void refresh();
}

(async () => {
  applyTheme(loadTheme());
  platform = await getPlatform();
  const cfg = loadConfig();
  if (!cfg.token) {
    try {
      const s = await api.setupStatus();
      renderAuth(s.needed);
    } catch {
      // 没填地址或连不上：渲染一个带默认地址的初始化页，让用户先填
      renderAuth(true);
    }
    return;
  }
  boot();
})();
