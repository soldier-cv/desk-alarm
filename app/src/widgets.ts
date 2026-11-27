/**
 * 共享 M3 弹层、自绘下拉、日期/时间选择与确认对话框。
 * 桌面端以 Popover / Dialog 呈现，窄屏移动端自动切换为 Modal Bottom Sheet。
 */
import type { StepEdit } from '../../shared/types';
import { ICO } from './icons';
import './widgets.css';

interface DropItem { value: string; label: string }

let openEl: HTMLElement | null = null;
let outsideHandler: ((ev: MouseEvent) => void) | null = null;

function isCompactViewport(): boolean {
  return window.innerWidth < 680;
}

function closeOpen() {
  if (outsideHandler) document.removeEventListener('mousedown', outsideHandler);
  outsideHandler = null;
  openEl?.remove();
  openEl = null;
}

function place(el: HTMLElement, anchor: HTMLElement) {
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const maxW = window.innerWidth - 12;
  const maxH = window.innerHeight - 12;
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
    <button type="button" class="dd-item${it.value === current ? ' on' : ''}" data-v="${esc(it.value)}">
      <span>${esc(it.label)}</span><span class="dd-check">${ICO.check(15)}</span>
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

const ROW = 34;
const PAD = 2;

function clockHint(hh: number, mm: number): string {
  const period = hh < 5 ? '凌晨' : hh < 11 ? '上午' : hh < 13 ? '中午' : hh < 18 ? '下午' : '晚上';
  return `${period} ${hh} 点${mm ? ` ${mm} 分` : '整'}`;
}

function parseClock(s: string): { hh: number; mm: number } | null {
  const t = s.trim();
  const valid = (h: number, m: number) => (h >= 0 && h < 24 && m >= 0 && m < 60 ? { hh: h, mm: m } : null);
  let m = t.match(/^(\d{1,2})[:：](\d{1,2})$/);
  if (m) return valid(Number(m[1]), Number(m[2]));
  m = t.match(/^(\d{1,2})点(?:(\d{1,2})分?|半)?$/);
  if (m) return valid(Number(m[1]), /半/.test(t) ? 30 : Number(m[2] ?? 0));
  m = t.match(/^(上午|早上|中午|下午|晚上|夜里)\s*(\d{1,2})点?(?:(\d{1,2})分?|半)?$/);
  if (m) {
    let h = Number(m[2]);
    if (['下午', '晚上', '夜里'].includes(m[1]) && h < 12) h += 12;
    if (m[1] === '中午' && h < 12) h = 12;
    if (['上午', '早上'].includes(m[1]) && h === 12) h = 0;
    return valid(h, /半/.test(t) ? 30 : Number(m[3] ?? 0));
  }
  return null;
}

export function openTimePicker(
  anchor: HTMLElement | null,
  value: string,
  onPick: (value: string) => void,
  opts: { modal?: boolean } = {},
) {
  const asModal = opts.modal || !anchor || isCompactViewport();
  if (!asModal) closeOpen();
  const [h0, m0] = value.split(':').map(Number);
  let hh = Number.isFinite(h0) ? h0 : 0;
  let mm = Number.isFinite(m0) ? m0 : 0;
  const p = (n: number) => String(n).padStart(2, '0');

  const track = (total: number) => {
    let out = '';
    for (let i = -PAD; i < total + PAD; i++) {
      const v = ((i % total) + total) % total;
      out += `<div class="tp-cv" data-i="${v}">${p(v)}</div>`;
    }
    return out;
  };

  const el = document.createElement('div');
  el.className = asModal ? 'dp-pop tp-pop inline-modal' : 'dp-pop tp-pop';
  el.tabIndex = -1;

  el.innerHTML = `
    <div class="tp-top">
      <button type="button" class="tp-read" data-tp="edit" title="点击直接输入">
        <span class="tp-time" id="tp-time"></span>
        <span class="tp-ampm" id="tp-ampm"></span>
      </button>
      <div class="tp-hint" id="tp-hint"></div>
    </div>
    <div class="tp-edit" hidden>
      <input class="wd-input" id="tp-input" placeholder="23:30 / 晚上8点" />
      <div class="tp-edit-tip">支持 23:30、8点、晚上8点半、下午3:15</div>
    </div>
    <div class="tp-wheel-wrap">
      <div class="tp-band"></div>
      <div class="tp-cols">
        <div class="tp-col" data-col="h"><div class="tp-track">${track(24)}</div></div>
        <span class="tp-sep">:</span>
        <div class="tp-col" data-col="m"><div class="tp-track">${track(60)}</div></div>
      </div>
    </div>
    <div class="tp-chips">
      <button type="button" class="tp-chip" data-tp="now">现在</button>
      <button type="button" class="tp-chip" data-tp="hour">整点</button>
      <button type="button" class="tp-chip" data-tp="plus15">+15 分</button>
      <button type="button" class="tp-chip" data-tp="plus60">+1 小时</button>
    </div>
    <div class="dp-foot">
      <button type="button" class="wd-btn" data-tp="cancel">取消</button>
      <button type="button" class="wd-btn filled" data-tp="ok">确定</button>
    </div>`;

  let mask: HTMLElement | null = null;
  const close = () => {
    if (mask) { mask.remove(); mask = null; }
    else closeOpen();
  };

  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  let col: 'h' | 'm' = 'h';
  let editing = false;

  const paintTrack = (which: 'h' | 'm', sel: number, total: number) => {
    const t = q<HTMLElement>(`.tp-col[data-col="${which}"] .tp-track`);
    t.style.transform = `translateY(${-sel * ROW}px)`;
    t.querySelectorAll<HTMLElement>('.tp-cv').forEach((c) => {
      const i = Number(c.dataset.i);
      const d = Math.abs(i - sel);
      const near = Math.min(d, total - d) === 1;
      c.classList.toggle('on', i === sel);
      c.classList.toggle('near', near && i !== sel);
    });
  };

  const paint = () => {
    q('#tp-time').innerHTML = `${p(hh)}<span class="tp-colon">:</span>${p(mm)}`;
    q('#tp-ampm').textContent = hh < 12 ? 'AM' : 'PM';
    q('#tp-hint').textContent = clockHint(hh, mm);
    paintTrack('h', hh, 24);
    paintTrack('m', mm, 60);
  };

  const setCol = (which: 'h' | 'm', v: number) => {
    if (which === 'h') hh = ((v % 24) + 24) % 24;
    else mm = ((v % 60) + 60) % 60;
    paint();
  };

  const setEditing = (on: boolean) => {
    editing = on;
    q<HTMLElement>('.tp-wheel-wrap').hidden = on;
    q<HTMLElement>('.tp-chips').hidden = on;
    q<HTMLElement>('.tp-edit').hidden = !on;
    if (on) {
      const input = q<HTMLInputElement>('#tp-input');
      input.value = `${p(hh)}:${p(mm)}`;
      input.focus();
      input.select();
    }
  };

  const applyInput = () => {
    const parsed = parseClock(q<HTMLInputElement>('#tp-input').value);
    if (parsed) { hh = parsed.hh; mm = parsed.mm; paint(); }
    setEditing(false);
  };

  el.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const cv = t.closest<HTMLElement>('.tp-cv');
    if (cv) {
      const trackEl = cv.closest<HTMLElement>('.tp-col')!;
      const which = trackEl.dataset.col as 'h' | 'm';
      col = which;
      const cells = [...trackEl.querySelectorAll('.tp-cv')];
      const delta = cells.indexOf(cv) - PAD;
      setCol(which, (which === 'h' ? hh : mm) + delta);
      return;
    }
    const colEl = t.closest<HTMLElement>('.tp-col');
    if (colEl) { col = colEl.dataset.col as 'h' | 'm'; return; }

    const act = t.closest<HTMLElement>('[data-tp]')?.dataset.tp;
    if (act === 'edit') { setEditing(true); return; }
    if (act === 'cancel') { close(); return; }
    if (act === 'ok') { onPick(`${p(hh)}:${p(mm)}`); close(); return; }
    if (act === 'now') { const d = new Date(); hh = d.getHours(); mm = d.getMinutes(); paint(); return; }
    if (act === 'hour') { mm = 0; paint(); return; }
    if (act === 'plus15') { const n = hh * 60 + mm + 15; hh = Math.floor(n / 60) % 24; mm = n % 60; paint(); return; }
    if (act === 'plus60') { hh = (hh + 1) % 24; paint(); return; }
  });

  el.addEventListener('input', (ev) => {
    if ((ev.target as HTMLElement).id !== 'tp-input') return;
    const parsed = parseClock((ev.target as HTMLInputElement).value);
    if (parsed) { hh = parsed.hh; mm = parsed.mm; paint(); }
  });

  el.addEventListener('keydown', (ev) => {
    if (editing) {
      if (ev.key === 'Enter') { ev.preventDefault(); applyInput(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); setEditing(false); }
      return;
    }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); setCol(col, (col === 'h' ? hh : mm) + 1); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); setCol(col, (col === 'h' ? hh : mm) - 1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); col = 'h'; }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); col = 'm'; }
    else if (ev.key === 'Enter') { ev.preventDefault(); onPick(`${p(hh)}:${p(mm)}`); close(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
  });

  el.addEventListener('wheel', (ev) => {
    if (editing) return;
    const colEl = (ev.target as HTMLElement).closest<HTMLElement>('.tp-col');
    if (!colEl) return;
    ev.preventDefault();
    const which = colEl.dataset.col as 'h' | 'm';
    col = which;
    setCol(which, (which === 'h' ? hh : mm) + (ev.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  paint();
  if (asModal) {
    mask = document.createElement('div');
    mask.className = `md-mask${isCompactViewport() ? ' sheet-mode' : ''}`;
    const dlg = document.createElement('div');
    dlg.className = 'md-dialog sm';
    dlg.innerHTML = '<div class="md-drag-bar"></div><div class="md-dialog-head"><h3>选择时刻</h3></div><div class="md-dialog-body"></div>';
    dlg.querySelector('.md-dialog-body')!.appendChild(el);
    mask.appendChild(dlg);
    mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(); });
    document.body.appendChild(mask);
  } else {
    openEl = el;
    place(el, anchor!);
    bindOutside(el, anchor!);
  }
  el.focus();
}

/** 跨端日期时间选择器：桌面传 anchor 就近展开，移动端以 M3 Bottom Sheet 呈现 */
export function openDateTimePicker(opts: {
  initial: number | null;
  now: number;
  anchor?: HTMLElement | null;
  modal?: boolean;
  title?: string;
  onPick: (at: number) => void;
}) {
  const { initial, now, anchor, title = '选择日期与时刻', onPick } = opts;
  const asModal = opts.modal || !anchor || isCompactViewport();
  if (!asModal) closeOpen();

  const pad = (n: number) => String(n).padStart(2, '0');
  const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const selected = new Date(initial ?? now + 3600_000);
  let hh = selected.getHours();
  let mm = selected.getMinutes();
  let viewY = selected.getFullYear();
  let viewM = selected.getMonth();

  const pop = document.createElement('div');
  pop.className = asModal ? 'dp-pop inline-modal' : 'dp-pop';

  let mask: HTMLElement | null = null;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    if (mask) { mask.remove(); mask = null; }
    else closeOpen();
  };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const commit = (at: number) => { onPick(at); close(); };
  const atTime = (d: Date, h: number, m: number) => {
    const x = new Date(d);
    x.setHours(h, m, 0, 0);
    return x;
  };

  const render = () => {
    const lead = new Date(viewY, viewM, 1).getDay();
    const total = new Date(viewY, viewM + 1, 0).getDate();
    const cells: string[] = [];
    for (let i = 0; i < lead; i++) cells.push('<span></span>');
    for (let d = 1; d <= total; d++) {
      const key = `${viewY}-${pad(viewM + 1)}-${pad(d)}`;
      const on = key === dateKey(selected);
      const isToday = key === dateKey(new Date(now));
      cells.push(`<button type="button" class="dp-day${on ? ' on' : ''}${isToday ? ' today' : ''}" data-day="${key}">${d}</button>`);
    }
    pop.innerHTML = `
      <div class="dp-quick">
        <button type="button" data-dp="today9">今天 9:00</button>
        <button type="button" data-dp="today18">今晚 18:00</button>
        <button type="button" data-dp="tomorrow9">明早 9:00</button>
        <button type="button" data-dp="tomorrow18">明晚 18:00</button>
        <button type="button" data-dp="week">下周一 9:00</button>
        <button type="button" data-dp="hour">1 小时后</button>
      </div>
      <div class="dp-month">
        <button type="button" class="wd-btn icon" data-dp="prev" aria-label="上个月">${ICO.chevronLeft(16)}</button>
        <b>${viewY} 年 ${viewM + 1} 月</b>
        <button type="button" class="wd-btn icon" data-dp="next" aria-label="下个月">${ICO.chevronRight(16)}</button>
      </div>
      <div class="dp-grid">
        ${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span class="dp-w">${w}</span>`).join('')}
        ${cells.join('')}
      </div>
      <div class="dp-time">
        <button type="button" class="dp-time-btn" id="dp-time-btn" data-v="${pad(hh)}:${pad(mm)}">
          <span>时刻 ${pad(hh)}:${pad(mm)}</span><span>${ICO.clock(16)}</span>
        </button>
      </div>
      <div class="dp-foot">
        <button type="button" class="wd-btn" data-dp="cancel">取消</button>
        <button type="button" class="wd-btn filled" data-dp="ok">确定</button>
      </div>`;
  };

  pop.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    const tb = t.closest<HTMLElement>('#dp-time-btn');
    if (tb) {
      openTimePicker(asModal ? null : tb, tb.dataset.v ?? '09:00', (v) => {
        const [h, m] = v.split(':').map(Number);
        hh = h; mm = m;
        render();
      }, { modal: asModal });
      return;
    }
    const day = t.closest<HTMLElement>('[data-day]');
    if (day) {
      const [y, m, d] = day.dataset.day!.split('-').map(Number);
      selected.setFullYear(y, m - 1, d);
      render();
      return;
    }
    const act = t.closest<HTMLElement>('[data-dp]')?.dataset.dp;
    if (!act) return;
    if (act === 'prev' || act === 'next') {
      viewM += act === 'next' ? 1 : -1;
      if (viewM < 0) { viewM = 11; viewY--; }
      if (viewM > 11) { viewM = 0; viewY++; }
      render();
      return;
    }
    if (act === 'cancel') { close(); return; }
    if (act === 'ok') { commit(atTime(selected, hh, mm).getTime()); return; }
    const base = new Date(now);
    if (act === 'tomorrow9' || act === 'tomorrow18') base.setDate(base.getDate() + 1);
    if (act === 'week') {
      const delta = (8 - base.getDay()) % 7 || 7;
      base.setDate(base.getDate() + delta);
    }
    if (act === 'hour') { commit(now + 3600_000); return; }
    const hour = act.endsWith('18') ? 18 : 9;
    const at = atTime(base, hour, 0);
    commit(at.getTime() <= now ? at.getTime() + 86400_000 : at.getTime());
  });

  render();
  if (asModal) {
    mask = document.createElement('div');
    mask.className = `md-mask${isCompactViewport() ? ' sheet-mode' : ''}`;
    const dlg = document.createElement('div');
    dlg.className = 'md-dialog sm';
    dlg.innerHTML = `<div class="md-drag-bar"></div><div class="md-dialog-head"><h3>${esc(title)}</h3></div><div class="md-dialog-body"></div>`;
    dlg.querySelector('.md-dialog-body')!.appendChild(pop);
    mask.appendChild(dlg);
    mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(); });
    document.body.appendChild(mask);
  } else {
    openEl = pop;
    place(pop, anchor!);
    bindOutside(pop, anchor!);
  }
}

/** 拆小步骤编辑对话框：支持改文字、删行、加行，两端统一 M3 外观 */
export function openStepsDialog(initial: StepEdit[]): Promise<StepEdit[] | null> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = `md-mask${isCompactViewport() ? ' sheet-mode' : ''}`;
    const dlg = document.createElement('div');
    dlg.className = 'md-dialog';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = `
      <div class="md-drag-bar"></div>
      <div class="md-dialog-head">
        <h3>${initial.some((s) => s.id) ? '编辑推进步骤' : '拆成小步骤'}</h3>
      </div>
      <p class="md-dialog-sub">把大事项拆成可立刻动手的小步。保存后一次生效，空行会自动忽略。</p>
      <div class="md-dialog-body"><div class="wd-steps" id="wd-steps"></div></div>
      <div class="md-dialog-foot">
        <button type="button" class="wd-btn tonal" id="wd-add">+ 添加一步</button>
        <span class="sp"></span>
        <button type="button" class="wd-btn" id="wd-cancel">取消</button>
        <button type="button" class="wd-btn filled" id="wd-save">保存</button>
      </div>`;
    mask.appendChild(dlg);

    const rows = dlg.querySelector<HTMLElement>('#wd-steps')!;
    const close = (value: StepEdit[] | null) => {
      document.removeEventListener('keydown', onKey);
      mask.remove();
      resolve(value);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);

    const addRow = (edit: StepEdit = { text: '' }, focus = false) => {
      const row = document.createElement('div');
      row.className = 'wd-step-row';
      row.dataset.stepId = edit.id ?? '';
      const input = document.createElement('input');
      input.className = 'wd-input';
      input.value = edit.text;
      input.placeholder = '这一步要做什么';
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          addRow({ text: '' }, true);
        }
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'wd-btn icon danger-text';
      del.innerHTML = ICO.close(16);
      del.title = '删掉这一行';
      del.setAttribute('aria-label', '删掉这一行');
      del.onclick = () => {
        if (rows.children.length > 1) row.remove();
        else input.value = '';
      };
      row.append(input, del);
      rows.appendChild(row);
      if (focus) input.focus();
    };

    initial.forEach((v) => addRow(v));
    if (!initial.length) addRow({ text: '' }, true);

    dlg.querySelector('#wd-add')!.addEventListener('click', () => addRow({ text: '' }, true));
    dlg.querySelector('#wd-cancel')!.addEventListener('click', () => close(null));
    dlg.querySelector('#wd-save')!.addEventListener('click', () => {
      const list: StepEdit[] = [];
      for (const row of Array.from(rows.children) as HTMLElement[]) {
        const text = row.querySelector('input')?.value.trim();
        if (!text) continue;
        const id = row.dataset.stepId;
        list.push(id ? { id, text } : { text });
      }
      close(list);
    });
    mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(null); });
    document.body.appendChild(mask);
  });
}

/** 延期选择：快捷档位 + 自定义日期时间，统一 M3 Dialog / Bottom Sheet */
export function openSnoozeDialog(opts: {
  title: string;
  now: number;
  onPick: (at: number) => void;
  onCustom?: (anchor: HTMLElement) => void;
}): void {
  const { title, now, onPick, onCustom } = opts;
  const mask = document.createElement('div');
  mask.className = `md-mask${isCompactViewport() ? ' sheet-mode' : ''}`;
  const dlg = document.createElement('div');
  dlg.className = 'md-dialog sm';
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');

  const fmt = (ts: number) => {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const dayAt = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const choices: Array<[string, number]> = [
    ['30 分钟后', now + 30 * 60_000],
    ['1 小时后', now + 60 * 60_000],
    ['2 小时后', now + 120 * 60_000],
    ['明天早上', dayAt(1)],
    ['3 天后', dayAt(3)],
    ['下周', dayAt(7)],
  ];

  dlg.innerHTML = `
    <div class="md-drag-bar"></div>
    <div class="md-dialog-head"><h3>${esc(title)}</h3></div>
    <div class="md-dialog-body"><div class="wd-list" id="wd-snooze"></div></div>
    <div class="md-dialog-foot"><button type="button" class="wd-btn" id="wd-cancel">取消</button></div>`;
  mask.appendChild(dlg);

  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  const list = dlg.querySelector<HTMLElement>('#wd-snooze')!;
  for (const [label, at] of choices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wd-list-btn';
    b.innerHTML = `<span>${label}</span><span class="sub">${fmt(at)}</span>`;
    b.onclick = () => { close(); onPick(at); };
    list.appendChild(b);
  }
  if (onCustom) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wd-list-btn accent';
    b.innerHTML = `<span>自定义日期时间…</span><span>${ICO.clock(16)}</span>`;
    b.onclick = () => {
      onCustom(b);
      close();
    };
    list.appendChild(b);
  }
  dlg.querySelector('#wd-cancel')!.addEventListener('click', close);
  mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(); });
  document.body.appendChild(mask);
}

/** M3 确认弹窗（替代原生 window.confirm，默认焦点在取消避免回车误删） */
export function openConfirmDialog(opts: {
  title: string;
  detail?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'md-mask';
    const dlg = document.createElement('div');
    dlg.className = 'md-dialog sm';
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = `
      <div class="md-dialog-head"><h3>${esc(opts.title)}</h3></div>
      ${opts.detail ? `<p class="md-dialog-sub">${esc(opts.detail)}</p>` : ''}
      <div class="md-dialog-foot">
        <button type="button" class="wd-btn" id="cf-cancel">${esc(opts.cancelText ?? '取消')}</button>
        <button type="button" class="wd-btn ${opts.danger ? 'danger' : 'filled'}" id="cf-ok">${esc(opts.confirmText ?? '确定')}</button>
      </div>`;
    mask.appendChild(dlg);

    const close = (ok: boolean) => {
      document.removeEventListener('keydown', onKey);
      mask.remove();
      resolve(ok);
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(false); };
    document.addEventListener('keydown', onKey);

    const cancelBtn = dlg.querySelector<HTMLButtonElement>('#cf-cancel')!;
    cancelBtn.onclick = () => close(false);
    dlg.querySelector<HTMLButtonElement>('#cf-ok')!.onclick = () => close(true);
    mask.addEventListener('mousedown', (ev) => { if (ev.target === mask) close(false); });
    document.body.appendChild(mask);
    cancelBtn.focus();
  });
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}
