/**
 * 对比度检查。暗色主题最容易翻车的地方就是「深字配深底」，
 * 浅色主题反过来是「浅字配浅底」。靠眼睛看不出 3:1 和 4.5:1 的差别，得算。
 *
 * WCAG 2.1：
 *   正文 < 18.66px 粗体 / < 24px 常规  → 4.5:1
 *   更大的字，以及 UI 控件边界         → 3:1
 *
 * 两套主题都检查：:root 是暗色，:root[data-theme="morandi"] 是莫兰迪。
 *
 * 用法：node scripts/contrast.mjs
 */
const hex = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};

/** sRGB → 相对亮度 */
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

// 从 styles.css 里读两套色板。一个是 :root，一个是 :root[data-theme="morandi"]
const css = await (await import('node:fs/promises')).readFile('src/styles.css', 'utf8');

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

for (const [name, token] of palettes) {
  const BG = token.bg;
  console.log(`\n=============== ${name}  底色 ${BG} ===============`);

  /** 正文类：字号小，必须 4.5:1 */
  const text = (label, fg, min = 4.5, bg = BG) => {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (需 ${min})`);
  };

  /** UI 边界类：输入框、复选框这类轮廓，3:1 就够 */
  const ui = (label, fg, bg = BG, min = 3) => {
    const r = ratio(fg, bg);
    const ok = r >= min;
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(24)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (需 ${min})`);
  };

  console.log('  文字');
  text('主文字 text', token.text);
  text('次要 muted', token.muted);
  text('弱化 dim', token.dim);
  text('强调文字 flare-text', token['flare-text']);
  text('完成 ok', token.ok);
  text('危险文字 danger-text', token['danger-text']);
  text('警告文字 warn-text', token['warn-text']);
  text('热 chip 文字', token['chip-hot-text'], 4.5, token.field);

  console.log('  UI 边界');
  ui('输入框边框 line-input', token['line-input']);
  ui('控件边框 line-ctrl', token['line-ctrl']);
  // 分隔线不是文字也不是控件，1.2:1 够用，只要不是完全看不见
  ui('分隔线 line（宽松）', token.line, BG, 1.2);

  console.log('  输入框内部（文字压在 raised 上，不是 bg）');
  text('输入框内正文', token.text, 4.5, token.raised);
  text('placeholder', token.muted, 4.5, token.raised);
  ui('输入框边框 vs 框内底', token['line-input'], token.raised, 1.5);

  // 实心按钮：文字压在整个块上，白字配亮色最容易低对比
  console.log('  实心块上的字');
  text('按钮字 on accent', token['on-flare'], 4.5, token.flare);
  text('按钮字 on ok', token['on-flare'], 4.5, token.ok);

  // 选中 / hover 是换了底色，文字色不变，要重新算
  console.log('  状态底色上的文字');
  text('选中行文字 on raised', token.text, 4.5, token.raised);
  text('hover 文字 on hover', token.muted, 4.5, token.hover);
  text('强调 on surface', token['flare-text'], 4.5, token.surface);
  text('分段选中文字 on raised-strong', token.text, 4.5, token['raised-strong']);
}

console.log(`\n${'--------------------------------------------'}`);
console.log(bad === 0 ? '两套主题全部达标' : `${bad} 项不达标`);
process.exit(bad === 0 ? 0 : 1);
