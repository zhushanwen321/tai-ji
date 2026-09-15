import { defineConfig } from 'vitest/config'

// dom-core 是 DOM-bound 前端逻辑（composer/input 等），测试用 jsdom 环境。
// 与 core 的 node 环境（真 headless，ADR-0058）形成明确分层。
export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
