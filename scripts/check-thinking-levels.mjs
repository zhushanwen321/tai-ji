#!/usr/bin/env node
/**
 * check-thinking-levels.mjs —— thinking 档位词表比对守卫。
 * （设计：docs/architecture/ext-simplify-17-shared-extraction.md §3.2 D5「机器守卫补强」）
 *
 * 背景：extensions 侧 THINKING_LEVELS 白名单是 pi-ai ModelThinkingLevel 联合的本地副本
 * （分层约束禁跨包 import，D5 双登记裁决），副本漂移钉值单测抓不到——单测只锚副本自身
 * 字面量，pi 升级改联合成员时副本静默过期（P1-a 漏 xhigh 即该代价已兑现的实证）。本守卫
 * 在提交期做构建期词表比对，补上这个红灯缺口。
 *
 * 与 check-pi-sync.mjs / check-pi-semantics.mjs 的分工——零重叠自查：
 * - check-pi-semantics 管实装互检 + 登记表 + 探针族，不校验 extensions 侧词表副本；
 * - check-pi-sync 管 build.yml/快照/peerDeps 等构建期派生锚点，S6 只比 KnownApi（API 名
 *   词表），不碰 thinking 档位；
 * - 本脚本只管 thinking 档位词表：pi-ai dist types.d.ts 的 ModelThinkingLevel 联合成员
 *   ↔ 本地两副本（llm-shared Set / pi-rpc 数组）双向比对。
 *
 * 守卫项 2 组：
 *   T1 llm-shared THINKING_LEVELS（extensions 侧唯一副本）== pi-ai ModelThinkingLevel
 *   T2 pi-rpc THINKING_LEVELS（被迫独立的协议侧副本，顺带比对——提取与比对逻辑同构）[fail]
 *
 * 用法：
 *   node scripts/check-thinking-levels.mjs               # 常规校验（pre-commit 按路径触发）
 *   node scripts/check-thinking-levels.mjs --self-test   # 纯函数轻量自检
 *
 * 零第三方依赖。退出码：0 = 通过；1 = 存在 fail。
 * 提取失败一律 fail（宁可误报不可漏报，pi-ai 源码形态变化时红灯提示人工同步）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PI_AI = '@earendil-works/pi-ai'
const LLM_SHARED_RESOLVE = join(ROOT, 'extensions', 'shared', 'llm-shared', 'src', 'resolve.ts')
const PI_RPC_TYPES = join(ROOT, 'packages', 'pi-rpc', 'src', 'types.ts')
const DESIGN_DOC = 'docs/architecture/ext-simplify-17-shared-extraction.md'

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

// ── 纯函数（--self-test 覆盖）────────────────────────────────────────

/**
 * 从 dts 文本提取 ModelThinkingLevel 联合的完整字符串成员集。
 * pi-ai 实装形态 `export type ModelThinkingLevel = "off" | ThinkingLevel;` 引用同文件
 * 类型别名——标识符引用递归展开（同款 `export type X = ...` 定义，循环引用报 error），
 * 使 pi-ai 未来改成完整字面量联合或多级别名都仍可提取。
 */
export function extractModelThinkingLevel(dtsText) {
  const root = dtsText.match(/export\s+type\s+ModelThinkingLevel\s*=\s*([\s\S]*?);/)
  if (!root) return { error: 'types.d.ts 中未找到 export type ModelThinkingLevel 定义（pi-ai 源码形态变化？）' }
  return expandUnion(root[1], dtsText, new Set(['ModelThinkingLevel']))
}

/** 展开联合表达式：字符串字面量直取，标识符引用按同文件 type 别名定义递归展开。 */
function expandUnion(expr, dtsText, seen) {
  const values = [...expr.matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
  // 字符串字面量剔除后再找标识符，避免把字面量内容当引用
  const stripped = expr.replace(/["'][^"']*["']/g, '')
  const idents = [...stripped.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1])
  for (const id of idents) {
    if (seen.has(id)) return { error: `类型别名循环引用: ${id}` }
    seen.add(id)
    const def = dtsText.match(new RegExp(`export\\s+type\\s+${id}\\s*=\\s*([\\s\\S]*?);`))
    if (!def) return { error: `联合中引用了 ${id}，但 types.d.ts 无对应 export type 定义（形态变化？）` }
    const sub = expandUnion(def[1], dtsText, seen)
    if (sub.error) return sub
    values.push(...sub.values)
  }
  if (values.length === 0) return { error: 'ModelThinkingLevel 定义中提取不到任何字符串字面量' }
  return { values }
}

/**
 * 从 TS 源码提取 `const <name>: <type> = new Set([...])` 或 `= [...]` 的字符串成员
 * （llm-shared Set 字面量与 pi-rpc 数组字面量同构，一条正则覆盖两种副本形态）。
 */
