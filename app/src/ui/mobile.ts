/**
 * Android 端 M3 界面：默认首页「今日」+ 4 Tab 导航（今日 / 待办 / 看板 / 设置）+ 全局 FAB 随手记 Sheet。
 */
import { invoke } from '@tauri-apps/api/core';
import { initUpdater, openAbout } from '../about';
import {
  ApiError, Realtime, api, clearToken, dayLabel, dueLabel, getMachineId, getPlatform,
  hhmm, lateBy, loadConfig, normalizeBaseUrl, noteFollowup, onUnauthorized, parseInput, probeServer, saveConfig,
  serverNow, staleLabel, switchServer, versionOf, warmthOf,
  FREQ_LABEL, FOLLOWUP_ACTION_LABEL, levelForStrength, rowActions,
  type ClientPlatform, type Followup, type FollowupAction, type MyStats,
  type Pursuit, type PursuitStatus, type ReminderStrength,
  type ServerMessage, type Settings, type StepEdit, type StepState,
} from '../api';
import { actionsFor } from '../../../shared/types';
import { buildRecurrence, fieldsFor, ruleFields, type Freq } from './recurrence-form';
import { FollowupController } from '../alarm';
import { ICO } from '../icons';
import { applyTheme, loadTheme, saveTheme, THEMES } from '../theme';
import { openConfirmDialog, openDateTimePicker, openSnoozeDialog, openStepsDialog } from '../widgets';
import '../styles-mobile.css';

const app = document.getElementById('app')!;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

type Tab = 'today' | 'todo' | 'stats' | 'settings';
type View = Tab | 'detail';
type TodoFilter = 'todo' | 'done' | 'archived';

