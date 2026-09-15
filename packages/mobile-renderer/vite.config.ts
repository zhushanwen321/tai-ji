import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// mobile-renderer 独立构建入口（W1 scaffolding）。桌面 renderer 的构建
// 编排（NEW_ARCH flag / E2E define / electron outDir）不适用——移动壳独立
// dev/build，产物出本包 dist/。
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    // 与桌面 renderer 的 1420 错开：两台壳无共享 dev server，且 multi-worktree
    // 同时 dev 时 strictPort 冲突会静默失败（AGENTS.md 已知坑）。
    port: 1421,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
