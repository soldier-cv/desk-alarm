/**
 * 自绘下拉与时间选择：原生控件在各平台样式飘、和主题不搭。
 * 弹层复用 .dp-pop 的外观，定位跟随 anchor，点外面关闭。
 */

interface DropItem { value: string; label: string }

let openEl: HTMLElement | null = null;
let outsideHandler: ((ev: MouseEvent) => void) | null = null;

function closeOpen() {
  if (outsideHandler) document.removeEventListener('mousedown', outsideHandler);
  outsideHandler = null;
  openEl?.remove();
  openEl = null;
}

function place(el: HTMLElement, anchor: HTMLElement) {
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, h = el.offsetHeight;
  const maxW = window.innerWidth - 16, maxH = window.innerHeight - 16;
  el.style.left = `${Math.max(8, Math.min(r.left, maxW - w))}px`;
  const below = r.bottom + 6;
  el.style.top = `${below + h <= maxH ? below : Math.max(8, r.top - h - 6)}px`;
}

function bindOutside(el: HTMLElement, anchor: HTMLElement) {
  outsideHandler = (ev) => {
    if (!el.contains(ev.target as Node) && ev.target !== anchor) closeOpen();
  };
  setTimeout(() => document.addEventListener('mousedown', outsideHandler!), 0);
}

/** 自绘下拉。current 为当前 value，命中项高亮并打勾 */
export function openDropdown(
  anchor: HTMLElement,
  items: DropItem[],
  current: string,
  onPick: (value: string) => void,
) {
  closeOpen();
  const el = document.createElement('div');
  el.className = 'dp-pop dd-pop';
  el.innerHTML = items.map((it) => `
    <button class="dd-item${it.value === current ? ' on' : ''}" data-v="${esc(it.value)}">
      <span>${esc(it.label)}</span><span class="dd-check">✓</span>
    </button>`).join('');
  place(el, anchor);
  openEl = el;

  el.addEventListener('click', (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-v]');
    if (!b) return;
    onPick(b.dataset.v!);
    closeOpen();
  });
  bindOutside(el, anchor);
}

/**
 * 自绘时间选择。value 为 "HH:MM"，任意分钟可选。
 * 时/分各一列可滚动，点选即高亮，确定后回传 "HH:MM"。
 */
export function openTimePicker(
  anchor: HTMLElement,
  value: string,
  onPick: (value: string) => void,
) {
  closeOpen();
  const [hh0, mm0] = value.split(':').map(Number);
  let hh = Number.isFinite(hh0) ? hh0 : 0;
  let mm = Number.isFinite(mm0) ? mm0 : 0;
  const p = (n: number) => String(n).padStart(2, '0');

  const el = document.createElement('div');
  el.className = 'dp-pop tp-pop';
  openEl = el;

  const render = () => {
    const hours = Array.from({ length: 24 }, (_, i) =>
      `<button class="tp-cell${i === hh ? ' on' : ''}" data-h="${i}">${p(i)}</button>`).join('');
    const mins = Array.from({ length: 60 }, (_, i) =>
      `<button class="tp-cell${i === mm ? ' on' : ''}" data-m="${i}">${p(i)}</button>`).join('');
    el.innerHTML = `
      <div class="tp-head">选择时间</div>
      <div class="tp-cols">
        <div class="tp-col" data-col="h">${hours}</div>
        <span class="tp-sep">:</span>
        <div class="tp-col" data-col="m">${mins}</div>
      </div>
      <div class="dp-foot">
        <button class="btn sm" data-tp="cancel">取消</button>
        <button class="btn solid sm" data-tp="ok">确定 ${p(hh)}:${p(mm)}</button>
      </div>`;
    // 把选中项滚到可视区中部
    el.querySelector('.tp-col[data-col="h"] .tp-cell.on')?.scrollIntoView({ block: 'center' });
    el.querySelector('.tp-col[data-col="m"] .tp-cell.on')?.scrollIntoView({ block: 'center' });
  };

  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const h = t.closest<HTMLElement>('[data-h]');
    const m = t.closest<HTMLElement>('[data-m]');
    if (h) { hh = Number(h.dataset.h); render(); return; }
    if (m) { mm = Number(m.dataset.m); render(); return; }
    const act = t.closest<HTMLElement>('[data-tp]')?.dataset.tp;
    if (act === 'cancel') { closeOpen(); return; }
    if (act === 'ok') { onPick(`${p(hh)}:${p(mm)}`); closeOpen(); }
  });

  render();
  place(el, anchor);
  bindOutside(el, anchor);
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}
