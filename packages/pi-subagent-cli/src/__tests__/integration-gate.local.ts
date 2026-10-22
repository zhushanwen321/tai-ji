/**
 * 集成测试门控（TAIJI_TEST_INTEGRATION）的引擎包内副本。
 *
 * 引擎包边界检查（scripts/check-engine-package-boundary.mjs）禁止 src 内相对说明符
 * 逃出包根，故本包测试文件不 import 仓库根的 test-guard/integration-gate.ts，按
 * zcode-engine.live.test.ts 内联读 ENGINE_CONFORMANCE_LIVE 的同款先例在包内读同名
 * env。语义与 skip 理由文案的唯一权威 = test-guard/integration-gate.ts +
 * docs/TEST-STRATEGY.md「集成测试门控约定」；改语义时与 SSOT 同步。
 */
const INTEGRATION_TESTS_ENV = 'TAIJI_TEST_INTEGRATION'

/** 集成测试轨是否启用（模块加载时求值一次）。未设置或取值非 '1' / 'true' → false。 */
export const INTEGRATION_TESTS_ENABLED: boolean =
  process.env[INTEGRATION_TESTS_ENV] === '1' || process.env[INTEGRATION_TESTS_ENV] === 'true'

/** skip 理由（注入 describe 名，显式可见，不静默消失）。 */
export const INTEGRATION_TESTS_SKIP_REASON: string = INTEGRATION_TESTS_ENABLED
  ? ''
  : `env ${INTEGRATION_TESTS_ENV} 未设置或取值非 '1'/'true'（集成测试门控关闭：本地默认跳过；` +
    `CI 与按改动范围触发时设 ${INTEGRATION_TESTS_ENV}=1 真跑，见 docs/TEST-STRATEGY.md「集成测试门控约定」）`
