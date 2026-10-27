#!/usr/bin/env node
/**
 * run-domain-tests.mjs — 按功能域触发测试（Wave2 域触发入口，Wave4 升级为多域/双源/泛化包）。
 *
 * 域执行清单 = 双源并集（Wave4 §4.2）：
 *   1. docs/testing/domain-slices/<domain>.json 的 tests glob 展开（切片 SSOT；展开语义
 *      复用 scripts/check-domain-slices.mjs 导出的 expandTestGlobs，单一实现）
 *   2. 全部切片的 sharedBy 反查（本域 ∈ 某文件注记域数组 → 该文件并入本域执行清单）
 *   3. docs/testing/domain-map.json 同名域 files（W2-B 挂载子集，归属冻结；check-domain-slices
 *      保证切片填充后包含它，未填充时本源是唯一来源——W2-B 14 域在批 B/C/D 填充前行为不回归）
 *
 * 包前缀泛化：文件路径 → 向上找最近 vitest config 定位执行 cwd（覆盖 packages/apps/
 * extensions 任意包，apps/electron/main 的独立分池 config 同样正确锚定——见 vitestRootFor
 * 注释），vitest 在该 cwd 下接收包内相对路径。TAIJI_TEST_DOMAIN（config 据此取消默认档
 * 排除，多域时值为逗号连接——消费方只判真值）与 TAIJI_SKIP_REAL_PI（默认池跳过真进程层）
 * 注入逻辑与 Wave2 相同。
 *
 * 用法：
 *   node scripts/run-domain-tests.mjs <domain> [<domain>...]      跑指定域（多域取并集，跨包逐包执行，汇总退出码）
 *   node scripts/run-domain-tests.mjs <domain> [<domain>...] --list 只打印将执行的文件清单
 *   node scripts/run-domain-tests.mjs --domains                   列出全部域名与文件数（双源并集口径）
 *
 * 域清单权威源 = docs/testing/domain-slices/（切片）+ docs/testing/domain-map.json（挂载），
 * 表健康度由 scripts/check-domain-slices.mjs（切片/交叉）与 scripts/check-domain-map.mjs（挂载）机器校验。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expandTestGlobs, readRegistry } from './check-domain-slices.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(SCRIPT_DIR, '..')
const SLICES_DIR = path.join(ROOT, 'docs', 'testing', 'domain-slices')
const MAP_PATH = path.join(ROOT, 'docs', 'testing', 'domain-map.json')
/** 与 test-guard/domain-exclusions.ts 的 DOMAIN_GATE_ENV 同名（mjs 侧不能 import ts，字面量 + check 脚本对拍）。 */
const DOMAIN_GATE_ENV = 'TAIJI_TEST_DOMAIN'

// ---------- 纯函数（scripts/__tests__ 消费） ----------

/** 加载 W2-B 挂载表（domain-map.json，冻结 SSOT）。 */
export function loadMountMap() {
  const raw = JSON.parse(readFileSync(MAP_PATH, 'utf-8'))
  const domains = raw?.domains
  if (!domains || typeof domains !== 'object') {
    console.error(`[run-domain-tests] domain-map.json 缺少 domains 对象：${MAP_PATH}`)
    process.exit(1)
  }
  return domains
}

/**
 * 双源收集：names 各域的执行文件并集。
 * slices 来自 readRegistry()（切片），mountDomains 来自 domain-map.json，expand(root, globs)
 * 注入（= expandTestGlobs）便于单测脱离真实磁盘。
 * 返回 Map<domain, {sliceFiles, sharedByFiles, mountFiles, files(并集排序)}>。
 */
export function collectDomainFiles(slices, mountDomains, names, expand) {
  const byName = new Map(slices.map((s) => [s.name, s]))
  const out = new Map()
  for (const name of names) {
    const slice = byName.get(name)
    if (!slice && !mountDomains[name]) continue
    const sliceFiles = slice ? expand(slice.tests ?? []) : []
    const sharedByFiles = []
    for (const s of slices) {
      for (const [file, domains] of Object.entries(s.sharedBy ?? {})) {
        if ((domains ?? []).includes(name)) sharedByFiles.push(file)
      }
    }
    const mountFiles = mountDomains[name]?.files ?? []
    const files = [...new Set([...sliceFiles, ...sharedByFiles, ...mountFiles])].sort()
    out.set(name, { sliceFiles, sharedByFiles, mountFiles, files })
  }
  return out
}

