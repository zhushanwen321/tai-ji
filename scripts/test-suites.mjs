/**
 * test-suites.mjs — 快速守卫测试族清单（SUITES，单一登记处）。
 *
 * 「哪些测试族在哪里跑」历史上散落七处（ci.yml 逐文件文本 / package.json scripts /
 * quality-gates 硬编码门 / coverage-gate.py 包前缀 / structure-wiring / e2e-map /
 * TEST-STRATEGY 散文）且零对账——后果：dev 合入边界与终局 PR CI 各跑各的子集，
 * 过期测试（stale）直到终局 PR 才第一次跑（v0.11.16 taste-lint 用例与 TC8 契约
 * 两连红），另有 6 个测试文件不在任何执行点。本清单 + check-test-suite-wiring.mjs
 * 对账器把「清单漂移」从静默分叉变成红灯：
 *   - ci.yml 对应步骤的命令文本必须与 SUITES.cmd 精确一致（漂移即 CI 红）
 *   - scripts/__tests__ 测试文件全集 − SUITES 引用 − 豁免清单 = 空（孤儿测试即红）
 *
 * 本清单只登记「快速守卫族」（秒到分钟级、无真实 LLM/真实进程依赖，dev 边界可跑）；
 * 大族（extensions 递归测试、runtime/renderer/main 测试、e2e）仍由 ci.yml 各 job
 * 直接承载，不入本清单。devGate: true 的族会被 quality-gates（--side 任意）执行
 * ——过期测试在合入 dev 当天红，不再等终局 PR。
 */

/** scripts-guards 族文件清单（= ci.yml「Test - scripts guards」步骤的逐文件列举，单一数据源）。 */
const SCRIPTS_GUARD_FILES = [
  'scripts/__tests__/check-unsafe-stream-writes.test.mjs',
  'scripts/__tests__/check-core-dist-gate.test.mjs',
  'scripts/__tests__/gitcode-release-sync.test.mjs',
  'scripts/__tests__/check-publish-surface.test.mjs',
  'scripts/__tests__/check-layout-literals.test.mjs',
  'scripts/__tests__/check-provider-credential-reads.test.mjs',
  'scripts/__tests__/vue-rules-split-justified.test.mjs',
  'scripts/__tests__/check-subagent-service-boundary.test.mjs',
  'scripts/__tests__/check-subagent-core-value-cycles.test.mjs',
  'scripts/__tests__/check-global-slot-keys.test.mjs',
  'scripts/__tests__/check-record-write-surface.test.mjs',
  'scripts/__tests__/validate-constraints.test.mjs',
  'scripts/__tests__/check-thinking-levels.test.mjs',
  'scripts/__tests__/check-ci-vitest-targets.test.mjs',
  'scripts/__tests__/check-doc-symbol-drift.test.mjs',
  'scripts/__tests__/check-guide-contract-projection.test.mjs',
  'scripts/__tests__/check-infra-services-import.test.mjs',
  'scripts/__tests__/verify-scheduler-e2e.test.mjs',
  'scripts/__tests__/render-sampling-decisions.test.mjs',
  'scripts/__tests__/check-domain-type-path.test.mjs',
  'scripts/__tests__/check-capability-allowlist-sync.test.mjs',
  'scripts/__tests__/check-artifact-dir-formula-sync.test.mjs',
  'scripts/__tests__/check-posix-resolve-mirror-sync.test.mjs',
  'scripts/__tests__/pi-env-admission-gate.test.mjs',
  'scripts/__tests__/merge-gate.test.mjs',
  'scripts/__tests__/merge-state.test.mjs',
  'scripts/__tests__/merge-wait-for-ci.test.mjs',
  'scripts/__tests__/merge-release.test.mjs',
  'scripts/__tests__/merge-verify-ci-release.test.mjs',
  'scripts/__tests__/changeset-versionable.test.mjs',
  'scripts/__tests__/changeset-check.test.mjs',
  'scripts/__tests__/check-test-blind-wait.test.mjs',
  'scripts/__tests__/check-prompt-outposts.test.mjs',
  'scripts/__tests__/check-pi-subtree-shared-imports.test.mjs',
  'scripts/__tests__/probe-registry.test.mjs',
  // 以下四个为 2026-10-26 收编的原「零执行点」测试（此前不在任何 CI 步骤/本地门禁）
  'scripts/__tests__/quality-gates.test.mjs',
  'scripts/__tests__/check-test-extremes.test.mjs',
  'scripts/__tests__/cross-branch-overlap.test.mjs',
  'scripts/__tests__/zcode-session-db-cleanup.test.mjs',
  'scripts/__tests__/check-test-suite-wiring.test.mjs',
]

/**
 * 快速守卫测试族登记。字段：
 *   id        族标识；cmd  执行命令（= ci.yml 对应步骤 run 文本的精确一致基准）
 *   files     族内测试文件（对账断言②的引用来源）
 *   needs     前置命令（quality-gates 在 dev 边界执行前先跑；CI 侧由既有步骤承载）
 *   devGate   true = quality-gates 在 dev 合入边界执行该族
 *   ci        CI 挂载锚点 { step: ci.yml 步骤名 }（对账器按步骤名找 run 值比对）
 */
export const SUITES = [
  {
    id: 'taste-lint',
    cmd: 'pnpm run test:taste-lint',
    files: [],
    needs: [],
    devGate: true,
    ci: { step: 'Test - taste-lint rules' },
  },
  {
    id: 'resources-plugins',
    cmd: 'pnpm test:resources-plugins',
    files: [],
    needs: [],
    devGate: true,
    ci: { step: 'Test - builtin plugins (resources)' },
  },
  {
    id: 'builtin-ext-bundle',
    cmd: 'pnpm exec vitest run scripts/__tests__/builtin-ext-bundle.test.mjs',
    files: ['scripts/__tests__/builtin-ext-bundle.test.mjs'],
    needs: ['bash scripts/prepare-builtin-extensions.sh'],
    devGate: true,
    ci: { step: 'Test - builtin-ext-bundle' },
  },
  {
    id: 'scripts-guards',
    cmd: `pnpm exec vitest run ${SCRIPTS_GUARD_FILES.join(' ')}`,
    files: SCRIPTS_GUARD_FILES,
    needs: [],
    devGate: true,
    ci: { step: 'Test - scripts guards' },
  },
]

/**
 * 不进 CI 的 scripts/__tests__ 测试豁免登记（对账断言②的显式白名单，逐条带理由；
 * 新增豁免须同时给出理由）。当前两条均为 pre-commit 触发式专属（staged 命中才跑，
 * 挂载点在 .githooks/install-hooks.sh，无 CI 面）。
 */
export const NON_CI_EXEMPT = [
  { file: 'scripts/__tests__/select-affected-e2e.test.mjs', reason: 'pre-commit 触发式专属（e2e-map SSOT 消费方自测，install-hooks.sh 挂载）' },
  { file: 'scripts/__tests__/check-session-hidden-surface.test.mjs', reason: 'pre-commit 触发式专属（install-hooks.sh 挂载）' },
]
