import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  // node:/bun: 是运行时 builtin（node:sqlite / bun:sqlite），esbuild platform=node
  // 自动 external；动态 import 均经变量间接（sqlite-driver.ts），无静态可解析字面量。
  external: [],
})
