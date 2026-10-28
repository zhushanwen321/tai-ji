import { defaultExclude } from 'vitest/config'
import { taijiTestConfig, guardProjectSetup } from '../../test-guard/factory.ts'
import { INTEGRATION_TESTS_ENABLED } from '../../test-guard/integration-gate.ts'

/**
 * vitest 分池维护契约（调度两池：main+integration 同池满并行 / real-pi 串行尾组；
 * 收集语义三个 project：main / real-pi / integration）。
 *
 * 调度契约（vitest 4.1.9，权威源 node_modules/vitest/dist/chunks/cli-api.24X8XwN1.js groupSpecs()）：
 * - `fileParallelism: false` 在配置解析层强制 `maxWorkers = 1`（任何显式 maxWorkers 被覆盖）；
 *   `maxWorkers === 1` + 默认 isolate/groupOrder 的文件进入 sequential 尾组（groups.push
 *   (sequential) 恒排所有分组之后）。
 * - `sequence.groupOrder` 是分桶键：同号 project 并入同一并行组（须同 maxWorkers，不同则
 *   groupSpecs 直接 throw），组号从低到高严格串行执行（`for...of` + `await`，零时间重叠）。
 *   main 与 integration 均 = order 0 且均不设显式 maxWorkers → 两者文件并入同一个默认
 *   满并行 worker 池混跑（10 逻辑核 → 9 worker）；real-pi = sequential 尾组，在该池完整
 *   结束后串行开跑。`--project=integration` 单跑时只收集该 project 的文件，同样满并行。
 * - integration 与 main 同池的实证依据（2026-10-28 探针，10 逻辑核）：安静窗口三轮全量
 *   22.5-22.9s（尾组隔离形态 24.9-26.1s），零失败；6 进程人为加压（load 1 分钟均值峰
 *   14.5，瞬时过 15）A/B 对照下 integration 15 文件时间和仅 +5%（21.2→22.3s）、无超时、
 *   零失败，skill-paths 真 spawn 用例（登记的 load>15 超时敏感项）1.17s 恒绿——integration
 *   组的等待窗是 faux TPS 本地计算（毫秒级、零网络），与 real-pi 组的真实 LLM 长等待
 *   （饱和饿死实证：单跑 15.8s 满并行 301s 顶满超时）性质不同，同池竞争不产生无上界等待。
 * - `poolOptions.forks.singleFork`（vitest 2/3 形态）在 vitest 4 已移除，勿再使用。
 * 入口命令不变（`npx vitest run` / scripts/pr-pre-merge.sh 不改）；分组只影响调度，不影响
 * 跑哪些用例；组内用例各自的 skip 门控（REAL_PI_READY / TAIJI_TEST_INTEGRATION）照常生效。
 *
 * 分工与建池理由：
 * - **main**：除 real-pi 尾组与 integration 门控组登记文件外的全部测试，默认满并行。
 * - **real-pi**：真实 pi + 真实 LLM turn 的 equivalence 用例。建池理由 = 真实 LLM 轮次的
 *   长等待窗口在 CPU 饱和下被饿死（单跑 15.8s 的用例满并行下 301s 顶满超时，19 倍差距，
 *   事件流证明 LLM 轮次在推进、非死锁），故结构性隔离；组内用例另经 REAL_PI_READY 门控，
 *   无凭证环境自动 skip。
 * - **integration**：集成测试门控组（env 开关 SSOT = test-guard/integration-gate.ts 的
 *   TAIJI_TEST_INTEGRATION）——本地默认跳过、CI 或按改动范围触发时真跑的真进程 / 真 IO
 *   用例（spawn 真 pi 进程 + 真 extension jiti 冷编译、真实 chokidar fs.watch、跨进程
 *   spawn 等）。建 project 的理由 = 门控收集语义（门控关闭时整文件不收集、不付装载成本，
 *   见 integrationInclude）；调度上与 main 同池混跑（依据见上方调度契约段）。这些用例
 *   测的是「代码 + OS 组合行为」，没有确定性完成信号可等，负载下拉长无稳定上界，不满足
 *   单测层「只测逻辑、高负载下也极快」的定位（判据与整治清单见 docs/TEST-STRATEGY.md
 *   「新写测试判据」节）；与 real-pi 的分界 = 是否需要真实 LLM 凭证（本池不依赖凭证，
 *   故可进 CI）。
 *
 * integration 文件同池混跑的安全前提（新增成员必须满足，违反须先隔离改造）：
 * - 临时目录一律 mkdtempSync 唯一（fixture 的 sessionDir/agentDir、测试侧 dataRoot/workDir），
 *   禁固定路径共享；
 * - env 注入（TAIJI_FAUX_TPS 等）只写本 worker fork 进程（vitest forks 池每文件独立进程，
 *   spawn 子进程 env 经 {...process.env} 快照透传，天然隔离），禁依赖跨文件 env 残留；
 * - pi 子进程 IPC 全走 stdin/stdout 管道（--mode rpc），无 TCP 端口 / 文件锁 / 共享 fs.watch
 *   路径。
 * - 等待窗必须是本地确定性计算（faux TPS / 固定超时窗），禁真实网络 / 慢盘长等待——同池
 *   满并行下真实长等待会复发 real-pi 组的饱和饿死形态（该类用例改走 real-pi 组登记或
 *   单独尾组，勿进本组）。
 * 同池机器占用上限：9 worker fork + integration 文件各自的 pi 子进程（每文件常态至多
 * 1-2 个 pi 在场，任意时刻 integration 文件至多占 9 worker 中的一部分）≈ 峰值 ~12 进程，
 * 与 integration 文件在尾组隔离时代（≤6 fork + pi ≈ 12）同量级，10 逻辑核可承载（加压实
 * 证见调度契约段）。
 *
 * 维护契约：
 * - 新增「真实 pi + 真实 LLM turn」的 equivalence 测试 → 文件路径同步加入 REAL_PI_TESTS
 *   （漏加会落回 main 满并行组，复发饿死超时）；纯 mock / fixture 重放用例不加。
 * - 新增「真进程 / 真 IO / 真实挂钟窗口」的集成用例 → 两种形态二选一：① 整文件都是门控
 *   用例 → 路径加入 INTEGRATION_TESTS（该数组喂 main project 的 exclude 与门控开启时
 *   integration project 的 include；漏加 = 门控关闭时该文件失去「整文件跳过」语义，仍会
 *   被 main 收集装载——若文件内已全包 skipIf 则仅多付装载成本，未包则会在门控关闭时真跑）；
 *   ② 文件内只有部分用例需门控 → 文件留在 main 组，用 `describe.skipIf
 *   (!INTEGRATION_TESTS_ENABLED)` 包裹（用例级门控）。选型判据 = 文件内是否还有快用例
 *   值得留在默认组。
 * - INTEGRATION_TESTS 成员若含未包门控的用例（门控关闭时仍要跑），必须同时登记
 *   INTEGRATION_UNGATED_CARRIERS——门控关闭时 integration project 只收集该表，漏登记
 *   = 该文件的非门控用例静默不收集（无报错、无 skip 记录）。
 * - real-pi 组不按门控条件化：成员 session-manager-full-e2e 含 7 条 faux 层用例
 *   （不依赖凭证，REAL_PI_READY 关闭时照跑），按门控关闭跳过整个组会静默丢掉这 7 条
 *   断言；该文件的串行尾组注册理由见 REAL_PI_TESTS 注释（满并行下 faux 层整体红），
 *   故既不能跳过收集也不能并回 main。
 * - main 与 integration 保持同 groupOrder（0）且同 maxWorkers 策略（都不设显式值）——
 *   任一侧单独引入显式 maxWorkers 会触发 groupSpecs 的「same groupOrder 须同
 *   maxWorkers」throw。
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
  // 2026-10-27 测试范围收缩（round6 wave2）：真进程 / 真 socket / 真 PTY 的整文件门控族。
  // 本批 5 个文件内每条用例都包了 describe.skipIf，故不进 INTEGRATION_UNGATED_CARRIERS。
  'src/__tests__/infra/subagent-control/control-server.test.ts',
  'test/server-subagent.test.ts',
  'test/server-subagent-boundary.test.ts',
  'test/cli-error-envelope.integration.test.ts',
  'src/services/terminal/__tests__/terminal-service.test.ts',
] as const

/**
 * integration 组内「门控关闭时仍有可执行用例」的成员（本表 ⊆ INTEGRATION_TESTS）。
 *
 * 门控关闭时 integration project 只收集本表成员：其余成员整文件被
 * `describe.skipIf(!INTEGRATION_TESTS_ENABLED)` 跳过，收集它们只付装载成本
 * （实测安静窗口 9 个空转文件 = 0.7s 墙钟，高负载窗口 ~2.4s），产出 0 条断言。
 * 本表成员混有未包门控的用例（如 mock RPC 层快用例），不收集会静默丢断言。
 *
 * 维护契约：文件级集成组新增成员时，若该文件含未包门控的用例，必须同时登记本表；
 * 漏登记 = 该文件的非门控用例在门控关闭时静默消失（无报错、无 skip 记录）。
 * 判据 = 文件内是否每条用例都被 skipIf 门控包裹。
 */
