/**
 * 安卓端界面。和桌面端共用 api / 跟进控制器 / 主题 / 解析规则，
 * 布局按手机重做：顶部状态 + 随手记 / 今天 / 设置，点推进项进详情页。
 */
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import {
  ApiError, Realtime, api, clearToken, dayLabel, dueLabel, getMachineId, getPlatform,
  loadConfig, normalizeBaseUrl, noteFollowup, onUnauthorized, parseInput, probeServer, saveConfig,
  serverNow, staleLabel, switchServer, versionOf, warmthOf, ENERGY_LABEL, NATURE_LABEL,
  type Followup, type FollowupAction, type FocusResult, type Importance,
  type NudgeLevel, type Pursuit, type PursuitStatus, type RecurrenceRule,
  type ServerMessage, type Settings, type StepState,
} from '../api';
import { FollowupController, dropBannerByPursuit } from '../alarm';
import { applyTheme, loadTheme, saveTheme, THEMES } from '../theme';
import '../styles-mobile.css';

const app = document.getElementById('app')!;

type View = 'capture' | 'today' | 'detail' | 'settings';
type ListKind = 'today' | 'inbox' | 'all';

let platform = 'android';
let view: View = 'capture';
let listKind: ListKind = 'today';
let rt: Realtime | null = null;
let focus: FocusResult | null = null;
let pursuits: Pursuit[] = [];
let followups: Followup[] = [];
let counts: Partial<Record<PursuitStatus, number>> = {};
let selectedId: string | null = null;
let captureImportance: Importance = 0;
const IMP_TITLE = ['不标：按默认权重排期', '★ 低：略微优先', '★★ 中：优先推进', '★★★ 高：最优先推进'];
const localHandled = new Map<string, number>();

const control = new FollowupController({
  onSilent: () => { void refresh(); },
  onNotify: (p, _level, reason, attempt) => {
    void notify(p.text, `${reason}${attempt > 1 ? ` · 第 ${attempt} 次` : ''}`);
    toast(`${p.text} · ${reason}`);
  },
  onBanner: (p, _level, reason) => toast(`${p.text} · ${reason}`),
  onTakeover: (p, level, reason) => showMobileTakeover(p, level, reason),
  onArchive: (p) => { toast(`长期停滞，已自动归档：${p.text}`); void refresh(); },
  onStop: (p, reason) => {
    document.getElementById('m-takeover')?.remove();
    dropBannerByPursuit(p.id);
    if (reason === 'elsewhere' && Date.now() - (localHandled.get(p.id) ?? 0) > 3000) {
      toast('这条已在别的设备上处理掉了');
    }
    void refresh();
  },
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
  toastTimer = window.setTimeout(() => el!.classList.remove('on'), 3200);
}

function natureIcon(n: Pursuit['nature']): string {
  return n === 'project' ? '◫' : n === 'recurring' ? '↻' : '·';
}

/* ------------------------------------------------------------ 骨架 */

function shell(): string {
  return `
  <div class="m-top">
    <span class="logo"><i></i></span>
    <b>今日推进</b>
    <span class="sp"></span>
    <span class="m-conn" id="conn"><span class="dot"></span><span id="conn-txt">未连接</span></span>
  </div>
  <section class="m-view" id="v-capture"></section>
  <section class="m-view" id="v-today"></section>
  <section class="m-view" id="v-detail"></section>
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
  if (v === 'today') { renderEntries(); void refresh(); }
  if (v === 'detail') renderDetail();
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
      <label>写一句话、链接或目录。带时间就设截止，不带就进收件箱</label>
      <textarea class="cap-input" id="cap" placeholder="例如：明天 15:00 交周报&#10;例如：把驾照考试拆成几步&#10;例如：https://example.com" autocomplete="off"></textarea>
      <div class="cap-parse" id="parse"></div>
      <div class="cap-imp" id="cap-imp">
        <span>重要性</span>
        ${([0, 1, 2, 3] as Importance[]).map((n) =>
          `<button type="button" class="chip ${captureImportance === n ? 'hot' : ''}" data-imp="${n}" title="${IMP_TITLE[n]}">${['不标', '★', '★★', '★★★'][n]}</button>`,
        ).join('')}
      </div>
      <div class="cap-row"><button class="btn solid block" id="save">记一条</button></div>
      <div class="cap-tip">重要性别靠措辞猜：觉得重要就点一下星。时间解析只做提示，以服务端存下来的为准。</div>
    </div>
  </div>`;

  const input = document.getElementById('cap') as HTMLTextAreaElement;
  const parse = document.getElementById('parse')!;
  const preview = () => {
    const p = parseInput(input.value);
    if (!input.value.trim()) { parse.innerHTML = ''; return; }
    parse.innerHTML = `
      <span class="chip ${p.kind === 'text' ? '' : 'hot'}">${esc(p.kindLabel)}</span>
      <span class="chip ${p.remindAt !== null ? 'hot' : ''}">${esc(p.timeLabel)}</span>`;
  };
  input.addEventListener('input', preview);
  document.getElementById('cap-imp')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-imp]');
    if (!b) return;
    captureImportance = Number(b.dataset.imp) as Importance;
    document.querySelectorAll<HTMLElement>('#cap-imp .chip').forEach((c) => {
      c.classList.toggle('hot', c.dataset.imp === String(captureImportance));
    });
  });
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
      dueAt: p.remindAt,
      importance: captureImportance,
      nature: 'one_off',
    });
    input.value = '';
    document.getElementById('parse')!.innerHTML = '';
    captureImportance = 0;
    document.querySelectorAll<HTMLElement>('#cap-imp .chip').forEach((c) => c.classList.toggle('hot', c.dataset.imp === '0'));
    toast(p.remindAt !== null ? '已设截止' : '已存进收件箱');
    void refresh();
    if (p.remindAt !== null) setView('today');
  } catch (e) {
    toast('保存失败：' + (e instanceof Error ? e.message : '请检查连接'));
  }
}

