import { taijiTestConfig } from './factory.ts'

// 防线自身的元测试（fs-guard.test.ts）：在被 fs-guard 拦截的 worker 里验证 guard 判定，
// 同样经工厂挂防线——实现与元测试同目录，防线语义自洽。
export default taijiTestConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    include: ['*.test.ts'],
  },
})
