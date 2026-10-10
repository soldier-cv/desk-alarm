/**
 * 主窗口。这个 webview 是整个应用的脑子：
 * 持有 HTTP/WS 连接、AlarmController、本地状态。
 * takeover 和 capture 两个窗口只负责画和发意图。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import {
  ApiError, Realtime, api, clearToken, dayLabel, hhmm, hostOf, lateBy, loadConfig,
  parseInput, saveConfig, serverNow, urgencyOf,
  type AckAction, type Device, type Dismissal, type Entry, type ServerMessage,
} from '../api';
import { AlarmController, dropWeakByEntry, onWeakChange, pushWeak } from '../alarm';
import '../styles.css';

const $ = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/* ------------------------------------------------------------ 状态 */

type View = 'today' | 'upcoming' | 'inbox' | 'all' | 'done' | 'dismissed' | 'neglected';

const VIEWS: Record<View, { title: string; sub: string }> = {
  today: { title: '今天', sub: '' },
  upcoming: { title: '即将到来', sub: '未来 7 天' },
  inbox: { title: '收集箱', sub: '没定时间，先存着' },
  all: { title: '全部条目', sub: '' },
  done: { title: '已完成', sub: '保留 7 天后自动清理' },
  dismissed: { title: '已忽略', sub: '弱提示里点了「忽略」的记录，连带你写的理由' },
  neglected: { title: '老是被忽略', sub: '这些提醒可能该删了，或者降成弱提示' },
};

const state = {
  view: 'today' as View,
  entries: [] as Entry[],
  dismissals: [] as Dismissal[],
  devices: [] as Device[],
  selected: null as string | null,
};

let rt: Realtime | null = null;

/* ------------------------------------------------------- 强提醒链路 */

const alarm = new AlarmController({
  onNotify: (entry, attempt) => {
    void invoke('ping', {
      title: attempt === 1 ? (entry.strength === 'weak' ? '提醒' : '提醒器') : `提醒器（第 ${attempt} 次）`,
      body: entry.text,
    }).catch(() => { /* 没通知权限就算了，横幅还在 */ });
  },

  onShow: (entry) => {
    void invoke('show_takeover', { entry, stage: 'banner', muted: false });
  },

  onEscalate: (entry) => {
    // 第 2 步：置顶 + 抖动 + 关不掉
    void invoke('show_takeover', { entry, stage: 'escalated', muted: false });
  },

  onRepeat: (entry, attempt) => {
    void invoke('show_takeover', { entry, stage: 'escalated', muted: false });
    void invoke('ping', { title: `提醒器（第 ${attempt} 次）`, body: entry.text });
  },

  onDismiss: (entry, reason) => {
    void emit('takeover:dismiss', {});
    if (reason === 'elsewhere') {
      void invoke('ping', { title: '提醒器', body: '这条已在别的设备上处理掉了' });
    }
    void refresh();
  },
});

/* ---------------------------------------------------------- 登录页 */

function renderLogin() {
  const cfg = loadConfig();
  document.body.innerHTML = `
  <div class="login">
    <div class="login-card">
      <div class="mark"><i></i></div>
      <h1>提醒器</h1>
      <p>输入口令连接你的服务端。多台设备登录后共享同一份提醒。</p>
      <form id="form">
        <div>
          <label for="code">口令</label>
          <input class="input" id="code" type="password" autocomplete="current-password" value="${esc(cfg.passcode)}">
        </div>
        <div>
          <label for="name">这台设备叫什么</label>
          <input class="input" id="name" value="${esc(cfg.deviceName)}">
        </div>
        <div class="login-err" id="err"></div>
        <button class="btn solid" id="go" style="height:38px">连接</button>
      </form>
      <div class="login-foot">
        服务端地址 <span class="mono">${esc(cfg.baseUrl)}</span><br>
        带 <span class="mono">--minimized</span> 启动表示开机自启，只进托盘不弹窗
      </div>
    </div>
  </div>`;

  const err = $<HTMLDivElement>('#err')!;
  const go = $<HTMLButtonElement>('#go')!;
  const code = $<HTMLInputElement>('#code')!;
  code.focus();

  const submit = async () => {
    err.textContent = '';
    go.disabled = true;
    go.textContent = '连接中';
    try {
      const name = $<HTMLInputElement>('#name')!.value.trim() || '我的笔记本';
      const r = await api.login(code.value, name);
      saveConfig({ passcode: code.value, deviceName: name, token: r.token, device: r.device });
      boot();
    } catch (e) {
      err.textContent = e instanceof ApiError && e.status === 401
        ? '口令不对'
        : '连不上服务端，确认地址和服务是否在跑';
      go.disabled = false;
      go.textContent = '连接';
    }
  };

  $<HTMLFormElement>('#form')!.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submit();
  });
  go.addEventListener('click', () => void submit());
  code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') void submit(); });
}