/* ------------------------------------------------------------ 推进列表 */

function renderListHead() {
  const host = document.getElementById('v-today')!;
  host.innerHTML = `
  <div class="list-tabs">
    <button data-kind="today" class="${listKind === 'today' ? 'on' : ''}">今天</button>
    <button data-kind="inbox" class="${listKind === 'inbox' ? 'on' : ''}">收件箱 <span id="ci">${counts.inbox || ''}</span></button>
    <button data-kind="all" class="${listKind === 'all' ? 'on' : ''}">全部</button>
  </div>
  <div class="list-scroll" id="list-scroll"></div>`;
  host.querySelectorAll<HTMLElement>('.list-tabs button').forEach((b) => {
    b.onclick = () => { listKind = b.dataset.kind as ListKind; renderListHead(); void loadList(); };
  });
}

function focusHtml(): string {
  if (listKind !== 'today') return '';
  if (!focus || !focus.items.length) {
    return `<div class="focus-card"><div class="focus-head"><b>今日聚焦</b></div>
      <div class="focus-empty">今天没有需要强推的事。</div></div>`;
  }
  return `<div class="focus-card">
    <div class="focus-head"><b>今日聚焦</b><span>剩余强打扰 <b>${focus.budgetLeft}</b></span></div>
    ${focus.items.map((it) => `
      <div class="focus-item">
        <div class="fi-title">${esc(it.pursuit.text)}</div>
        <div class="fi-reason">${esc(it.reason)}</div>
        ${it.suggestedNextStep ? `<div class="fi-next">下一步：${esc(it.suggestedNextStep)}</div>` : ''}
        <div class="acts">
          <button class="btn" data-follow="done" data-id="${esc(it.pursuit.id)}">推进</button>
          <button class="btn" data-follow="smaller" data-id="${esc(it.pursuit.id)}">拆小</button>
          <button class="btn" data-follow="later" data-id="${esc(it.pursuit.id)}">改天</button>
          <button class="btn" data-follow="archive" data-id="${esc(it.pursuit.id)}">归档</button>
        </div>
      </div>`).join('')}
  </div>`;
}

