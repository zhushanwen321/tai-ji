// scheduler-manager 插件单测配置（MF-1-7 首批装配）。
// resources/plugins 不在 pnpm workspace——import 一律走相对路径直指源码/仓库根设施
// （裸包名在该目录链上无 node_modules 可解析，同 index.ts 头注的根因说明）。
// root 钉在本目录（taste-lint/vitest.config.ts 同款先例）：include 以 config 所在
// 目录为基准解析，无论从仓库根（根 package.json test:resources-plugins --config 指入）
// 还是从本插件目录直接跑（coverage-gate run_coverage cwd），收集面一致、不依赖 cwd。
// 防线纪律：全仓所有 vitest.config.ts 必须经仓库根 test-guard/factory 的 taijiTestConfig
// 包装（TAIJI_AGENT_DATA_DIR 钉死 tmp + fs-guard 切面），漏挂由
// scripts/check-vitest-guard.mjs 拦截（SCAN_ROOTS 已含 resources）。
import { fileURLToPath } from 'node:url'
import { taijiTestConfig } from '../../../test-guard/factory.ts'

export default taijiTestConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['__tests__/**/*.test.ts'],
  },
})
