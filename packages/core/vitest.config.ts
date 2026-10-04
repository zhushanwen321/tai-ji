import { taijiTestConfig } from '../../test-guard/factory.ts'

// core 是平台无关内核（headless），真零 DOM（ADR-0058：composer/input DOM 逻辑已迁 @taiji/dom-core）。
// 测试用 node 环境跑纯逻辑编排（bootstrap 时序/ES1 中断）。
// 无 vue plugin、无 happy-dom、无 coverage threshold（P0 骨架阶段，覆盖率随 P3 域迁移滚动校准）。
export default taijiTestConfig({
  test: {
    environment: 'node',
    // 用例级耗时报告（docs/TEST-STRATEGY.md 统一约定：default + junit 落盘，慢用例用 grep/sort 排查）
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
  },
})
