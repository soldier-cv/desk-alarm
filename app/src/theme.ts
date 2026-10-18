/**
 * 主题。两套色板都写在 styles.css 的 :root 里，
 * 这里只负责往 <html> 上挂 data-theme 和记住用户的选择。
 */
export type Theme = 'dark' | 'morandi';

const KEY = 'deskalam.theme';

export const THEMES: Array<{ id: Theme; label: string; hint: string }> = [
  { id: 'dark', label: '暗色', hint: '近黑底 + 橙色强调，默认' },
  { id: 'morandi', label: '莫兰迪', hint: '暖灰纸感 + 陶土红，白天更好读' },
];

export function loadTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === 'morandi' ? 'morandi' : 'dark';
}

/**
 * 应用到 <html>。capture / takeover 也在读同一个属性，
 * 但它们是独立窗口，主窗口改完要通知它们刷新。
 */
export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
}

export function saveTheme(t: Theme) {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}
