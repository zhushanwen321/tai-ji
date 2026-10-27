#!/usr/bin/env node
/**
 * check-zero-mock-pool.mjs — 零特征共享池（isolate:false 双池）的清单派生与健康度检查。
 *
 * 机制背景（.tmp/round6/process-reuse-reeval.md 实证）：subagent-core / core /
 * zcode-subagent-cli 三包的默认档测试按「零特征文件 → 共享池（isolate:false，模块图与
 * worker 进程跨文件复用）；其余文件 → 隔离池（isolate:true，每文件新进程）」分池执行。
 * 共享池的准入判据是文件不含 mock / 共享可变状态硬特征——本脚本是该判据的唯一派生实现
 * （登记表只存结果，判据逻辑只在此处）。
 *
 * 三层判据（与 reeval 同源）：
 *   1. 静态特征扫描（七特征正则，vi.mock / vi.doMock / vi.resetModules /
 *      vi.useFakeTimers / vi.stubGlobal / process.env 直写 / globalThis 直写）——
 *      命中任一即污染源，禁止进池（漏判实例：core settings-store 被「正常 API 调用改写
 *      模块级单例」污染，静态扫描抓不到，故有第 3 层）；
 *   2. 门控排除——集成门控（import integration-gate）与真机 live 门控
 *      （ENGINE_CONFORMANCE_LIVE）文件一律不进池：其真实执行只发生在门控档，
 *      共享态语义从未验证，门控开启时也保持与分池前完全一致的隔离执行；
 *   3. 动态出场登记（registry 的 dynamicExclusions 表）——静态零特征但共享池实跑红过的
 *      文件出局进隔离池，附原因；池成员变更后必须重跑两轮全量动态验证（全绿 + junit
 *      用例名守恒）才能提交。
 *
 * 检查项（默认模式，红灯 = exit 1）：
 *   G1 结构：登记表 packages 覆盖三包、条目为字符串数组；
 *   G2 存在性：登记文件必须在盘上（改名/删除未同步登记 → 红）；
 *   G3 特征复扫：登记进池的文件命中任一静态特征 → 红（防静默污染：给池内文件新增
 *      vi.mock 等特征会让它在共享 worker 里污染同池邻居）；
 *   G4 门控复扫：登记进池的文件出现门控标记 → 红（门控文件禁共享，见判据 2）；
 *   G5 动态出场表：条目必须在盘上、仍属静态零特征且未被门控排除（否则登记过期 → 红）；
 *   G6 消费一致性：三包 vitest.config.ts 必须引用 zero-mock-pool 加载器（池清单来自
 *      权威源派生，禁止手抄文件清单进 config）；
 *   G7 漂移方向（warn 不红）：盘上新增零特征文件未登记 → 提示跑 --update + 动态验证。
 *      有意不红：漏登记的文件落回隔离池，只是慢一点，失败模式安全方向正确（reeval §3.1）。
 *
 * 用法：
 *   node scripts/check-zero-mock-pool.mjs            # 检查（pre-commit / CI）
 *   node scripts/check-zero-mock-pool.mjs --update   # 按派生结果重写登记表
 *                                                    #（保留 dynamicExclusions；提交前
 *                                                    #  必须跑两轮全量动态验证）
 *   node scripts/check-zero-mock-pool.mjs --list     # 打印各包派生账目（只读）
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const REGISTRY_PATH = path.join(ROOT, 'docs', 'testing', 'zero-mock-pool.json')

/** 池化包清单：name = 仓库包目录名（登记表键）；scanDirs = 该包默认档收集的测试目录。 */
const POOL_PKGS = [
  { name: 'subagent-core', scanDirs: ['src'] },
  { name: 'core', scanDirs: ['src'] },
  { name: 'zcode-subagent-cli', scanDirs: ['src', 'test'] },
]

/** 静态污染特征（正则 + 排除理由）。判据与 reeval 七特征一致；vi.spyOn 有意不在列：
 *  spy 回调/局部对象是单测常态（不制造跨文件模块污染），按它排除会把池砍到不可用。 */
