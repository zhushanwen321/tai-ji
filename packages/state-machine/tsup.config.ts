import { defineConfig } from 'tsup'

export default defineConfig({
  // index 出口（内核：类型 + defineStateMachine + transition + coerceState）+
  // testing 子出口（generateTableTests——import vitest，与运行时出口隔离，
  // 消费方测试文件单独引 './testing'，运行时链路不触及 vitest）
  entry: ['src/index.ts', 'src/testing.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: false,
  // 零运行时依赖；vitest 是 optional peer（仅 testing 子出口触及），保持 external
  external: ['vitest'],
})