function entryHtml(p: Pursuit): string {
  const u = warmthOf(p);
  const total = p.steps.length;
  const done = p.steps.filter((s) => s.state === 'done').length;
  return `<div class="entry u-${u}" data-id="${esc(p.id)}">
    <div class="row1" data-open="${esc(p.id)}">
      <div class="txt">${esc(p.text)}</div>
    </div>
    <div class="meta">
      <span class="${u === 'due' || u === 'over' ? 'hot' : ''}">${esc(dueLabel(p))} · ${esc(staleLabel(p))}</span>
      <span>${'●'.repeat(p.importance)}${'○'.repeat(3 - p.importance)}</span>
      <span>${natureIcon(p.nature)} ${NATURE_LABEL[p.nature]}</span>
      <span>步骤 ${done}/${total}</span>
    </div>
    <div class="prog"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>
    <div class="acts">
      <button class="btn" data-follow="done" data-id="${esc(p.id)}">推进</button>
      <button class="btn" data-follow="later" data-id="${esc(p.id)}">改天</button>
      <button class="btn" data-follow="archive" data-id="${esc(p.id)}">归档</button>
    </div>
  </div>`;
}

function renderEntries() {
  const box = document.getElementById('list-scroll');
  if (!box) return;
  const list = pursuits.length
    ? pursuits.map(entryHtml).join('')
    : '<div class="empty">这里还没有推进项。<br>去「随手记」写一条吧。</div>';
  box.innerHTML = focusHtml() + list;
  bindFollowButtons(box);
  box.querySelectorAll<HTMLElement>('[data-open]').forEach((el) => {
    el.onclick = () => openDetail(el.dataset.open!);
  });
}

function bindFollowButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-follow]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      void mobileFollowup(b.dataset.id!, b.dataset.follow as FollowupAction);
    };
  });
}

async function loadList() {
  try {
    const [list, f] = await Promise.all([api.pursuits(listKind), api.focus()]);
    pursuits = [...list.pursuits].sort((a, b) => b.weight - a.weight);
    focus = f;
    renderEntries();
  } catch {
    toast('加载失败，请检查服务端连接');
  }
}

/* ------------------------------------------------------------ 详情 */

function findPursuit(id: string | null): Pursuit | undefined {
  if (!id) return undefined;
  return pursuits.find((p) => p.id === id);
}

function openDetail(id: string) {
  const p = findPursuit(id);
  if (!p) return;
  selectedId = id;
  followups = [];
  setView('detail');
  void api.followups(id).then((r) => {
    if (selectedId !== id) return;
    followups = r.followups;
    if (view === 'detail') renderDetail();
  }).catch(() => { /* 历史读不到不影响其它操作 */ });
}

