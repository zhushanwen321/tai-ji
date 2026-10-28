#!/usr/bin/env node
/**
 * run-daily-tests.mjs — 日常档测试入口（`pnpm test`；round6 第二类测试按域分流）。
 *
 * 语义：变更分析（diff → 受影响域，选择器 = select-affected-domain 同款纯函数）→
 * 执行「foundation/host 基础池 core 快集 ∪ 命中域全量」；无变更 / 无命中时只跑基础池
 * core。全量两段式入口移至 `pnpm test:all`（CI 与发布前回归用），本档不替代它。
 *
 * diff base 口径（不动脑可复现，按优先级取第一个可用）：
 *   1. `--base <ref>` 显式指定
 *   2. 当前分支的 upstream（branch.*.remote 配置的跟踪目标——feat/fix 分支交付 push 后
 *      指向自己的远端副本，diff = 未 push 的本地改动）
 *   3. 分支名匹配 dev-X.Y.Z → github/dev-X.Y.Z（DEV-WORKFLOW §5：dev 分支常驻、push
 *      到 github 远端，diff = 未 push 的集成分累加）
 *   4. 兜底 github/main（CI 的 PR/push 目标分支，ci.yml on.push/pull_request）
 * 变更文件 = merge-base 到工作树的两点 diff（含已 commit 未推送 + staged + 未 commit
 * 改动）∪ untracked 新文件；已删除文件不计（--diff-filter=d，与选择器同口径）。
 *
 * 基础池分级（POOL_SLOW_PREFIXES）：foundation(146) + host(107) 全跑 2026-10-27 实测
 * 47.3s（18 包，load 4.6-11），超出日常档预算；排除 4 个重包后 core 快集 92 文件 /
 * 14 包（junit suite-time 6.9s）。被排除包的池文件不丢覆盖——改动命中 foundation /
 * host 的 scope 时对应池升级为全量（见 POOL_SLOW_PREFIXES 注释）。
 *
 * 用法：
 *   pnpm test                          # 日常档（本脚本）
 *   pnpm test -- --base <ref>          # 显式 diff base
 *   node scripts/run-daily-tests.mjs --pools full   # 基础池全量（对照/排查用）
 *   node scripts/run-daily-tests.mjs --list         # 只打印执行清单不执行
 *
 * 退出码：0 全绿 / 1 有包失败或 junit 聚合判定失败 / 2 环境错误（注册表、git）。
 */
import { execSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadRegistry, selectAffectedDomains } from './select-affected-domain.mjs'
import { collectDomainFiles, groupFilesByPackage, loadMountMap, runPackages, strictExpander } from './run-domain-tests.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const POOLS = ['foundation', 'host']

/**
 * 基础池日常恒跑的包级排除（前缀 = 池内文件路径前缀）。分级依据 2026-10-27 全池实测
 * junit（.tmp/round6/daily-tier-report.md 留档）：runtime（62f，suite-time 47.3s，
 * pi-store-bundle 8.0s / skill-paths 5.2s / json-store 4.5s 主导）、apps/electron/main
 * （75f，15.1s）、packages/renderer 与 packages/mobile-renderer（happy-dom 每文件固定
 * 开销 ~1s+，TEST-STRATEGY「分片」注释实测）。四包合计占全池 suite-time ~91%。
 * 排除不是丢覆盖：改动命中 foundation/host 的 scope（改这些包的池内被测源码）时，
 * 对应池在本档升级为全量执行；全量兜底 = pnpm test:all。改动此表须重测全池并更新依据。
 */
const POOL_SLOW_PREFIXES = [
  'packages/runtime/',
  'apps/electron/main/',
  'packages/renderer/',
  'packages/mobile-renderer/',
]