let platform: ClientPlatform = 'android';
let view: View = 'today';
let lastTab: Tab = 'today';
let todoFilter: TodoFilter = 'todo';
let rt: Realtime | null = null;
let pursuits: Pursuit[] = [];
let followups: Followup[] = [];
let todayCount = 0;
let selectedId: string | null = null;
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
    // 系统通知由原生保活服务发出，WebView 只做前台轻提示避免重复
    toast(`${p.text} · ${reason}${attempt > 1 ? ` · 第 ${attempt} 次` : ''}`);
  },
  onTakeover: (p) => {
    const idx = mobileTakeoverQueue.findIndex((x) => x.id === p.id);
    if (idx >= 0) mobileTakeoverQueue[idx] = p;
    else mobileTakeoverQueue.push(p);
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
  void invoke('ping', { title, body }).catch(() => {});
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

/* ------------------------------------------------------------ 骨架 */

const TAB_TITLE: Record<Tab, string> = {
  today: '今日待办',
  todo: '全部待办',
  stats: '推进看板',
  settings: '设置',
};

function shell(): string {
  const curTheme = loadTheme();
  return `
  <header class="m-top" id="m-top">
    <span class="logo"></span>
    <b id="m-title">今日待办</b>
    <span class="sp"></span>
    <button type="button" class="m-conn" id="conn" aria-label="连接状态与服务端"><span class="dot"></span><span id="conn-txt">未连接</span></button>
    <button type="button" class="btn icon-btn" id="m-theme" aria-label="切换主题">${curTheme === 'dark' ? ICO.sun(20) : ICO.moon(20)}</button>
  </header>
  <section class="m-view" id="v-today"></section>
  <section class="m-view" id="v-todo"></section>
  <section class="m-view" id="v-stats"></section>
  <section class="m-view" id="v-settings"></section>
  <section class="m-view" id="v-detail"></section>
  <button type="button" class="m-fab" id="m-fab" aria-label="快速记一条">${ICO.add(24)}</button>
  <nav class="m-nav" id="m-nav">
    <button type="button" data-tab="today" class="on">
      <span class="nav-pill">${ICO.today(22)}<span class="nav-badge" id="b-today" hidden></span></span>
      <span>今日</span>
    </button>
    <button type="button" data-tab="todo">
      <span class="nav-pill">${ICO.todo(22)}</span>
      <span>待办</span>
    </button>
    <button type="button" data-tab="stats">
      <span class="nav-pill">${ICO.stats(22)}</span>
      <span>看板</span>
    </button>
    <button type="button" data-tab="settings">
      <span class="nav-pill">${ICO.settings(22)}</span>
      <span>设置</span>
    </button>
  </nav>`;
}

function setView(v: View) {
  view = v;
  if (v !== 'detail') lastTab = v;
  const isDetail = v === 'detail';

  document.getElementById('m-top')!.hidden = isDetail;
  document.getElementById('m-nav')!.hidden = isDetail;
  document.getElementById('m-fab')!.hidden = isDetail || v === 'settings';

  if (!isDetail) {
    document.getElementById('m-title')!.textContent = TAB_TITLE[v];
    document.querySelectorAll<HTMLElement>('#m-nav [data-tab]').forEach((b) => {
      b.classList.toggle('on', b.dataset.tab === v);
    });
  }

  document.querySelectorAll<HTMLElement>('.m-view').forEach((el) => el.classList.remove('on'));
  document.getElementById(`v-${v}`)?.classList.add('on');

  if (v === 'today') { renderTodayShell(); void loadList('today'); }
  if (v === 'todo') { renderTodoShell(); void loadList(todoFilter); }
  if (v === 'stats') void renderMobileStats();
  if (v === 'settings') renderSettings();
  if (v === 'detail') renderDetail();
}

function setConn(state: 'connecting' | 'open' | 'closed') {
  const el = document.getElementById('conn');
  const txt = document.getElementById('conn-txt');
  if (!el || !txt) return;
  el.className = `m-conn ${state}`;
  txt.textContent = state === 'open' ? '已连接' : state === 'connecting' ? '连接中' : '已断开';
}

/* ------------------------------------------------------------ 全局 FAB 随手记 Bottom Sheet */

function openCaptureSheet() {
  let strength: ReminderStrength = 'weak';
  const mask = document.createElement('div');
  mask.className = 'md-mask sheet-mode';
  const dlg = document.createElement('div');
  dlg.className = 'md-dialog';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.innerHTML = `
    <div class="md-drag-bar"></div>
    <div class="md-dialog-head">
      <h3>快速记一条</h3>
      <button type="button" class="wd-btn icon" id="cap-close" aria-label="关闭">${ICO.close(18)}</button>
    </div>
    <div class="md-dialog-body">
      <textarea class="input" id="cap-in" rows="3" placeholder="例如：明天 15:00 交周报&#10;例如：半小时后喝水" autocomplete="off"></textarea>
      <div class="cap-chips" id="cap-quick">
        <button type="button" class="cap-chip" data-append="1小时后 ">+1 小时</button>
        <button type="button" class="cap-chip" data-append="今天18:00 ">今晚 18:00</button>
        <button type="button" class="cap-chip" data-append="明天9:00 ">明早 9:00</button>
      </div>
      <div class="cap-chips" id="cap-parse"></div>
      <div style="margin-top:14px">
        <div class="seg" id="cap-seg">
          <button type="button" class="on" data-strength="weak">弱提醒（通知）</button>
          <button type="button" data-strength="strong">${ICO.bolt(14)}强提醒（弹窗）</button>
        </div>
      </div>
    </div>
    <div class="md-dialog-foot">
      <button type="button" class="wd-btn filled" id="cap-save" style="width:100%">记下来</button>
    </div>`;
  mask.appendChild(dlg);
  document.body.appendChild(mask);

  const input = dlg.querySelector<HTMLTextAreaElement>('#cap-in')!;
  const parseEl = dlg.querySelector<HTMLElement>('#cap-parse')!;
  const close = () => mask.remove();

  const renderPreview = () => {
    const v = input.value.trim();
    if (!v) {
      parseEl.innerHTML = `<span class="set-val">未填时间：${strength === 'strong' ? '强提醒默认 2 小时后' : '弱提醒默认 1 天后'}</span>`;
      return;
    }
    const p = parseInput(v);
    parseEl.innerHTML = `
      <span class="cap-chip ${p.kind === 'text' ? '' : 'hot'}">${esc(p.kindLabel)}</span>
      <span class="cap-chip ${p.remindAt !== null ? 'hot' : ''}">${esc(p.remindAt !== null ? `截止：${p.timeLabel}` : '未填时间 · 使用默认截止')}</span>`;
  };

  input.addEventListener('input', renderPreview);
  dlg.querySelector('#cap-quick')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-append]');
    if (!b) return;
    input.value = `${b.dataset.append!}${input.value.replace(/^(1小时后 |今天18:00 |明天9:00 )/, '')}`;
    renderPreview();
    input.focus();
  });
  dlg.querySelector('#cap-seg')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-strength]');
    if (!b) return;
    strength = b.dataset.strength as ReminderStrength;
    dlg.querySelectorAll<HTMLElement>('#cap-seg [data-strength]').forEach((x) => {
      const on = x.dataset.strength === strength;
      x.classList.toggle('on', on);
      x.classList.toggle('hot', on && strength === 'strong');
    });
    renderPreview();
  });
  dlg.querySelector('#cap-close')!.addEventListener('click', close);
  mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(); });

  dlg.querySelector('#cap-save')!.addEventListener('click', async () => {
    const text = input.value.trim();
    if (!text) { toast('先写点什么'); return; }
    const p = parseInput(text);
    try {
      await api.create({
        text, kind: p.kind,
        url: p.kind === 'link' ? text : null,
        path: p.kind === 'path' ? text : null,
        dueAt: p.remindAt,
        strength,
      });
      close();
      toast(p.remindAt !== null ? '已记下并设好截止' : '已存进待办');
      void refresh();
    } catch (e) {
      toast('保存失败：' + msgOf(e));
    }
  });

  renderPreview();
  setTimeout(() => input.focus(), 60);
}

/* ------------------------------------------------------------ 列表（今日 / 全部待办） */

function renderTodayShell() {
  const host = document.getElementById('v-today')!;
  if (!host.querySelector('#today-scroll')) {
    host.innerHTML = '<div class="list-scroll" id="today-scroll"></div>';
  }
}

function renderTodoShell() {
  const host = document.getElementById('v-todo')!;
  host.innerHTML = `
  <div class="chip-bar">
    <button type="button" class="f-chip ${todoFilter === 'todo' ? 'on' : ''}" data-filter="todo">未完成</button>
    <button type="button" class="f-chip ${todoFilter === 'done' ? 'on' : ''}" data-filter="done">已完成</button>
    <button type="button" class="f-chip ${todoFilter === 'archived' ? 'on' : ''}" data-filter="archived">已归档</button>
  </div>
  <div class="list-scroll" id="todo-scroll"></div>`;
  host.querySelectorAll<HTMLElement>('[data-filter]').forEach((b) => {
    b.onclick = () => {
      todoFilter = b.dataset.filter as TodoFilter;
      renderTodoShell();
      void loadList(todoFilter);
    };
  });
}