function renderDetail() {
  const host = document.getElementById('v-detail');
  const p = findPursuit(selectedId);
  if (!host) return;
  if (!p) {
    host.innerHTML = `<div class="detail-wrap"><button class="btn" id="back">返回</button>
      <div class="empty">这条已经不在了。</div></div>`;
    host.querySelector('#back')!.addEventListener('click', () => setView('today'));
    return;
  }
  host.innerHTML = `
  <div class="detail-wrap">
    <div class="detail-top"><button class="btn sm" id="back">‹ 返回</button><b>推进详情</b></div>
    <div class="detail-scroll">
      <h2 class="detail-title">${esc(p.text)}</h2>
      <div class="detail-meta">${esc(dueLabel(p))} · ${esc(staleLabel(p))} · ${NATURE_LABEL[p.nature]}</div>

      <div class="set-group">
        <h3>步骤清单</h3>
        ${p.steps.length ? p.steps.map((s) => `
          <label class="step ${s.state === 'done' ? 'done' : ''}">
            <input type="checkbox" data-step="${esc(s.id)}" ${s.state === 'done' ? 'checked' : ''}>
            <span>${esc(s.text)}</span></label>`).join('')
          : '<div class="set-val">还没有步骤。</div>'}
        <div class="add-step"><input class="input" id="new-step" placeholder="加一个步骤，回车">
          <button class="btn" id="add-step">添加</button></div>
      </div>

      <div class="set-group">
        <h3>备注</h3>
        <textarea class="cap-input" id="note" rows="3">${esc(p.note ?? '')}</textarea>
        <button class="btn block" id="save-note" style="margin-top:10px">保存备注</button>
      </div>

      <div class="set-group">
        <h3>重要性</h3>
        <div class="imp-row">${([0, 1, 2, 3] as Importance[]).map((n) =>
          `<button class="btn ${p.importance === n ? 'solid' : ''}" data-imp="${n}" title="${IMP_TITLE[n]}">${['不标', '★', '★★', '★★★'][n]}</button>`,
        ).join('')}</div>
      </div>

      <div class="set-group">
        <h3>启动精力 / 性质</h3>
        <div class="imp-row">
          ${(['low', 'medium', 'high'] as const).map((e) =>
            `<button class="btn ${p.energy === e ? 'solid' : ''}" data-energy="${e}">${ENERGY_LABEL[e]}</button>`).join('')}
        </div>
        <div class="imp-row" style="margin-top:8px">
          ${(['one_off', 'recurring', 'project'] as const).map((n) =>
            `<button class="btn ${p.nature === n ? 'solid' : ''}" data-nature="${n}">${NATURE_LABEL[n]}</button>`).join('')}
        </div>
      </div>

      <div class="set-group">
        <h3>重复规则</h3>
        <select id="rule-freq" class="m-select">
          ${(['none', 'daily', 'weekly', 'monthly', 'yearly', 'workdays', 'interval'] as const).map((f) =>
            `<option value="${f}" ${(p.recurrence?.freq ?? 'none') === f ? 'selected' : ''}>${f === 'none' ? '不重复' : f}</option>`).join('')}
        </select>
        <input class="input" id="rule-interval" type="number" min="1" value="${p.recurrence?.interval ?? 1}" placeholder="间隔天数">
        <button class="btn block" id="save-rule" style="margin-top:10px">保存重复</button>
      </div>

      <div class="set-group">
        <h3>跟进历史</h3>
        ${followups.length ? followups.map((f) => `
          <div class="set-val" style="padding:6px 0">${esc(new Date(f.at).toLocaleString('zh-CN'))} · L${f.level} · ${esc(f.action)}${f.note ? ` · ${esc(f.note)}` : ''}</div>`).join('')
          : '<div class="set-val">还没有跟进记录。</div>'}
      </div>

      <div class="set-group">
        <button class="btn solid block" data-follow="done" data-id="${esc(p.id)}">推进</button>
        <button class="btn block" data-follow="partial" data-id="${esc(p.id)}" style="margin-top:8px">推了一点</button>
        <button class="btn block" data-follow="archive" data-id="${esc(p.id)}" style="margin-top:8px">归档</button>
      </div>
    </div>`;

  host.querySelector('#back')!.addEventListener('click', () => setView('today'));
  bindFollowButtons(host);
  host.querySelectorAll<HTMLInputElement>('[data-step]').forEach((box) => {
    box.onchange = () => {
      const stateName: StepState = box.checked ? 'done' : 'todo';
      void api.updateStep(box.dataset.step!, { state: stateName }).then(r => {
        const i = pursuits.findIndex((x) => x.id === p.id);
        if (i >= 0) pursuits[i] = r.pursuit;
        renderDetail();
      }).catch((e) => toast(msgOf(e)));
    };
  });
  host.querySelector('#add-step')!.addEventListener('click', () => void addMobileStep(p));
  host.querySelector<HTMLInputElement>('#new-step')!.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void addMobileStep(p);
  });
  host.querySelector('#save-note')!.addEventListener('click', () => {
    const note = (host.querySelector('#note') as HTMLTextAreaElement).value;
    void api.update(p.id, { note: note || null, version: versionOf(p) })
      .then(() => toast('备注已保存')).catch((e) => toast(msgOf(e)));
  });
  host.querySelectorAll<HTMLElement>('[data-imp]').forEach((b) => {
    b.onclick = () => void patchPursuit(p, { importance: Number(b.dataset.imp) });
  });
  host.querySelectorAll<HTMLElement>('[data-energy]').forEach((b) => {
    b.onclick = () => void patchPursuit(p, { energy: b.dataset.energy });
  });
  host.querySelectorAll<HTMLElement>('[data-nature]').forEach((b) => {
    b.onclick = () => void patchPursuit(p, { nature: b.dataset.nature });
  });
  host.querySelector('#save-rule')!.addEventListener('click', () => {
    const freq = (host.querySelector('#rule-freq') as HTMLSelectElement).value;
    const interval = Number((host.querySelector('#rule-interval') as HTMLInputElement).value) || 1;
    let rule: RecurrenceRule | null = null;
    if (freq !== 'none') rule = { freq: freq as RecurrenceRule['freq'], interval };
    void patchPursuit(p, { recurrence: rule });
  });
}

