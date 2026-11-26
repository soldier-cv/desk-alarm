/**
 * 强提醒接管窗口。无边框、置顶、关不掉，只有跟进动作能结束它。
 * 与主窗口不共享全局变量，动作全靠 Tauri 事件发给主窗口（WS 在那边）。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { dayLabel, hhmm, hostOf, serverNow, type FollowupAction, type Pursuit } from '../api';
import { applyTheme, loadTheme } from '../theme';
import { openStepsDialog } from '../widgets';
import '../styles.css';

applyTheme(loadTheme());
listen<{ theme: 'dark' | 'morandi' }>('theme:changed', (ev) => applyTheme(ev.payload.theme));

interface Payload {
  items: Pursuit[];
  index: number;
  reason: string;
  serverTs: number;
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

function item(): Pursuit | null {
  return current?.items[current.index] ?? null;
}

function renderActions(p: Payload, it: Pursuit) {
  const next = it.steps.find((s) => s.state !== 'done');
  const more = p.index < p.items.length - 1;
  el.acts.innerHTML = `
    <button class="btn solid" data-act="done" data-step="${esc(next?.id ?? '')}">完成</button>
    <button class="btn ghost" data-act="smaller">拆小</button>
    <button class="btn ghost" data-act="later">延期</button>
    <button class="btn danger" data-act="archive">归档</button>
    ${more ? `<button class="btn ghost" data-act="next">下一条（${p.items.length - p.index - 1}）</button>` : ''}`;

  const now = serverNow();
  el.snooze.innerHTML = `
    <span class="lb">${esc(p.reason || '到点了，先给它一个去向')}</span>
    <button class="btn sm ghost" data-act="later" data-to="${now + 30 * 60_000}">30 分钟后</button>
    <button class="btn sm ghost" data-act="later" data-to="${now + 60 * 60_000}">1 小时后</button>
    <button class="btn sm ghost" data-act="later" data-to="${now + 120 * 60_000}">2 小时后</button>
    <button class="btn sm ghost" data-act="later" data-to="${dayAfter(1)}">明天 9:00</button>
    <button class="btn sm ghost" data-act="later" data-to="${dayAfter(3)}">3 天后</button>
    <button class="btn sm ghost" data-act="later" data-to="${dayAfter(7)}">下周</button>`;
}

function render(p: Payload) {
  current = p;
  const it = item();
  if (!it) return;
  startedAt = Date.now();

  el.root.classList.remove('entering');
  void el.root.offsetWidth;
  el.root.classList.add('entering');

  const at = it.dueAt ?? serverNow();
  el.clock.innerHTML = `${hhmm(at)}<span>${esc(dayLabel(at))}</span>`;
  el.title.textContent = it.text;
  el.note.textContent = it.note ?? '';
  el.note.hidden = !it.note;

  const targets: string[] = [];
  if (it.url) {
    targets.push(`<div class="t">${ICON.link}<span>${esc(hostOf(it.url))}</span><button class="btn sm ghost act" data-act="open">打开</button></div>`);
  }
  if (it.path) {
    targets.push(`<div class="t path">${ICON.folder}<span>${esc(it.path)}</span></div>`);
  }
  el.target.innerHTML = targets.join('');

  el.where.textContent = it.deviceIds.length
    ? `同步到 ${it.deviceIds.length} 台设备`
    : '这条在所有设备可见';

  el.stage.textContent = p.muted
    ? `强提醒 · ${p.index + 1}/${p.items.length}：静音时段内，窗口会自己收起`
    : `强提醒 · ${p.index + 1}/${p.items.length}：到点了，先给它一个去向`;
  el.stage.setAttribute('data-stage', 'banner');

  renderActions(p, it);

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
  const it = item();
  if (!it) return;
  await emit('takeover:action', {
    pursuitId: it.id,
    action,
    version: it.version,
    ...extra,
  });
}

async function askSteps() {
  const it = item();
  if (!it) return;
  const initial = it.steps.length
    ? it.steps.map((s) => ({ id: s.id, text: s.text }))
    : [{ text: it.text }];
  const edits = await openStepsDialog(initial);
  if (!edits) return;
  await send('smaller', { stepEdits: edits });
}

async function act(kind: string, to?: number, stepId?: string) {
  const it = item();
  if (!it) return;
  switch (kind) {
    case 'done': await send('done', stepId ? { stepId } : {}); break;
    case 'smaller': await askSteps(); break;
    case 'later': await send('later', { to: to ?? dayAfter(1) }); break;
    case 'archive': await send('archive'); break;
    case 'next':
      if (current && current.index < current.items.length - 1) {
        await emit('takeover:next', {});
      }
      break;
    case 'open':
      if (it.url) await emit('takeover:open-url', { pursuitId: it.id, url: it.url });
      break;
  }
}

document.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b) void act(b.dataset.act!, b.dataset.to ? Number(b.dataset.to) : undefined, b.dataset.step);
});

// Esc 不结束提醒。这是设计意图：只有跟进动作能关掉
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && item()) {
    const next = item()!.steps.find((s) => s.state !== 'done');
    void act('done', undefined, next?.id);
  }
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