/** vitest config 文件名（spawn cwd 的行为锚点——cwd 决定 vitest 读哪份 config）。 */
const VITEST_CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
]

/**
 * 文件路径 → 最近的 vitest config 所在目录（仓库根为上界）；找不到返回 null。
 * 锚 config 而非 package.json：apps/electron/main 无 package.json 但有独立分池
 * vitest.config.ts，按 package.json 定位会上浮到 apps/electron 的 config（include 只有
 * scripts/__tests__）→ main/ 下池文件被 include 滤光、No test files found（TEST-STRATEGY
 * 「运行命令（cwd 敏感）」节登记的 config 上浮坑）。其余包 config 与 package.json 同目录，
 * 定位结果不变。
 */
export function vitestRootFor(root, file) {
  let dir = path.dirname(path.join(root, file))
  const stop = path.resolve(root)
  while (true) {
    if (VITEST_CONFIG_NAMES.some((n) => existsSync(path.join(dir, n)))) return path.relative(root, dir) || '.'
    if (path.resolve(dir) === stop) return null
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** 按包分组：Map<包相对路径, 包内相对路径数组>；无法定位 vitest config 的文件记入 problems。 */
export function groupFilesByPackage(root, files) {
  const byPkg = new Map()
  const problems = []
  for (const file of files) {
    const pkg = vitestRootFor(root, file)
    if (!pkg) {
      problems.push(file)
      continue
    }
    if (!byPkg.has(pkg)) byPkg.set(pkg, [])
    byPkg.get(pkg).push(path.relative(pkg, file))
  }
  return { byPkg, problems }
}

/**
 * 逐包执行文件集（`node <root>/node_modules/vitest/vitest.mjs run <files>`，注入
 * TAIJI_TEST_DOMAIN 与 TAIJI_SKIP_REAL_PI，串行、失败不中断后续包）。供本脚本 main
 * 与日常档入口（scripts/run-daily-tests.mjs）共用，执行语义单源。
 * 经 node 直调根 vitest 入口而非 `pnpm exec`：apps/electron/main 无 package.json，
 * pnpm exec 在其下报 ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE；vitest 统一 hoist 到根
 * node_modules（全仓 ^4.1.x 单版本线），cwd 决定 config 解析，与 pnpm exec 等价。
 * 返回 { failed, total, files }：failed = 退出码非零的包数。
 */
export function runPackages(byPkg, domainLabel) {
  let failed = 0
  let fileCount = 0
  const vitestBin = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
  for (const [pkg, pkgFiles] of byPkg) {
    fileCount += pkgFiles.length
    console.log(`\n[run-domain-tests] 域 "${domainLabel}" · ${pkg} · ${pkgFiles.length} 文件`)
    const result = spawnSync(process.execPath, [vitestBin, 'run', ...pkgFiles], {
      cwd: path.join(ROOT, pkg),
      stdio: 'inherit',
      env: {
        ...process.env,
        // 域触发档：config 据此取消默认档排除，显式文件清单才能被收集（多域逗号连接，消费方只判真值）
        [DOMAIN_GATE_ENV]: domainLabel,
        // 与默认档同口径（AGENTS.md 测试章：跳过真进程层）
        TAIJI_SKIP_REAL_PI: '1',
      },
    })
    if (result.status !== 0) {
      failed++
      console.error(`[run-domain-tests] ${pkg} 退出码 ${result.status}`)
    }
  }
  return { failed, total: byPkg.size, files: fileCount }
}

/**
 * 漂移 fail-fast 展开器：死 glob / 失踪文件若静默跳过，域触发会漏跑且绿灯误导
 * （junit 守恒威胁）。供本脚本 main 与日常档入口（run-daily-tests.mjs）共用，单一实现。
 */
export function strictExpander(root) {
  return (globs) => {
    const { files, problems } = expandTestGlobs(root, globs)
    if (problems.length > 0) {
      console.error(`[run-domain-tests] 切片展开漂移（登记与磁盘不一致，拒绝半清单执行）：`)
      for (const p of problems) console.error(`  - ${p}`)
      console.error('  恢复动作：node scripts/check-domain-slices.mjs 定位违规并同步 docs/testing/domain-slices/<domain>.json')
      process.exit(1)
    }
    return files
  }
}

// ---------- main ----------

function availableDomains(slices, mountDomains) {
  const names = new Set([...slices.map((s) => s.name), ...Object.keys(mountDomains)])
  return [...names].sort()
}

function main() {
  const args = process.argv.slice(2)
  const { slices } = readRegistry(SLICES_DIR)
  const mountDomains = loadMountMap()
  const expand = strictExpander(ROOT)

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.error('用法: node scripts/run-domain-tests.mjs <domain> [<domain>...] [--list]')
    console.error('      node scripts/run-domain-tests.mjs --domains')
    console.error('')
    console.error('可用域（docs/testing/domain-slices/ 切片 ∪ docs/testing/domain-map.json 挂载）：')
    for (const name of availableDomains(slices, mountDomains)) {
      const slice = slices.find((s) => s.name === name)
      const src = slice && mountDomains[name] ? 'slice+mount' : slice ? 'slice' : 'mount'
      console.error(`  ${name.padEnd(20)} ${src.padEnd(11)} ${slice?.summary ?? mountDomains[name]?.summary ?? ''}`)
    }
    process.exit(args.length === 0 ? 1 : 0)
  }
  if (args.includes('--domains')) {
    for (const name of availableDomains(slices, mountDomains)) {
      console.log(`${name}\t${collectDomainFiles(slices, mountDomains, [name], expand).get(name)?.files.length ?? 0}`)
    }
    return
  }

  const listOnly = args.includes('--list')
  const names = args.filter((a) => !a.startsWith('--'))
  if (names.length === 0) {
    console.error('[run-domain-tests] 未指定域——用法见 node scripts/run-domain-tests.mjs --help')
    process.exit(1)
  }
  const known = new Set(availableDomains(slices, mountDomains))
  const unknown = names.filter((n) => !known.has(n))
  if (unknown.length > 0) {
    console.error(`[run-domain-tests] 未知域 "${unknown.join('", "')}"——可用域见 node scripts/run-domain-tests.mjs --domains`)
    process.exit(1)
  }

  const collected = collectDomainFiles(slices, mountDomains, names, expand)
  const files = [...new Set(names.flatMap((n) => collected.get(n)?.files ?? []))].sort()
  if (files.length === 0) {
    console.error(`[run-domain-tests] 域 "${names.join('", "')}" 双源文件清单均为空（登记异常，先跑 node scripts/check-domain-slices.mjs）`)
    process.exit(1)
  }

  const { byPkg, problems } = groupFilesByPackage(ROOT, files)
  if (problems.length > 0) {
    console.error(`[run-domain-tests] 以下文件无法定位所属包（向上找不到 vitest config）——登记异常：`)
    for (const f of problems) console.error(`  - ${f}`)
    process.exit(1)
  }

  if (listOnly) {
    for (const f of files) console.log(f)
    return
  }

  const domainLabel = names.join(',')
  const run = runPackages(byPkg, domainLabel)

  if (run.failed > 0) {
    console.error(`\n[run-domain-tests] 域 "${domainLabel}" 完成：${run.failed}/${run.total} 包失败`)
    process.exit(1)
  }
  console.log(`\n[run-domain-tests] 域 "${domainLabel}" 全绿（${run.total} 包，${run.files} 文件）`)
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.cwd(), process.argv[1])).href
// import 守卫：纯函数（collectDomainFiles / groupFilesByPackage / runPackages）供日常档入口
// scripts/run-daily-tests.mjs 复用，import 不得触发 CLI 行为
if (isMain) main()