function entryHtml(p: Pursuit): string {
  const u = warmthOf(p);
  const total = p.steps.length;
  const done = p.steps.filter((s) => s.state === 'done').length;
  const isDone = p.status === 'done';
  const isArchived = p.status === 'archived';
  const actions = rowActions(p.status);

  return `
  <article class="entry u-${u}${isDone ? ' done' : ''}" data-open="${esc(p.id)}">
    <div class="entry-top">
      ${u === 'none' ? '' : `<i class="udot ${u}"></i>`}
      <span>${esc(dueLabel(p))} · ${esc(staleLabel(p))}</span>
      ${p.strength === 'strong' ? `<span class="str-badge">${ICO.bolt(11)}强提醒</span>` : ''}
      ${total ? `<span class="step-pill">${done}/${total}</span>` : ''}
    </div>
    <div class="txt">${esc(p.text)}</div>
    ${total ? `<div class="prog"><i style="width:${Math.round((done / total) * 100)}%"></i></div>` : ''}
    <div class="acts">
      ${actions.map((a) => `<button type="button" class="btn ${a === 'done' ? 'tonal' : a === 'archive' ? 'danger' : 'ghost'}" data-follow="${a}" data-id="${esc(p.id)}">${FOLLOWUP_ACTION_LABEL[a]}</button>`).join('')}
      ${!isDone && !isArchived ? `
        <button type="button" class="btn ghost" data-follow="later" data-id="${esc(p.id)}">延期</button>
        <button type="button" class="btn ghost" data-follow="smaller" data-id="${esc(p.id)}">拆小</button>` : ''}
      ${isArchived ? `<button type="button" class="btn danger" data-del="${esc(p.id)}">删除</button>` : ''}
    </div>
  </article>`;
}

function groupMobile(list: Pursuit[], kind: 'today' | TodoFilter): Array<{ title: string; hot?: boolean; items: Pursuit[] }> {
  if (kind === 'done' || kind === 'archived') return [{ title: '', items: list }];
  const now = serverNow();
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  const over = list.filter((p) => p.dueAt !== null && p.dueAt <= now);
  const today = list.filter((p) => p.dueAt !== null && p.dueAt > now && p.dueAt <= endToday.getTime());
  const later = list.filter((p) => p.dueAt === null || p.dueAt > endToday.getTime());
  const out: Array<{ title: string; hot?: boolean; items: Pursuit[] }> = [];
  if (over.length) out.push({ title: `已逾期 · ${over.length}`, hot: true, items: over });
  if (today.length) out.push({ title: `今天到期 · ${today.length}`, items: today });
  if (later.length) out.push({ title: `后续或未设截止 · ${later.length}`, items: later });
  return out;
}

function renderEntries(kind: 'today' | TodoFilter) {
  const box = document.getElementById(kind === 'today' ? 'today-scroll' : 'todo-scroll');
  if (!box) return;
  if (!pursuits.length) {
    const emptyText = kind === 'today'
      ? ['今天没有待办', '点右下角 + 号随手记一条吧。']
      : kind === 'done'
        ? ['还没有已完成项', '推完的事项会沉淀在这里。']
        : kind === 'archived'
          ? ['归档是空的', '已结束或超期自动归档的记录在这里。']
          : ['待办是空的', '点右下角 + 号写下第一件要推进的事。'];
    box.innerHTML = `<div class="empty"><div class="empty-ico">${ICO.today(24)}</div><b>${emptyText[0]}</b><div>${emptyText[1]}</div></div>`;
    return;
  }
  const groups = groupMobile(pursuits, kind);
  box.innerHTML = groups.map((g) => `
    ${g.title ? `<div class="m-group${g.hot ? ' hot' : ''}"><span>${g.title}</span><span class="line"></span></div>` : ''}
    ${g.items.map(entryHtml).join('')}`).join('');

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
  root.querySelectorAll<HTMLElement>('[data-del]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const ok = await openConfirmDialog({
        title: '删除这条归档记录？',
        detail: '删除后不可恢复。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      void api.deletePursuit(b.dataset.del!).then(() => {
        if (selectedId === b.dataset.del) { selectedId = null; if (view === 'detail') setView(lastTab); }
        toast('已删除');
        void refresh();
      }).catch((e) => toast(msgOf(e)));
    };
  });
}

