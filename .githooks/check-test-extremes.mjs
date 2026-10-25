#!/usr/bin/env node
/**
 * check-test-extremes.mjs —— 单测层极端形态静态检查（判据权威 = docs/TEST-STRATEGY.md
 * 「新写测试判据」节；2026-10 单测层整治后立的提交时防线）。
 *
 * 拦四类可静态判定的信号（staged 测试文件）：
 *   X1 真子进程调用但未挂集成门控 —— 文件调用 node:child_process 的
 *      spawn/execFile/spawnSync/execFileSync/fork，且未 import
 *      INTEGRATION_TESTS_ENABLED（test-guard/integration-gate.ts 或包内 local 副本）。
 *      判据第③档：真进程面必须挂 TAIJI_TEST_INTEGRATION 门控（或登记 EXEMPT 说明合法例外）。
 *   X2 显式 timeout ≥5000ms —— `(test)?Timeout[:=]` 数值 ≥5000（含下划线数字 30_000）。
 *      预算膨胀是负载症状的止痛药；需要的不是预算，是确定性化或挂门控。
 *   X3 vi.waitFor 显式 timeout ≥1000ms —— 等待窗口无完成信号保证，1000ms 以上即第③档形态。
 *   X4 performance.now() / process.hrtime 断言素材 —— 性能水位断言（类型 g）归门控组/bench。
 *
 * 三种运行形态：
 *   无参        = hook 模式：扫 git staged 的测试文件（*.test.ts / *.test.mjs / *.spec.ts）
 *   文件路径参数 = 独立模式：只扫给定文件（自测用）
 *   --all      = 全仓模式：扫 git ls-files 的全部测试文件（EXEMPT 表盘点用）
 *
 * 豁免：EXEMPT 表按仓库相对路径登记，逐条附理由；命中豁免的文件跳过全部信号。
 * 不设独立 SKIP_* 开关（R1 后惯例，总开关 SKIP_ALL_CHECKS 兜底）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 豁免登记表（仓库相对路径 → 理由）。合法例外只有三类先例：
 * ① 锁 / 进程语义本身是被测物且量小（真 pid 判定）；
 * ② 检查器/门禁脚本的黑盒自测（spawn 检查器本体，单处 <300ms）；
 * ③ 既有专用门（真实凭证 / 真 LLM 手动门），门控方向与集成门控不同。
 */
/**
 * 存量登记（2026-10-22 全仓盘点）：二波整治清单外的既有文件命中信号，待后续波次
 * 逐个处置（确定性化 / 挂门控 / 豁免细分）。登记在本表的文件暂不受本检查拦截——
 * 改动这些文件时新引入的极端形态由 CI 慢用例门禁（scripts/check-slow-tests.mjs）
 * 结果侧兜底。从本表移除条目 = 该文件已处置。
 */
const STOCK = {
  'apps/electron/main/test/download-asset.test.ts': null,
  'extensions/universal/base-tool-enhance/src/__tests__/notify.test.ts': null,
  'extensions/universal/base-tool-enhance/src/__tests__/pending-reconcile.test.ts': null,
  'packages/dom-core/src/__tests__/smoke.test.ts': null,
  'packages/extension-protocol/src/background-task-process.test.ts': null,
  'packages/pi-subagent-cli/src/__tests__/spawn-event-adapter-rpc.test.ts': null,
  'packages/pi-subagent-cli/src/__tests__/ui-request-queue.test.ts': null,
  'packages/runtime/src/infra/git-executor.test.ts': null,
  'packages/runtime/src/infra/shell-runner.test.ts': null,
  'packages/runtime/src/infra/system/trash.test.ts': null,
  'packages/runtime/src/services/worktree/worktree-service.test.ts': null,
  'packages/runtime/test/cli-error-envelope.integration.test.ts': null,
  'packages/runtime/test/network-proxy-stats.test.ts': null,
  'packages/runtime/test/plugin-api-extended.test.ts': null,
  'packages/runtime/test/plugin-ui-timeout-authority.test.ts': null,
  'packages/runtime/test/server-extension.test.ts': null,
  'packages/runtime/test/shell-runner.test.ts': null,
  'packages/subagent-core/src/execution/__tests__/execute-nesting.test.ts': null,
  'packages/subagent-core/src/execution/engine/__tests__/conformance/engine-crash.test.ts': null,
  'packages/subagent-core/src/execution/engine/__tests__/conformance/static-spawn-guard.test.ts': null,
  'packages/subagent-core/src/orchestration/__tests__/rebuild-sample-fixture.test.ts': null,
  'packages/subagent-engine-sdk/src/__tests__/cli-entry.test.ts': null,
  'packages/ui/src/features/chat/__tests__/markdown-filepath.test.ts': null,
  'packages/ui/src/features/chat/__tests__/markdown-renderer-incremental.test.ts': null,
  'packages/zcode-subagent-cli/src/__tests__/zcode-engine-appserver.test.ts': null,
}
for (const k of Object.keys(STOCK)) STOCK[k] = '存量：二波清单外文件（2026-10-22 盘点登记），信号待后续波次处置（确定性化/挂门控/豁免细分）'

