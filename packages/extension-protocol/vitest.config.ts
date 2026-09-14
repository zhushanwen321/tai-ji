import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 每次运行自动落盘用例级耗时报告（junit 的 testcase/@time 即单个用例耗时，
    // 秒；default 保留终端输出）——项目 vitest 统一约定，见根 AGENTS.md 测试章。
    reporters: ['default', 'junit'],
    outputFile: {
      junit: './test-results/vitest-junit.xml',
    },
  },
})
