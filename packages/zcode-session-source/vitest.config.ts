import { taijiTestConfig } from '../../test-guard/factory.ts'

// 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig）——[HISTORICAL]
// 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
// 同一断言集在 node/bun 下各跑一遍（D3 源级双跑）：node 趟走 node:sqlite 驱动路径，
// bun 趟（bunx vitest run，挂 pre-commit/CI）走 bun:sqlite 驱动路径。
export default taijiTestConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
})
