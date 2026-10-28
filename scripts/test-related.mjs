#!/usr/bin/env node
/**
 * scripts/test-related.mjs —— diff 关联文件级测试跑（测试提速目标 B 的替代口径 B2）。
 *
 * 用途：日常循环只跑「本次改动触及的源文件」按 import 关系反查出的关联测试
 * （vitest related 语义），而非包级全量。
 *
 * ── 输入形态 ─────────────────────────────────────────────────────────────────
 * 1. 显式文件列表：`node scripts/test-related.mjs <file> [<file> ...]`
 *    路径相对仓库根或绝对路径均可；不存在的文件按 0 关联容错（vitest related 对
 *    缺失 target 自然给出 0 关联，已实测）。
 * 2. 无参数：自动取 `git diff --name-only $(git merge-base HEAD <base>)`（工作树 vs
 *    base，含未提交改动——日常循环的主场景是 feat worktree 上「分支以来 + 未提交」）。
 *    base 解析顺序：`--base <ref>` 参数 > env `TAIJI_TEST_RELATED_BASE` > 自动推导。
 *
 *    默认 base = HEAD 与主开发分支的 merge-base。选 merge-base 而非固定 ref 的理由：
 *    DEV-WORKFLOW 的 worktree 模型下 feat 分支从 dev 队列分支切出，
 *    merge-base(HEAD, dev) 恰好 = 分叉点，diff 即「本分支自己的改动」，不含 dev 分支
 *    上别人的未发布提交（对比 merge-base(HEAD, main) 会把 dev 领先 main 的整段都算进来）。
 *    主开发分支自动推导：取远程 github/dev-* 中版本号最高者（dev 队列尾即当前活跃
 *    dev 分支），排除与当前分支同名者；无 dev-* 时退化 main。merge-base == HEAD
 *    （当前就在主开发分支上，无独立改动）时打印提示退出 0——此时请显式传文件或 --base。
 *
 * ── 定位与执行 ───────────────────────────────────────────────────────────────
 * - 从变更文件路径逐级向上推导最近的测试根：优先「含 vitest.config.ts 的目录」
 *   （apps/electron/main 这类非 workspace 包的独立 config 先例），其次「含
 *   package.json 的 workspace 包目录」；到仓库根仍无 → 该文件打印跳过
 *   （docs / 根配置 / e2e / taste-lint / 根 scripts 等均属此类——根 config 是
 *   全仓跑的兜底防线而非日常入口，变更根 scripts 不在本脚本范围）。
 * - 每包一次 vitest 程序化预检（vitest/node 的 createVitest +
 *   getRelevantTestSpecifications，即 `vitest list --files-only` 同款纯枚举管线，
 *   做 import 图分析但不执行测试）：
 *   - 关联测试文件数 N == 0：打印「无关联测试」，正常跳过。
 *   - 0 < N <= CAP：spawn CLI `npx vitest run <预检枚举出的 N 个文件>`——文件
 *     集合与 `npx vitest related --run <files>` 完全相同（清单即 related 过滤器
 *     输出），但省掉第二次 import 图分析（runtime 级大模块图单次 ~7s）。
 *   - N > CAP：该包回退包全量——spawn CLI `npx vitest run`（cwd = 包根，走该包
 *     config 的分池与门控），打印提示。触及 barrel / 大模块枢纽时 related 会爆炸，
 *     全量的分池调度（串行尾组、threads 池满并行）比散弹式 related 更可预期。
 * - CAP = env `TAIJI_TEST_RELATED_CAP`（默认 60，超限判定为 N > CAP）。
 * - 包内逐包严格串行（本脚本不引入任何并发）；overall 并行度 = 1。
 *
 * ── 回退名单（related 兼容性探针结论，2026-10-26 于 vitest 4.1.9 实测）────────
 * 以下形态特殊的包 `vitest related` 均可用（探针 + 30 merge 回放复核）：
 * - packages/runtime（main/real-pi/integration 三池）：related 可用（import 图分析
 *   固定成本 ~8s，是模块图体量决定的，与分池无关）。
 * - packages/zcode-session-source（unit/slow-sqlite 双池）、
 *   apps/electron/main（guarded/legacy 双池）、extensions/shared/file-lock
 *   （unit/integration 两池）：related 均可用。
 * 「CLI 旗标 + 多 project 配置」的冲突前科（packages/runtime 三池曾启动即失败）
 * 未在 related 路径复发。
 *
 * 静态不兼容名单（见 STATIC_FALLBACK_PKGS，直接回退包全量）：
 * - packages/subagent-core：workflows/*.js 是构建期壳模板（顶层 return 的 CJS
 *   形态，文件头声明「语法上不可 import」），而其契约测试以动态 import 断言
 *   import 该文件必须 rejects——related 预检的 import 图分析（含 dynamicDeps）
 *   transform 该文件即 Parse failure（30 merge 回放 20/22 次复现）；执行路径
 *   不受影响（运行时 reject 恰是断言对象），故仅预检不可用，直接全量。
 * 其余包若运行时枚举失败，同样自动回退该包全量并注明原因。
 *
 * ── 环境与退出码 ─────────────────────────────────────────────────────────────
 * - 内部统一带 TAIJI_SKIP_REAL_PI=1（不烧真实 LLM token；real-pi 池组内
 *   REAL_PI_READY 门控自动 skip，integration 池 TAIJI_TEST_INTEGRATION 不设即跳过）。
 * - 退出码：全部包绿（或全部无关联/跳过）= 0；任一包测试红或启动失败 = 1。
 * - 输出：每包打印 变更文件清单 / 关联测试数 N / 模式（related | full-fallback |
 *   no-related | skipped-no-pkg）/ 墙钟 / 通过与失败计数；末尾 SUMMARY 一行。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CAP = Number.parseInt(process.env.TAIJI_TEST_RELATED_CAP ?? '60', 10)
const TEST_ENV = { ...process.env, TAIJI_SKIP_REAL_PI: '1' }

// 静态不兼容名单（理由见文件头「回退名单」节）：这些包不做 related 预检，直接全量。
const STATIC_FALLBACK_PKGS = new Set(['packages/subagent-core'])

// ── 参数解析 ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const files = []
  let base = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') {
      base = argv[++i]
      if (!base) throw new Error('--base 需要一个 ref 参数')
    } else if (a.startsWith('--base=')) {
      base = a.slice('--base='.length)
    } else if (a === '--help' || a === '-h') {
      printUsage()
      process.exit(0)
    } else {
      files.push(a)
    }
  }
  return { files, base }
}

function printUsage() {
  console.log(`用法:
  node scripts/test-related.mjs <file> [<file> ...]   显式文件列表（相对仓库根或绝对）
  node scripts/test-related.mjs --base <ref>          无文件时 git diff 的 base 覆盖
  node scripts/test-related.mjs                       自动：git diff merge-base(HEAD, 主开发分支)

环境变量:
  TAIJI_TEST_RELATED_BASE   默认 base ref 覆盖（优先级低于 --base）
  TAIJI_TEST_RELATED_CAP    关联测试文件数上限（默认 60，超过回退该包全量）
内部统一带 TAIJI_SKIP_REAL_PI=1。`)
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', ...opts }).trim()
}

// ── 默认 base：主开发分支自动推导 ─────────────────────────────────────────────
function versionKey(ref) {
  const m = ref.match(/dev-(\d+(?:\.\d+)*)$/)
  return m ? m[1].split('.').map(Number) : null
}

function cmpVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d
  }
  return 0
}

function resolveMainDevBranch() {
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/github'])
    .split('\n')
    .filter(Boolean)
  const devRefs = refs
    .map((r) => r.replace(/^github\//, ''))
    .filter((r) => r.startsWith('dev-') && versionKey(r))
    .sort((x, y) => cmpVersion(versionKey(x), versionKey(y)))
  if (devRefs.length) return `github/${devRefs[devRefs.length - 1]}`
  return 'github/main'
}

function collectChangedFiles(baseOverride) {
  const baseRef = baseOverride ?? process.env.TAIJI_TEST_RELATED_BASE ?? resolveMainDevBranch()
  const mergeBase = git(['merge-base', 'HEAD', baseRef])
  // merge-base == HEAD 的两种场景都合法：当前分支即主开发分支（diff 退化为
  // 未提交改动）；或当前分支领先 base。均直接用 merge-base，diff 为空再退出。
  console.log(`[test-related] 无文件参数：git diff --name-only ${mergeBase}（base 分支 ${baseRef} 的 merge-base，含未提交改动）`)
  return git(['diff', '--name-only', mergeBase]).split('\n').filter(Boolean)
}

// ── 包归属推导：最近 vitest.config.ts > 最近 package.json（非根）──────────────
// 仓库根本身有 vitest.config.ts（全仓跑的兜底防线）与 package.json，均不算归属
// 目标——日常入口必须是各包 cwd（仓规），无包归属文件一律跳过。
function resolveTestRoot(fileRel) {
  let dir = dirname(resolve(REPO_ROOT, fileRel))
  while (dir !== REPO_ROOT) {
    if (existsSync(join(dir, 'vitest.config.ts'))) return dir
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return null
}

// ── 单包执行：预检（纯枚举）→ 按枚举清单跑 / 全量回退 ───────────────────────
// 预检：createVitest + getRelevantTestSpecifications（vitest list --files-only 同款
// 管线）——只做 import 图分析与 glob，不执行测试、不触发 reporter 事件（程序化
// runTestSpecifications 路径在 vitest 4.1.9 有 reporter ctx 注入崩溃，实测于
// packages/shared：每个 reporter 事件抛 reading 'config'/reading 'logger'，故执行段
// 一律走 CLI 子进程）。执行段用 `npx vitest run <预检枚举出的关联测试文件清单>`
// 而非二次 `vitest related --run`：跑的文件集合与 related --run 完全相同（清单就是
// related 过滤器的输出），但省掉第二次 import 图分析（runtime 级大模块图单次 ~7s）。
async function enumerateRelated(pkgRoot, absTargets) {
  const { createVitest } = await import('vitest/node')
  const vitest = await createVitest('test', {
    root: pkgRoot,
    watch: false,
    run: true,
    reporters: [],
    related: absTargets,
  })
  try {
    const specs = await vitest.getRelevantTestSpecifications()
    return specs.map((s) => s.moduleId)
  } finally {
    await vitest.close().catch(() => {})
  }
}

async function runPackage(pkgRoot, filesRel) {
  const pkgLabel = relative(REPO_ROOT, pkgRoot) || '.'
  const t0 = performance.now()
  const absTargets = filesRel.map((f) => resolve(REPO_ROOT, f))
  const wall = () => `${((performance.now() - t0) / 1000).toFixed(1)}s`

  if (STATIC_FALLBACK_PKGS.has(pkgLabel)) {
    console.log(`[test-related] ${pkgLabel}: 在静态不兼容名单（related 预检不可用，见脚本头注释），直接包全量`)
    return runFullFallback(pkgRoot, pkgLabel, filesRel, t0, 'static-fallback-list')
  }

  let relatedFiles
  try {
    relatedFiles = await enumerateRelated(pkgRoot, absTargets)
  } catch (e) {
    console.log(`[test-related] ${pkgLabel}: 关联枚举失败（${String(e.message).split('\n')[0]}），该包回退全量`)
    return runFullFallback(pkgRoot, pkgLabel, filesRel, t0, `enumerate-failed: ${String(e.message).split('\n')[0]}`)
  }

  const n = relatedFiles.length
  if (n === 0) {
    console.log(`[test-related] ${pkgLabel}: 无关联测试，跳过（files=${filesRel.join(', ')}，wall=${wall()}）`)
    return { pkg: pkgLabel, mode: 'no-related', related: 0, passed: 0, failed: 0, fallback: false, wallSec: (performance.now() - t0) / 1000, files: filesRel }
  }
  if (n > CAP) {
    console.log(`[test-related] ${pkgLabel}: 关联测试 ${n} 个 > 上限 ${CAP}，回退包全量（触及 barrel/枢纽的爆炸保护）`)
    return runFullFallback(pkgRoot, pkgLabel, filesRel, t0, `cap-${n}-gt-${CAP}`)
  }

  console.log(`[test-related] ${pkgLabel}: related 模式，关联测试文件 ${n} 个（files=${filesRel.join(', ')}）`)
  const res = spawnSync('npx', ['vitest', 'run', ...relatedFiles], {
    cwd: pkgRoot,
    env: TEST_ENV,
    stdio: 'inherit',
  })
  const wallSec = (performance.now() - t0) / 1000
  const failed = res.status === 0 ? 0 : 1
  console.log(`[test-related] ${pkgLabel}: related 完成 exit=${res.status}，wall=${wallSec.toFixed(1)}s`)
  return { pkg: pkgLabel, mode: 'related', related: n, passed: failed ? 0 : n, failed, fallback: false, wallSec, files: filesRel }
}

function runFullFallback(pkgRoot, pkgLabel, filesRel, t0, reason) {
  console.log(`[test-related] ${pkgLabel}: 包全量回退执行（npx vitest run，reason=${reason}）`)
  const res = spawnSync('npx', ['vitest', 'run'], {
    cwd: pkgRoot,
    env: TEST_ENV,
    stdio: 'inherit',
  })
  const wallSec = (performance.now() - t0) / 1000
  const failed = res.status === 0 ? 0 : 1
  console.log(`[test-related] ${pkgLabel}: 全量回退完成 exit=${res.status}，wall=${wallSec.toFixed(1)}s`)
  return { pkg: pkgLabel, mode: 'full-fallback', related: -1, passed: failed ? 0 : 1, failed, fallback: true, fallbackReason: reason, wallSec, files: filesRel }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const { files: fileArgs, base } = parseArgs(process.argv.slice(2))
const changed = fileArgs.length ? fileArgs : collectChangedFiles(base)
if (!changed.length) {
  console.log('[test-related] 变更文件列表为空，无事可做。')
  process.exit(0)
}

// 归属分桶（保持包序稳定）
const buckets = new Map()
const noPkg = []
for (const f of changed) {
  const root = resolveTestRoot(f)
  if (!root) noPkg.push(f)
  else if (!buckets.has(root)) buckets.set(root, [f])
  else buckets.get(root).push(f)
}
for (const f of noPkg) {
  console.log(`[test-related] 跳过（无 workspace 包归属）：${f}`)
}

const totalT0 = performance.now()
const results = []
for (const [pkgRoot, files] of buckets) {
  results.push(await runPackage(pkgRoot, files))
}

const totalWall = ((performance.now() - totalT0) / 1000).toFixed(1)
const failedPkgs = results.filter((r) => r.failed > 0)
console.log('')
console.log('── 每包明细 ──')
for (const r of results) {
  const rel = r.related < 0 ? 'fallback' : String(r.related)
  console.log(
    `${r.pkg}: mode=${r.mode}, related=${rel}, files=[${r.files.join(', ')}], wall=${r.wallSec.toFixed(1)}s` +
      (r.fallback ? `, fallbackReason=${r.fallbackReason}` : '') +
      (r.failed ? `, RED=${r.failed}` : ''),
  )
}
console.log(
  `[test-related] SUMMARY packages=${results.length} no-related=${results.filter((r) => r.mode === 'no-related').length} ` +
    `fallback=${results.filter((r) => r.fallback).length} skipped-no-pkg=${noPkg.length} ` +
    `failed=${failedPkgs.length} wall=${totalWall}s`,
)
process.exit(failedPkgs.length ? 1 : 0)
