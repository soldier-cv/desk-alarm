/**
 * 统一 24x24 线性 SVG 图标集（Material Symbols 风格，stroke-width 1.8）。
 * 桌面端与 Android 端共用，避免跨平台 Unicode 字符尺寸和对齐漂移。
 */
function svg(body: string, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export const ICO = {
  today: (s = 20) => svg('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M16 3v4M8 3v4M3 10h18"/><circle cx="12" cy="15" r="1.5" fill="currentColor" stroke="none"/>', s),
  todo: (s = 20) => svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none"/>', s),
  stats: (s = 20) => svg('<path d="M4 20h16"/><rect x="6" y="12" width="3" height="8" rx="1"/><rect x="11" y="8" width="3" height="12" rx="1"/><rect x="16" y="4" width="3" height="16" rx="1"/>', s),
  done: (s = 20) => svg('<circle cx="12" cy="12" r="9"/><path d="m8.5 12.2 2.4 2.4 4.8-5"/>', s),
  archive: (s = 20) => svg('<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5"/><path d="M10 13h4"/>', s),
  token: (s = 20) => svg('<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21M17.5 12v3M20.5 12v2.5"/>', s),
  dashboard: (s = 20) => svg('<rect x="3" y="3" width="7.5" height="8.5" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.8"/><rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.8"/><rect x="3" y="14.5" width="7.5" height="6.5" rx="1.8"/>', s),
  settings: (s = 20) => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03Z"/>', s),
  add: (s = 20) => svg('<path d="M12 5v14M5 12h14"/>', s),
  bolt: (s = 14) => svg('<path d="M13 2 4.5 13.2h6.3L9.8 22 19.5 10.5h-6.3z" fill="currentColor" stroke="none"/>', s),
  check: (s = 16) => svg('<path d="M5 12.5 9.5 17 19 7.5"/>', s),
  clock: (s = 16) => svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>', s),
  split: (s = 16) => svg('<path d="M4 6h16M4 12h10M4 18h7"/><path d="M16 15l3 3-3 3"/>', s),
  clone: (s = 16) => svg('<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>', s),
  trash: (s = 16) => svg('<path d="M4 7h16M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/><path d="M6.5 7l.8 12.2A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.8L17.5 7"/>', s),
  reopen: (s = 16) => svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>', s),
  close: (s = 18) => svg('<path d="M6 6l12 12M18 6 6 18"/>', s),
  back: (s = 20) => svg('<path d="M15 18l-6-6 6-6"/>', s),
  chevronDown: (s = 16) => svg('<path d="M6 9l6 6 6-6"/>', s),
  chevronLeft: (s = 16) => svg('<path d="M15 18l-6-6 6-6"/>', s),
  chevronRight: (s = 16) => svg('<path d="M9 18l6-6-6-6"/>', s),
  panelCollapse: (s = 18) => svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>', s),
  sun: (s = 18) => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', s),
  moon: (s = 18) => svg('<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a6.8 6.8 0 0 0 11 11Z"/>', s),
  update: (s = 18) => svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 17v3h16v-3"/>', s),
  logout: (s = 18) => svg('<path d="M10 17l-5-5 5-5"/><path d="M5 12h11"/><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/>', s),
  link: (s = 14) => svg('<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>', s),
  folder: (s = 14) => svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>', s),
  device: (s = 16) => svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>', s),
  alert: (s = 18) => svg('<path d="M12 3 2.5 19.5h19L12 3Z"/><path d="M12 9v4.5M12 16.5h.01"/>', s),
};
