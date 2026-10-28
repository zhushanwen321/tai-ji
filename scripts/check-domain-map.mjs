#!/usr/bin/env node
/**
 * check-domain-map.mjs — docs/testing/domain-map.json 的机器自校验。
 *
 * domain-map.json 是「挂载渲染重型测试按域触发」的单一权威源（round6 Wave2），
 * 三方消费它：renderer/ui 的 vitest.config.ts（默认档排除）、
 * scripts/run-domain-tests.mjs（域触发）、本脚本（健康度校验）。任何一侧漂移
 * （文件改名/移动、清单双收录、登记了非挂载文件、config 绕开权威源）都会让
 * 「默认档排除」与「域触发选中」失配——本脚本把这些漂移拦成红灯。
 *
 * 检查项：
 *   1. 结构：domains 非空，每域有 summary 与非空 files 数组；
 *   2. 路径格式：条目必须是 packages/{renderer,ui}/src/ 下的 .test.ts(x)/.spec.ts；
 *   3. 存在性：每个登记文件必须在盘上（改名/删除未同步登记 → 红）；
 *   4. 双收录：同一文件只允许归属一个域；
 *   5. 挂载特征：登记文件必须含 @vue/test-utils 引用或 mount( 调用——
 *      防止逻辑文件被误登记进域清单（域清单只收挂载渲染重型文件）；
 *   6. 消费一致性：renderer/ui 的 vitest.config.ts 必须引用 domain-exclusions
 *      加载器（默认档排除来自权威源），scripts/run-domain-tests.mjs 必须存在。
 *   7. staged 新增挂载文件登记提示（warn 级）：新增 .test.ts 含挂载特征且未登记
 *      域表时提示自查（重型的结果性判定兜底 = CI check-slow-tests >2s 门禁，
 *      静态特征区分不了轻重，故不红灯）。
 *
 * 用法：node scripts/check-domain-map.mjs（不挂钩子，挂接归 W2-C）
 */
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const MAP_PATH = path.join(ROOT, 'docs', 'testing', 'domain-map.json')

