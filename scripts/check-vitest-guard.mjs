#!/usr/bin/env node
/**
 * check-vitest-guard.mjs — vitest 防线挂载守卫：所有含 vitest 测试的包，其
 * vitest.config.ts 必须经仓库根 test-guard/factory.ts 导出的 taijiTestConfig 包装
 * （文件特征：内容含 `test-guard/factory`），使 TAIJI_AGENT_DATA_DIR 钉死 + fs-guard
 * 破坏性 fs 操作拦截两条防线对所有 vitest 运行生效；防「新包/新 config 漏挂防线」回归。
 *
 * 背景事故：2026-09-16 从 packages/shared cwd 误跑 workspace 全仓 vitest，runtime 包
 * 防线配置未加载，测试删除了用户真实 ~/.taiji 数据目录。
 *
 * 检查面：
 *   1. packages/ extensions/ apps/ 下 *.test.ts / *.test.mjs（排除 node_modules、
 *      dist、test-results 目录段）→ 向上最近含 package.json 或 vitest.config.ts 的
 *      目录 = 包根（去重）；
 *   2. 每个包根的 vitest.config.ts 必须存在且含 `taijiTestConfig`；
 *   3. test-guard/（无 package.json）下若有 *.test.ts，test-guard/vitest.config.ts
 *      必须含 `taijiTestConfig`；
 *   4. 仓库根 vitest.config.ts（兜底 config）必须存在且含 `taijiTestConfig`。
 *
 * 只做静态特征校验，不执行测试。
 * 用法：node scripts/check-vitest-guard.mjs [目标根目录]（缺省 = 仓库根；位置参数仅供 fixture 自测）
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 防线挂载特征：vitest.config.ts 经 test-guard/factory 包装后必含工厂函数名。
 * 用函数名而非 import 路径做特征：test-guard/ 自身的 config 以相对路径 './factory.ts'
 * 引用（含会误判路径特征的形态），工厂函数名才是「经工厂包装」的本质标记。 */
const FACTORY_MARK = 'taijiTestConfig'
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..')
// 缺省根由脚本位置推导（不依赖 cwd）；位置参数仅供 fixture 自测覆盖目标根
const targetRoot = path.resolve(process.argv[2] ?? DEFAULT_ROOT)

/** 扫描根（相对目标根）与排除的目录段 */
const SCAN_ROOTS = ['packages', 'extensions', 'apps']
const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'test-results'])
const TEST_SUFFIXES = ['.test.ts', '.test.mjs']

const toPosix = (p) => p.split(path.sep).join('/')

function isDirectory(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 递归收集目录树下的 *.test.ts / *.test.mjs（绝对路径），跳过排除目录段 */
function collectTestFiles(absDir, out = []) {
  if (!isDirectory(absDir)) return out
  for (const name of readdirSync(absDir)) {
    const full = path.join(absDir, name)
    if (isDirectory(full)) {
      if (EXCLUDED_DIR_NAMES.has(name)) continue
      collectTestFiles(full, out)
    } else if (TEST_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
      out.push(full)
    }
  }
  return out
}

/**
 * 归属规则：测试文件向上最近的含 package.json **或 vitest.config.ts** 的目录 = 其包根。
 * vitest.config.ts 也算归属锚点：apps/electron/main 是测试组织单元但非 workspace 包
 * （无 package.json），其 config 就在 main/ 下——按 config 位置归属才不会被误并到
 * apps/electron 层报「缺 config」假红。
 * 一路到目标根（含，目标根自身可作兜底归属）仍无 → 孤儿（返回 null）。
 */
function findPkgRoot(absFile) {
  let dir = path.dirname(absFile)
  while (true) {
    if (existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, 'vitest.config.ts'))) return dir
    if (dir === targetRoot) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 单个 config 文件校验：不存在 / 存在但未含防线特征，各返回一条违规描述，合法返回 null */
function checkConfig(configPath, missingText) {
  if (!existsSync(configPath)) return `${missingText}：vitest.config.ts 不存在`
  if (!readFileSync(configPath, 'utf-8').includes(FACTORY_MARK)) {
    return `${missingText}：vitest.config.ts 存在但未引用 ${FACTORY_MARK}（未经 taijiTestConfig 包装）`
  }
  return null
}

const failures = []

// ── 1+2. 扫描测试文件 → 归属包根 → 逐包根校验 config ─────────────────────
const testFiles = []
for (const scanRoot of SCAN_ROOTS) {
  testFiles.push(...collectTestFiles(path.join(targetRoot, scanRoot)))
}

const testsByPkgRoot = new Map() // 包根绝对路径 → 归属测试文件列表
const orphans = []
for (const file of testFiles) {
  const pkgRoot = findPkgRoot(file)
  if (pkgRoot === null) {
    orphans.push(file)
    continue
  }
  if (!testsByPkgRoot.has(pkgRoot)) testsByPkgRoot.set(pkgRoot, [])
  testsByPkgRoot.get(pkgRoot).push(file)
}

const pkgRootEntries = [...testsByPkgRoot.entries()]
  .map(([pkgRoot, tests]) => ({ rel: toPosix(path.relative(targetRoot, pkgRoot)), tests }))
  .sort((a, b) => a.rel.localeCompare(b.rel))

for (const { rel, tests } of pkgRootEntries) {
  const violation = checkConfig(
    path.join(targetRoot, rel, 'vitest.config.ts'),
    `${rel}（包根，${tests.length} 个测试文件归属）`,
  )
  if (violation) failures.push(violation)
}

for (const file of orphans) {
  failures.push(
    `${toPosix(path.relative(targetRoot, file))}（孤儿测试文件）` +
      `：不属于任何包根（向上至目标根均无 package.json，无 vitest.config.ts 挂载点）`,
  )
}

// ── 3. test-guard/（无 package.json）条件校验 ────────────────────────────
const testGuardDir = path.join(targetRoot, 'test-guard')
const testGuardTests = collectTestFiles(testGuardDir)
let testGuardChecked = false
if (testGuardTests.length > 0) {
  testGuardChecked = true
  const violation = checkConfig(
    path.join(testGuardDir, 'vitest.config.ts'),
    'test-guard（无 package.json 目录，' + `其下 ${testGuardTests.length} 个 *.test.*）`,
  )
  if (violation) failures.push(violation)
}

// ── 4. 仓库根兜底 config（无条件校验）───────────────────────────────────
const rootConfigViolation = checkConfig(
  path.join(targetRoot, 'vitest.config.ts'),
  '<目标根>（仓库根兜底）',
)
if (rootConfigViolation) failures.push(rootConfigViolation)

// ── 输出 ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`[vitest-guard] 守卫拦截：${failures.length} 项违规（目标根：${toPosix(targetRoot)}）\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error('')
  console.error('[FIX] vitest.config.ts 必须经 test-guard/factory 的 taijiTestConfig 包装，参照 packages/shared/vitest.config.ts。')
  console.error('      孤儿测试文件：移入既有包，或为其所在目录补 package.json + 挂防线的 vitest.config.ts。')
  process.exit(1)
}

console.log(
  `[vitest-guard] OK：vitest 防线挂载完整（包根 ${pkgRootEntries.length} 个 ✓` +
    ` + test-guard ${testGuardChecked ? '✓' : '无测试文件，不适用'}` +
    ` + 根兜底 ✓；扫描测试文件 ${testFiles.length} 个，目标根 ${toPosix(targetRoot)}）`,
)
