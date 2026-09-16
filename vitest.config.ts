import { defaultExclude } from 'vitest/config'
import { taijiTestConfig } from './test-guard/factory.ts'

// 仓库根兜底 vitest 配置：从仓库根 cwd 跑 vitest、或从无 config 的子目录裸跑 vitest
// （root 向上逃逸到仓库根）时的防线兜底。[HISTORICAL] 2026-09-16 prod 数据目录删除事故：
// mis-run 形态的全仓 vitest 在无根 config 时以「默认配置、零防线」扫全仓，runtime 测试
// 组按默认推导删光用户真实 ~/.taiji——根级兜底使该形态命中本 config，防线注入后全仓安全。
// 根级入口 = 唯一合法的全仓跑测入口；单包/单文件日常入口仍是各包 cwd（各自 config 均
// 经 taijiTestConfig 挂防线，守卫 scripts/check-vitest-guard.mjs 拦漏挂）。
// exclude：e2e/ 是 playwright 领地（非 vitest 执行器）；taste-lint/ 是独立工具链；
// 各包 **/e2e/ 是真实 pi / 真实 LLM 的门控验收资产（e2e 执行准则：按改动面触发），
// 从根跑全仓单测时不得误扫——误扫既打红（e2e 产物写包目录被 guard 拦）又有误触发
// 真实 LLM 消耗的风险。
export default taijiTestConfig({
  test: {
    reporters: ['default', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    exclude: [...defaultExclude, 'e2e/**', 'taste-lint/**', '**/e2e/**'],
  },
})