const PKG_PREFIXES = ['packages/renderer/', 'packages/ui/']
const FILE_SUFFIXES = ['.test.ts', '.test.tsx', '.spec.ts']
/** 挂载特征：@vue/test-utils 引用（直挂/flushPromises 等工具导入）或 mount( 调用。 */
const MOUNT_MARK = /@vue\/test-utils|\bmount\(/

const failures = []

// ── 1. 结构 ────────────────────────────────────────────────────────────────
if (!existsSync(MAP_PATH)) {
  console.error(`[domain-map] 权威源不存在：docs/testing/domain-map.json（相对仓库根 ${ROOT}）`)
  process.exit(1)
}
let domains
try {
  const raw = JSON.parse(readFileSync(MAP_PATH, 'utf-8'))
  domains = raw.domains
} catch (err) {
  console.error(`[domain-map] JSON 解析失败：${err.message}`)
  process.exit(1)
}
if (!domains || typeof domains !== 'object' || Object.keys(domains).length === 0) {
  failures.push('domains 对象缺失或为空——至少登记一个功能域')
}

const seenFileToDomain = new Map()
let fileCount = 0
for (const [domain, entry] of Object.entries(domains ?? {})) {
  if (!entry || typeof entry !== 'object') {
    failures.push(`域 "${domain}"：条目必须是对象`)
    continue
  }
  if (typeof entry.summary !== 'string' || entry.summary.length === 0) {
    failures.push(`域 "${domain}"：缺 summary（一句话说明域覆盖的功能面）`)
  }
  if (!Array.isArray(entry.files) || entry.files.length === 0) {
    failures.push(`域 "${domain}"：files 缺失或为空`)
    continue
  }
  for (const file of entry.files) {
    fileCount++
    // ── 2. 路径格式 ──
    const prefix = PKG_PREFIXES.find((p) => file.startsWith(p))
    if (!prefix) {
      failures.push(`域 "${domain}"：文件 "${file}" 不在已知包前缀（${PKG_PREFIXES.join(' | ')}）下`)
      continue
    }
    if (!FILE_SUFFIXES.some((s) => file.endsWith(s))) {
      failures.push(`域 "${domain}"：文件 "${file}" 后缀不是测试文件（${FILE_SUFFIXES.join(' / ')}）`)
    }
    // ── 3. 存在性 ──
    const abs = path.join(ROOT, file)
    if (!existsSync(abs)) {
      failures.push(
        `域 "${domain}"：文件 "${file}" 不在盘上——文件被改名/移动/删除后未同步登记。` +
          `[FIX] 同步更新 docs/testing/domain-map.json 的 files 条目（域触发将找不到该文件）`,
      )
    } else if (!MOUNT_MARK.test(readFileSync(abs, 'utf-8'))) {
      // ── 5. 挂载特征（文件存在才读）──
      failures.push(
        `域 "${domain}"：文件 "${file}" 无挂载特征（无 @vue/test-utils 引用、无 mount( 调用）——` +
          `域清单只收挂载渲染重型文件，逻辑层文件留守默认档。` +
          `[FIX] 从 domain-map.json 的 files 移除该条目`,
      )
    }
    // ── 4. 双收录 ──
    const prev = seenFileToDomain.get(file)
    if (prev !== undefined) {
      failures.push(`文件 "${file}" 双收录：同时属于域 "${prev}" 与 "${domain}"（每文件必须唯一归属）`)
    } else {
      seenFileToDomain.set(file, domain)
    }
  }
}

// ── 6. 消费一致性 ──────────────────────────────────────────────────────────
const CONSUMERS = [
  { file: 'packages/renderer/vitest.config.ts', mark: 'domain-exclusions' },
  { file: 'packages/ui/vitest.config.ts', mark: 'domain-exclusions' },
  { file: 'scripts/run-domain-tests.mjs', mark: 'domain-map.json' },
]
for (const { file, mark } of CONSUMERS) {
  const abs = path.join(ROOT, file)
  if (!existsSync(abs)) {
    failures.push(`消费方缺失：${file} 不在盘上`)
  } else if (!readFileSync(abs, 'utf-8').includes(mark)) {
    failures.push(
      `消费方 ${file} 未引用 "${mark}"——默认档排除/域触发绕开了 domain-map.json 权威源。` +
        `[FIX] 经 test-guard/domain-exclusions.ts 的 loadDomainExclusions 派生排除清单，禁止手抄文件清单`,
    )
  }
}

if (failures.length > 0) {
  console.error(`[domain-map] 检查拦截：${failures.length} 项违规\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  console.error('')
  console.error('[FIX] 权威源 = docs/testing/domain-map.json；口径说明见该文件 meta.criterion；')
  console.error('      域触发 = node scripts/run-domain-tests.mjs <domain> [--list]')
  process.exit(1)
}

const perDomain = Object.entries(domains)
  .map(([name, entry]) => `${name}:${entry.files.length}`)
  .join(' ')
console.log(`[domain-map] OK：${Object.keys(domains).length} 域 / ${fileCount} 文件（${perDomain}）——结构、存在性、唯一归属、挂载特征、消费方接线全部通过`)

// ── 7. staged 新增挂载文件的登记提示（warn 级，不红灯）────────────────────
// 静态挂载特征区分不了「重型（须登记进域表）」与「轻量（合法留默认档，存量数百个）」，
// 故只提示不拦；重型实测阈值以 meta.criterion 为准，>2s 慢用例红灯只是最终兜底。
let stagedAdded = []
try {
  stagedAdded = execSync('git diff --cached --name-only --diff-filter=A', { cwd: ROOT, encoding: 'utf-8' })
    .split('\n')
    .filter(Boolean)
} catch {
  stagedAdded = [] // 非 git 上下文（如直接手跑）跳过提示
}
const registeredSet = new Set(
  Object.values(domains ?? {}).flatMap((entry) => (Array.isArray(entry?.files) ? entry.files : [])),
)
const freshMounted = stagedAdded.filter(
  (f) =>
    PKG_PREFIXES.some((p) => f.startsWith(p)) &&
    FILE_SUFFIXES.some((s) => f.endsWith(s)) &&
    !registeredSet.has(f) &&
    existsSync(path.join(ROOT, f)) &&
    MOUNT_MARK.test(readFileSync(path.join(ROOT, f), 'utf-8')),
)
if (freshMounted.length > 0) {
  console.warn('')
  console.warn(`⚠ [domain-map] 本次新增 ${freshMounted.length} 个带挂载特征的测试文件未登记域表（不拦提交，按判据自查）：`)
  for (const f of freshMounted) console.warn(`    ${f}`)
  console.warn('  · 满足 meta.criterion 重型阈值（单用例 ≥300ms 或文件级 tests 段 ≥1s）→ 同 commit 登记进 docs/testing/domain-map.json 对应域，走域触发档；')
  console.warn('  · 默认组单用例 >2s 会再被 CI check-slow-tests 红灯拦截；轻量挂载文件留默认档即可。')
}