export function extractConstListMembers(text, constName) {
  const m = text.match(new RegExp(`const\\s+${constName}\\s*:[^=]*=\\s*(?:new\\s+Set\\(\\s*)?\\[([\\s\\S]*?)\\]`))
  if (!m) return { error: `源码中未找到 const ${constName} = new Set([...]) / [...] 定义（改名/移动？）` }
  const values = [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1])
  if (values.length === 0) return { error: `const ${constName} 列表中提取不到任何字符串字面量` }
  return { values }
}

/** 求集合差异：extra = a 有 b 无；missing = b 有 a 无。 */
export function setDiff(a, b) {
  const bs = new Set(b)
  const as = new Set(a)
  return {
    extra: [...as].filter((x) => !bs.has(x)),
    missing: [...bs].filter((x) => !as.has(x)),
  }
}

// ── --self-test：纯函数轻量自检（不触真实仓库文件）────────────────────

function selfTest() {
  const assert = (cond, name) => {
    if (!cond) {
      console.error(`  ✗ self-test: ${name}`)
      process.exitCode = 1
    } else {
      console.log(`  ✓ self-test: ${name}`)
    }
  }

  // extractModelThinkingLevel：0.84.4 实测形态（引用别名）/ 完整字面量 / 多级引用 / 缺失 / 循环
  const dts1 =
    'export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";\nexport type ModelThinkingLevel = "off" | ThinkingLevel;'
  assert(
    JSON.stringify(extractModelThinkingLevel(dts1).values) ===
      JSON.stringify(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    '别名引用展开（实装形态）',
  )
  const dts2 = 'export type ModelThinkingLevel = "off" | "low" | "max";'
  assert(JSON.stringify(extractModelThinkingLevel(dts2).values) === JSON.stringify(['off', 'low', 'max']), '完整字面量联合直取')
  const dts3 = 'export type A = "x" | "y";\nexport type B = "z" | A;\nexport type ModelThinkingLevel = "off" | B;'
  assert(JSON.stringify(extractModelThinkingLevel(dts3).values) === JSON.stringify(['off', 'z', 'x', 'y']), '多级别名递归展开')
  assert(extractModelThinkingLevel('export type KnownApi = "a";').error !== undefined, '缺 ModelThinkingLevel 定义报 error')
  const dts4 = 'export type A = A;\nexport type ModelThinkingLevel = A;'
  assert(extractModelThinkingLevel(dts4).error !== undefined, '别名循环引用报 error')
  // extractConstListMembers：Set 多行（llm-shared 形态）/ 数组单行（pi-rpc 形态）/ 缺失
  const ts1 = 'const THINKING_LEVELS: ReadonlySet<string> = new Set([\n\t"off",\n\t"max",\n]);'
  assert(JSON.stringify(extractConstListMembers(ts1, 'THINKING_LEVELS').values) === JSON.stringify(['off', 'max']), 'Set 多行字面量提取（llm-shared 形态）')
  const ts2 = "const THINKING_LEVELS: readonly string[] = ['off', 'max']"
  assert(JSON.stringify(extractConstListMembers(ts2, 'THINKING_LEVELS').values) === JSON.stringify(['off', 'max']), '数组单行提取（pi-rpc 形态）')
  assert(extractConstListMembers('const OTHER = 1;', 'THINKING_LEVELS').error !== undefined, '常量缺失报 error')
  // setDiff
  const d = setDiff(['a', 'b'], ['b', 'c'])
  assert(JSON.stringify(d.extra) === '["a"]' && JSON.stringify(d.missing) === '["c"]', 'setDiff 双向差异')

  if (process.exitCode === 1) {
    console.error('thinking-levels self-test 未通过')
    process.exit(1)
  }
  console.log('✓ thinking-levels self-test 全部通过')
  process.exit(0)
}

if (process.argv.includes('--self-test')) selfTest()

// ── 实装定位（与 check-pi-sync.mjs resolvePiAiRoot 同款爬包根手法，校验 name 防爬出包）──

/** 定位 node_modules 实装 pi-ai 包根，返回 {root} 或 {error}。不执行 pi-ai 代码，纯路径解析。 */
export function resolvePiAiRoot() {
  let dir
  try {
    // exports 封锁 './package.json'，只能从可导入子路径入口爬（check-pi-sync 已验证）
    dir = dirname(fileURLToPath(import.meta.resolve(`${PI_AI}/providers/all`)))
  } catch (e) {
    return { error: `无法解析 ${PI_AI} 入口（未安装？）：${e.message.split('\n')[0]}` }
  }
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8'))
      if (pkg.name === PI_AI) return { root: dir }
    } catch {
      // 当前目录无 package.json，继续向上
    }
    const parent = dirname(dir)
    if (parent === dir) return { error: `从 providers/all 入口向上未定位到 ${PI_AI} 包根` }
    dir = parent
  }
}

// ── 权威源读取 ───────────────────────────────────────────────────────

