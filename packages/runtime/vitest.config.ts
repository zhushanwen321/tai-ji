import { defaultExclude } from 'vitest/config'
import { taijiTestConfig, guardProjectSetup } from '../../test-guard/factory.ts'

/**
 * vitest 分池维护契约（三池：main 满并行组 / real-pi 串行尾组 / integration 串行尾组）。
 *
 * 调度契约（vitest 4.1.9，权威源 node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js groupSpecs()）：
 * - `fileParallelism: false` 在配置解析层强制 `maxWorkers = 1`；`maxWorkers === 1` + 默认
 *   isolate/groupOrder 的文件进入 sequential 尾组（groups.push(sequential) 排在最后）。
 * - task groups 之间 `for...of` + `await Promise.allSettled` 严格串行：主组（main）满并行
 *   **完整结束、worker 全部释放后**，串行尾组文件才逐个以单 worker 执行——零时间重叠。
 * - `poolOptions.forks.singleFork`（vitest 2/3 形态）在 vitest 4 已移除，勿再使用。
 * 入口命令不变（`npx vitest run` / scripts/pr-pre-merge.sh 不改）；分组只影响调度，不影响
 * 跑哪些用例；组内用例各自的 skip 门控（REAL_PI_READY / TAIJI_TEST_INTEGRATION）照常生效。
 *
 * 三池分工与建池理由：
 * - **main**：除两个尾组登记文件外的全部测试，保持默认满并行。
 * - **real-pi**：真实 pi + 真实 LLM turn 的 equivalence 用例。建池理由 = 真实 LLM 轮次的
 *   长等待窗口在 CPU 饱和下被饿死（单跑 15.8s 的用例满并行下 301s 顶满超时，19 倍差距，
 *   事件流证明 LLM 轮次在推进、非死锁），故结构性隔离；组内用例另经 REAL_PI_READY 门控，
 *   无凭证环境自动 skip。
 * - **integration**：集成测试门控组（env 开关 SSOT = test-guard/integration-gate.ts 的
 *   TAIJI_TEST_INTEGRATION）——本地默认跳过、CI 或按改动范围触发时真跑的真进程 / 真 IO
 *   用例（spawn 真 pi 进程 + 真 extension jiti 冷编译、真实 chokidar fs.watch、跨进程
 *   spawn 等）。建池理由 = 这些用例测的是「代码 + OS 组合行为」，没有确定性完成信号可等，
 *   负载下拉长无稳定上界，不满足单测层「只测逻辑、高负载下也极快」的定位（判据与整治
 *   清单见 docs/TEST-STRATEGY.md「新写测试判据」节）；与 real-pi 的分界 = 是否需要真实 LLM
 *   凭证（本池不依赖凭证，故可进 CI）。
 *
 * 维护契约：
 * - 新增「真实 pi + 真实 LLM turn」的 equivalence 测试 → 文件路径同步加入 REAL_PI_TESTS
 *   （漏加会落回 main 满并行组，复发饿死超时）；纯 mock / fixture 重放用例不加。
 * - 新增「真进程 / 真 IO / 真实挂钟窗口」的集成用例 → 两种形态二选一：① 整文件都是门控
 *   用例 → 路径加入 INTEGRATION_TESTS（该数组同时喂 integration project 的 include 与
 *   main project 的 exclude，漏加 = 文件落回 main 满并行组）；② 文件内只有部分用例需门控
 *   → 文件留在 main 组，用 `describe.skipIf(!INTEGRATION_TESTS_ENABLED)` 包裹（用例级
 *   门控）。选型判据 = 文件内是否还有快用例值得留在默认组。
 * - faux LLM 层用例（spawnPiFixture 传 fauxResponses：真 pi 进程 + 真 extension 加载 + 假 LLM，
 *   门控 FAUX_PI_READY）**不进 real-pi 池**——该池的存在理由是真实 LLM 轮次的长等待窗口
 *   在 CPU 饱和下饿死，faux 轮次是毫秒级本地计算、零网络，该模式结构性不存在。但 faux 层
 *   被整治清单判为「移出单测层」时进 integration 池（文件级集成组），门控改用
 *   TAIJI_TEST_INTEGRATION。
 * - 防线（globalSetup env 固定 + fs-guard 切面）经 test-guard/factory 顶层注入；
 *   projects 内 setupFiles **不**继承 root 级（vitest projects 语义，实测 setup 0ms 不执行），
 *   故各 project 经 guardProjectSetup 显式挂 FS_GUARD_PATH + ENV_PURITY_PATH（globalSetup
 *   无此问题，root 级对所有 project 生效）。新 project 漏挂由 scripts/check-vitest-guard.mjs
 *   第 5 条拦截。
 */
