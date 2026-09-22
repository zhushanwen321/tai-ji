#!/usr/bin/env node
/**
 * check-bun-driver.mjs —— zcode-session-source bun 驱动路径双跑挂点
 * （session-reader-shared-core 设计 §3.3 D3「bun 侧执行形态两层」之源级双跑；
 * 实施计划 U5-②。同一断言集在 node/bun 下各跑一遍，分别触发 node:sqlite /
 * bun:sqlite 两条驱动路径——本脚本只负责 bun 那一跑，node 趟由常规 vitest
 * 流程覆盖，本脚本不新增测试文件。）
 *
 * 背景（设计 F1-F4）：pi 扩展宿主是编译版 bun 二进制，bun 运行时下
 * import('node:sqlite') 失败（P-bun-host 已实测 ERR_UNKNOWN_BUILTIN_MODULE）、
 * 只有 bun:sqlite 可用。ext 的 vitest 默认跑 node，bun 驱动路径 CI 天然覆盖不到
 * ——这是 F4「本地绿产品挂」陷阱的同构风险，源级双跑兜住。
 *
 * 分支语义（fail-open 边界，逐条可核）：
 *   1. packages/zcode-session-source 不存在或无 vitest.config.ts → 包未就位，
 *      放行（exit 0）——U3 交付前本段为 no-op；
 *   2. bun 不在 PATH（含 ~/.bun/bin 常见安装位探测）→ 输出可操作 [FIX] 安装
 *      指引后放行（exit 0）——本机无 bun 不是代码缺陷，bun 趟由 CI 承担
 *      （ci.yml invariants 装 bun 后同脚本 --require-bun 跑，缺失即红）；
 *      **fail-open 仅限本场景**；
 *   3. 包就位 ∧ bun 可用 → 真实执行 `bunx --bun --no-install vitest run`（包目录下），
 *      测试失败 → exit 1 必红（无任何放行分支）。
 *
 * `--no-install`：只解析本地 node_modules/.bin 的 vitest，绝不从 registry 拉版
 * （防「无 bin 时静默跑最新版」的行为漂移，同 ci.yml taste-lint step 的 npx 禁用
 * 理由）。`--bun`：强制 bun 运行时（见分支 3 注释的「假 bun 趟」陷阱）。
 * `--require-bun`（CI 用）：bun 缺失从放行翻转为 exit 1——CI 已显式装
 * bun，缺失 = 装配步骤坏了，静默绿会让 bun 驱动路径零覆盖还全绿。
 *
 * 零第三方依赖。用法：node scripts/check-bun-driver.mjs [--require-bun]
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SCRIPT_DIR, '..')
const SOURCE_PKG_DIR = join(ROOT, 'packages', 'zcode-session-source')
const REQUIRE_BUN = process.argv.includes('--require-bun')

// ── 分支 1：包未就位 → no-op 放行 ──────────────────────────────────────────
// 判据 = vitest.config.ts（包根测试装配的最小标志；目录壳存在但测试未装配时
// 同样无事可跑）。U3 交付后此分支自然退出舞台，保留是为让脚本在交付窗口期
// 两端（已交付/未交付）都能跑。
if (!existsSync(join(SOURCE_PKG_DIR, 'vitest.config.ts'))) {
  console.log(
    '[bun-driver] SKIP：packages/zcode-session-source 未就位（无 vitest.config.ts），bun 驱动双跑不适用（U3 交付前 no-op）',
  )
  process.exit(0)
}

// ── 分支 2：bun 探测 ───────────────────────────────────────────────────────
// 先按 PATH 探测；失败再探 ~/.bun/bin/bun（bun 官方安装脚本默认位置——
// pre-commit 的非交互环境 PATH 可能不含 ~/.bun/bin）。
function resolveBun() {
  const probe = (cmd) => {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf-8' })
    return r.status === 0 ? { cmd, version: r.stdout.trim() } : null
  }
  return probe('bun') ?? probe(join(homedir(), '.bun', 'bin', 'bun'))
}

const bun = resolveBun()
if (bun === null) {
  const msg =
    '[FIX] 本机未检测到 bun（PATH 与 ~/.bun/bin 均无）——zcode-session-source 的 ' +
    'bun:sqlite 驱动路径本机不覆盖。安装：curl -fsSL https://bun.sh/install | bash ' +
    '（或 brew install oven-sh/bun/bun）；安装后重试。本机无 bun 时本检查放行，' +
    'bun 趟由 CI 承担（ci.yml invariants）。'
  if (REQUIRE_BUN) {
    console.error('[bun-driver] FAIL：--require-bun 模式下 bun 缺失不允许放行')
    console.error(msg)
    process.exit(1)
  }
  console.log('[bun-driver] SKIP（fail-open，仅限 bun 缺失场景）')
  console.log(msg)
  process.exit(0)
}

// ── 分支 3：真实执行 bun 趟（测试失败必红，无放行分支）────────────────────
// `--bun` 必带（U5 实测陷阱）：vitest bin 的 shebang 是 `#!/usr/bin/env node`，
// `bunx vitest` 默认按 shebang 用系统 node 执行——整趟（含 fork worker）实际跑在
// node 下，node:sqlite 可用，等于把 node 趟又跑了一遍的「假 bun 趟」（worker 里的
// node:sqlite ExperimentalWarning 是判别证据）。`--bun` 强制 vitest 及其 worker
// 跑在 bun 运行时，驱动探测（typeof Bun）才会真正命中 bun:sqlite 路径。
console.log(`[bun-driver] 运行 bun 趟：cd packages/zcode-session-source && bunx --bun --no-install vitest run（bun ${bun.version}）`)
const r = spawnSync(bun.cmd, ['x', '--bun', '--no-install', 'vitest', 'run'], {
  cwd: SOURCE_PKG_DIR,
  stdio: 'inherit',
})
if (r.status !== 0) {
  console.error(`[bun-driver] FAIL：bun 趟 vitest 失败（exit ${r.status ?? r.signal}）——`)
  console.error('  bun:sqlite 驱动路径或双端 API 对齐（P-api-parity）在 bun 运行时下有断言未过，')
  console.error('  按上方 vitest 明细修复后重试；这是生产宿主（bun 二进制 pi）实际走的驱动路径，')
  console.error('  禁止跳过（设计 D3：bun 路径无法在 node 下执行，本趟是其唯一本地覆盖）。')
  process.exit(r.status ?? 1)
}
console.log('[bun-driver] OK：bun 趟全绿（bun:sqlite 驱动路径在本机 bun 下验证通过）')