/* ------------------------------------------------------------ 主界面 */

function renderShell() {
  document.body.innerHTML = `
  <div class="app">
    <div class="topbar">
      <span class="logo"><i></i></span>
      <b>提醒器</b>
      <div class="sp"></div>
      <div class="conn no-drag"><span class="sdot off" id="sdot"></span><span id="stxt">未连接</span></div>
      <button class="btn sm no-drag" id="btn-hotkey" title="全局热键">Ctrl+Shift+Space 快速记</button>
      <button class="btn sm no-drag" id="btn-test">试响</button>
      <button class="btn sm no-drag" id="btn-hide">缩到托盘</button>
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
      <span>时钟偏差 <span class="mono" id="s-skew">0 ms</span></span>
      <div class="sp"></div>
      <span>开机自启 <b id="s-auto">-</b></span>
      <button class="btn sm" id="btn-logout">退出登录</button>
    </div>
  </div>`;

  $<HTMLButtonElement>('#btn-hide')!.onclick = () => void invoke('hide_main');
  $<HTMLButtonElement>('#btn-test')!.onclick = () => {
    void invoke('ping', { title: '试响', body: '能听到声音就说明这台设备没问题' });
  };
  $<HTMLButtonElement>('#btn-hotkey')!.onclick = () => void invoke('show_capture');
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
  void invoke<boolean>('is_autostart_enabled')
    .then((on) => { const el = $<HTMLElement>('#s-auto'); if (el) el.textContent = on ? '开' : '关'; })
    .catch(() => { /* 没权限就算了 */ });
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
 * 忽略。和「完成」语义完全不同的一步：
 * 条目不会被关掉，只是留下一条带理由的记录。
 * 累计到服务端配的阈值会自动降级，并给出「该删了」的建议
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

/* ------------------------------------------------------------ 渲染 */

function setView(v: View) {
  state.view = v;
  state.selected = null;
  void refresh();
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
        <span class="count ${v === 'today' && bad > 0 ? 'due' : ''}">${n}</span>
      </button>`).join('')}
    <div class="nav-sep"></div>
    <div class="nav-head">弱提示</div>
    <button class="nav ${state.view === 'dismissed' ? 'on' : ''}" data-view="dismissed">已忽略<span class="count">${state.dismissals.length}</span></button>
    <button class="nav ${state.view === 'neglected' ? 'on' : ''}" data-view="neglected">老是被忽略</button>
    <div class="nav-sep"></div>
    <div class="nav-head">推送设备</div>
    <button class="nav on"><span class="sdot"></span>${esc(me?.name ?? '本机')}<span class="count">本机</span></button>
    ${others.map((d) => `
      <div class="nav" title="${esc(d.transport.toUpperCase())}">
        <span class="sdot ${d.online ? '' : d.pushReady ? 'alert' : 'off'}"></span>${esc(d.name)}
        <span class="count">${d.online ? '在线' : d.pushReady ? d.transport.toUpperCase() : '未配推送'}</span>
      </div>`).join('')}
    <div style="flex:1"></div>
    <button class="nav" id="btn-autostart"><span class="sdot ${loadConfig().settings.sound === 'none' ? 'off' : ''}"></span>开机自启<span class="count" id="auto-state">-</span></button>`;

  const auto = $<HTMLButtonElement>('#btn-autostart')!;
  auto.onclick = async () => {
    const el = $<HTMLSpanElement>('#auto-state')!;
    const cur = el.dataset.on === '1';
    try {
      const now = await invoke<boolean>('set_autostart', { enable: !cur });
      el.dataset.on = now ? '1' : '0';
      el.textContent = now ? '开' : '关';
    } catch { el.textContent = '设置失败'; }
  };
  void invoke<boolean>('is_autostart_enabled').then((on) => {
    const el = $<HTMLSpanElement>('#auto-state');
    if (!el) return;
    el.dataset.on = on ? '1' : '0';
    el.textContent = on ? '开' : '关';
  }).catch(() => { /* ignore */ });
}

function renderList() {
  const box = $<HTMLDivElement>('#list')!;

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

function rowHtml(e: Entry): string {
  const missed = e.status === 'missed';
  const done = e.status === 'done';
  const nameOf = (id: string) => state.devices.find((x) => x.id === id)?.name ?? id;

  let meta = '';
  if (e.url) meta += `<span class="tag host">${esc(hostOf(e.url))}</span>`;
  if (e.path) meta += `<span class="tag path">${esc(e.path)}</span>`;
  if (e.repeat !== 'none') {
    meta += `<span class="tag">${{ daily: '每天', weekly: '每周', monthly: '每月' }[e.repeat]}</span>`;
  }
  // 强度标签。弱提示设计里最该被一眼看见的信息
  meta += e.strength === 'weak'
    ? '<span class="tag">弱提示</span>'
    : '<span class="tag due">强提示</span>';
  if (e.bypassQuiet) meta += '<span class="tag">绕过静音</span>';
  meta += `<span class="tag">${e.devices[0] === '*' ? '推给全部在线设备' : `仅推送到：${e.devices.map(nameOf).join(' / ')}`}</span>`;
  if (e.dismissCount > 0) meta += `<span class="tag due">被忽略 ${e.dismissCount} 次</span>`;
  if (done && e.doneDevice) meta += `<span class="tag elsewhere">已在「${esc(e.doneDevice)}」完成</span>`;
  if (missed) meta += `<span class="tag due">${esc(lateBy(e.firedAt ?? serverNow()))}还没处理</span>`;

  const u = urgencyOf(e);
  const label = timeLabel(e);

  return `
  <div class="item${done ? ' done' : ''}${u === 'none' ? '' : ` u-${u}`} ${state.selected === e.id ? 'on' : ''}"
       data-id="${esc(e.id)}" data-u="${u}" data-tl="${esc(label)}">
    <div class="cbox" data-toggle="${esc(e.id)}">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#0B0C0D" stroke-width="3.4"><path d="M4 12.5l5 5L20 6.5"/></svg>
    </div>
    <div>
      <div class="it-time">${u === 'none' ? '' : `<i class="udot ${u}"></i>`}${esc(label)}</div>
      <div class="it-title">${esc(e.text)}</div>
      <div class="it-meta">${meta}</div>
    </div>
    <div class="it-act">
      <button class="btn sm" data-more="${esc(e.id)}">推迟</button>
    </div>
  </div>`;
}

/**
 * 时间行的文案。
 *
 * 一小时内不报钟点，报「还有 X 分钟」。
 * 临近期限时，差多少比几点钟有用得多
 */
function timeLabel(e: Entry): string {
  if (e.status === 'missed') {
    return `${dayLabel(e.remindAt!)} ${hhmm(e.remindAt!)} · ${lateBy(e.firedAt ?? serverNow())}还没处理`;
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
 * 临近度会随时间自己往前走，但事件驱动的刷新不会推进它。
 * 每 20 秒原地更新行：不改 innerHTML 整体，
 * 滚动位置和选中态都不丢。只变了梯度的行才动 DOM
 */
function tickUrgency() {
  const box = document.querySelector<HTMLElement>('.list-scroll');
  if (!box || state.entries.length === 0) return;

  for (const e of state.entries) {
    if (e.status === 'done' || e.remindAt === null) continue;
    const row = box.querySelector<HTMLElement>(`[data-id="${CSS.escape(e.id)}"]`);
    if (!row) continue;

    const u = urgencyOf(e);
    const label = timeLabel(e);
    if (row.dataset.u === u && row.dataset.tl === label) continue;

    row.dataset.u = u;
    row.dataset.tl = label;
    row.classList.remove('u-soon', 'u-close', 'u-due', 'u-over');
    if (u !== 'none') row.classList.add(`u-${u}`);

    const timeEl = row.querySelector('.it-time');
    if (timeEl) timeEl.innerHTML = `${u === 'none' ? '' : `<i class="udot ${u}"></i>`}${esc(label)}`;
  }
}

function renderEditor() {
  const box = $<HTMLElement>('#editor')!;
  const e = state.entries.find((x) => x.id === state.selected);

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
        <textarea class="input" id="f-t" rows="2" style="resize:vertical">${esc(e.text)}</textarea>
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
          ? `<div class="hint" style="color:var(--flare)">已经被忽略 ${e.dismissCount} 次${e.dismissCount >= s.neglectedAfter ? '，建议直接删掉' : ''}</div>`
          : ''}
      </div>

      <div class="fld">
        <label>提醒时间</label>
        <div class="seg">
          <button data-w="none" class="${e.remindAt === null ? 'on' : ''}">不定时</button>
          <button data-w="1h" class="${e.remindAt !== null && e.remindAt <= serverNow() + 3600_000 ? 'on' : ''}">1 小时后</button>
          <button data-w="set" class="${e.remindAt !== null && e.remindAt > serverNow() + 3600_000 ? 'on hot' : ''}">指定时间</button>
        </div>
        ${e.remindAt !== null ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
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
        <textarea class="input" id="f-n" rows="3" style="resize:vertical" placeholder="提醒时一起显示的内容">${esc(e.note ?? '')}</textarea>
      </div>
    </div>
    <div class="ed-foot">
      <button class="btn solid" data-do="done">完成</button>
      <button class="btn" data-do="tomorrow">明天同一时间</button>
      <button class="btn danger" data-do="del" style="margin-left:auto">删除</button>
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
  renderEditor();
  const cfg = loadConfig();
  const skew = $<HTMLElement>('#s-skew');
  if (skew) skew.textContent = `${cfg.serverSkewMs > 0 ? '+' : ''}${cfg.serverSkewMs} ms`;
}

function setLink(s: 'connecting' | 'open' | 'closed') {
  const dot = $<HTMLElement>('#sdot');
  const txt = $<HTMLElement>('#stxt');
  const srv = $<HTMLElement>('#s-server');
  if (!dot) return;
  dot.className = `sdot ${s === 'open' ? '' : 'off'}`;
  txt.textContent = s === 'open' ? '已连接' : s === 'connecting' ? '连接中' : '已断开';
  srv.textContent = `服务端 ${loadConfig().baseUrl}`;
}

/* ------------------------------------------------------------ 操作 */

async function refresh() {
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
    void emit('capture:result', { ok: false, message: '保存失败，检查服务端连接' });
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

/** 「明天同一时间」，以及已忽略条目的「再提醒我」 */
async function promptSnooze(id: string) {
  const base = state.entries.find((x) => x.id === id);
  if (base?.status === 'done') {
    try { await api.rearm(id); } catch { /* ignore */ }
    void refresh();
    return;
  }
  const from = base?.remindAt ?? serverNow();
  const d = new Date(from);
  d.setDate(d.getDate() + 1);
  await api.snooze(id, { to: d.getTime() });
  void refresh();
}

function onEditorClick(ev: Event) {
  const t = (ev.target as HTMLElement)
    .closest<HTMLElement>('[data-s],[data-w],[data-r],[data-all],[data-dev],[data-do]');
  const e = state.entries.find((x) => x.id === state.selected);
  if (!t || !e) return;

  const save = (patch: Record<string, unknown>) =>
    api.update(e.id, { ...patch, version: e.version })
      .then(refresh)
      .catch(() => { /* 版本冲突下次同步覆盖 */ });

  const s = t.dataset.s;
  if (s) { void save({ strength: s }); return; }

  const w = t.dataset.w;
  if (w === 'none') { void save({ remindAt: null }); return; }
  if (w === '1h' || w === 'set') { void save({ remindAt: serverNow() + 3600_000 }); return; }

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
  if (doWhat === 'del') { void api.remove(e.id).then(() => { state.selected = null; return refresh(); }); return; }
  if (doWhat === 'tomorrow') { void promptSnooze(e.id); return; }
}

function onEditorInput(ev: Event) {
  const t = ev.target as HTMLInputElement | HTMLTextAreaElement;
  const e = state.entries.find((x) => x.id === state.selected);
  if (!e) return;
  const w = window as unknown as Record<string, number>;

  if (t.id === 'f-t' || t.id === 'f-n') {
    clearTimeout(w.__deb);
    w.__deb = window.setTimeout(() => {
      const field = t.id === 'f-t' ? { text: t.value } : { note: t.value || null };
      api.update(e.id, { ...field, version: e.version }).catch(() => { /* ignore */ });
    }, 400);
  }

  if (t.id === 'f-tm' || t.id === 'f-d' || t.id === 'f-bq') {
    clearTimeout(w.__deb2);
    w.__deb2 = window.setTimeout(() => {
      const ds = $<HTMLInputElement>('#f-d')?.value;
      const ts = $<HTMLInputElement>('#f-tm')?.value;
      const bq = $<HTMLInputElement>('#f-bq')?.checked ?? false;
      const patch: Record<string, unknown> = { bypassQuiet: bq };
      if (ds && ts) {
        const at = new Date(`${ds}T${ts}`).getTime();
        if (!Number.isNaN(at)) patch.remindAt = at;
      }
      api.update(e.id, { ...patch, version: e.version }).then(refresh).catch(() => { /* ignore */ });
    }, 500);
  }
}

/* ------------------------------------------------------ 跨窗口事件 */

function wireEvents() {
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
    await invoke('open_external', { url });
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
        void emit('capture:result', { ok: true });
        void refresh();
      } catch (err) {
        void emit('capture:result', { ok: false, message: err instanceof Error ? err.message : '保存失败' });
      }
    },
  );

  listen('tray:capture', () => void invoke('show_capture'));
  listen('hotkey:capture', () => void invoke('show_capture'));
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

  // 临近梯度随时间自己往前走，事件刷新不会推进它
  tickUrgency();
  window.setInterval(tickUrgency, 20_000);
}

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome': {
      // 上线补发。漏掉的强提示进响铃队列，弱提示进横幅
      for (const m of msg.missed) {
        void invoke('ping', {
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

if (loadConfig().token) boot();
else renderLogin();
