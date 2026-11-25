/**
 * 快速捕获窗口。全局热键唤起，Enter 存完立刻接着记下一条。
 * 时间解析只做提示，落库以服务端存下来的为准。
 */
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { parseInput, type Parsed, type ReminderStrength } from '../api';
import { applyTheme, loadTheme } from '../theme';

applyTheme(loadTheme());
listen<{ theme: 'dark' | 'morandi' }>('theme:changed', (ev) => applyTheme(ev.payload.theme));

const input = document.querySelector<HTMLInputElement>('#q')!;
const parse = document.querySelector<HTMLDivElement>('#parse')!;
const hint = document.querySelector<HTMLDivElement>('#hint')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;

let picked: Parsed = parseInput('');
let strength: ReminderStrength = 'weak';

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function renderParse(raw: string) {
  picked = parseInput(raw);
  if (!raw.trim()) {
    parse.hidden = true;
    return;
  }
  parse.hidden = false;
  parse.innerHTML = `
    <span class="chip ${picked.kind === 'text' ? '' : 'hot'}">${esc(picked.kindLabel)}</span>
    <span class="chip ${picked.remindAt ? 'hot' : ''}">${esc(
      picked.remindAt
        ? `截止：${picked.timeLabel}`
        : `没填时间：${strength === 'strong' ? '强提醒默认 2 小时后' : '弱提醒默认 1 天后'}`,
    )}</span>
    <button type="button" class="chip ${strength === 'weak' ? 'hot' : ''}" data-strength="weak" title="到点发通知，没填时间默认 1 天后">弱提醒</button>
    <button type="button" class="chip ${strength === 'strong' ? 'hot' : ''}" data-strength="strong" title="到点弹窗，没填时间默认 2 小时后">强提醒</button>`;
}

input.addEventListener('input', () => {
  renderParse(input.value);
  bar.classList.toggle('ready', input.value.trim().length > 0);
});

parse.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-strength]');
  if (!b) return;
  strength = b.dataset.strength as ReminderStrength;
  renderParse(input.value);
});

input.addEventListener('keydown', async (ev) => {
  if (ev.key === 'Escape') {
    input.value = '';
    strength = 'weak';
    parse.hidden = true;
    await invoke('hide_capture');
  }
  if (ev.key !== 'Enter') return;

  const text = input.value.trim();
  if (!text) return;

  // 交给主窗口落库；这个窗口不碰 API，失败也不影响主界面
  await emit('capture:submit', {
    text,
    dueAt: picked.remindAt,
    kind: picked.kind,
    strength,
  });

  // 连记：只清空不清屏，连续按 Enter 能一条接一条地记
  input.value = '';
  strength = 'weak';
  parse.hidden = true;
  bar.classList.remove('ready');
  input.focus();
});

listen<{ ok: boolean; message?: string }>('capture:result', (ev) => {
  if (ev.payload.ok) {
    hint.textContent = '已保存，接着记下一条';
    hint.className = 'ok';
  } else {
    hint.textContent = ev.payload.message ?? '保存失败';
    hint.className = 'err';
  }
  window.setTimeout(() => {
    hint.textContent = 'Enter 保存，Esc 取消';
    hint.className = '';
  }, 2200);
});

listen('capture:focus', () => {
  input.focus();
  input.select();
});

getCurrentWindow().onFocusChanged(({ payload }) => {
  if (!payload) void invoke('hide_capture');
});

input.focus();
