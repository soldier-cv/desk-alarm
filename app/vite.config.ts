import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 三个窗口三个入口。Tauri 里每个窗口有自己的 url，
// 这里对应 tauri.conf.json 里 windows[].url 的设置。
export default defineConfig({
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
      },
    },
  },
});