async function addMobileStep(p: Pursuit) {
  const input = document.getElementById('new-step') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  try {
    const r = await api.addStep(p.id, { text });
    const i = pursuits.findIndex((x) => x.id === p.id);
    if (i >= 0) pursuits[i] = r.pursuit;
    renderDetail();
  } catch (e) { toast(msgOf(e)); }
}

async function patchPursuit(p: Pursuit, patch: Record<string, unknown>) {
  try {
    const r = await api.update(p.id, { ...patch, version: versionOf(p) });
    const i = pursuits.findIndex((x) => x.id === p.id);
    if (i >= 0) pursuits[i] = r.pursuit;
    renderDetail();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast('刚在别的设备上改过，已刷新');
    else toast(msgOf(e));
  }
}

/* -------------------------------------------------------- 跟进动作 */

async function mobileFollowup(id: string, action: FollowupAction, extra: Record<string, unknown> = {}) {
  const p = findPursuit(id);
  if (!p) { toast('这条已经不在了'); return; }
  if (action === 'smaller' && !extra.steps) {
    const value = window.prompt('拆成 2-3 个能立刻动手的小步骤，用换行分隔', p.text);
    if (value === null) return;
    const steps = value.split(/\r?\n|；|;/).map((s) => s.trim()).filter(Boolean);
    if (!steps.length) return;
    extra.steps = steps;
  }
  if (action === 'later' && !extra.to) {
    const d = new Date(serverNow());
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    extra.to = d.getTime();
  }
  try {
    localHandled.set(id, Date.now());
    if (!extra.steps && !extra.to) rt?.followup(id, action, versionOf(p));
    await api.followup(id, {
      action, version: versionOf(p),
      ...(Array.isArray(extra.steps) ? { steps: extra.steps as string[] } : {}),
      ...(extra.to ? { to: Number(extra.to) } : {}),
    });
    noteFollowup(id, action);
    control.acknowledge(action);
    dropBannerByPursuit(id);
    document.getElementById('m-takeover')?.remove();
    toast(action === 'done' ? '已推进' : action === 'archive' ? '已归档' : '已记下');
    if (view === 'detail') setView('today');
    void refresh();
  } catch (e) {
    toast('操作失败：' + msgOf(e));
  }
}

function showMobileTakeover(p: Pursuit, level: NudgeLevel, reason: string) {
  document.getElementById('m-takeover')?.remove();
  const host = document.createElement('div');
  host.id = 'm-takeover';
  host.className = 'm-takeover';
  host.innerHTML = `
    <div class="mt-card">
      <div class="mt-lv">L${level} 接管 · 关不掉</div>
      <h2>${esc(p.text)}</h2>
      <div class="mt-reason">${esc(reason)}</div>
      <div class="acts">
        <button class="btn solid" data-follow="done" data-id="${esc(p.id)}">推进</button>
        <button class="btn" data-follow="smaller" data-id="${esc(p.id)}">拆小</button>
        <button class="btn" data-follow="later" data-id="${esc(p.id)}">改天</button>
        <button class="btn" data-follow="archive" data-id="${esc(p.id)}">归档</button>
      </div>
    </div>`;
  document.body.appendChild(host);
  bindFollowButtons(host);
}

/* ------------------------------------------------------------ 设置 */