const INTEGRATION_UNGATED_CARRIERS = [
  'src/__tests__/equivalence/usage-queue-commands-invalidation.test.ts',
] as const

/** integration project 的 include：门控开 = 全部成员；门控关 = 只留非门控载体。
 *  门控关闭时若整表都收集，9 个全 skip 文件是纯空转（实测 0 断言、0.7~2.4s 墙钟随负载）。 */
const integrationInclude = INTEGRATION_TESTS_ENABLED
  ? [...INTEGRATION_TESTS]
  : [...INTEGRATION_UNGATED_CARRIERS]

export default taijiTestConfig({
  test: {
    // cw 验收标记行 reporter：e2e-mock 型验收（如 trace-runtime A31）要求 stdout 含
    // `<验收id> PASS|FAIL` 标记行；--reporter=json 时自静默（vitest 型验收 stdout 须纯 JSON）。
    // root 级 reporters 对 projects 分池（main/real-pi/integration 三组）的所有测试输出生效。
    reporters: ['default', './test/cw-acceptance-markers-reporter.ts', 'junit'],
    outputFile: { junit: './test-results/vitest-junit.xml' },
    projects: [
      {
        // 主组：除 real-pi 尾组与 integration 门控组登记文件外的全部测试，默认满并行。
        // 与 integration 同 groupOrder（0）且同 maxWorkers 策略（都不设显式值）→ 两者文件
        // 在同一 worker 池混跑（见文件头调度契约）。
        test: guardProjectSetup({
          name: 'main',
          include: ['test/**/*.test.ts', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: [...defaultExclude, ...REAL_PI_TESTS, ...INTEGRATION_TESTS],
        }),
      },
      {
        // 真实 pi 组：文件间串行（maxWorkers 解析为 1），恒在所有并行组（main+integration
        // 同池）完整结束后才开跑（见文件头调度契约）
        test: guardProjectSetup({
          name: 'real-pi',
          include: [...REAL_PI_TESTS],
          fileParallelism: false,
        }),
      },
      {
        // 集成测试门控组：真进程 / 真 IO 用例。groupOrder: 0 且不设显式 maxWorkers =
        // 与 main 组同池满并行混跑（同池实证依据与安全前提见文件头）；include 按门控组装
        // （见 integrationInclude 注释）：门控关闭时只收集非门控载体文件，其余成员不收集、
        // 不付装载成本。
        test: guardProjectSetup({
          name: 'integration',
          include: integrationInclude,
          sequence: { groupOrder: 0 },
        }),
      },
    ],
  },
})
