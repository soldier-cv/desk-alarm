/**
 * 对比度检查。暗色主题最容易翻车的地方就是「深字配深底」，
 * 靠眼睛看不出 3:1 和 4.5:1 的区别，得算。
 *
 * WCAG 2.1：
 *   正文 < 18.66px 粗体 / < 24px 常规  → 4.5:1
 *   更大的字，以及 UI 控件边界         → 3:1
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

// 从 styles.css 的 :root 里读当前色板，改了样式就跑一次，别靠眼睛
const css = await (await import('node:fs/promises')).readFile('src/styles.css', 'utf8');
const root = css.match(/:root\s*\{([\s\S]*?)\}/)[1];
const token = {};
for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9A-Fa-f]{3,8})/g)) {
  token[m[1]] = m[2];
}

const BG = token.bg;
console.log(`底色 ${BG}\n`);

let bad = 0;
/** 正文类：字号小，必须 4.5:1 */
const text = (name, fg, min = 4.5, bg = BG) => {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (需 ${min})`);
};

/** UI 边界类：输入框、复选框这类轮廓，3:1 就够 */
const ui = (name, fg, bg = BG, min = 3) => {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) bad++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} ${fg} on ${bg}  ${r.toFixed(2)}:1  (需 ${min})`);
};

console.log('文字');
text('主文字 text', token.text);
text('次要 muted', token.muted);
text('弱化 dim', token.dim);
text('强调 flare', token.flare);
text('完成 ok', token.ok);

console.log('\nUI 边界');
ui('输入框边框 line-input', token['line-input']);
ui('控件边框 line-ctrl', token['line-ctrl']);

// 分隔线不是文字也不是控件，1.3:1 够用，只要不是完全看不见就行
ui('分隔线 line（宽松）', token.line, BG, 1.2);

console.log('\n输入框内部（文字压在 raised 上，不是 bg）');
text('输入框内正文', token.text, 4.5, token.raised);
text('placeholder', token.muted, 4.5, token.raised);
ui('输入框边框 vs 框内底', token['line-input'], token.raised, 1.5);

console.log(`\n${'--------------------------------------------'}`);
console.log(bad === 0 ? '全部达标' : `${bad} 项不达标`);
process.exit(bad === 0 ? 0 : 1);