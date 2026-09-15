import { defineConfig } from 'vitest/config'

// core 是平台无关内核（headless），真零 DOM（ADR-0058：composer/input DOM 逻辑已迁 @taiji/dom-core）。
// 测试用 node 环境跑纯逻辑编排（bootstrap 时序/ES1 中断）。
// 无 vue plugin、无 happy-dom、无 coverage threshold（P0 骨架阶段，覆盖率随 P3 域迁移滚动校准）。
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    environment: 'node',
  },
})
