/**
 * 安卓端界面。和桌面端共用 api / 跟进控制器 / 主题 / 解析规则，
 * 布局按手机重做：顶部状态 + 随手记 / 今天 / 设置，点推进项进详情页。
 */
import { invoke } from '@tauri-apps/api/core';
import { initUpdater, openAbout } from '../about';
import {
  ApiError, Realtime, api, clearToken, dayLabel, dueLabel, getMachineId, getPlatform,
  loadConfig, normalizeBaseUrl, noteFollowup, onUnauthorized, parseInput, probeServer, saveConfig,
  serverNow, staleLabel, switchServer, versionOf, warmthOf,
  FREQ_LABEL, FOLLOWUP_ACTION_LABEL, NATURE_LABEL, levelForStrength, rowActions,
  type ClientPlatform, type Followup, type FollowupAction, type FocusResult,
  type Pursuit, type PursuitStatus, type RecurrenceRule, type ReminderStrength,
  type ServerMessage, type Settings, type StepEdit, type StepState,
} from '../api';
import { actionsFor, effectiveImportance } from '../../../shared/types';
import { buildRecurrence, fieldsFor, ruleFields, type Freq } from './recurrence-form';
import { FollowupController } from '../alarm';
import { applyTheme, loadTheme, saveTheme, THEMES } from '../theme';
import { openSnoozeDialog, openStepsDialog } from '../widgets';
import '../styles-mobile.css';

const app = document.getElementById('app')!;

type View = 'capture' | 'today' | 'detail' | 'settings';
type ListKind = 'today' | 'todo' | 'done' | 'archived';

let platform: ClientPlatform = 'android';
let view: View = 'capture';
let listKind: ListKind = 'today';
let rt: Realtime | null = null;
let focus: FocusResult | null = null;
let pursuits: Pursuit[] = [];
let followups: Followup[] = [];
let counts: Partial<Record<PursuitStatus, number>> = {};
let selectedId: string | null = null;
let captureStrength: ReminderStrength = 'weak';
const localHandled = new Map<string, number>();

const mobileTakeoverQueue: Pursuit[] = [];

function showNextMobileTakeover() {
  if (!mobileTakeoverQueue.length) {
    document.getElementById('m-takeover')?.remove();
    return;
  }
  showMobileTakeover(mobileTakeoverQueue[0], mobileTakeoverQueue.length);
}