async function loadList(kind: 'today' | TodoFilter) {
  try {
    const list = await api.pursuits(kind);
    pursuits = [...list.pursuits].sort((a, b) =>
      (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.importanceSort - b.importanceSort);
    renderEntries(kind);
  } catch {
    toast('加载失败，请检查服务端连接');
  }
}

/* ------------------------------------------------------------ 移动端个人看板 */

async function renderMobileStats() {
  const host = document.getElementById('v-stats')!;
  host.innerHTML = '<div class="m-stats"><div class="empty">读取推进数据中…</div></div>';
  try {
    const s: MyStats = await api.myStats();
    const max = Math.max(1, ...s.days.map((d) => Math.max(d.focus, d.done, d.pending)));
    host.innerHTML = `
      <div class="m-stats">
        <div class="m-stat-hero">
          <div><span class="big">${s.streakDays}</span><span class="unit">天连续推进</span></div>
          <div><span class="big">${s.completedThisWeek}</span><span class="unit">本周完成</span></div>
          <div><span class="big">${s.completedTotal}</span><span class="unit">累计完成</span></div>
        </div>
        <div class="m-stat-grid">
          <div class="m-stat-card"><span>今日待办</span><b>${s.today.focus}</b></div>
          <div class="m-stat-card ok"><span>今日完成</span><b>${s.today.done}</b></div>
          <div class="m-stat-card warn"><span>待跟进</span><b>${s.today.pendingFollowup}</b></div>
        </div>
        <div class="m-stat-title">最近 7 天</div>
        <div class="m-bars">
          ${s.days.map((d) => `
            <div class="m-bar-col">
              <div class="m-bar-track">
                <i class="m-bar-done" style="height:${Math.round((d.done / max) * 100)}%"></i>
                <i class="m-bar-miss" style="height:${Math.round((d.pending / max) * 100)}%"></i>
              </div>
              <span>${esc(d.day.slice(5))}</span>
            </div>`).join('')}
        </div>
      </div>`;
  } catch (e) {
    host.innerHTML = `<div class="m-stats"><div class="empty">加载失败：${esc(msgOf(e))}</div></div>`;
  }
}

/* ------------------------------------------------------------ 详情页（补齐标题/截止编辑） */

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
  }).catch(() => {});
}