function gitOut(spec, allowFail = false) {
  try {
    return execSync(spec, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    if (allowFail) return null
    console.error(`[run-daily-tests] git 命令失败：${spec}`)
    console.error(`  恢复动作：确认仓库状态（git status）后重试，或显式指定 base：pnpm test -- --base <ref>`)
    process.exit(2)
  }
}

/** base 解析：返回 { ref, desc }；全部候选不可用 = 环境错误（exit 2）。 */
export function resolveBase(explicitBase, git = gitOut) {
  if (explicitBase) {
    if (!git(`git rev-parse --verify --quiet ${explicitBase}^{commit}`, true)) {
      console.error(`[run-daily-tests] --base "${explicitBase}" 不是可用 ref`)
      console.error('  恢复动作：git fetch github 后重试，或换一个存在的 ref（分支名 / commit / tag）')
      process.exit(2)
    }
    return { ref: explicitBase, desc: `--base ${explicitBase}` }
  }
  const upstream = git('git rev-parse --abbrev-ref --symbolic-full-name @{upstream}', true)
  if (upstream) return { ref: '@{upstream}', desc: `分支 upstream（${upstream}）` }
  const branch = git('git rev-parse --abbrev-ref HEAD')
  if (/^dev-\d+\.\d+\.\d+$/.test(branch) && git(`git rev-parse --verify --quiet github/${branch}^{commit}`, true)) {
    return { ref: `github/${branch}`, desc: `dev 分支远端副本（github/${branch}）` }
  }
  if (git('git rev-parse --verify --quiet github/main^{commit}', true)) {
    return { ref: 'github/main', desc: '兜底 github/main（分支无 upstream 且不匹配 dev-X.Y.Z）' }
  }
  console.error('[run-daily-tests] 无可用 base：分支无 upstream、非 dev-X.Y.Z 分支、github/main 不可达')
  console.error('  恢复动作：git fetch github，或显式指定 base：pnpm test -- --base <ref>')
  process.exit(2)
}

/** 变更文件集：merge-base → 工作树（两点 diff，含 staged/未 commit）∪ untracked 新文件。 */
export function changedFiles(baseRef, git = gitOut) {
  let mb = git(`git merge-base ${baseRef} HEAD`, true)
  if (!mb) mb = baseRef // 无共同祖先：退化为对 base 的两点 diff
  const diffed = git(`git diff --name-only --diff-filter=d ${mb}`).split('\n').filter(Boolean)
  const untracked = git('git ls-files --others --exclude-standard').split('\n').filter(Boolean)
  return [...new Set([...diffed, ...untracked])].sort()
}

/** 执行清单：池（core 或全量）∪ 命中功能域全量；命中池自身时该池升级全量。 */
export function buildExecFileSet(collected, affected, { poolsFull }) {
  const out = new Set()
  for (const pool of POOLS) {
    const poolHit = affected.includes(pool)
    for (const f of collected.get(pool)?.files ?? []) {
      if (poolsFull || poolHit || !POOL_SLOW_PREFIXES.some((p) => f.startsWith(p))) out.add(f)
    }
  }
  for (const domain of affected) {
    if (POOLS.includes(domain)) continue
    for (const f of collected.get(domain)?.files ?? []) out.add(f)
  }
  return [...out].sort()
}

function printHelp() {
  console.log(`run-daily-tests.mjs — 日常档测试入口（pnpm test）

语义：diff → 受影响域（domain-slices 选择器）→ 基础池 core 快集 ∪ 命中域全量；
无变更/无命中时仅基础池 core。全量回归入口 = pnpm test:all。

diff base 口径（优先级取第一个可用）：
  1. --base <ref>            显式指定
  2. 分支 upstream（@{upstream}，交付 push 后 = 未 push 的本地改动）
  3. dev-X.Y.Z 分支 → github/dev-X.Y.Z（DEV-WORKFLOW dev 分支队列模型）
  4. github/main（兜底）
变更含未 commit 的工作树改动与 untracked 新文件（merge-base 两点 diff）。

用法：
  pnpm test                              日常档
  pnpm test -- --base <ref>              显式 diff base
  node scripts/run-daily-tests.mjs --pools full    基础池全量（对照/排查）
  node scripts/run-daily-tests.mjs --list          只打印执行清单`)
}

/** CLI 参数解析与校验；--help/-h 返回 null（由 main 打印用法后返回）。 */
function parseDailyArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return null
  const argValue = (name) => {
    const i = args.indexOf(name)
    return i !== -1 ? args[i + 1] : undefined
  }
  const pools = argValue('--pools')
  if (args.includes('--pools') && !['full', 'core'].includes(pools)) {
    console.error('[run-daily-tests] --pools 只接受 full | core')
    process.exit(2)
  }
  return { base: argValue('--base'), listOnly: args.includes('--list'), poolsFull: pools === 'full' }
}

