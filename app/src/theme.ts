/**
 * 主题。两套 M3 色板统一定义在 tokens.css，
 * 这里负责挂 data-theme、持久化选择并同步移动端系统栏 theme-color。
 */
export type Theme = 'dark' | 'morandi';

const KEY = 'deskalam.theme';

export const THEMES: Array<{ id: Theme; label: string; hint: string; surface: string }> = [
  { id: 'dark', label: '暗色', hint: '深碳基底 + 警示橙，默认', surface: '#0E1012' },
  { id: 'morandi', label: '莫兰迪', hint: '暖灰纸感 + 陶土红，白天更好读', surface: '#EFECE6' },
];

export function loadTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return t === 'morandi' ? 'morandi' : 'dark';
}

export function applyTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = t === 'morandi' ? '#EFECE6' : '#0E1012';
  }
}

export function saveTheme(t: Theme) {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}