function selectedWeekdays(raw: string): Set<number> {
  const set = new Set<number>();
  for (const part of raw.split(/[,，\s]+/)) {
    if (!part) continue;
    const n = Number(part);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return set;
}

function renderDetail() {
  const host = document.getElementById('v-detail');
  const p = findPursuit(selectedId);
  if (!host) return;
  if (!p) {
    host.innerHTML = `<div class="detail-wrap">
      <div class="detail-top"><button type="button" class="btn icon-btn" id="back">${ICO.back(22)}</button><b>推进详情</b></div>
      <div class="empty">这条已经不在了。</div></div>`;
    host.querySelector('#back')!.addEventListener('click', () => setView(lastTab));
    return;
  }

  const freq = p.recurrence?.freq ?? 'none';
  const rf = ruleFields(p.recurrence);
  const pickedDays = selectedWeekdays(rf.byWeekday);
  const dueText = p.dueAt === null ? '未设截止' : `${dayLabel(p.dueAt)} ${hhmm(p.dueAt)}`;

  host.innerHTML = `
  <div class="detail-wrap">
    <div class="detail-top">
      <button type="button" class="btn icon-btn" id="back" aria-label="返回">${ICO.back(22)}</button>
      <b>推进详情</b>
      <button type="button" class="btn sm tonal" id="clone" data-id="${esc(p.id)}">${ICO.clone(15)}克隆</button>
    </div>
    <div class="detail-scroll">
      <div class="set-group">
        <h3>事项内容</h3>
        <textarea class="input" id="d-text" rows="2">${esc(p.text)}</textarea>
        <div class="detail-meta">${esc(dueLabel(p))} · ${esc(staleLabel(p))}</div>
      </div>

      <div class="set-group">
        <h3>提醒类型与截止</h3>
        <div class="seg" style="margin-bottom:12px">
          <button type="button" class="${p.strength === 'weak' ? 'on' : ''}" data-strength="weak">弱提醒</button>
          <button type="button" class="${p.strength === 'strong' ? 'on hot' : ''}" data-strength="strong">${ICO.bolt(14)}强提醒</button>
        </div>
        <div class="due-row">
          <button type="button" class="due-btn" id="d-due">
            <span class="mono">${esc(dueText)}</span>
            <span class="set-val">修改</span>
          </button>
          ${p.dueAt !== null ? `<button type="button" class="btn icon-btn ghost" id="d-due-clear" aria-label="清除截止">${ICO.close(16)}</button>` : ''}
        </div>
      </div>

      <div class="set-group">
        <h3>步骤清单</h3>
        ${p.steps.length ? p.steps.map((s) => `
          <div class="step ${s.state === 'done' ? 'done' : ''}">
            <label class="step-chk-wrap"><input type="checkbox" data-step="${esc(s.id)}" ${s.state === 'done' ? 'checked' : ''}></label>
            <input class="step-text" data-step-text="${esc(s.id)}" value="${esc(s.text)}" aria-label="步骤文字">
            <button type="button" class="step-del" data-step-del="${esc(s.id)}" aria-label="删除步骤">${ICO.close(16)}</button>
          </div>`).join('')
          : '<div class="set-val">还没有步骤，拆小后更容易迈出第一步。</div>'}
        <div class="add-step">
          <input class="input" id="new-step" placeholder="加一个步骤">
          <button type="button" class="btn tonal" id="add-step">添加</button>
        </div>
      </div>

      <div class="set-group">
        <h3>备注</h3>
        <textarea class="input" id="note" rows="3" placeholder="补充上下文或线索">${esc(p.note ?? '')}</textarea>
        <button type="button" class="btn tonal block" id="save-note" style="margin-top:10px">保存备注</button>
      </div>

      <div class="set-group">
        <h3>重复规则</h3>
        <select id="rule-freq" class="m-select">
          ${(Object.keys(FREQ_LABEL) as Array<keyof typeof FREQ_LABEL>).map((f) =>
            `<option value="${f}" ${freq === f ? 'selected' : ''}>${FREQ_LABEL[f]}</option>`).join('')}
        </select>
        <div id="m-rule-extra">
          ${fieldsFor(freq).includes('weekday') ? `
            <div class="wd-chips" id="m-wd-chips">
              ${WEEKDAYS.map((w, i) => `<button type="button" class="wd-chip${pickedDays.has(i) ? ' on' : ''}" data-wd="${i}">周${w}</button>`).join('')}
            </div>
            <input type="hidden" id="rule-byday" value="${esc(rf.byWeekday)}">` : ''}
          ${fieldsFor(freq).includes('month') ? `<input class="input" id="rule-bymonth" type="number" min="1" max="12" value="${esc(rf.byMonth)}" placeholder="月份 1-12" style="margin-top:8px">` : ''}
          ${fieldsFor(freq).includes('monthday') ? `<input class="input" id="rule-bymonthday" type="number" min="1" max="31" value="${esc(rf.byMonthday)}" placeholder="几号 (1-31)" style="margin-top:8px">` : ''}
        </div>
        <button type="button" class="btn tonal block" id="save-rule" style="margin-top:10px">保存重复规则</button>
      </div>

      <div class="set-group">
        <h3>跟进历史</h3>
        ${followups.length ? followups.map((f) => `
          <div class="set-val" style="padding:6px 0">${esc(new Date(f.at).toLocaleString('zh-CN'))} · ${f.level === 4 ? '强提醒' : '弱提醒'} · ${esc(FOLLOWUP_ACTION_LABEL[f.action] ?? f.action)}${f.note ? ` · ${esc(f.note)}` : ''}</div>`).join('')
          : '<div class="set-val">还没有跟进记录。</div>'}
      </div>

      <div class="set-group detail-acts">
        ${actionsFor(p.status).includes('done')
          ? `<button type="button" class="btn solid block" data-follow="done" data-id="${esc(p.id)}">${ICO.check(17)}完成</button>`
          : ''}
        <div class="detail-acts-grid">
          ${(['later', 'smaller', 'reopen', 'archive'] as FollowupAction[])
            .filter((a) => actionsFor(p.status).includes(a))
            .map((a) => `<button type="button" class="btn ${a === 'archive' ? 'danger' : 'tonal'}" data-follow="${a}" data-id="${esc(p.id)}">${FOLLOWUP_ACTION_LABEL[a]}</button>`).join('')}
          ${p.status === 'archived' ? `<button type="button" class="btn danger" data-del="${esc(p.id)}">永久删除</button>` : ''}
        </div>
      </div>
    </div>
  </div>`;

  host.querySelector('#back')!.addEventListener('click', () => setView(lastTab));
  bindFollowButtons(host);

  const titleEl = host.querySelector<HTMLTextAreaElement>('#d-text')!;
  titleEl.addEventListener('change', () => {
    const val = titleEl.value.trim();
    if (!val || val === p.text) return;
    void patchPursuit(p, { text: val });
  });

  host.querySelector('#d-due')!.addEventListener('click', () => {
    openDateTimePicker({
      initial: p.dueAt,
      now: serverNow(),
      modal: true,
      title: '修改截止时间',
      onPick: (at) => void patchPursuit(p, { dueAt: at }),
    });
  });
  host.querySelector('#d-due-clear')?.addEventListener('click', () => void patchPursuit(p, { dueAt: null }));

  host.querySelectorAll<HTMLInputElement>('[data-step]').forEach((box) => {
    box.onchange = () => {
      const stateName: StepState = box.checked ? 'done' : 'todo';
      void api.updateStep(box.dataset.step!, { state: stateName }).then((r) => {
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
      void api.updateStep(input.dataset.stepText!, { text }).then((r) => {
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

  const bindWeekdayChips = () => {
    host.querySelector('#m-wd-chips')?.addEventListener('click', (ev) => {
      const chip = (ev.target as HTMLElement).closest<HTMLElement>('[data-wd]');
      if (!chip) return;
      chip.classList.toggle('on');
      const days = [...host.querySelectorAll<HTMLElement>('#m-wd-chips .wd-chip.on')]
        .map((c) => c.dataset.wd!).join(',');
      const hidden = host.querySelector<HTMLInputElement>('#rule-byday');
      if (hidden) hidden.value = days;
    });
  };
  bindWeekdayChips();

  const freqSel = host.querySelector<HTMLSelectElement>('#rule-freq')!;
  freqSel.addEventListener('change', () => {
    const f = freqSel.value as Freq;
    const extra = host.querySelector<HTMLElement>('#m-rule-extra')!;
    const current = {
      byWeekday: host.querySelector<HTMLInputElement>('#rule-byday')?.value ?? rf.byWeekday,
      byMonthday: host.querySelector<HTMLInputElement>('#rule-bymonthday')?.value ?? rf.byMonthday,
      byMonth: host.querySelector<HTMLInputElement>('#rule-bymonth')?.value ?? rf.byMonth,
    };
    const days = selectedWeekdays(current.byWeekday);
    extra.innerHTML = `
      ${fieldsFor(f).includes('weekday') ? `
        <div class="wd-chips" id="m-wd-chips">
          ${WEEKDAYS.map((w, i) => `<button type="button" class="wd-chip${days.has(i) ? ' on' : ''}" data-wd="${i}">周${w}</button>`).join('')}
        </div>
        <input type="hidden" id="rule-byday" value="${esc(current.byWeekday)}">` : ''}
      ${fieldsFor(f).includes('month') ? `<input class="input" id="rule-bymonth" type="number" min="1" max="12" value="${esc(current.byMonth)}" placeholder="月份 1-12" style="margin-top:8px">` : ''}
      ${fieldsFor(f).includes('monthday') ? `<input class="input" id="rule-bymonthday" type="number" min="1" max="31" value="${esc(current.byMonthday)}" placeholder="几号 (1-31)" style="margin-top:8px">` : ''}`;
    bindWeekdayChips();
  });

  host.querySelector('#save-rule')!.addEventListener('click', () => {
    const val = (sel: string) => host.querySelector<HTMLInputElement>(sel)?.value?.trim() ?? '';
    const fields = {
      byWeekday: val('#rule-byday'), byMonthday: val('#rule-bymonthday'), byMonth: val('#rule-bymonth'),
    };
    void patchPursuit(p, { recurrence: buildRecurrence(freqSel.value as Freq, fields) });
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
  const scrollTop = document.querySelector<HTMLElement>('.detail-scroll')?.scrollTop ?? 0;
  try {
    const r = await api.update(p.id, { ...patch, version: versionOf(p) });
    const i = pursuits.findIndex((x) => x.id === p.id);
    if (i >= 0) pursuits[i] = r.pursuit;
    toast('已保存');
    renderDetail();
    const scroller = document.querySelector<HTMLElement>('.detail-scroll');
    if (scroller) scroller.scrollTop = scrollTop;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast('刚在别的设备上改过，已刷新');
    else toast(msgOf(e));
  }
}

/* -------------------------------------------------------- 跟进动作与全屏强提醒 */

async function mobileFollowup(id: string, action: FollowupAction, extra: Record<string, unknown> = {}) {
  const p = findPursuit(id) ?? mobileTakeoverQueue.find((x) => x.id === id);
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
        title: `延期「${p.text.slice(0, 18)}」`,
        now: serverNow(),
        onPick: resolve,
        onCustom: () => {
          openDateTimePicker({
            initial: p.dueAt ?? serverNow() + 3600_000,
            now: serverNow(),
            modal: true,
            title: '选择延期后的截止时间',
            onPick: resolve,
          });
        },
      });
    });
    if (at === null) return;
    extra.to = at;
  }
  try {
    localHandled.set(id, Date.now());
    await api.followup(id, {
      action, version: versionOf(p),
      ...(Array.isArray(extra.steps) ? { steps: extra.steps as string[] } : {}),
      ...(Array.isArray(extra.stepEdits) ? { stepEdits: extra.stepEdits as StepEdit[] } : {}),
      ...(extra.to ? { to: Number(extra.to) } : {}),
    });
    noteFollowup(id, action, levelForStrength(p.strength));
    control.acknowledge(action);
    toast(action === 'done' ? '已完成' : action === 'archive' ? '已归档' : '已记下');
    if (view === 'detail') setView(lastTab);
    void refresh();
  } catch (e) {
    toast('操作失败：' + msgOf(e));
  }
}

async function mobileClone(id: string) {
  try {
    await api.clone(id);
    toast('已克隆，步骤已重置、截止已清空');
    if (view === 'detail') setView(lastTab);
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
  const at = p.dueAt ?? serverNow();
  const overdueHint = p.dueAt !== null && p.dueAt < serverNow() ? `已逾期 ${lateBy(p.dueAt)} · ` : '';
  host.innerHTML = `
    <div class="mt-warn">
      <span>${ICO.alert(18)} 强提醒到点</span>
      <span>${total > 1 ? `1 / ${total} 条，逐条处理` : '必须处理'}</span>
    </div>
    <div class="mt-body">
      <div class="mt-clock">${hhmm(at)}</div>
      <h2>${esc(p.text)}</h2>
      <div class="mt-reason">${esc(overdueHint + (p.note || '到点了，先给这件事一个明确去向'))}</div>
      ${next ? `<div class="mt-step"><small>未完成步骤</small><b>${esc(next.text)}</b></div>` : ''}
    </div>
    <div class="mt-foot">
      <button type="button" class="btn solid block" data-follow="done" data-id="${esc(p.id)}">${ICO.check(18)}完成</button>
      <div class="mt-foot-row">
        <button type="button" class="btn tonal" data-follow="smaller" data-id="${esc(p.id)}">${ICO.split(16)}拆小</button>
        <button type="button" class="btn tonal" data-follow="later" data-id="${esc(p.id)}">${ICO.clock(16)}延期</button>
      </div>
      <button type="button" class="btn danger block" data-follow="archive" data-id="${esc(p.id)}">归档</button>
    </div>`;
  document.body.appendChild(host);
  bindFollowButtons(host);
}

/* ------------------------------------------------------------ 设置与服务端 Sheet */

function openServerSheet() {
  const mask = document.createElement('div');
  mask.className = 'md-mask sheet-mode';
  const dlg = document.createElement('div');
  dlg.className = 'md-dialog sm';
  dlg.innerHTML = `
    <div class="md-drag-bar"></div>
    <div class="md-dialog-head">
      <h3>服务端连接</h3>
      <button type="button" class="wd-btn icon" id="srv-close">${ICO.close(18)}</button>
    </div>
    <div class="md-dialog-body">
      <div class="set-field">
        <label>服务端地址</label>
        <input class="wd-input" id="srv-url" value="${esc(loadConfig().baseUrl)}" placeholder="http://192.168.1.10:8091" autocomplete="off">
        <div class="probe" id="srv-probe">换地址会清掉当前登录会话</div>
      </div>
    </div>
    <div class="md-dialog-foot">
      <button type="button" class="wd-btn tonal" id="srv-test">测试连接</button>
      <button type="button" class="wd-btn filled" id="srv-save">切换并重登</button>
    </div>`;
  mask.appendChild(dlg);
  document.body.appendChild(mask);

  const close = () => mask.remove();
  const url = dlg.querySelector<HTMLInputElement>('#srv-url')!;
  const probe = dlg.querySelector<HTMLElement>('#srv-probe')!;
  dlg.querySelector('#srv-close')!.addEventListener('click', close);
  mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(); });

  dlg.querySelector('#srv-test')!.addEventListener('click', async () => {
    const norm = normalizeBaseUrl(url.value);
    if (!norm) { probe.textContent = '地址格式不对'; probe.className = 'probe bad'; return; }
    probe.textContent = '测试中…'; probe.className = 'probe';
    const r = await probeServer(norm);
    probe.textContent = r.ok ? `已连上（时钟差 ${Math.round(r.skewMs)} ms）` : r.reason;
    probe.className = `probe ${r.ok ? 'ok' : 'bad'}`;
    if (r.ok) saveConfig({ serverSkewMs: r.skewMs });
  });
  dlg.querySelector('#srv-save')!.addEventListener('click', () => {
    const norm = normalizeBaseUrl(url.value);
    if (!norm) { probe.textContent = '地址格式不对'; probe.className = 'probe bad'; return; }
    if (norm === loadConfig().baseUrl) { close(); return; }
    switchServer(norm);
    rt?.close();
    location.reload();
  });
}

function renderSettings() {
  const host = document.getElementById('v-settings')!;
  const u = loadConfig().user;
  const s = loadConfig().settings;
  host.innerHTML = `<div class="set-scroll">
    <div class="set-group">
      <div class="who">
        <div class="avatar">${esc((u?.username ?? '?').slice(0, 1).toUpperCase())}</div>
        <div>
          <div style="font-size:17px;font-weight:650">${esc(u?.username ?? '未登录')}</div>
          <div class="set-val">${u?.role === 'admin' ? '管理员' : '普通用户'} · ${esc(loadConfig().deviceName)}</div>
        </div>
      </div>
    </div>
    <div class="set-group">
      <h3>连接</h3>
      <div class="set-row">
        <div><div class="lbl">服务端地址</div><div class="sub mono">${esc(loadConfig().baseUrl || '未配置')}</div></div>
        <button type="button" class="btn sm tonal" id="m-open-srv">切换</button>
      </div>
    </div>
    <div class="set-group">
      <h3>推进节奏（所有设备同步生效）</h3>
      <div class="set-field"><label>逾期多少天自动归档</label><input class="input" id="pf-archive-days" type="number" min="1" value="${s.archiveAfterDays}"></div>
      <div class="set-field"><label>每日聚焦时刻</label><input class="input" id="pf-focus" type="time" value="${minText(s.focusAtMin)}"></div>
      <div class="set-field"><label>静音开始</label><input class="input" id="pf-quiet-start" type="time" value="${minText(s.quietStartMin)}"></div>
      <div class="set-field"><label>静音结束</label><input class="input" id="pf-quiet-end" type="time" value="${minText(s.quietEndMin)}"></div>
      <div class="set-field"><label>提示音</label>
        <select id="pf-sound" class="m-select">
          ${(['system', 'custom', 'none'] as const).map((v) =>
            `<option value="${v}" ${s.sound === v ? 'selected' : ''}>${v === 'none' ? '静音' : v === 'custom' ? '自定义' : '系统提示音'}</option>`).join('')}
        </select></div>
      <div class="probe" id="pf-msg"></div>
      <button type="button" class="btn solid block" id="pf-save">保存偏好</button>
    </div>
    <div class="set-group">
      <h3>外观主题</h3>
      <div class="seg" id="m-theme-seg">
        ${THEMES.map((t) => `<button type="button" class="${loadTheme() === t.id ? 'on' : ''}" data-theme-id="${t.id}">${esc(t.label)}</button>`).join('')}
      </div>
    </div>
    <div class="set-group">
      <h3>关于与自检</h3>
      <button type="button" class="btn tonal block" id="open-about">关于 / 检查更新</button>
      <button type="button" class="btn ghost block" id="ping" style="margin-top:10px">测试通知（确认锁屏能响）</button>
      <button type="button" class="btn danger block" id="logout" style="margin-top:10px">退出登录</button>
    </div>
  </div>`;

  document.getElementById('m-open-srv')!.onclick = () => openServerSheet();
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
      pfMsg.textContent = '保存失败，请检查服务端连接'; pfMsg.className = 'probe bad';
    }
  };
  document.getElementById('m-theme-seg')!.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-theme-id]');
    if (!b) return;
    const t = b.dataset.themeId as 'dark' | 'morandi';
    saveTheme(t);
    syncTopThemeBtn();
    renderSettings();
  });
  document.getElementById('open-about')!.onclick = () => openAbout();
  document.getElementById('ping')!.onclick = () => { notify('试响', '如果你看到这条通知，说明手机通知正常'); toast('已发测试通知'); };
  document.getElementById('logout')!.onclick = async () => {
    const ok = await openConfirmDialog({
      title: '退出当前账号？',
      detail: '退出后将停止本机提醒，需重新登录。',
      confirmText: '退出登录',
      danger: true,
    });
    if (!ok) return;
    rt?.close(); clearToken(); location.reload();
  };
}