/** 命中域归因清单（每域首条 reason，多条时附计数）。 */
function printAffectedReasons(reasons) {
  for (const d of [...reasons.keys()].sort()) {
    const rs = reasons.get(d)
    console.log(`  - ${d} ← ${rs[0].file}（${rs[0].via}）${rs.length > 1 ? ` 等 ${rs.length} 条` : ''}`)
  }
}

/** 广播载体命中提示（宁全勿缺，不强制）。 */
function printBroadcastHint(broadcastHits) {
  if (broadcastHits.length === 0) return
  console.error(`[run-daily-tests] 广播载体命中（基础层契约枢纽，宁全勿缺）：`)
  for (const f of broadcastHits) console.error(`  - ${f}`)
  console.error('  建议：本档结束后追加全量回归 pnpm test:all（提示不强制）')
}

/** 执行前计划输出（diff 口径 / 命中域）。 */
function printDailyPlan(base, files, affectedDomains, poolHits) {
  console.log('[run-daily-tests] 日常档（按域分流；全量 = pnpm test:all）')
  console.log(`- diff 口径：${base.desc}，变更 ${files.length} 文件（含未 commit 与 untracked）`)
  console.log(
    `- 命中域：${affectedDomains.length} 个${affectedDomains.length ? `（${affectedDomains.join('、')}）` : ''}` +
      `${poolHits.length ? `；基础池命中（${poolHits.join('、')} → 对应池全量）` : ''}`,
  )
}

/** 执行清单规模行（归因明细之后，维持原输出顺序）。 */
function printExecList(execFiles, poolsFull) {
  console.log(`- 执行清单：${execFiles.length} 文件（基础池 ${poolsFull ? '全量' : 'core'} + 域增量）`)
}

function main() {
  const parsed = parseDailyArgs(process.argv.slice(2))
  if (parsed === null) return printHelp()

  const { slices, meta } = loadRegistry()
  const mountDomains = loadMountMap()
  const expand = strictExpander(ROOT)

  const base = resolveBase(parsed.base)
  const files = changedFiles(base.ref)
  const { affected, reasons, broadcastHits } = selectAffectedDomains(slices, meta.broadcastCarriers ?? [], files)
  const affectedDomains = affected.filter((d) => !POOLS.includes(d))
  const poolHits = POOLS.filter((p) => affected.includes(p))

  const collected = collectDomainFiles(slices, mountDomains, [...new Set([...POOLS, ...affected])], expand)
  const execFiles = buildExecFileSet(collected, affected, { poolsFull: parsed.poolsFull })

  printDailyPlan(base, files, affectedDomains, poolHits)
  if (affected.length > 0) printAffectedReasons(reasons)
  printExecList(execFiles, parsed.poolsFull)
  printBroadcastHint(broadcastHits)

  if (execFiles.length === 0) {
    console.error('[run-daily-tests] 执行清单为空（注册表异常）——恢复动作：node scripts/check-domain-slices.mjs')
    process.exit(2)
  }
  if (parsed.listOnly) {
    for (const f of execFiles) console.log(f)
    return
  }

  const { byPkg, problems } = groupFilesByPackage(ROOT, execFiles)
  if (problems.length > 0) {
    console.error(`[run-daily-tests] 以下文件无法定位执行包（向上找不到 vitest config）——登记异常：`)
    for (const f of problems) console.error(`  - ${f}`)
    process.exit(2)
  }

  spawnScript(['scripts/check-test-results.mjs', '--clean'])
  const label = affected.length > 0 ? affected.join(',') : POOLS.join(',')
  const run = runPackages(byPkg, label)
  const aggregate = spawnScript(['scripts/check-test-results.mjs'])

  if (run.failed > 0 || aggregate !== 0) {
    console.error(`\n[run-daily-tests] 日常档完成：${run.failed}/${run.total} 包失败，junit 聚合判定退出码 ${aggregate}`)
    process.exit(1)
  }
  console.log(`\n[run-daily-tests] 日常档全绿（${run.total} 包，${run.files} 文件）`)
}

/** 同步执行仓库脚本并返回退出码（--clean 的输出吞掉，聚合判定输出透传 stdio）。 */
function spawnScript(scriptArgs) {
  const result = spawnSync(process.execPath, scriptArgs, {
    cwd: ROOT,
    stdio: scriptArgs.includes('--clean') ? 'ignore' : 'inherit',
  })
  return result.status ?? 1
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.cwd(), process.argv[1])).href
if (isMain) main()