const EXEMPT = {
  ...STOCK,
  // —— 确定性时钟 mock（X4 假阳性：performance.now 被 vi.spyOn 全控，非真实计时断言） ——
  'packages/ui/src/primitives/__tests__/sheet.test.ts': 'Sheet 拖拽手势测试的时钟全控 mock——happy-dom 的 PointerEvent 构造函数自身消费 performance.now() 做 timeStamp，须 spyOn mock 后事件构造与 handler 共享同一时钟源，速度 = dy/durationMs 断言才确定性成立；是确定性化手段，非性能水位断言',
  // —— 检查器黑盒自测（spawn 检查脚本本体，亚秒级） ——
  'scripts/__tests__/check-test-extremes.test.mjs': '本检查器黑盒自测（spawn 检查器本体，单处 <300ms）',
  'scripts/__tests__/check-test-blind-wait.test.mjs': '盲等检查器黑盒自测（每处 spawn <300ms，裁决保留）',
  'scripts/__tests__/check-prompt-outposts.test.mjs': '出站调用点检查黑盒自测（fixture 由被测脚本常量生成，spawn 亚秒级）',
  'scripts/__tests__/check-domain-type-path.test.mjs': '检查器黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/check-global-slot-keys.test.mjs': '检查器黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/check-guide-contract-projection.test.mjs': '检查器黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/check-infra-services-import.test.mjs': '检查器黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/check-pi-subtree-shared-imports.test.mjs': '检查器黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/check-subagent-core-value-cycles.test.mjs': '检查器黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/render-sampling-decisions.test.mjs': '采样决策脚本黑盒自测（spawn 脚本本体，亚秒级）',
  'scripts/__tests__/vue-rules-split-justified.test.mjs': '规则拆分检查黑盒自测（spawn 检查脚本本体，亚秒级）',
  'scripts/__tests__/builtin-ext-bundle.test.mjs': '打包校验脚本黑盒（spawnSync node 量小，2026-10 二波已缩量共享 fixture）',
  'scripts/__tests__/changeset-versionable.test.mjs': 'pre-commit 脚本经 git index 读状态，git 是被测物（二波已缩 init 次数）',
  'scripts/__tests__/changeset-check.test.mjs': '门禁脚本黑盒（每处真 node 进程 <600ms，二波已删死建仓）',
  'scripts/__tests__/cross-branch-overlap.test.mjs': 'overlap 判定黑盒，git 双分支是被测物（二波已缩 commit 数）',
  'scripts/__tests__/quality-gates.test.mjs': '锁语义需真实 pid 判定（裁决保留，2 处 spawn 均 <300ms）',
  // —— 二波形态：亚秒级真进程冒烟留默认组（实测 <300ms/条） ——
  'packages/zcode-subagent-cli/src/__tests__/appserver-launcher.test.ts': '二波裁决形态：5 条主链真 spawn 留默认组（实测单条 <300ms），env 矩阵已进程内化',
  'packages/zcode-subagent-cli/src/__tests__/session-channel.test.ts': '二波裁决形态：8 条真进程冒烟留默认组（实测单条 <300ms），其余 33 处已桩化',
  // —— 锁 / 进程语义本身是被测物 ——
  'apps/electron/main/test/update-self-healer.test.ts': 'argv 级进程识别是被测物：1 条真 bash 阳性 + 其余注入 ps 输出（二波裁决形态）',
  'packages/subagent-core/src/__tests__/transport-local.test.ts': '谓词层留一次确定性 ps -p 探活（不可达 pid、ENOENT 立返、零时间窗；E2E-INTEG-28 登记）',
  // —— performance.now 作轮询时钟（fake Date 用例下 Date.now 冻结的替代），非性能断言 ——
  'apps/electron/main/logs/__tests__/main-logger.test.ts': 'performance.now 作轮询 deadline 时钟（fake Date 下 Date.now 冻结会死循环），非时延断言',
  'apps/electron/main/logs/__tests__/stderr-sink-rotation.test.ts': 'performance.now 作轮询 deadline 时钟（同上），非时延断言',
  // —— 既有专用门（方向 = 手动/凭证门，非集成门控） ——
  'packages/zcode-subagent-cli/src/__tests__/zcode-engine.live.test.ts': 'ENGINE_CONFORMANCE_LIVE 手动真机门（默认 skip，env 显式开启才 spawn）',
  'packages/runtime/src/__tests__/infra/subagent-control/real-engine-integration.test.ts': 'TAIJI_SKIP_REAL_ENGINE_E2E 既有专用门（CI-only 定位，E2E-CTRL 域登记）',
  'packages/runtime/src/__tests__/equivalence/session-manager-full-e2e.test.ts': 'real-pi 串行尾组 + REAL_PI_READY 凭证门（文件在 REAL_PI_TESTS 池，同步检查另有守卫）',
}

