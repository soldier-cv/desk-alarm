/**
 * 快速捕获窗口。全局热键 Ctrl+Shift+Space 唤起。
 *
 * 存在的理由：你正在全屏写代码，脑子里冒出一个念头，
 * 不该为此切窗口。抬一下手记一条，Enter 完事。
 */
import { emit, listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { parseInput, type Parsed } from '../api';
// 样式在 capture.html 里内联，这个窗口只有 560x132，不值得再拉一份 CSS

const input = document.querySelector<HTMLInputElement>('#q')!;
const parse = document.querySelector<HTMLDivElement>('#parse')!;
const hint = document.querySelector<HTMLDivElement>('#hint')!;
const bar = document.querySelector<HTMLDivElement>('#bar')!;

let picked: Parsed = parseInput('');

function renderParse(raw: string) {
  picked = parseInput(raw);
  if (!raw.trim()) {
    parse.hidden = true;
    return;
  }
  parse.hidden = false;
  const strong = picked.strength === 'strong';
  parse.innerHTML = `
    <span class="chip ${picked.kind === 'text' ? '' : 'hot'}">${esc(picked.kindLabel)}</span>
    <span class="chip ${picked.remindAt ? 'hot' : ''}">${esc(
      picked.remindAt ? `提醒：${picked.timeLabel}` : '不提醒，进收集箱',
    )}</span>
    <span class="chip ${strong ? 'hot' : ''}">${esc(strong ? '强提示，会弹全屏' : '弱提示，只出通知')}</span>
    <span class="chip">推送到全部在线设备</span>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

input.addEventListener('input', () => {
  renderParse(input.value);
  // Enter 之后输入框立刻清掉，用户可以连着记第二条
  bar.classList.toggle('ready', input.value.trim().length > 0);
});

input.addEventListener('keydown', async (ev) => {
  if (ev.key === 'Escape') {
    input.value = '';
    parse.hidden = true;
    await invoke('hide_capture');
  }
  if (ev.key !== 'Enter') return;

  const text = input.value.trim();
  if (!text) return;

  // 交给主窗口去落库。这个窗口不碰 API，失败也不影响主界面
  await emit('capture:submit', {
    text,
    remindAt: picked.remindAt,
    kind: picked.kind,
    strength: picked.strength,
  });

  input.value = '';
  parse.hidden = true;
  bar.classList.remove('ready');
  await invoke('hide_capture');
});

/** 主窗口回执：成功给个绿边，失败把原因显示出来，别让人以为没存上 */
listen<{ ok: boolean; message?: string }>('capture:result', (ev) => {
  if (ev.payload.ok) {
    hint.textContent = '已保存';
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

/** 失焦就收起，别在后台留一个窗口挡着别人干活 */
getCurrentWindow().onFocusChanged(({ payload }) => {
  if (!payload) void invoke('hide_capture');
});

input.focus();
