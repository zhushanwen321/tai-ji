import { defineConfig } from 'tsup'

// 单 entry：全部消费方（session-reader / runtime 导入薄包装 / zcode source 包）都从
// 根路径导入，无子路径导出面——多 entry 会制造无消费方的产物面。零运行时依赖，
// 不需要 external（session-delivery 先例同款）。
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  external: [],
})