const TEST_FILE_RE = /\.test\.(ts|mjs)$|\.spec\.ts$/
// e2e 层（Playwright 真实 app 层）不归单测层防线管：其超时预算/真实交互属 e2e 语义，
// 触发与登记纪律走 docs/testing/e2e-map.json，不按单测判据拦。只扫测试文件本体
// （*.test.* / *.spec.*）——__tests__/ 下的 helper/fixture/探针不扫：门控语义由
// 消费它们的测试文件承载（pi-fixture.ts / fake-engine.ts / probes/*.mjs 属此类）。
const E2E_PATH_RE = /(^|\/)e2e\//

const CHILD_PROC_IMPORT_RE = /from\s+['"]node:child_process['"]/
const CHILD_PROC_CALL_RE = /\b(spawnSync|execFileSync|spawn|execFile|fork)\s*\(/
const UNAMBIGUOUS_CALL_RE = /\b(spawnSync|execFileSync)\s*\(/
const GATE_IMPORT_RE =
  /import\s*\{[^{}]*\bINTEGRATION_TESTS_ENABLED\b[^{}]*\}\s*from\s+['"][^'"]*integration-gate(\.local)?(\.ts)?['"]/
const TIMEOUT_RE = /\b(?:test)?[Tt]imeout\s*[:=]\s*(\d[\d_]*)/g
const WAITFOR_TIMEOUT_RE = /waitFor\((?:[^()]|\([^()]*\))*?timeout\s*:\s*(\d[\d_]*)/g
const PERF_RE = /\bperformance\.now\s*\(|\bprocess\.hrtime\b/

const num = (s) => Number.parseInt(String(s).replace(/_/g, ''), 10)

function collectTargets(args) {
  if (args.includes('--all')) {
    const out = execFileSync('git', ['ls-files'], { cwd: PROJECT_ROOT, encoding: 'utf8' })
    return out.split('\n').filter((f) => TEST_FILE_RE.test(f) && !E2E_PATH_RE.test(f))
  }
  if (args.length > 0) return args
  const out = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    { cwd: PROJECT_ROOT, encoding: 'utf8' },
  )
  return out
    .split('\n')
    .filter((f) => TEST_FILE_RE.test(f) && !E2E_PATH_RE.test(f) && !f.includes('node_modules'))
}

/** @returns {string[]} 命中的信号描述（空 = 通过） */
function scanFile(rel) {
  const abs = resolve(PROJECT_ROOT, rel)
  if (!existsSync(abs)) return []
  const text = readFileSync(abs, 'utf8')
  const flattened = text.replace(/\s+/g, ' ')
  // 挂了集成门控的文件 = 已受 sanction：真进程调用与门控组预算（含大 timeout）属
  // 集成组语义，其代价由 CI 慢用例门禁 + e2e-map E2E-INTEG 登记看护，不在本检查拦。
  if (GATE_IMPORT_RE.test(flattened)) return []
  const hits = []

  const callsChildProc = CHILD_PROC_CALL_RE.test(flattened)
  const importsChildProc = CHILD_PROC_IMPORT_RE.test(flattened)
  if (callsChildProc && (importsChildProc || UNAMBIGUOUS_CALL_RE.test(flattened))) {
    hits.push(
      'X1 真子进程调用（node:child_process）但未挂集成门控——按 docs/TEST-STRATEGY.md「新写测试判据」挂 TAIJI_TEST_INTEGRATION 门控（import INTEGRATION_TESTS_ENABLED + describe.skipIf），或确属合法例外时在 .githooks/check-test-extremes.mjs 的 EXEMPT 表登记理由',
    )
  }

  let m
  TIMEOUT_RE.lastIndex = 0
  while ((m = TIMEOUT_RE.exec(flattened)) !== null) {
    if (m[1] !== undefined && num(m[1]) >= 5000) {
      hits.push(`X2 显式 timeout ≥5000ms（${m[1]}）——预算膨胀不是解法：确定性化、缩数据量或挂门控（判据见 docs/TEST-STRATEGY.md「新写测试判据」）`)
      break
    }
  }
  WAITFOR_TIMEOUT_RE.lastIndex = 0
  while ((m = WAITFOR_TIMEOUT_RE.exec(flattened)) !== null) {
    if (m[1] !== undefined && num(m[1]) >= 1000) {
      hits.push(`X3 waitFor 显式 timeout ≥1000ms（${m[1]}）——等待窗口无完成信号保证，改确定性 flush / 注入完成信号（「异步等待写法」节）`)
      break
    }
  }
  if (PERF_RE.test(flattened)) {
    hits.push('X4 performance.now()/process.hrtime 断言素材——性能水位断言（类型 g）移集成门控组或 bench，不进默认单测层')
  }
  return hits
}

function main() {
  const targets = collectTargets(process.argv.slice(2))
  const problems = []
  for (const raw of targets) {
    // 路径归一化：仓库内路径转仓库相对（EXEMPT 表与输出的口径），仓库外（自测
    // fixture 等）保持绝对路径。
    const abs = resolve(PROJECT_ROOT, raw)
    const rel = abs.startsWith(`${PROJECT_ROOT}/`) ? relative(PROJECT_ROOT, abs) : abs
    if (EXEMPT[rel] !== undefined) continue
    if (!TEST_FILE_RE.test(rel) || E2E_PATH_RE.test(rel)) continue
    for (const hit of scanFile(rel)) problems.push(`  ${rel}\n      ${hit}`)
  }
  if (problems.length > 0) {
    console.error('[check-test-extremes] 检出单测层极端形态（判据 = docs/TEST-STRATEGY.md「新写测试判据」）:')
    console.error(problems.join('\n'))
    console.error('  [恢复动作] 确定性同步化 / 缩数据量 / 挂 TAIJI_TEST_INTEGRATION 门控 / 删冗余；')
    console.error('            锁或进程语义本身是被测物等合法例外，在 .githooks/check-test-extremes.mjs 的 EXEMPT 表登记理由。')
    process.exit(1)
  }
  const skipped = targets.filter((f) => EXEMPT[f] !== undefined).length
  console.log(`[check-test-extremes] OK（扫描 ${targets.length} 个测试文件${skipped > 0 ? `，${skipped} 个豁免` : ''}，零极端形态）`)
}

main()
