import { defaultExclude } from 'vitest/config'
import { taijiTestConfig, guardProjectSetup } from '../../test-guard/factory.ts'

// 防线经仓库根 test-guard/factory 统一注入（taijiTestConfig）——[HISTORICAL]
// 2026-09-02 会话丢失事故双层防线 + 2026-09-16 prod 数据目录删除事故升级为仓库级强制。
// 同一断言集在 node/bun 下各跑一遍（D3 源级双跑）：node 趟走 node:sqlite 驱动路径，
// bun 趟（bunx vitest run，挂 pre-commit/CI）走 bun:sqlite 驱动路径。
//
// ── 两轨分工（unit / slow-sqlite，照 packages/runtime/vitest.config.ts 三池模式）────
//
// 调度契约（vitest 4.1.9，权威源 node_modules/vitest 的 groupSpecs()）：fileParallelism:
// false 的 project 解析为单 worker、进入 sequential 尾组；task groups 之间严格串行——
// unit 轨完整结束、worker 全部释放后，slow-sqlite 轨文件才逐个以单 worker 执行，零时间
// 重叠。入口命令不变（`vitest run` / bun 趟 check-bun-driver 均不改）；分组只影响调度，
// 不影响跑哪些用例；组内用例各自的 skip 门控照常生效。
//
// - **unit**：SLOW_SQLITE_TESTS 登记文件外的全部测试，默认满并行 + vitest 默认 testTimeout
//   （5s）——单测层定位是「只测逻辑、高负载下也极快」（判据见
//   docs/TEST-STRATEGY.md「新写测试判据」节），默认轨不放宽预算。
// - **slow-sqlite**：真实 sqlite I/O 慢文件（WAL 恢复阶梯 / 错误契约，单条 1.5-2.4s，
//   插桩 + 全仓并行负载下实测最长 ~11s），串行尾组隔离 + 组级 testTimeout 30s；组内
//   用例经 TAIJI_TEST_INTEGRATION 门控（SSOT = test-guard/integration-gate.ts）本地默认
//   跳过、CI 或显式 env 真跑——约定见 docs/TEST-STRATEGY.md「集成测试门控约定」。
//
// 维护契约：
// - 新增「真实 sqlite 大 IO / 损坏恢复语义」测试文件 → 路径同步加入 SLOW_SQLITE_TESTS
//   （该数组同时喂 slow-sqlite 轨的 include 与 unit 轨的 exclude，漏加 = 文件落回 unit
//   满并行轨）；文件内用例挂 describe.skipIf(!INTEGRATION_TESTS_ENABLED) 门控。
// - 纯逻辑 / 内存桩用例不加门控、不登记本表，留 unit 轨。
// - 各 project 的防线（fs-guard + env-purity）经 guardProjectSetup 显式挂载——vitest
//   projects 语义下 project 内 setupFiles 不继承 root 级，漏挂由
//   scripts/check-vitest-guard.mjs 第 5 条拦截。

/** slow-sqlite 串行尾组登记表：真实 sqlite I/O 慢文件（门控 + 串行隔离，见文件头）。 */
const SLOW_SQLITE_TESTS = [
  // 四级恢复阶梯（WAL 留证 / 平台矩阵 / L3 快照拷贝）——sqlite 损坏与 WAL 恢复语义，
  // mock 不可替代（整治清单判 a 类）
  'src/__tests__/recovery.test.ts',
  // 错误注入 + 真库容错（parseRowData 契约 / candidatesByteSize / 假驱动错误收尾）
  'src/__tests__/error-contract.test.ts',
] as const

export default taijiTestConfig({
  test: {
    projects: [
      {
        // unit 轨：慢文件外全部测试，默认满并行 + 默认 testTimeout（与拆轨前满并行行为一致）
        test: guardProjectSetup({
          name: 'unit',
          include: ['src/__tests__/**/*.test.ts'],
          exclude: [...defaultExclude, ...SLOW_SQLITE_TESTS],
        }),
      },
      {
        // slow-sqlite 轨：真实 sqlite I/O 慢文件，文件间串行、unit 轨结束后才开跑；
        // 组内用例本地不设 TAIJI_TEST_INTEGRATION 时经 describe.skipIf 跳过
        test: guardProjectSetup({
          name: 'slow-sqlite',
          include: [...SLOW_SQLITE_TESTS],
          fileParallelism: false,
          testTimeout: 30000,
        }),
      },
    ],
  },
})