const control = new FollowupController({
  onNotify: (p, reason, attempt) => {
    void notify(p.text, `${reason}${attempt > 1 ? ` · 第 ${attempt} 次` : ''}`);
    toast(`${p.text} · ${reason}`);
  },
  onTakeover: (p) => {
    if (!mobileTakeoverQueue.some((x) => x.id === p.id)) mobileTakeoverQueue.push(p);
    showNextMobileTakeover();
  },
  onStop: (p, reason) => {
    const i = mobileTakeoverQueue.findIndex((x) => x.id === p.id);
    if (i >= 0) {
      mobileTakeoverQueue.splice(i, 1);
      showNextMobileTakeover();
    }
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
  return n === 'project' ? '◫' : '·';
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
      <label>写一句话、链接或目录。带时间就设截止，不带就进待办</label>
      <textarea class="cap-input" id="cap" placeholder="例如：明天 15:00 交周报&#10;例如：把驾照考试拆成几步&#10;例如：https://example.com" autocomplete="off"></textarea>
      <div class="cap-parse" id="parse"></div>
      <div class="cap-imp" id="cap-imp">
        <span>提醒类型</span>
        <button type="button" class="chip ${captureStrength === 'weak' ? 'hot' : ''}" data-strength="weak">弱提醒</button>
        <button type="button" class="chip ${captureStrength === 'strong' ? 'hot' : ''}" data-strength="strong">强提醒</button>
      </div>
      <div class="cap-row"><button class="btn solid block" id="save">记一条</button></div>
      <div class="cap-tip">强弱自己选，不靠措辞猜；没填时间按强弱给默认截止。</div>
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
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-strength]');
    if (!b) return;
    captureStrength = b.dataset.strength as ReminderStrength;
    document.querySelectorAll<HTMLElement>('#cap-imp .chip').forEach((c) => {
      c.classList.toggle('hot', c.dataset.strength === captureStrength);
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
      strength: captureStrength,
      nature: 'one_off',
    });
    input.value = '';
    document.getElementById('parse')!.innerHTML = '';
    captureStrength = 'weak';
    document.querySelectorAll<HTMLElement>('#cap-imp .chip').forEach((c) => c.classList.toggle('hot', c.dataset.strength === 'weak'));
    toast(p.remindAt !== null ? '已设截止' : '已存进待办');
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
    <button data-kind="today" class="${listKind === 'today' ? 'on' : ''}">今日待办</button>
    <button data-kind="todo" class="${listKind === 'todo' ? 'on' : ''}">待办</button>
    <button data-kind="done" class="${listKind === 'done' ? 'on' : ''}">已完成</button>
    <button data-kind="archived" class="${listKind === 'archived' ? 'on' : ''}">已归档</button>
  </div>
  <div class="list-scroll" id="list-scroll"></div>`;
  host.querySelectorAll<HTMLElement>('.list-tabs button').forEach((b) => {
    b.onclick = () => { listKind = b.dataset.kind as ListKind; renderListHead(); void loadList(); };
  });
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
      <span>${p.strength === 'strong' ? '强提醒' : '弱提醒'}</span>
      <span>${natureIcon(p.nature)} ${NATURE_LABEL[p.nature]}</span>
      <span>步骤 ${done}/${total}</span>
    </div>
    <div class="prog"><i style="width:${total ? Math.round(done / total * 100) : 0}%"></i></div>
    <div class="acts">
      ${rowActions(p.status).map((a) => `<button class="btn" data-follow="${a}" data-id="${esc(p.id)}">${FOLLOWUP_ACTION_LABEL[a]}</button>`).join('')}
      ${p.status === 'archived' ? `<button class="btn danger" data-del="${esc(p.id)}">删除</button>` : ''}
    </div>
  </div>`;
}

function renderEntries() {
  const box = document.getElementById('list-scroll');
  if (!box) return;
  const list = pursuits.length
    ? pursuits.map(entryHtml).join('')
    : '<div class="empty">这里还没有推进项。<br>去「随手记」写一条吧。</div>';
  box.innerHTML = list;
  bindFollowButtons(box);
  box.querySelectorAll<HTMLElement>('[data-open]').forEach((el) => {
    el.onclick = () => openDetail(el.dataset.open!);
  });
}

function bindFollowButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-follow]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      void mobileFollowup(b.dataset.id!, b.dataset.follow as FollowupAction,
        b.dataset.step ? { stepId: b.dataset.step } : {});
    };
  });
  root.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      if (!window.confirm('确定删除这条归档记录？删除后不可恢复。')) return;
      void api.deletePursuit(b.dataset.del!).then(() => {
        if (selectedId === b.dataset.del) selectedId = null;
        void refresh();
      }).catch((e) => toast(msgOf(e)));
    };
  });
}

