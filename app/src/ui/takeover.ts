/**
 * 强提醒接管窗口。高显著警示条 + 当前步骤高亮 + 分层跟进动作，只有跟进动作能关闭。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { dayLabel, hhmm, hostOf, lateBy, serverNow, type FollowupAction, type Pursuit } from '../api';
import { ICO } from '../icons';
import { applyTheme, loadTheme } from '../theme';
import { openDateTimePicker, openStepsDialog } from '../widgets';
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
  warnLabel: $<HTMLElement>('#tk-warn-label'),
  clock: $<HTMLDivElement>('#tk-clock'),
  queue: $<HTMLDivElement>('#tk-queue'),
  title: $<HTMLDivElement>('#tk-title'),
  note: $<HTMLDivElement>('#tk-note'),
  stepCard: $<HTMLDivElement>('#tk-step-card'),
  target: $<HTMLDivElement>('#tk-target'),
  where: $<HTMLDivElement>('#tk-where'),
  stage: $<HTMLSpanElement>('#tk-stage'),
  elapsed: $<HTMLSpanElement>('#tk-elapsed'),
  bar: $<HTMLElement>('#tk-bar'),
  acts: $<HTMLDivElement>('#tk-acts'),
  snooze: $<HTMLDivElement>('#tk-snooze'),
};

el.warnLabel.innerHTML = `${ICO.alert(18)}<span>WARNING</span>`;

let current: Payload | null = null;
let tickTimer: number | null = null;
let startedAt = 0;

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}

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
  const doneLabel = next ? '完成这一步' : '标记完成';

  el.acts.innerHTML = `
    <button type="button" class="btn solid" data-act="done" data-step="${esc(next?.id ?? '')}">
      ${ICO.check(17)}<span>${doneLabel}</span><span class="tk-kbd">Enter</span>
    </button>
    <button type="button" class="btn tonal" data-act="smaller">${ICO.split(16)}<span>拆小步骤</span></button>
    ${more ? `<button type="button" class="btn ghost" data-act="next">下一条（剩余 ${p.items.length - p.index - 1}）</button>` : ''}
    <button type="button" class="btn danger tk-archive" data-act="archive">${ICO.archive(16)}<span>归档</span></button>`;

  const now = serverNow();
  el.snooze.innerHTML = `
    <span class="lb">${ICO.clock(14)} 推迟到</span>
    <button type="button" class="btn sm ghost" data-act="later" data-to="${now + 30 * 60_000}">30 分钟后</button>
    <button type="button" class="btn sm ghost" data-act="later" data-to="${now + 60 * 60_000}">1 小时后</button>
    <button type="button" class="btn sm ghost" data-act="later" data-to="${now + 120 * 60_000}">2 小时后</button>
    <button type="button" class="btn sm ghost" data-act="later" data-to="${dayAfter(1)}">明天 9:00</button>
    <button type="button" class="btn sm ghost" data-act="later" data-to="${dayAfter(3)}">3 天后</button>
    <button type="button" class="btn sm ghost" data-act="later" data-to="${dayAfter(7)}">下周</button>
    <button type="button" class="btn sm tonal" data-act="later-custom">自定义…</button>`;
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
  const overdueSuffix = it.dueAt !== null && it.dueAt < serverNow() ? ` · 已逾期 ${lateBy(it.dueAt)}` : '';
  el.clock.innerHTML = `${hhmm(at)}<span>${esc(dayLabel(at) + overdueSuffix)}</span>`;

  if (p.items.length > 1) {
    el.queue.hidden = false;
    el.queue.innerHTML = `${ICO.bolt(14)}<span>强提醒队列 ${p.index + 1} / ${p.items.length}</span>`;
  } else {
    el.queue.hidden = true;
  }

  el.title.textContent = it.text;
  el.note.textContent = it.note ?? '';
  el.note.hidden = !it.note;

  const totalSteps = it.steps.length;
  const doneSteps = it.steps.filter((s) => s.state === 'done').length;
  const nextStep = it.steps.find((s) => s.state !== 'done');
  if (nextStep) {
    el.stepCard.hidden = false;
    el.stepCard.innerHTML = `
      <div class="tk-step-meta">
        <span>当前待推进步骤</span>
        <span class="mono">进度 ${doneSteps} / ${totalSteps}</span>
      </div>
      <div class="tk-step-text">${esc(nextStep.text)}</div>`;
  } else {
    el.stepCard.hidden = true;
  }

  const targets: string[] = [];
  if (it.url) {
    targets.push(`<div class="t">${ICO.link(15)}<span>${esc(hostOf(it.url))}</span><button type="button" class="btn sm tonal act" data-act="open">打开链接</button></div>`);
  }
  if (it.path) {
    targets.push(`<div class="t path">${ICO.folder(15)}<span>${esc(it.path)}</span></div>`);
  }
  el.target.innerHTML = targets.join('');

  el.where.textContent = it.deviceIds.length
    ? `同步到 ${it.deviceIds.length} 台设备 · 任意设备处理后自动收起`
    : '所有在线设备同步可见 · 任意设备处理后自动收起';

  el.stage.textContent = p.muted
    ? '静音时段内，窗口即将自动收起'
    : (p.reason || '到点了，先给它一个明确去向');
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

async function act(kind: string, anchor: HTMLElement, to?: number, stepId?: string) {
  const it = item();
  if (!it) return;
  switch (kind) {
    case 'done': await send('done', stepId ? { stepId } : {}); break;
    case 'smaller': await askSteps(); break;
    case 'later': if (to) await send('later', { to }); break;
    case 'later-custom':
      openDateTimePicker({
        initial: it.dueAt ?? serverNow() + 3600_000,
        now: serverNow(),
        anchor,
        title: '自定义推迟时间',
        onPick: (at) => void send('later', { to: at }),
      });
      break;
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
  if (b) void act(b.dataset.act!, b, b.dataset.to ? Number(b.dataset.to) : undefined, b.dataset.step);
});

// Esc 不结束强提醒，且当有弹窗打开时先交由弹窗处理
document.addEventListener('keydown', (ev) => {
  if (document.querySelector('.md-mask, .dp-pop')) return;
  if (ev.key === 'Enter' && item()) {
    const next = item()!.steps.find((s) => s.state !== 'done');
    void act('done', el.root, undefined, next?.id);
  }
  if (ev.key === 'Escape') {
    void emit('takeover:close-blocked', {});
    el.root.classList.add('shake');
  }
});

listen<Payload>('takeover:show', (ev) => render(ev.payload));
void emit('takeover:ready');

listen('takeover:close-blocked', () => {
  el.root.classList.add('shake');
});

listen('takeover:dismiss', () => {
  void invoke('hide_takeover');
});