function syncTopThemeBtn() {
  const b = document.getElementById('m-theme');
  if (b) b.innerHTML = loadTheme() === 'dark' ? ICO.sun(20) : ICO.moon(20);
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

/* ------------------------------------------------------------ 实时同步 */

function onRealtime(msg: ServerMessage) {
  switch (msg.t) {
    case 'welcome': {
      const overdue = msg.overdue ?? [];
      const strongOver = overdue.filter((p) => p.strength === 'strong');
      const weakOver = overdue.filter((p) => p.strength === 'weak');
      for (const p of strongOver) {
        const idx = mobileTakeoverQueue.findIndex((x) => x.id === p.id);
        if (idx >= 0) mobileTakeoverQueue[idx] = p;
        else mobileTakeoverQueue.push(p);
      }
      if (strongOver.length > 0) showNextMobileTakeover();
      if (weakOver.length > 0) toast(`有 ${weakOver.length} 条提醒已逾期未处理`);
      else if (msg.missed.length && strongOver.length === 0) toast(`上线补发 ${msg.missed.length} 条跟进`);
      void refresh();
      break;
    }
    case 'pursuit.overdue_digest':
      toast(`有 ${msg.count} 条提醒已逾期未处理 · ${msg.sample.slice(0, 20)}`);
      void refresh();
      break;
    case 'pursuit.created':
    case 'pursuit.updated':
    case 'pursuit.stepped':
    case 'pursuit.deleted':
      void refresh();
      break;
    case 'pursuit.followed':
      noteFollowup(msg.pursuit.id, msg.action, levelForStrength(msg.pursuit.strength));
      control.dismissedElsewhere(msg.pursuit.id);
      void refresh();
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
    todayCount = c.today;
    const b = document.getElementById('b-today');
    if (b) {
      b.hidden = todayCount <= 0;
      b.textContent = todayCount > 99 ? '99+' : String(todayCount);
    }
    if (view === 'today') await loadList('today');
    else if (view === 'todo') await loadList(todoFilter);
    else if (view === 'stats') await renderMobileStats();
  } catch { /* 静默 */ }
}

async function startNativePush() {
  if (!hasTauri()) return;
  const cfg = loadConfig();
  if (!cfg.baseUrl || !cfg.token) return;
  try {
    await invoke('plugin:push|start', { baseUrl: cfg.baseUrl, token: cfg.token });
  } catch { /* 保活起不来不阻塞前台 */ }
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
        <input class="input" id="base" value="${esc(cfg.baseUrl || 'http://192.168.1.10:8091')}" autocomplete="off" spellcheck="false">
        <div class="probe" id="probe"></div></div>
      <button type="button" class="btn tonal block" id="test-conn" style="margin-bottom:16px">测试连接</button>
      <div class="fld"><label>用户名</label><input class="input" id="user" autocomplete="username"></div>
      <div class="fld"><label>密码</label><input class="input" id="pass" type="password" autocomplete="${needed ? 'new-password' : 'current-password'}"></div>
      ${needed ? '<div class="fld"><label>确认密码</label><input class="input" id="confirm" type="password" autocomplete="new-password"></div>' : ''}
      <div class="fld"><label>这台设备叫什么</label><input class="input" id="dev" value="${esc(cfg.deviceName || '我的手机')}" autocomplete="off"></div>
      <div class="err" id="err"></div>
      <button type="button" class="btn solid block" id="go">${needed ? '创建管理员' : '登录'}</button>
      ${needed ? '<div class="foot">服务端已有管理员？<a id="to-login">去登录</a></div>' : ''}
      <button type="button" class="btn ghost block" id="about-link" style="margin-top:12px">关于 / 检查更新</button>
    </div>
  </div>`;

  const err = document.getElementById('err')!;
  const base = document.getElementById('base') as HTMLInputElement;
  const probeEl = document.getElementById('probe')!;
  document.getElementById('to-login')?.addEventListener('click', () => renderAuth(false));
  document.getElementById('about-link')!.onclick = () => openAbout();

  const testConn = async () => {
    const norm = normalizeBaseUrl(base.value);
    if (!norm) { probeEl.textContent = '地址格式不对，需要 http:// 或 https:// 开头'; probeEl.className = 'probe bad'; return false; }
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
      err.textContent = '登录失败：' + msgOf(e);
    }
  };
}

/* ------------------------------------------------------------ 启动 */

function boot() {
  app.innerHTML = shell();
  applyTheme(loadTheme());
  document.querySelectorAll<HTMLElement>('#m-nav [data-tab]').forEach((b) => {
    b.onclick = () => setView(b.dataset.tab as Tab);
  });
  document.getElementById('m-fab')!.onclick = () => openCaptureSheet();
  document.getElementById('conn')!.onclick = () => openServerSheet();
  document.getElementById('m-theme')!.onclick = () => {
    saveTheme(loadTheme() === 'dark' ? 'morandi' : 'dark');
    syncTopThemeBtn();
    if (view === 'settings') renderSettings();
  };

  setView('today');
  connect();
  void startNativePush();
  void refresh();
  window.setInterval(() => {
    if (view === 'today') renderEntries('today');
    else if (view === 'todo') renderEntries(todoFilter);
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
