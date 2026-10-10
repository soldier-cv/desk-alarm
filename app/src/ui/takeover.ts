/**
 * 接管窗口。这是「强提示」真正落地的地方：
 * 无边框、置顶、关不掉、只有四个动作能结束它。
 *
 * 注意：这个 webview 和主窗口不共享 JS 全局变量，
 * 所有动作都通过 Tauri 事件发给主窗口，那边才持有 WS 和 AlarmController。
 */
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { hhmm, hostOf, serverNow } from '../api';
import type { AckAction, Entry } from '../api';
import '../styles.css';

interface Payload {
  entry: Entry;
  stage: 'banner' | 'escalated';
  /** 静默时段内且不是 hard，只提示不强推 */
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

/* ------------------------------------------------------------ 渲染 */

const ICON = {
  link: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
};

function render(p: Payload) {
  // 兜底：弱提示不该走到接管窗口。真进来了就直接收起来，
  // 否则会出现「说了弱提示却弹全屏」这种最伤信任的情况
  if (p.entry.strength === 'weak') {
    void invoke('hide_takeover');
    return;
  }

  current = p;
  const e = p.entry;
  startedAt = Date.now();

  el.root.classList.toggle('shake', p.stage === 'escalated');
  el.root.classList.remove('entering');
  void el.root.offsetWidth; // 强制回流，让 entering 动画能重放
  el.root.classList.add('entering');

  el.clock.innerHTML = `${hhmm(e.remindAt)}<span>${new Date(e.remindAt ?? serverNow()).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span>`;
  el.title.textContent = e.text;
  el.note.textContent = e.note ?? '';
  el.note.hidden = !e.note;

  const targets: string[] = [];
  if (e.url) {
    targets.push(`<div class="t">${ICON.link}<span>${esc(hostOf(e.url))}</span><button class="btn sm ghost act" data-act="open">打开</button></div>`);
  }
  if (e.path) {
    targets.push(`<div class="t path">${ICON.folder}<span>${esc(e.path)}</span></div>`);
  }
  el.target.innerHTML = targets.join('');

  el.where.textContent = e.devices[0] === '*'
    ? '推送到全部在线设备'
    : `只推送到：${e.devices.map((d) => esc(d)).join(' / ')}`;

  el.escNote.textContent = p.muted
    ? '静音时段内，窗口会自己收起'
    : '关不掉，只能选一个处理方式';

  // 没有链接时不显示「打开链接」
  el.acts.querySelector<HTMLButtonElement>('[data-act="open"]')?.remove();
  if (!e.url) {
    el.acts.insertAdjacentHTML('afterbegin', '<button class="btn ghost" data-act="open" disabled>打开链接</button>');
  }

  el.stage.textContent = p.stage === 'escalated'
    ? '已升级：关不掉，每分钟重复一次'
    : '首次提示 0 秒，30 秒未确认升级全屏，5 分钟后每 2 分钟重复';
  el.stage.setAttribute('data-stage', p.stage);

  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = window.setInterval(() => {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    el.elapsed.textContent = `已响 ${s} 秒`;
    el.bar.style.width = `${Math.min(100, (s / 300) * 100)}%`;
  }, 1000);
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/* -------------------------------------------------------- 动作派发 */

/**
 * 四个动作。不给「稍后再说」以外的第四个逃逸口，
 * 「静音 10 分钟」是有代价的，它会记 snooze_count。
 * 全部通过事件交给主窗口，主窗口有 WS 连接和 AlarmController。
 */
async function act(kind: string) {
  const p = current;
  if (!p) return;

  const fire = (action: AckAction, snoozeTo?: number) =>
    emit('takeover:action', { entryId: p.entry.id, action, snoozeTo });

  switch (kind) {
    case 'done':
      await fire('done');
      break;
    case 'open':
      if (p.entry.url) {
        // 先把条目完成再开浏览器。顺序反了的话，用户可能开了网页就忘了回来
        await emit('takeover:open-url', { entryId: p.entry.id, url: p.entry.url });
      }
      break;
    case 'sn10': await fire('snooze', serverNow() + 10 * 60_000); break;
    case 'sn30': await fire('snooze', serverNow() + 30 * 60_000); break;
    case 'sn60': await fire('snooze', serverNow() + 60 * 60_000); break;
    case 'sntom': {
      const base = new Date(p.entry.remindAt ?? serverNow());
      base.setDate(base.getDate() + 1);
      await fire('snooze', base.getTime());
      break;
    }
    case 'silence': await fire('silence'); break;
  }
  await invoke('hide_takeover');
}

document.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (b) void act(b.dataset.act!);
});

// Esc 不结束提醒。这是设计意图，不是遗漏。
// 触发「我关不掉」的反馈，让主窗口把升级程度往上抬。
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && current) void act('done');
  if (ev.key === 'Escape') {
    void emit('takeover:close-blocked', {});
    el.root.classList.add('shake');
  }
});

/* ------------------------------------------------------------ 订阅 */

listen<Payload>('takeover:show', (ev) => render(ev.payload));

listen('takeover:close-blocked', () => {
  el.root.classList.add('shake');
});

/** 别的设备处理了，或者本机处理完了，主窗口会通知收起来 */
listen('takeover:dismiss', () => {
  void invoke('hide_takeover');
});