const FEATURES = [
  { mark: 'vi.mock', rx: /\bvi\.mock\(/, why: '模块 mock 工厂跨文件残留注册' },
  { mark: 'vi.doMock', rx: /\bvi\.doMock\(/, why: '惰性模块 mock 同上' },
  { mark: 'vi.resetModules', rx: /\bvi\.resetModules\(/, why: '清共享模块缓存，摧毁同池摊销前提' },
  { mark: 'vi.useFakeTimers', rx: /\bvi\.useFakeTimers\(/, why: '假时钟未复位时后续文件挂钟逻辑挂死' },
  { mark: 'vi.stubGlobal', rx: /\bvi\.stubGlobal\(/, why: '全局桩跨文件存活' },
  { mark: 'envWrite', rx: /process\.env\.[A-Za-z_]+\s*=[^=]/, why: 'env 直写跨文件存活' },
  { mark: 'globalWrite', rx: /globalThis\.[A-Za-z_]+\s*=[^=]/, why: 'globalThis 直写跨文件存活' },
]

/** 门控排除标记：门控文件的真实执行语义只在门控档验证过，禁止进共享池。 */
const GATES = [
  { mark: 'integration-gate', rx: /integration-gate/, why: '集成门控（TAIJI_TEST_INTEGRATION）文件' },
  { mark: 'live-gate', rx: /ENGINE_CONFORMANCE_LIVE/, why: '真机 live 门控文件' },
]

const EXCLUDED_DIR_NAMES = new Set(['node_modules', 'dist', 'test-results'])
const TEST_SUFFIX = '.test.ts'

const toPosix = (p) => p.split(path.sep).join('/')

/** 摘除字符串字面量外的注释（形态同 check-vitest-guard.mjs）：注释里提到 vi.mock 不算特征。 */
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
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    out += ch
  }
  return out
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 收集包内默认档测试文件（包内相对 posix 路径，已排序）。 */
function collectTestFiles(pkg) {
  const pkgRoot = path.join(ROOT, 'packages', pkg.name)
  const out = []
  for (const dir of pkg.scanDirs) {
    const base = path.join(pkgRoot, dir)
    if (!isDirectory(base)) continue
    const walk = (absDir) => {
      for (const name of readdirSync(absDir)) {
        const full = path.join(absDir, name)
        if (isDirectory(full)) {
          if (EXCLUDED_DIR_NAMES.has(name)) continue
          walk(full)
        } else if (name.endsWith(TEST_SUFFIX)) {
          out.push(toPosix(path.relative(pkgRoot, full)))
        }
      }
    }
    walk(base)
  }
  return out.sort()
}

/**
 * 派生单包共享池候选：静态零特征 ∧ 无门控标记。
 * 返回逐文件账目（pool / gatedOut / featured），动态出场文件由调用方另行剔除。
 */
function derivePkg(pkg) {
  const pkgRoot = path.join(ROOT, 'packages', pkg.name)
  const account = { pool: [], gatedOut: [], featured: [] }
  for (const rel of collectTestFiles(pkg)) {
    const raw = readFileSync(path.join(pkgRoot, rel), 'utf-8')
    const text = stripComments(raw)
    const feats = FEATURES.filter((f) => f.rx.test(text)).map((f) => f.mark)
    if (feats.length > 0) {
      account.featured.push({ file: rel, feats })
      continue
    }
    const gates = GATES.filter((g) => g.rx.test(text)).map((g) => g.mark)
    if (gates.length > 0) {
      account.gatedOut.push({ file: rel, gates })
      continue
    }
    account.pool.push(rel)
  }
  return account
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return null
  return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'))
}

// ── 派生与检查 ──────────────────────────────────────────────────────────────
const derived = new Map(POOL_PKGS.map((pkg) => [pkg.name, derivePkg(pkg)]))
const registry = loadRegistry()

if (registry === null) {
  console.error(
    `[zero-mock-pool] 登记表不存在：docs/testing/zero-mock-pool.json。` +
      `[FIX] 先跑 node scripts/check-zero-mock-pool.mjs --update 生成，再提交前完成两轮全量动态验证`,
  )
  process.exit(1)
}

const dynamicExclusions = Array.isArray(registry.dynamicExclusions) ? registry.dynamicExclusions : []
/** 动态出场集合（仓库相对路径 → 条目）。 */
const excludedMap = new Map(
  dynamicExclusions
    .filter((e) => e && typeof e.file === 'string')
    .map((e) => [e.file, e]),
)

if (process.argv.includes('--update')) {
  const next = {
    _meta: registry._meta,
    dynamicExclusions,
    packages: Object.fromEntries(
      POOL_PKGS.map((pkg) => {
        const excl = new Set(
          [...excludedMap.keys()].filter((f) => f.startsWith(`packages/${pkg.name}/`)),
        )
        return [pkg.name, derived.get(pkg.name).pool.filter((f) => !excl.has(`packages/${pkg.name}/${f}`))]
      }),
    ),
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(next, null, 2) + '\n')
  const counts = POOL_PKGS.map((pkg) => `${pkg.name}:${next.packages[pkg.name].length}`).join(' ')
  console.log(`[zero-mock-pool] 登记表已按派生结果重写（${counts}；dynamicExclusions ${dynamicExclusions.length} 条保留）`)
  console.log('[zero-mock-pool] 提交前必跑：三包各两轮全量（TAIJI_SKIP_REAL_PI=1 pnpm test）全绿 + junit 用例名守恒')
  process.exit(0)
}

const failures = []
const warnings = []

for (const pkg of POOL_PKGS) {
  const registered = registry.packages?.[pkg.name]
  // G1 结构
  if (!Array.isArray(registered) || registered.length === 0) {
    failures.push(`G1 ${pkg.name}：登记表 packages.${pkg.name} 缺失或为空`)
    continue
  }
  if (registered.some((f) => typeof f !== 'string')) {
    failures.push(`G1 ${pkg.name}：登记条目必须是字符串路径`)
    continue
  }
  const pkgRoot = path.join(ROOT, 'packages', pkg.name)
  const derivedSet = new Set(derived.get(pkg.name).pool)
  for (const rel of registered) {
    // G2 存在性
    if (!existsSync(path.join(pkgRoot, rel))) {
      failures.push(
        `G2 ${pkg.name}：登记文件 "${rel}" 不在盘上——改名/移动/删除后未同步登记。[FIX] 跑 --update 重写登记表（并重跑两轮全量动态验证）`,
      )
      continue
    }
    const text = stripComments(readFileSync(path.join(pkgRoot, rel), 'utf-8'))
    // G3 特征复扫（防静默污染：池内文件新增 mock 特征 = 红）
    const feats = FEATURES.filter((f) => f.rx.test(text)).map((f) => f.mark)
    if (feats.length > 0) {
      failures.push(
        `G3 ${pkg.name}：池内文件 "${rel}" 命中静态特征 [${feats.join(',')}]——共享 worker 里的污染源。` +
          `[FIX] 从池移除该文件（--update）并重跑两轮全量动态验证；若特征可去（mock 移到隔离池文件），先迁文件再更新`,
      )
    }
    // G4 门控复扫
    const gates = GATES.filter((g) => g.rx.test(text)).map((g) => g.mark)
    if (gates.length > 0) {
      failures.push(
        `G4 ${pkg.name}：池内文件 "${rel}" 出现门控标记 [${gates.join(',')}]——门控文件禁止共享（门控档执行语义未在共享态验证）。` +
          `[FIX] 跑 --update（门控文件自动出局）并重跑两轮全量动态验证`,
      )
    }
  }
  // G7 漂移方向（warn）：零特征 ∧ 非门控 ∧ 非动态出场，但未登记
  const excl = new Set(
    [...excludedMap.keys()].filter((f) => f.startsWith(`packages/${pkg.name}/`)).map((f) => f.slice(`packages/${pkg.name}/`.length)),
  )
  const missing = [...derivedSet].filter((f) => !registered.includes(f) && !excl.has(f))
  if (missing.length > 0) {
    warnings.push(`G7 ${pkg.name}：${missing.length} 个零特征文件未登记（落回隔离池，仅损失提速）：${missing.slice(0, 3).map((f) => `"${f}"`).join(' ')}${missing.length > 3 ? ' …' : ''}`)
  }
}

// G5 动态出场表：条目在盘上、仍属静态零特征、非门控（否则登记过期）
for (const entry of dynamicExclusions) {
  if (!entry || typeof entry.file !== 'string' || typeof entry.reason !== 'string' || entry.reason.length === 0) {
    failures.push('G5 dynamicExclusions：条目必须含非空 file 与 reason')
    continue
  }
  if (!existsSync(path.join(ROOT, entry.file))) {
    failures.push(`G5 动态出场条目 "${entry.file}" 不在盘上——文件已删除/改名。[FIX] 从 dynamicExclusions 移除该条目`)
    continue
  }
  const pkg = POOL_PKGS.find((p) => entry.file.startsWith(`packages/${p.name}/`))
  if (!pkg) {
    failures.push(`G5 动态出场条目 "${entry.file}" 不在池化三包内——登记错位。[FIX] 移除或改到正确包`)
    continue
  }
  const rel = entry.file.slice(`packages/${pkg.name}/`.length)
  const text = stripComments(readFileSync(path.join(ROOT, entry.file), 'utf-8'))
  const feats = FEATURES.filter((f) => f.rx.test(text)).map((f) => f.mark)
  const gates = GATES.filter((g) => g.rx.test(text)).map((g) => g.mark)
  if (feats.length > 0 || gates.length > 0) {
    failures.push(
      `G5 动态出场条目 "${entry.file}" 已命中静态特征 [${feats.join(',')}] 或门控 [${gates.join(',')}]——该文件本就被判据 1/2 排除，出场登记过期。` +
        `[FIX] 从 dynamicExclusions 移除该条目`,
    )
  }
  const registered = registry.packages?.[pkg.name] ?? []
  if (registered.includes(rel)) {
    failures.push(`G5 "${entry.file}" 同时在共享池与动态出场表——矛盾登记。[FIX] 跑 --update 重写登记表`)
  }
}

// G6 消费一致性：三包 config 必须经加载器消费权威源
for (const pkg of POOL_PKGS) {
  const configPath = path.join(ROOT, 'packages', pkg.name, 'vitest.config.ts')
  if (!existsSync(configPath)) {
    failures.push(`G6 packages/${pkg.name}/vitest.config.ts 不存在`)
  } else if (!readFileSync(configPath, 'utf-8').includes('zero-mock-pool')) {
    failures.push(
      `G6 packages/${pkg.name}/vitest.config.ts 未引用 zero-mock-pool 加载器——共享池清单绕开了登记表权威源。` +
        `[FIX] 经 test-guard/zero-mock-pool.ts 的 loadZeroMockPool 派生 include，禁止手抄文件清单`,
    )
  }
}

// ── 输出 ───────────────────────────────────────────────────────────────────
if (process.argv.includes('--list')) {
  for (const pkg of POOL_PKGS) {
    const a = derived.get(pkg.name)
    console.log(`== ${pkg.name}: 默认档 ${a.pool.length + a.gatedOut.length + a.featured.length} 文件 = 池 ${a.pool.length} + 特征 ${a.featured.length} + 门控出局 ${a.gatedOut.length}`)
    for (const g of a.gatedOut) console.log(`   门控出局: ${g.file} (${g.gates.join(',')})`)
  }
  process.exit(failures.length > 0 ? 1 : 0)
}

if (failures.length > 0) {
  console.error(`[zero-mock-pool] 检查拦截：${failures.length} 项违规\n`)
  for (const f of failures) console.error(`  ✗ ${f}`)
  console.error('')
  console.error('[FIX] 权威源 = docs/testing/zero-mock-pool.json；判据与维护契约见该文件 _meta；')
  console.error('      清单更新 = node scripts/check-zero-mock-pool.mjs --update（提交前必须两轮全量动态验证）')
  process.exit(1)
}

const summary = POOL_PKGS.map((pkg) => {
  const registered = registry.packages[pkg.name]
  const a = derived.get(pkg.name)
  return `${pkg.name} 池 ${registered.length}/${a.pool.length + a.gatedOut.length + a.featured.length}`
}).join(' | ')
for (const w of warnings) console.warn(`  ⚠ ${w}`)
console.log(
  `[zero-mock-pool] OK：${summary} | 动态出场 ${dynamicExclusions.length} 条——结构、存在性、特征复扫、门控复扫、消费方接线全部通过`,
)
