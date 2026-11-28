/**
 * 快速捕获窗口。全局热键唤起，Enter 存完立刻接着记下一条，Alt+S 快捷切强/弱提醒。
 */
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { parseInput, type Parsed, type ReminderStrength } from '../api';
import { ICO } from '../icons';
import { applyTheme, loadTheme } from '../theme';
import '../styles.css';

applyTheme(loadTheme());
listen<{ theme: 'dark' | 'morandi' }>('theme:changed', (ev) => applyTheme(ev.payload.theme));

const input = document.querySelector<HTMLInputElement>('#q')!;
const parse = document.querySelector<HTMLDivElement>('#parse')!;
const hint = document.querySelector<HTMLDivElement>('#hint')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;
const strSeg = document.querySelector<HTMLDivElement>('#str-seg')!;
const capIco = document.querySelector<HTMLElement>('#cap-ico');
if (capIco) capIco.innerHTML = ICO.add(24);

let picked: Parsed = parseInput('');
let strength: ReminderStrength = 'weak';

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function syncStrengthUI() {
  strSeg.querySelectorAll<HTMLButtonElement>('[data-strength]').forEach((b) => {
    const on = b.dataset.strength === strength;
    b.classList.toggle('on', on);
    b.classList.toggle('hot', on && strength === 'strong');
  });
}

function renderParse(raw: string) {
  picked = parseInput(raw);
  syncStrengthUI();
  if (!raw.trim()) {
    parse.innerHTML = `<span class="hint">例：明天 15:00 交周报 · 半小时后喝水 · https://...</span>`;
    return;
  }
  parse.innerHTML = `
    <span class="chip ${picked.kind === 'text' ? '' : 'hot'}">${esc(picked.kindLabel)}</span>
    <span class="chip ${picked.remindAt ? 'hot' : ''}">${esc(
      picked.remindAt
        ? `截止：${picked.timeLabel}`
        : `未填时间：${strength === 'strong' ? '强提醒默认 2 小时后' : '弱提醒默认 1 天后'}`,
    )}</span>`;
}

input.addEventListener('input', () => {
  renderParse(input.value);
  bar.classList.toggle('ready', input.value.trim().length > 0);
});

strSeg.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-strength]');
  if (!b) return;
  strength = b.dataset.strength as ReminderStrength;
  renderParse(input.value);
  input.focus();
});

document.addEventListener('keydown', async (ev) => {
  if (ev.isComposing) return;
  if (ev.altKey && ev.key.toLowerCase() === 's') {
    ev.preventDefault();
    strength = strength === 'strong' ? 'weak' : 'strong';
    renderParse(input.value);
    return;
  }
  if (ev.key === 'Escape') {
    input.value = '';
    strength = 'weak';
    bar.classList.remove('ready');
    renderParse('');
    await invoke('hide_capture');
    return;
  }
  if (ev.key !== 'Enter' || ev.repeat) return;

  const text = input.value.trim();
  if (!text) return;

  ev.preventDefault();
  await emit('capture:submit', {
    text,
    dueAt: picked.remindAt,
    kind: picked.kind,
    strength,
  });

  input.value = '';
  strength = 'weak';
  bar.classList.remove('ready');
  renderParse('');
  input.focus();
});

listen<{ ok: boolean; message?: string }>('capture:result', (ev) => {
  if (ev.payload.ok) {
    hint.textContent = '已保存，可接着记下一条';
    hint.className = 'hint ok';
  } else {
    hint.textContent = ev.payload.message ?? '保存失败';
    hint.className = 'hint err';
  }
  window.setTimeout(() => {
    hint.textContent = 'Enter 保存 · Alt+S 切强弱 · Esc 关闭';
    hint.className = 'hint';
  }, 2200);
});

listen('capture:focus', () => {
  renderParse(input.value);
  input.focus();
  input.select();
});

getCurrentWindow().onFocusChanged(({ payload }) => {
  if (!payload) void invoke('hide_capture');
});

renderParse('');
input.focus();
