/**
 * 集成测试门控（TAIJI_TEST_INTEGRATION）——「本地默认跳过、CI 或按改动范围启用」的
 * 全仓统一 env 开关。
 *
 * 用途：把依赖真实进程 / 真实 IO / 真实挂钟窗口的用例（spawn 真子进程、真磁盘吞吐、
 * 真实 fs.watch 事件、跨进程互斥）移出默认单测层——它们在 CPU 满载下无稳定上界，
 * 单测层的定位是「只测逻辑正确性、高负载下也极快」（判据见 docs/TEST-STRATEGY.md「新写测试判据」节）。
 *
 * 语义：
 * - 关闭（未设置，或取值既不是 '1' 也不是 'true'）= 门控用例本地跳过；
 * - 开启（'1' / 'true'）= CI 或按改动范围触发时真跑。
 *
 * 两种用法（何时用哪种见 docs/TEST-STRATEGY.md「集成测试门控约定」）：
 * 1. 用例级门控（单文件内既有真进程用例又有快用例）：
 *      import { INTEGRATION_TESTS_ENABLED } from '../../../../../test-guard/integration-gate.ts'
 *      describe.skipIf(!INTEGRATION_TESTS_ENABLED)('…', () => { … })
 * 2. 文件级集成组（整文件都是门控用例）：文件路径登记进所在包 vitest.config.ts 的
 *    integration project（include），并加进 main project 的 exclude（漏加 = 同一文件
 *    双执行）——本组 fileParallelism: false 串行尾组，本地不设 env 时用例经
 *    describe.skipIf 跳过。
 *
 * 与既有四种门控的分工（REAL_PI_READY / TAIJI_SKIP_REAL_PI / TAIJI_SKIP_REAL_ENGINE_E2E /
 * ENGINE_CONFORMANCE_LIVE）见 docs/TEST-STRATEGY.md 同节——那四种按「凭证/binary 是否
 * 在位」判定可用性，本门控只按「是否显式要求跑集成组」判定，两轴正交。
 */

const INTEGRATION_TESTS_ENV = 'TAIJI_TEST_INTEGRATION'

/** 集成测试组是否启用（模块加载时求值一次）。
 *  未设置或取值非 '1' / 'true' → false（门控用例本地跳过）。 */
export const INTEGRATION_TESTS_ENABLED: boolean =
  process.env[INTEGRATION_TESTS_ENV] === '1' || process.env[INTEGRATION_TESTS_ENV] === 'true'

/** skip 理由（注入 describe 名，显式可见，不静默消失）。 */
export const INTEGRATION_TESTS_SKIP_REASON: string = INTEGRATION_TESTS_ENABLED
  ? ''
  : `env ${INTEGRATION_TESTS_ENV} 未设置或取值非 '1'/'true'（集成测试门控关闭：本地默认跳过；` +
    `CI 与按改动范围触发时设 ${INTEGRATION_TESTS_ENV}=1 真跑，见 docs/TEST-STRATEGY.md「集成测试门控约定」）`