function renderSettings() {
  const host = document.getElementById('v-settings')!;
  const u = loadConfig().user;
  const s = loadConfig().settings;
  host.innerHTML = `<div class="set-scroll">
    <div class="set-group">
      <div class="who"><div class="avatar">${esc((u?.username ?? '?').slice(0, 1).toUpperCase())}</div>
        <div><div style="font-weight:600">${esc(u?.username ?? '未登录')}</div>
        <div class="set-val">${u?.role === 'admin' ? '管理员' : '普通用户'}</div></div></div>
    </div>
    <div class="set-group">
      <h3>连接</h3>
      <div class="set-field"><label>服务端地址</label>
        <input id="base" value="${esc(loadConfig().baseUrl)}" placeholder="http://192.168.1.10:8091" autocomplete="off">
        <div class="probe" id="probe"></div></div>
      <button class="btn block" id="test">测试连接</button>
    </div>
    <div class="set-group">
      <h3>推进节奏（一端改，所有设备生效）</h3>
      <div class="set-field"><label>每日强打扰额度</label><input id="pf-budget" type="number" min="0" max="20" value="${s.dailyStrongBudget}"></div>
      <div class="set-field"><label>L2 停滞阈值（小时）</label><input id="pf-l2" type="number" min="0" value="${Math.round(s.escalateAfterMs.l2 / 3600000)}"></div>
      <div class="set-field"><label>L3 停滞阈值（小时）</label><input id="pf-l3" type="number" min="0" value="${Math.round(s.escalateAfterMs.l3 / 3600000)}"></div>
      <div class="set-field"><label>L4 停滞阈值（小时）</label><input id="pf-l4" type="number" min="0" value="${Math.round(s.escalateAfterMs.l4 / 3600000)}"></div>
      <div class="set-field"><label>L5 停滞阈值（小时）</label><input id="pf-l5" type="number" min="0" value="${Math.round(s.escalateAfterMs.l5 / 3600000)}"></div>
      <div class="set-field"><label>每日聚焦时刻</label><input id="pf-focus" type="time" value="${minText(s.focusAtMin)}"></div>
      <div class="set-field"><label>静音开始</label><input id="pf-quiet-start" type="time" value="${minText(s.quietStartMin)}"></div>
      <div class="set-field"><label>静音结束</label><input id="pf-quiet-end" type="time" value="${minText(s.quietEndMin)}"></div>
      <div class="set-field"><label>提示音</label>
        <select id="pf-sound" class="m-select">
          ${(['system', 'custom', 'none'] as const).map((v) =>
            `<option value="${v}" ${s.sound === v ? 'selected' : ''}>${v === 'none' ? '静音' : v === 'custom' ? '自定义' : '系统提示音'}</option>`).join('')}
        </select></div>
      <div class="probe" id="pf-msg"></div>
      <button class="btn solid block" id="pf-save">保存偏好</button>
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
      <button class="btn block" id="ping">测试通知（确认能提醒）</button>
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
  const tf = (id: string) => document.getElementById(id) as HTMLInputElement;
  const pfMsg = document.getElementById('pf-msg')!;
  document.getElementById('pf-save')!.onclick = async () => {
    pfMsg.className = 'probe'; pfMsg.textContent = '';
    const hrs = (id: string) => Math.max(0, Number(tf(id).value)) * 3_600_000;
    const patch: Partial<Settings> = {
      dailyStrongBudget: Math.max(0, Number(tf('pf-budget').value)),
      escalateAfterMs: { l2: hrs('pf-l2'), l3: hrs('pf-l3'), l4: hrs('pf-l4'), l5: hrs('pf-l5') },
      quietStartMin: toMin(tf('pf-quiet-start').value),
      quietEndMin: toMin(tf('pf-quiet-end').value),
      focusAtMin: toMin(tf('pf-focus').value),
      sound: (document.getElementById('pf-sound') as HTMLSelectElement).value as Settings['sound'],
    };
    if (Object.values(patch).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0))) {
      pfMsg.textContent = '请填写有效的数字'; pfMsg.className = 'probe bad'; return;
    }
    pfMsg.textContent = '保存中…';
    try {
      const r = await api.patchSettings(patch);
      saveConfig({ settings: r.settings });
      pfMsg.textContent = '已保存，所有设备同步生效'; pfMsg.className = 'probe ok';
    } catch {
      pfMsg.textContent = '保存失败，检查服务端连接'; pfMsg.className = 'probe bad';
    }
  };
  if (hasTauri()) void getVersion().then((v) => {
    const el = document.getElementById('curver');
    if (el) el.textContent = 'v' + v;
  }).catch(() => {});
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
      statusEl.textContent = '检查失败：' + msgOf(e);
    }
  };
  document.getElementById('do-upd')!.onclick = async () => {
    if (!pendingApk) return;
    statusEl.textContent = '开始下载，请在通知栏查看进度…';
    try {
      await invoke('plugin:apk-installer|download_and_install', pendingApk);
      statusEl.textContent = '下载完成，请在系统安装器中确认安装';
    } catch (e) {
      const msg = msgOf(e);
      statusEl.textContent = msg === 'NEED_INSTALL_PERMISSION' ? '请先允许「安装未知应用」后重试' : '安装失败：' + msg;
    }
  };
  document.getElementById('ping')!.onclick = () => { notify('试响', '如果你看到这条通知，说明手机通知正常'); toast('已发通知'); };
  document.getElementById('logout')!.onclick = () => {
    rt?.close(); clearToken(); location.reload();
  };
}

function minText(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function toMin(v: string): number {
  const [h, m] = v.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------ 实时 / 刷新 */

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome':
      if (msg.missed.length) toast(`上线补发 ${msg.missed.length} 条跟进`);
      void refresh();
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
      focus = { serverTs: serverNow(), items: msg.items, budgetLeft: msg.budgetLeft };
      if (view === 'today') renderEntries();
      break;
    case 'pursuit.nudge':
      control.fire(msg.pursuit, msg.level, msg.reason, msg.channel);
      void refresh();
      break;
    case 'settings.changed':
      saveConfig({ settings: msg.settings });
      if (view === 'settings') renderSettings();
      toast('推进偏好已在别的设备更新');
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

async function startNativePush() {
  if (!hasTauri()) return;
  const cfg = loadConfig();
  if (!cfg.baseUrl || !cfg.token) return;
  try {
    await invoke('plugin:push|start', { baseUrl: cfg.baseUrl, token: cfg.token });
  } catch { /* 保活起不来不该挡住前台使用 */ }
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
      <p>${needed ? '这个服务端还没有管理员。创建第一个账号后即可登录使用，此入口只显示一次。' : '用账号连接你的服务端。每台设备用自己的身份登录，推进项按用户隔离。'}</p>
      <div class="fld"><label>服务端地址</label>
        <input id="base" value="${esc(cfg.baseUrl || 'http://192.168.1.10:8091')}" autocomplete="off" spellcheck="false"></div>
      <div class="probe" id="probe"></div>
      <button class="btn" id="test-conn" style="margin-bottom:16px">测试连接</button>
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
  const probeEl = document.getElementById('probe')!;
  document.getElementById('to-login')?.addEventListener('click', () => renderAuth(false));

  const testConn = async () => {
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { probeEl.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; probeEl.className = 'probe bad'; return; }
    probeEl.textContent = '测试中…'; probeEl.className = 'probe';
    const r = await probeServer(norm);
    probeEl.textContent = r.ok ? `已连上（时钟差 ${Math.round(r.skewMs)} ms），可以登录` : r.reason;
    probeEl.className = 'probe ' + (r.ok ? 'ok' : 'bad');
    if (r.ok) saveConfig({ serverSkewMs: r.skewMs });
    return r.ok;
  };
  document.getElementById('test-conn')!.onclick = () => { void testConn(); };

  document.getElementById('go')!.onclick = async () => {
    err.textContent = '';
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { err.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; return; }
    const username = (document.getElementById('user') as HTMLInputElement).value.trim();
    const password = (document.getElementById('pass') as HTMLInputElement).value;
    const deviceName = (document.getElementById('dev') as HTMLInputElement).value.trim() || '我的手机';
    if (!username) { err.textContent = '请填用户名'; return; }
    if (password.length < 8) { err.textContent = '密码至少 8 位'; return; }
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
        const r = await api.login(username, password, deviceName, platform === 'android' ? 'android' : 'web');
        saveConfig({ token: r.token, user: r.user, device: r.device });
      }
      boot();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ALREADY_SETUP') { renderAuth(false); return; }
      err.textContent = '登录失败：' + (msgOf(e));
    }
  };
}

/* ------------------------------------------------------------ 启动 */

function boot() {
  app.innerHTML = shell();
  applyTheme(loadTheme());
  document.querySelectorAll<HTMLElement>('.m-nav button').forEach((b) => {
    b.onclick = () => setView(b.dataset.view as View);
  });
  renderCapture();
  renderListHead();
  setView('capture');
  connect();
  void startNativePush();
  void refresh();
  window.setInterval(() => {
    if (view === 'today') renderEntries();
  }, 20_000);
}

onUnauthorized(() => { rt?.close(); location.reload(); });

(async () => {
  applyTheme(loadTheme());
  platform = await getPlatform();
  const cfg = loadConfig();
  if (!cfg.token) {
    try {
      const s = await api.setupStatus();
      renderAuth(s.needed);
    } catch {
      renderAuth(true);
    }
    return;
  }
  boot();
})();
