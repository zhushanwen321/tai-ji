import path from 'node:path'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    // 数组形态按序匹配（vite 文档）。跨包集成测试（cross-package-subagent-core.test.ts）
    // 消费 @zhushanwen/subagent-core 未进 barrel 的内部符号（D3 判定不进），按
    // subagent-workflow vitest.config 同款正则把带 .ts 后缀的包名深路径重写到 core src
    // 物理路径——不依赖 package exports 的 `./*` 通配（u-2c 已删）；barrel（包根无路径段）
    // 不命中，走 workspace node 解析（exports "." → src/index.ts）。
    alias: [
      {
        find: /^@zhushanwen\/subagent-core\/(.+\.ts)$/,
        replacement: `${path.resolve(__dirname, '../../../packages/subagent-core/src')}/$1`,
      },
    ],
  },
})
