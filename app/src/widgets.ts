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

const ROW = 34;
const PAD = 2; // 上下各补两格，让两端也有内容可滚，不会露出空白

function clockHint(hh: number, mm: number): string {
  const period = hh < 5 ? '凌晨' : hh < 11 ? '上午' : hh < 13 ? '中午' : hh < 18 ? '下午' : '晚上';
  return `${period} ${hh} 点${mm ? ` ${mm} 分` : '整'}`;
}

/** "23:30 / 晚上8点 / 下午3:15" -> HH:MM。解析不了返回 null */
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

/**
 * 自绘时间选择。HH:MM，任意分钟可选。滚轮 + 顶部输入 + 常用快捷。
 * 一次建 DOM，之后只改 transform，不重建列表（重建会让选中项跳动）。
 */
export function openTimePicker(
  anchor: HTMLElement,
  value: string,
  onPick: (value: string) => void,
) {
  closeOpen();
  const [h0, m0] = value.split(':').map(Number);
  let hh = Number.isFinite(h0) ? h0 : 0;
  let mm = Number.isFinite(m0) ? m0 : 0;
  const p = (n: number) => String(n).padStart(2, '0');

  const el = document.createElement('div');
  el.className = 'dp-pop tp-pop';
  el.tabIndex = -1;
  openEl = el;

  // 环形补格：i=-2..total+1，data-i 是取模后的真实值
  const track = (total: number) => {
    let out = '';
    for (let i = -PAD; i < total + PAD; i++) {
      const v = ((i % total) + total) % total;
      out += `<div class="tp-cv" data-i="${v}">${p(v)}</div>`;
    }
    return out;
  };

  el.innerHTML = `
    <div class="tp-top">
      <button class="tp-read" data-tp="edit" title="点击直接输入">
        <span class="tp-time" id="tp-time"></span>
        <span class="tp-ampm" id="tp-ampm"></span>
      </button>
      <div class="tp-hint" id="tp-hint"></div>
    </div>
    <div class="tp-edit" hidden>
      <input class="tp-input" id="tp-input" placeholder="23:30 / 晚上8点" />
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
      <button class="tp-chip" data-tp="now">现在</button>
      <button class="tp-chip" data-tp="hour">整点</button>
      <button class="tp-chip" data-tp="plus15">+15 分</button>
      <button class="tp-chip" data-tp="plus60">+1 小时</button>
    </div>
    <div class="dp-foot">
      <button class="btn sm" data-tp="cancel">取消</button>
      <button class="btn solid sm" data-tp="ok">确定</button>
    </div>`;

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
      const delta = cells.indexOf(cv) - PAD; // 第 2 行（索引 PAD）是选中位
      const cur = which === 'h' ? hh : mm;
      setCol(which, cur + delta);
      return;
    }
    const colEl = t.closest<HTMLElement>('.tp-col');
    if (colEl) { col = colEl.dataset.col as 'h' | 'm'; return; }

    const act = t.closest<HTMLElement>('[data-tp]')?.dataset.tp;
    if (act === 'edit') { setEditing(true); return; }
    if (act === 'cancel') { closeOpen(); return; }
    if (act === 'ok') { onPick(`${p(hh)}:${p(mm)}`); closeOpen(); return; }
    if (act === 'now') {
      const d = new Date(); hh = d.getHours(); mm = d.getMinutes(); paint(); return;
    }
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
    const key = ev.key;
    if (editing) {
      if (key === 'Enter') { ev.preventDefault(); applyInput(); }
      else if (key === 'Escape') { ev.preventDefault(); setEditing(false); }
      return;
    }
    if (key === 'ArrowUp') { ev.preventDefault(); setCol(col, (col === 'h' ? hh : mm) + 1); }
    else if (key === 'ArrowDown') { ev.preventDefault(); setCol(col, (col === 'h' ? hh : mm) - 1); }
    else if (key === 'ArrowLeft') { ev.preventDefault(); col = 'h'; }
    else if (key === 'ArrowRight') { ev.preventDefault(); col = 'm'; }
    else if (key === 'Enter') { ev.preventDefault(); onPick(`${p(hh)}:${p(mm)}`); closeOpen(); }
    else if (key === 'Escape') { ev.preventDefault(); closeOpen(); }
  });

  // 滚轮切值。需要 passive:false 才能 preventDefault，否则弹层后面的页面会跟着滚
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
  place(el, anchor);
  bindOutside(el, anchor);
  el.focus();
}

/**
 * 拆小步骤输入。逐行录入，Enter 追加新行；三处入口共用，避免各写一份 prompt。
 */
export function openStepsDialog(initial: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '9999', background: 'rgba(0,0,0,.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      background: 'var(--card, #fff)', color: 'var(--foreground, inherit)',
      borderRadius: '12px', padding: '18px', width: 'min(440px, 100%)',
      maxHeight: '90vh', overflow: 'auto', boxShadow: '0 12px 40px rgba(0,0,0,.35)',
    });
    box.innerHTML = `
      <h3 style="margin:0 0 6px">拆成小步骤</h3>
      <p class="hint" style="margin:0 0 12px">每行一步，按 Enter 加新行；空行会忽略。</p>`;
    const rows = document.createElement('div');
    rows.style.display = 'grid';
    rows.style.gap = '8px';
    box.appendChild(rows);

    const close = (value: string[] | null) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close(null);
    };
    document.addEventListener('keydown', onKey);

    const addRow = (value = '', focus = false) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.gap = '8px';
      const input = document.createElement('input');
      input.className = 'input';
      input.value = value;
      input.placeholder = '这一步要做什么';
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          addRow('', true);
        }
      });
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn sm ghost';
      del.textContent = '×';
      del.title = '删掉这一行';
      del.onclick = () => {
        if (rows.children.length > 1) row.remove();
        else input.value = '';
      };
      row.append(input, del);
      rows.appendChild(row);
      if (focus) input.focus();
    };

    initial.forEach((v) => addRow(v));
    if (!initial.length) addRow('', true);

    const actions = document.createElement('div');
    actions.className = 'set-actions';
    actions.style.marginTop = '14px';
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn sm';
    add.textContent = '+ 添加一行';
    add.onclick = () => addRow('', true);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn sm ghost';
    cancel.textContent = '取消';
    cancel.onclick = () => close(null);
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn solid sm';
    save.textContent = '保存';
    save.onclick = () => {
      const list = [...rows.querySelectorAll('input')]
        .map((i) => i.value.trim()).filter(Boolean);
      close(list.length ? list : null);
    };
    actions.append(add, cancel, save);
    box.appendChild(actions);
    overlay.appendChild(box);
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close(null);
    });
    document.body.appendChild(overlay);
  });
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  ));
}
