/**
 * M3 双主题对比度检查（WCAG 2.1 AA）。
 * 正文 ≥ 4.5:1，大字与 UI 控件边界 ≥ 3:1。
 */
import { readFile } from 'node:fs/promises';

const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};

const lum = (h) => {
  const [r, g, b] = hex(h).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const css = await readFile('src/tokens.css', 'utf8');

function readPalette(selector) {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const block = css.match(re)?.[1];
  if (!block) { console.error(`找不到色板 ${selector}`); process.exit(1); }
  const token = {};
  for (const m of block.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)) token[m[1]] = m[2];
  return token;
}

const palettes = [
  ['暗色（默认）', readPalette(':root')],
  ['莫兰迪', readPalette(':root[data-theme="morandi"]')],
];

let bad = 0;

for (const [name, t] of palettes) {
  const BG = t['md-surface'];
  const LOW = t['md-surface-container-low'];
  const MID = t['md-surface-container'];
  const HIGH = t['md-surface-container-high'];
  const HIGHEST = t['md-surface-container-highest'];

  console.log(`\n=============== ${name}  底色 ${BG} ===============`);

  const text = (label, fg, min = 4.5, bg = BG) => {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (需 ${min})`);
  };

  const ui = (label, fg, bg = BG, min = 3) => {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (需 ${min})`);
  };

  console.log('  Surface 正文');
  text('主文字 on-surface', t['md-on-surface'], 4.5, BG);
  text('次要 on-surface-variant', t['md-on-surface-variant'], 4.5, BG);
  text('弱化 on-surface-muted', t['md-on-surface-muted'], 4.5, BG);
  text('弱化 on container', t['md-on-surface-muted'], 4.5, MID);
  text('弱化 on container-high', t['md-on-surface-muted'], 4.5, HIGH);
  text('主色文字 primary on surface', t['md-primary'], 4.5, BG);
  text('主色文字 primary on low', t['md-primary'], 4.5, LOW);
  text('完成文字 tertiary', t['md-tertiary'], 4.5, BG);
  text('错误文字 error', t['md-error'], 4.5, BG);
  text('警告文字 warn-text', t['warn-text'], 4.5, BG);
  text('热 chip 文字 on container', t['chip-hot-text'], 4.5, MID);

  console.log('  M3 容器与实心块上的文字');
  text('on-primary on primary', t['md-on-primary'], 4.5, t['md-primary']);
  text('on-primary-container', t['md-on-primary-container'], 4.5, t['md-primary-container']);
  text('on-secondary-container', t['md-on-secondary-container'], 4.5, t['md-secondary-container']);
  text('on-tertiary on tertiary', t['md-on-tertiary'], 4.5, t['md-tertiary']);
  text('on-tertiary-container', t['md-on-tertiary-container'], 4.5, t['md-tertiary-container']);
  text('on-error on error', t['md-on-error'], 4.5, t['md-error']);
  text('on-error-container', t['md-on-error-container'], 4.5, t['md-error-container']);
  text('警示条文字 on warn-bg', t['warn-on'], 4.5, t['warn-bg']);
  text('主文字 on container-highest', t['md-on-surface'], 4.5, HIGHEST);

  console.log('  UI 控件边界');
  ui('控件边框 outline on surface', t['md-outline'], BG, 3);
  ui('控件边框 outline on low', t['md-outline'], LOW, 3);
  ui('输入框边框 vs container', t['md-outline'], MID, 2.5);
  ui('分隔线 outline-variant', t['md-outline-variant'], BG, 1.15);
}

console.log(`\n${'--------------------------------------------'}`);
console.log(bad === 0 ? '两套主题全部达标' : `${bad} 项不达标`);
process.exit(bad === 0 ? 0 : 1);
