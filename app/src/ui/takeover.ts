/**
 * L4 接管窗口。无边框、置顶、关不掉，只有跟进动作能结束它。
 * 与主窗口不共享全局变量，动作全靠 Tauri 事件发给主窗口（WS 在那边）。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { dayLabel, hhmm, hostOf, serverNow, type FollowupAction, type NudgeChannel, type NudgeLevel, type Pursuit } from '../api';
import { applyTheme, loadTheme } from '../theme';
import '../styles.css';

applyTheme(loadTheme());
listen<{ theme: 'dark' | 'morandi' }>('theme:changed', (ev) => applyTheme(ev.payload.theme));

interface Payload {
  pursuit: Pursuit;
  level: NudgeLevel;
  channel: NudgeChannel;
  reason: string;
  serverTs: number;
  stage: 'banner' | 'escalated';
  muted: boolean;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const el = {
  root: $<HTMLDivElement>('#tk'),
  clock: $<HTMLDivElement>('#tk-clock'),
  title: $<HTMLDivElement>('#tk-title'),
  note: $<HTMLDivElement>('#tk-note'),
  target: $<HTMLDivElement>('#tk-target'),
  where: $<HTMLDivElement>('#tk-where'),
  stage: $<HTMLSpanElement>('#tk-stage'),
  elapsed: $<HTMLSpanElement>('#tk-elapsed'),
  bar: $<HTMLElement>('#tk-bar'),
  escNote: $<HTMLSpanElement>('#tk-esc'),
  acts: $<HTMLDivElement>('#tk-acts'),
  snooze: $<HTMLDivElement>('#tk-snooze'),
};

let current: Payload | null = null;
let tickTimer: number | null = null;
let startedAt = 0;

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

const ICON = {
  link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function dayAfter(days: number, hour = 9): number {
  const d = new Date(serverNow());
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

function renderActions(p: Payload) {
  el.acts.innerHTML = `
    <button class="btn solid" data-act="done">完成</button>
    <button class="btn ghost" data-act="smaller">拆小</button>
    <button class="btn ghost" data-act="later">延期</button>
    <button class="btn danger" data-act="archive">归档</button>`;

  el.snooze.innerHTML = `
    <span class="lb">${esc(p.reason || '这件事停太久了，先决定下一步')}</span>
    <button class="btn sm ghost" data-act="later" data-to="${dayAfter(1)}">明天 9:00</button>
    <button class="btn sm ghost" data-act="later" data-to="${dayAfter(3)}">3 天后</button>
    <button class="btn sm ghost" data-act="later" data-to="${dayAfter(7)}">下周</button>`;
}

function render(p: Payload) {
  current = p;
  const item = p.pursuit;
  startedAt = Date.now();

  el.root.classList.toggle('shake', p.stage === 'escalated');
  el.root.classList.remove('entering');
  void el.root.offsetWidth;
  el.root.classList.add('entering');

  const at = item.dueAt ?? serverNow();
  el.clock.innerHTML = `${hhmm(at)}<span>${esc(dayLabel(at))}</span>`;
  el.title.textContent = item.text;
  el.note.textContent = item.note ?? '';
  el.note.hidden = !item.note;

  const targets: string[] = [];
  if (item.url) {
    targets.push(`<div class="t">${ICON.link}<span>${esc(hostOf(item.url))}</span><button class="btn sm ghost act" data-act="open">打开</button></div>`);
  }
  if (item.path) {
    targets.push(`<div class="t path">${ICON.folder}<span>${esc(item.path)}</span></div>`);
  }
  el.target.innerHTML = targets.join('');

  el.where.textContent = item.deviceIds.length
    ? `同步到 ${item.deviceIds.length} 台设备`
    : '这条在所有设备可见';

  el.escNote.textContent = p.muted
    ? '静音时段内，窗口会自己收起'
    : '关不掉，只能选一个跟进动作';

  el.stage.textContent = p.stage === 'escalated'
    ? '已升级：关不掉，会继续跟催'
    : `L${p.level} 接管：这件事已经停滞，先给它一个去向`;
  el.stage.setAttribute('data-stage', p.stage);

  renderActions(p);

  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = window.setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.elapsed.textContent = `已等待 ${s} 秒`;
    el.bar.style.width = `${Math.min(100, (s / 300) * 100)}%`;
  }, 1000);

  if (p.muted) window.setTimeout(() => void invoke('hide_takeover'), 4000);
}

/* -------------------------------------------------------- 动作派发 */

async function send(action: FollowupAction, extra: Record<string, unknown> = {}) {
  const p = current;
  if (!p) return;
  await emit('takeover:action', {
    pursuitId: p.pursuit.id,
    action,
    version: p.pursuit.version,
    ...extra,
  });
  await invoke('hide_takeover');
}

function askSteps() {
  const p = current;
  if (!p) return;
  const next = p.pursuit.steps.find((s) => s.state !== 'done')?.text ?? p.pursuit.text;
  const value = window.prompt('把这件事拆成 2-3 个能立刻动手的小步骤，用换行分隔', next);
  if (value === null) return;
  const steps = value.split(/\r?\n|；|;/).map((s) => s.trim()).filter(Boolean);
  if (!steps.length) return;
  void send('smaller', { steps });
}

async function act(kind: string, to?: number) {
  const p = current;
  if (!p) return;
  switch (kind) {
    case 'done': await send('done'); break;
    case 'smaller': askSteps(); break;
    case 'later': await send('later', { to: to ?? dayAfter(1) }); break;
    case 'archive': await send('archive'); break;
    case 'open':
      if (p.pursuit.url) {
        await emit('takeover:open-url', { pursuitId: p.pursuit.id, url: p.pursuit.url });
        await invoke('hide_takeover');
      }
      break;
  }
}

document.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b) void act(b.dataset.act!, b.dataset.to ? Number(b.dataset.to) : undefined);
});

// Esc 不结束提醒。这是设计意图：让主窗口把升级程度往上抬
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && current) void act('done');
  if (ev.key === 'Escape') {
    void emit('takeover:close-blocked', {});
    el.root.classList.add('shake');
  }
});

listen<Payload>('takeover:show', (ev) => render(ev.payload));

// 本页加载完成；亮窗那一刻若事件发生在前，主窗口会据此补发一次
void emit('takeover:ready');

listen('takeover:close-blocked', () => {
  el.root.classList.add('shake');
});

listen('takeover:dismiss', () => {
  void invoke('hide_takeover');
});
