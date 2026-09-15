import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// P0 coexistence spike 方案 B 实证：spike-dual-entry 独立 renderer 构建配置。
// 与现有 vite.config.ts 零交集（纯新增，不改现有文件，ES2）：
// - root 指向 spike-dual-entry/（index.html 在其下，script src 相对引用 ./main.ts）
// - outDir 落现有 renderer/dist 内子目录：.gitignore 全局 dist/ 规则自动覆盖（产物不进 git），
//   且生产形态 electron-builder files 的 renderer/dist/** 规则自然包含（静态评估更真实）
// - 不引 vue()/alias/tailwind 插件：占位入口纯 TS，最小复杂度
// - base './'：产物 index.html 用相对路径引用 assets（file:// 可加载）
export default defineConfig({
  root: resolve(__dirname, 'spike-dual-entry'),
  base: './',
  build: {
    outDir: resolve(__dirname, '../../apps/electron/renderer/dist/spike-dual-entry'),
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
  },
})
