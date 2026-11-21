import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';

// 四个入口：桌面三窗口 + 独立移动端页面。
export default defineConfig({
  plugins: [tailwindcss()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'chrome110', // WebView2 在 Win10 上最低这个版本
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        takeover: resolve(__dirname, 'takeover.html'),
        capture: resolve(__dirname, 'capture.html'),
        mobile: resolve(__dirname, 'mobile.html'),
      },
    },
  },
});