const piAiRoot = resolvePiAiRoot()
let dtsText
let piAiVersion
if (piAiRoot.error) {
  console.error(
    `  ✗ node_modules 实装 pi-ai 不可用（${piAiRoot.error}）——恢复动作：仓库根执行 pnpm install 后重跑 node scripts/check-thinking-levels.mjs`,
  )
  process.exit(1)
}
const dtsPath = join(piAiRoot.root, 'dist', 'types.d.ts')
if (!existsSync(dtsPath)) {
  console.error(
    `  ✗ 实装 pi-ai 的 dist/types.d.ts 缺失: ${dtsPath}——恢复动作：确认 pnpm install 完整；若 pi-ai 改了类型文件布局，同步 scripts/check-thinking-levels.mjs 的定位逻辑`,
  )
  process.exit(1)
}
dtsText = readFileSync(dtsPath, 'utf-8')
piAiVersion = JSON.parse(readFileSync(join(piAiRoot.root, 'package.json'), 'utf-8')).version

const extracted = extractModelThinkingLevel(dtsText)
if (extracted.error) {
  console.error(
    `  ✗ ModelThinkingLevel 提取失败: ${extracted.error}——恢复动作：人工核对 ${dtsPath} 的定义形态后同步 scripts/check-thinking-levels.mjs 的提取正则，重跑 node scripts/check-thinking-levels.mjs`,
  )
  process.exit(1)
}
const piMembers = extracted.values
console.log(`thinking-levels 守卫：权威源 pi-ai ${piAiVersion} ModelThinkingLevel（${piMembers.length} 值）↔ 本地词表副本`)

// ── 副本比对（T1 llm-shared / T2 pi-rpc；fail 信息指向各自副本 + 设计文档）──

const RECOVERY_SUFFIX = `——恢复动作：人工核对 ${dtsPath} 的 ModelThinkingLevel 定义后同步副本与 ${DESIGN_DOC} D5（pi 升级新增/移除档位即红灯），重跑 node scripts/check-thinking-levels.mjs`

function compareCopy(label, filePath, values) {
  const { extra, missing } = setDiff(values, piMembers)
  if (extra.length === 0 && missing.length === 0) {
    ok(`${label} 与 pi-ai ${piAiVersion} ModelThinkingLevel 一致（${values.length} 值）`)
    return
  }
  const parts = []
  if (extra.length > 0) parts.push(`副本多出: ${extra.join(', ')}`)
  if (missing.length > 0) parts.push(`副本缺失: ${missing.join(', ')}`)
  fail(`${label} 与 pi-ai ${piAiVersion} ModelThinkingLevel 漂移: ${parts.join('；')}${RECOVERY_SUFFIX}`)
}

// T1：llm-shared（extensions 侧唯一副本，D5 双登记裁决）
{
  if (!existsSync(LLM_SHARED_RESOLVE)) {
    fail(`T1 llm-shared resolve.ts 缺失: ${LLM_SHARED_RESOLVE}——恢复动作：确认文件未被移动/删除（副本迁移时同步本守卫路径与 ${DESIGN_DOC} D5）`)
  } else {
    const r = extractConstListMembers(readFileSync(LLM_SHARED_RESOLVE, 'utf-8'), 'THINKING_LEVELS')
    if (r.error) {
      fail(`T1 llm-shared THINKING_LEVELS 提取失败: ${r.error}（${LLM_SHARED_RESOLVE}）${RECOVERY_SUFFIX}`)
    } else {
      compareCopy('T1 llm-shared THINKING_LEVELS', LLM_SHARED_RESOLVE, r.values)
    }
  }
}

// T2：pi-rpc（协议侧被迫独立副本，package.json 明文禁 subagent-core 依赖；顺带比对）
{
  if (!existsSync(PI_RPC_TYPES)) {
    fail(`T2 pi-rpc types.ts 缺失: ${PI_RPC_TYPES}——恢复动作：确认文件未被移动/删除（副本迁移时同步本守卫路径）`)
  } else {
    const r = extractConstListMembers(readFileSync(PI_RPC_TYPES, 'utf-8'), 'THINKING_LEVELS')
    if (r.error) {
      fail(`T2 pi-rpc THINKING_LEVELS 提取失败: ${r.error}（${PI_RPC_TYPES}）${RECOVERY_SUFFIX}`)
    } else {
      compareCopy('T2 pi-rpc THINKING_LEVELS', PI_RPC_TYPES, r.values)
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────
if (failed === 0) {
  console.log(`✓ thinking-levels 守卫通过（pi-ai ${piAiVersion} 权威源 ↔ llm-shared + pi-rpc 两副本词表一致）`)
  process.exit(0)
}
console.error('thinking-levels 守卫未通过，按上方 ✗ 明细修复后重跑（每条报错自带恢复动作）')
process.exit(1)
