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
 *   4. 仓库根 vitest.config.ts（兜底 config）必须存在且含 `taijiTestConfig`；
 *   5. 凡声明 `projects` 的 config，projects 数组内每个 project 条目都必须覆盖 fs-guard
 *      （经工厂 `guardProjectSetup` 助手，或显式 `setupFiles: [FS_GUARD_PATH]`）——
 *      projects 内 setupFiles 不继承 root 级，新 project 漏挂即静默失去 fs-guard 切面；
 *      有意不挂 fs-guard 的 project 须登记在 PROJECT_GUARD_EXEMPT（当前唯一例外：
 *      apps/electron/main 的 legacy 池，存量用例未适配 guard，见其配置注释）。
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
/** project 级防线挂载特征：project `test` 片段经工厂 guardProjectSetup 助手包装。 */
const GUARD_PROJECT_MARK = 'guardProjectSetup'
/** project 级防线显式挂载特征（不经助手时的等价形态）。 */
const GUARD_SETUP_MARK = 'FS_GUARD_PATH'
/**
 * 已登记的 project 级 fs-guard 豁免（有意不挂 guard 的 project）。
 * key = config 相对目标根的 posix 路径，value = 该 config 内豁免的 project name 列表。
 * 新增豁免必须在此登记并附原因——把「有意不挂」与「漏挂」区分开，后者仍被本守卫拦截。
 */
const PROJECT_GUARD_EXEMPT = {
  // legacy 池为存量 40+ 测试文件；挂 guard 会暴露存量用例自身设计缺陷（见该 config 注释），
  // 接入是独立单元工作，故有意豁免。
  'apps/electron/main/vitest.config.ts': ['legacy'],
}
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

/** 去除 // 行注释与块注释（字符串字面量内原样保留）——避免注释里的括号/逗号干扰结构扫描。 */
/** 行注释消费：跳到行尾换行符处（不含换行本身，由调用方补回换行保持行号）。返回新下标。 */
function skipLineComment(text, i) {
  while (i < text.length && text[i] !== '\n') i++
  return i
}

/** 块注释消费：跳过到收口符之后（与原内联写法一致，收口判定后的下标自增含在返回值里）。返回新下标。 */
function skipBlockComment(text, i) {
  i += 2
  while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
  return i + 1
}

/** 摘除字符串字面量外的全部注释（行注释位补回换行），供后续按行正则扫描。 */
function stripComments(text) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      i = skipLineComment(text, i)
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i)
      continue
    }
    out += ch
  }
  return out
}

/** 定位 `projects: [ ... ]` 的数组体（字符串感知的方括号配平）；未声明/不可解析返回 null。 */
function extractProjectsBody(text) {
  const clean = stripComments(text)
  const marker = /\bprojects\s*:\s*\[/.exec(clean)
  if (!marker) return null
  const open = clean.indexOf('[', marker.index)
  let depth = 0
  let quote = null
  for (let i = open; i < clean.length; i++) {
    const ch = clean[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if (ch === '[') depth++
    else if (ch === ']') {
      depth--
      if (depth === 0) return clean.slice(open + 1, i)
    }
  }
  return null
}

/** 把数组体按顶层逗号切成元素（越出嵌套括号/字符串的逗号不算分隔）。 */
/** 单字符分类表：顶层切分扫描用（Set 命中语义与 === 链逐字一致）。 */
const QUOTE_CHARS = new Set(['"', "'", '`'])
const OPEN_BRACKETS = new Set(['[', '{', '('])
const CLOSE_BRACKETS = new Set([']', '}', ')'])

/** 按括号深度切顶层元素（引号内字符不参与计数），供 projects/coverage 提取用。 */
function splitTopLevelElements(body) {
  const out = []
  let depth = 0
  let start = 0
  let quote = null
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (QUOTE_CHARS.has(ch)) quote = ch
    else if (OPEN_BRACKETS.has(ch)) depth++
    else if (CLOSE_BRACKETS.has(ch)) depth--
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i))
      start = i + 1
    }
  }
  out.push(body.slice(start))
  return out.map((s) => s.trim()).filter((s) => s.length > 0)
}

/** project name 提取（object 字面量的 name: 'xxx'；字符串 glob 元素无名）。 */
function projectName(element, index) {
  return /name\s*:\s*['"`]([\w-]+)['"`]/.exec(element)?.[1] ?? `#${index}`
}

/**
 * 第 5 条：凡声明 projects 的 config，逐个 project 校验 fs-guard 覆盖（未覆盖 → 违规）。
 * 覆盖 = 经工厂 guardProjectSetup 助手，或显式 setupFiles: [FS_GUARD_PATH]。
 */
function checkProjectGuard(configPath, label, text) {
  if (!/\bprojects\s*:/.test(text)) return []
  const body = extractProjectsBody(text)
  if (body === null) {
    return [
      `${label}：声明了 projects 但无法静态解析（内联数组形态不可判定）——请用内联 projects 数组 + guardProjectSetup 挂 project 级 fs-guard`,
    ]
  }
  const rel = toPosix(path.relative(targetRoot, configPath))
  const exempt = new Set(PROJECT_GUARD_EXEMPT[rel] ?? [])
  const violations = []
  for (const [index, element] of splitTopLevelElements(body).entries()) {
    if (element.includes(GUARD_PROJECT_MARK) || element.includes(GUARD_SETUP_MARK)) continue
    const name = projectName(element, index)
    if (exempt.has(name)) continue
    violations.push(
      `${label}：project '${name}' 未挂 fs-guard（test 片段既无 ${GUARD_PROJECT_MARK}，也无 ${GUARD_SETUP_MARK}）——` +
        `新 project 漏挂会让该 project 全部测试静默失去破坏性 fs 拦截；有意不挂请登记 PROJECT_GUARD_EXEMPT`,
    )
  }
  return violations
}

/** 单个 config 文件校验：返回违规描述列表（不存在 / 未含防线特征 / project 级漏挂），合法返回空数组。 */
function checkConfig(configPath, missingText) {
  if (!existsSync(configPath)) return [`${missingText}：vitest.config.ts 不存在`]
  const text = readFileSync(configPath, 'utf-8')
  if (!text.includes(FACTORY_MARK)) {
    return [`${missingText}：vitest.config.ts 存在但未引用 ${FACTORY_MARK}（未经 taijiTestConfig 包装）`]
  }
  return checkProjectGuard(configPath, missingText, text)
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
  failures.push(
    ...checkConfig(
      path.join(targetRoot, rel, 'vitest.config.ts'),
      `${rel}（包根，${tests.length} 个测试文件归属）`,
    ),
  )
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
  failures.push(
    ...checkConfig(
      path.join(testGuardDir, 'vitest.config.ts'),
      'test-guard（无 package.json 目录，' + `其下 ${testGuardTests.length} 个 *.test.*）`,
    ),
  )
}

// ── 4. 仓库根兜底 config（无条件校验）───────────────────────────────────
failures.push(...checkConfig(path.join(targetRoot, 'vitest.config.ts'), '<目标根>（仓库根兜底）'))

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