async function loadList() {
  try {
    const list = await api.pursuits(listKind);
    pursuits = [...list.pursuits].sort((a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.importanceSort - b.importanceSort);
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
  const freq = p.recurrence?.freq ?? 'none';
  const rf = ruleFields(p.recurrence);
  host.innerHTML = `
  <div class="detail-wrap">
    <div class="detail-top"><button class="btn sm" id="back">‹ 返回</button><b>推进详情</b></div>
    <div class="detail-scroll">
      <h2 class="detail-title">${esc(p.text)}</h2>
      <div class="detail-meta">${esc(dueLabel(p))} · ${esc(staleLabel(p))} · ${NATURE_LABEL[p.nature]}</div>

      <div class="set-group">
        <h3>步骤清单</h3>
        ${p.steps.length ? p.steps.map((s) => `
          <div class="step ${s.state === 'done' ? 'done' : ''}">
            <input type="checkbox" data-step="${esc(s.id)}" ${s.state === 'done' ? 'checked' : ''} title="标记完成">
            <input class="step-text" data-step-text="${esc(s.id)}" value="${esc(s.text)}" aria-label="步骤文字">
            <button type="button" class="step-del" data-step-del="${esc(s.id)}" title="删除步骤" aria-label="删除步骤">×</button>
          </div>`).join('')
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
        <h3>提醒类型</h3>
        <div class="imp-row">
          <button class="btn ${p.strength === 'weak' ? 'solid' : ''}" data-strength="weak">弱提醒</button>
          <button class="btn ${p.strength === 'strong' ? 'solid' : ''}" data-strength="strong">强提醒</button>
        </div>
      </div>

      <div class="set-group">
        <h3>性质</h3>
        <div class="imp-row">
          ${(['one_off', 'project'] as const).map((n) =>
            `<button class="btn ${p.nature === n ? 'solid' : ''}" data-nature="${n}">${NATURE_LABEL[n]}</button>`).join('')}
        </div>
      </div>

      <div class="set-group">
        <h3>重复规则</h3>
        <select id="rule-freq" class="m-select">
          ${(Object.keys(FREQ_LABEL) as Array<keyof typeof FREQ_LABEL>).map((f) =>
            `<option value="${f}" ${freq === f ? 'selected' : ''}>${FREQ_LABEL[f]}</option>`).join('')}
        </select>
        ${fieldsFor(freq).includes('weekday')
          ? `<input class="input" id="rule-byday" value="${esc(rf.byWeekday)}" placeholder="周几，0=日，逗号分隔" style="margin-top:8px">` : ''}
        ${fieldsFor(freq).includes('month')
          ? `<input class="input" id="rule-bymonth" type="number" min="1" max="12" value="${esc(rf.byMonth)}" placeholder="月份 1-12" style="margin-top:8px">` : ''}
        ${fieldsFor(freq).includes('monthday')
          ? `<input class="input" id="rule-bymonthday" type="number" min="1" max="31" value="${esc(rf.byMonthday)}" placeholder="几号" style="margin-top:8px">` : ''}
        <button class="btn block" id="save-rule" style="margin-top:10px">保存重复</button>
      </div>

      <div class="set-group">
        <h3>跟进历史</h3>
        ${followups.length ? followups.map((f) => `
          <div class="set-val" style="padding:6px 0">${esc(new Date(f.at).toLocaleString('zh-CN'))} · ${f.level === 4 ? '强提醒' : '弱提醒'} · ${esc(FOLLOWUP_ACTION_LABEL[f.action] ?? f.action)}${f.note ? ` · ${esc(f.note)}` : ''}</div>`).join('')
          : '<div class="set-val">还没有跟进记录。</div>'}
      </div>

      <div class="set-group">
        ${(['done', 'later', 'smaller', 'archive', 'reopen'] as FollowupAction[])
          .filter((a) => actionsFor(p.status).includes(a))
          .map((a, i) => `<button class="btn block ${a === 'done' ? 'solid' : ''}" data-follow="${a}" data-id="${esc(p.id)}" ${a === 'done' ? `data-step="${esc(p.steps.find((s) => s.state !== 'done')?.id ?? '')}"` : ''} style="margin-top:${i ? 8 : 0}px">${FOLLOWUP_ACTION_LABEL[a]}</button>`).join('')}
        <button class="btn block" id="clone" data-id="${esc(p.id)}" style="margin-top:8px">克隆</button>
        ${p.status === 'archived' ? `<button class="btn block danger" data-del="${esc(p.id)}" style="margin-top:8px">删除</button>` : ''}
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
  host.querySelectorAll<HTMLInputElement>('[data-step-text]').forEach((input) => {
    input.onchange = () => {
      const text = input.value.trim();
      if (!text) { renderDetail(); return; }
      void api.updateStep(input.dataset.stepText!, { text }).then(r => {
        const i = pursuits.findIndex((x) => x.id === p.id);
        if (i >= 0) pursuits[i] = r.pursuit;
        renderDetail();
      }).catch((e) => toast(msgOf(e)));
    };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); } };
  });
  host.querySelectorAll<HTMLElement>('[data-step-del]').forEach((btn) => {
    btn.onclick = () => {
      void api.deleteStep(btn.dataset.stepDel!).then(() => {
        const i = pursuits.findIndex((x) => x.id === p.id);
        if (i >= 0) pursuits[i].steps = pursuits[i].steps.filter((s) => s.id !== btn.dataset.stepDel);
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
  host.querySelectorAll<HTMLElement>('[data-strength]').forEach((b) => {
    b.onclick = () => void patchPursuit(p, { strength: b.dataset.strength });
  });
  host.querySelectorAll<HTMLElement>('[data-nature]').forEach((b) => {
    b.onclick = () => void patchPursuit(p, { nature: b.dataset.nature });
  });
  const freqSel = host.querySelector<HTMLSelectElement>('#rule-freq');
  const paintRuleFields = () => {
    const f = freqSel!.value as Freq;
    const current = {
      byWeekday: host.querySelector<HTMLInputElement>('#rule-byday')?.value ?? rf.byWeekday,
      byMonthday: host.querySelector<HTMLInputElement>('#rule-bymonthday')?.value ?? rf.byMonthday,
      byMonth: host.querySelector<HTMLInputElement>('#rule-bymonth')?.value ?? rf.byMonth,
    };
    host.querySelector('#rule-byday')?.remove();
    host.querySelector('#rule-bymonth')?.remove();
    host.querySelector('#rule-bymonthday')?.remove();
    const before = host.querySelector('#save-rule')!;
    const insert = (html: string) => before.insertAdjacentHTML('beforebegin', html);
    if (fieldsFor(f).includes('weekday')) insert(`<input class="input" id="rule-byday" value="${esc(current.byWeekday)}" placeholder="周几，0=日，逗号分隔" style="margin-top:8px">`);
    if (fieldsFor(f).includes('month')) insert(`<input class="input" id="rule-bymonth" type="number" min="1" max="12" value="${esc(current.byMonth)}" placeholder="月份 1-12" style="margin-top:8px">`);
    if (fieldsFor(f).includes('monthday')) insert(`<input class="input" id="rule-bymonthday" type="number" min="1" max="31" value="${esc(current.byMonthday)}" placeholder="几号" style="margin-top:8px">`);
  };
  freqSel?.addEventListener('change', paintRuleFields);
  host.querySelector('#save-rule')!.addEventListener('click', () => {
    const val = (sel: string) => host.querySelector<HTMLInputElement>(sel)?.value?.trim() ?? '';
    const fields = {
      byWeekday: val('#rule-byday'), byMonthday: val('#rule-bymonthday'), byMonth: val('#rule-bymonth'),
    };
    void patchPursuit(p, { recurrence: buildRecurrence(freqSel!.value as Freq, fields) });
  });
  host.querySelector('#clone')!.addEventListener('click', () => void mobileClone(p.id));
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
  if (!actionsFor(p.status).includes(action)) {
    toast('当前状态不允许这个操作');
    return;
  }
  if (action === 'smaller' && !extra.stepEdits) {
    const initial: StepEdit[] = p.steps.length
      ? p.steps.map((s) => ({ id: s.id, text: s.text }))
      : [{ text: p.text }];
    const edits = await openStepsDialog(initial);
    if (!edits) return;
    extra.stepEdits = edits;
  }
  if (action === 'later' && !extra.to) {
    const at = await new Promise<number | null>((resolve) => {
      openSnoozeDialog({
        title: `延期「${p.text.slice(0, 20)}」`, now: serverNow(),
        onPick: resolve, onCustom: () => resolve(null),
      });
    });
    if (at === null) return;
    extra.to = at;
  }
  try {
    localHandled.set(id, Date.now());
    // 跟进只有 HTTP 一条写入路径；WS 再发一次会用同一个 version 触发乐观锁冲突
    await api.followup(id, {
      action, version: versionOf(p),
      ...(Array.isArray(extra.steps) ? { steps: extra.steps as string[] } : {}),
      ...(Array.isArray(extra.stepEdits) ? { stepEdits: extra.stepEdits as StepEdit[] } : {}),
      ...(extra.to ? { to: Number(extra.to) } : {}),
      ...(extra.stepId ? { stepId: String(extra.stepId) } : {}),
    });
    noteFollowup(id, action, levelForStrength(p.strength));
    control.acknowledge(action);
    toast(action === 'done' ? '已完成' : action === 'archive' ? '已归档' : '已记下');
    if (view === 'detail') setView('today');
    void refresh();
  } catch (e) {
    toast('操作失败：' + msgOf(e));
  }
}

async function mobileClone(id: string) {
  try {
    await api.clone(id);
    toast('已克隆，步骤状态已重置、截止已清空');
    if (view === 'detail') setView('today');
    void refresh();
  } catch (e) {
    toast('克隆失败：' + msgOf(e));
  }
}

function showMobileTakeover(p: Pursuit, total: number) {
  document.getElementById('m-takeover')?.remove();
  const host = document.createElement('div');
  host.id = 'm-takeover';
  host.className = 'm-takeover';
  const next = p.steps.find((s) => s.state !== 'done');
  host.innerHTML = `
    <div class="mt-card">
      <div class="mt-lv">强提醒 · ${total > 1 ? `1/${total} 条，逐条处理` : '关不掉'}</div>
      <h2>${esc(p.text)}</h2>
      <div class="mt-reason">到点了：${esc(p.text)}</div>
      <div class="acts">
        <button class="btn solid" data-follow="done" data-id="${esc(p.id)}" data-step="${esc(next?.id ?? '')}">完成</button>
        <button class="btn" data-follow="smaller" data-id="${esc(p.id)}">拆小</button>
        <button class="btn" data-follow="later" data-id="${esc(p.id)}">延期</button>
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
      <div class="set-field"><label>逾期多少天自动归档</label><input id="pf-archive-days" type="number" min="1" value="${s.archiveAfterDays}"></div>
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
      <h3>关于 / 更新</h3>
      <div class="set-row"><div><div class="lbl">项目信息、版本与更新</div><div class="sub">查看简介，检查并安装最新版</div></div></div>
      <button class="btn block" id="open-about" style="margin-top:8px">打开关于</button>
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
    const patch: Partial<Settings> = {
      archiveAfterDays: Math.max(1, Number(tf('pf-archive-days').value)),
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
  document.getElementById('theme')!.onchange = (ev) => {
    saveTheme((ev.target as HTMLSelectElement).value as 'dark' | 'morandi');
  };
  document.getElementById('open-about')!.onclick = () => openAbout();
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
      void refresh();
      break;
    case 'pursuit.followed':
      noteFollowup(msg.pursuit.id, msg.action, levelForStrength(msg.pursuit.strength));
      control.dismissedElsewhere(msg.pursuit.id);
      void refresh();
      break;
    case 'pursuit.deleted':
      void refresh();
      break;
    case 'pursuit.focused':
      focus = { serverTs: serverNow(), items: msg.items };
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
      <button type="button" class="btn block" id="about-link" style="margin-top:12px;min-height:38px;font-size:13px">关于 / 检查更新</button>
    </div>
  </div>`;

  const err = document.getElementById('err')!;
  const base = document.getElementById('base') as HTMLInputElement;
  const probeEl = document.getElementById('probe')!;
  document.getElementById('to-login')?.addEventListener('click', () => renderAuth(false));
  document.getElementById('about-link')!.onclick = () => openAbout();

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
  initUpdater(platform, toast);
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
