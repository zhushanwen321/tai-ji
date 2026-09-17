import { taijiTestConfig } from '../../test-guard/factory.ts'

// apps/electron 壳包（@taiji/electron）的 vitest 防线挂载点。本包 package.json 的 test
// script 委托 main/（cd main && vitest run，legacy 池跨目录收集本包 scripts/__tests__），
// 本 config 不改变该执行入口；存在意义 = check-vitest-guard 守卫要求的防线挂载点 +
// 从本包 cwd 直接跑 vitest 时 scripts/__tests__ 的防线齐备入口（test-guard factory 注入）。
export default taijiTestConfig({
  test: {
    include: ['scripts/__tests__/**/*.test.mjs'],
  },
})
