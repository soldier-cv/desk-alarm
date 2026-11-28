/**
 * 快速捕获窗口。全局热键唤起，Enter/「记一条」存完立刻接着记下一条，Alt+S 快捷切强/弱提醒。
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
const strSeg = document.querySelector<HTMLDivElement>('#str-seg')!;
const qGo = document.querySelector<HTMLButtonElement>('#q-go')!;
const saved = document.querySelector<HTMLDivElement>('#saved')!;
const savedChk = document.querySelector<HTMLSpanElement>('#saved-chk')!;
const savedText = document.querySelector<HTMLSpanElement>('#saved-text')!;
const capIco = document.querySelector<HTMLElement>('#cap-ico');
if (capIco) capIco.innerHTML = ICO.add(24);

let picked: Parsed = parseInput('');
let strength: ReminderStrength = 'weak';
let savedTimer: number | null = null;

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function showResult(ok: boolean, message?: string) {
  if (savedTimer !== null) clearTimeout(savedTimer);
  saved.classList.toggle('err', !ok);
  savedChk.textContent = ok ? '✓' : '!';
  savedText.textContent = ok ? '已保存，可接着记下一条' : (message ?? '保存失败');
  saved.hidden = false;
  void saved.offsetWidth;
  saved.classList.add('on');
  savedTimer = window.setTimeout(() => {
    saved.classList.remove('on');
    savedTimer = window.setTimeout(() => {
      saved.hidden = true;
      savedTimer = null;
    }, 200);
  }, ok ? 900 : 2200);
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
});

strSeg.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-strength]');
  if (!b) return;
  strength = b.dataset.strength as ReminderStrength;
  renderParse(input.value);
  input.focus();
});

async function submit() {
  const text = input.value.trim();
  if (!text) return;
  await emit('capture:submit', {
    text,
    dueAt: picked.remindAt,
    kind: picked.kind,
    strength,
  });
  input.value = '';
  strength = 'weak';
  renderParse('');
  input.focus();
}

qGo.addEventListener('click', () => void submit());

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
    renderParse('');
    if (savedTimer !== null) clearTimeout(savedTimer);
    saved.classList.remove('on');
    saved.hidden = true;
    await invoke('hide_capture');
    return;
  }
  if (ev.key !== 'Enter' || ev.repeat) return;
  if (!input.value.trim()) return;

  ev.preventDefault();
  await submit();
});

listen<{ ok: boolean; message?: string }>('capture:result', (ev) => {
  showResult(ev.payload.ok, ev.payload.message);
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