const REAL_PI_TESTS = [
  // L2.5 二批（2026-09-15）后：全部「真实 pi + 真实 LLM turn」equivalence 用例已迁组
  // faux（见上方维护契约）。数组保留为注册位——新增真实 LLM 层文件必须登记于此
  // （检查 session-manager-e2e-fixture-unit.test.ts 双向 diff）。
  // [2026-10-20 state-machine-infrastructure u-m1] session-manager-full-e2e（faux 层
  // 7 用例 + session-manager-archive-delete U9 加入的真 LLM 层 3 用例——经
  // REAL_PI_READY 门控，无凭证环境自动 skip；双 spawn + 真 extension jiti 冷编译）
  // 同款自愿登记：满并行下 faux 7/7 红（2026-10-20
  // 两轮实证：runtime 全量 669 文件满载下该文件整体失败），单跑 12s 恒绿 7/7——
  // 按上例同判（双 spawn + jiti 冷编译形态的满并行竞态，非用例自身缺陷），登记
  // 串行尾组，非断言放宽。
  'src/__tests__/equivalence/session-manager-full-e2e.test.ts',
] as const

/**
 * 集成测试门控组（TAIJI_TEST_INTEGRATION）登记表：真进程 / 真 IO 用例，本地默认跳过。
 *
 * 维护契约见文件头。本表成员在 e2e-map.json 登记 R2 规则（id = E2E-INTEG-两位序号，
 * trigger: on-diff、layer: L2、serial: true、run 命令带 TAIJI_TEST_INTEGRATION=1）；
 * 新增 / 删除成员须同 commit 更新 e2e-map.json 与 docs/TEST-STRATEGY.md「集成测试门控约定」。
 */
const INTEGRATION_TESTS = [
  'src/__tests__/equivalence/usage-queue-commands-invalidation.test.ts',
  'src/__tests__/equivalence/attach-lifecycle.test.ts',
  'src/__tests__/equivalence/broadcast-getstate.test.ts',
  'src/__tests__/equivalence/chaos.test.ts',
  'src/__tests__/equivalence/send-queue-e2e.test.ts',
  'src/__tests__/equivalence/delivery-compaction-window-e2e.test.ts',
  'src/__tests__/equivalence/completion-backflow-e2e.test.ts',
  'src/__tests__/equivalence/thinking-level-effective-e2e.test.ts',
  'src/infra/pi/__tests__/pi-semantics-skill-expansion-golden.test.ts',
  'test/skill-registry-watcher-real.test.ts',
] as const

export default taijiTestConfig({
  test: {
    // cw 验收标记行 reporter：e2e-mock 型验收（如 trace-runtime A31）要求 stdout 含
    // `<验收id> PASS|FAIL` 标记行；--reporter=json 时自静默（vitest 型验收 stdout 须纯 JSON）。
    // root 级 reporters 对 projects 分池（main/real-pi/integration 三组）的所有测试输出生效。
    reporters: ['default', './test/cw-acceptance-markers-reporter.ts', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    projects: [
      {
        // 主组：除两个串行尾组登记文件外的全部测试，保持默认满并行（与分池前行为一致）
        test: guardProjectSetup({
          name: 'main',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...defaultExclude, ...REAL_PI_TESTS, ...INTEGRATION_TESTS],
        }),
      },
      {
        // 真实 pi 组：文件间串行（maxWorkers 解析为 1），且在主组完整结束后才开跑（见文件头调度契约）
        test: guardProjectSetup({
          name: 'real-pi',
          include: [...REAL_PI_TESTS],
          fileParallelism: false,
        }),
      },
      {
        // 集成测试门控组：真进程 / 真 IO 用例，文件间串行、主组结束后开跑；本地不设
        // TAIJI_TEST_INTEGRATION 时组内用例经 describe.skipIf 跳过（文件级集成组）。
        test: guardProjectSetup({
          name: 'integration',
          include: [...INTEGRATION_TESTS],
          fileParallelism: false,
        }),
      },
    ],
  },
})
