#!/usr/bin/env node
/**
 * check-slow-tests.mjs —— CI 慢用例门禁（结果性防线，判据权威 = docs/TEST-STRATEGY.md
 * 「新写测试判据」节）。
 *
 * 解析各包 `test-results/vitest-junit.xml`（vitest config 每次运行自动落盘的用例级
 * 耗时，见 AGENTS.md「用例级耗时报告」），默认组任一用例超阈值即红。e2e-map
 * `E2E-INTEG-*` 规则登记的门控资产文件豁免——它们的耗时属集成组语义（真进程 / 真 IO
 * 用例在 CI 经 TAIJI_TEST_INTEGRATION=1 真跑，本就不受单测层 ≤1s 判据约束）。
 *
 * 用法：node scripts/check-slow-tests.mjs [--max-ms 2000] [--if-fresh]
 *   - CI：各 test job 的 Test 步骤后运行（cwd = 仓库根，扫全部已落盘 junit——每个
 *     job 的工作区只有自己包的 junit，天然按 job 范围判定）
 *   - 本地对账：任意时点跑当前已落盘套件（junit 每次运行覆盖式重写）
 *   - pre-commit（--if-fresh）：只查「本次 staged 测试文件所属包」且 junit 新鲜
 *     （mtime ≥ staged 文件 mtime，即改完真跑过）的包；junit 缺失或陈旧的包黄字
 *     跳过不拦（防陈旧数据误拦与「未跑测试不许提交」的过度强制）；无测试文件
 *     staged 时静默通过
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { relative, join, resolve, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const maxIdx = args.indexOf('--max-ms')
const MAX_MS = maxIdx >= 0 ? Number(args[maxIdx + 1]) : 2000
if (!Number.isFinite(MAX_MS) || MAX_MS <= 0) {
  console.error('[check-slow-tests] --max-ms 需为正数')
  process.exit(2)
}
const IF_FRESH = args.includes('--if-fresh')

/** 递归收集 <root>/…​/test-results/vitest-junit.xml（剪枝 node_modules/.git/dist） */
function findJunitFiles(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'test-results') {
        const junit = join(full, 'vitest-junit.xml')
        if (existsSync(junit)) out.push(junit)
        continue
      }
      findJunitFiles(full, out)
    }
  }
  return out
}

/** 门控资产文件集合（仓库相对路径）——e2e-map E2E-INTEG-* 规则的全部 assets */
function gatedAssetSet() {
  const mapPath = join(ROOT, 'docs/testing/e2e-map.json')
  if (!existsSync(mapPath)) return new Set()
  const map = JSON.parse(readFileSync(mapPath, 'utf8'))
  const set = new Set()
  for (const rule of map.rules ?? []) {
    if (!String(rule.id ?? '').startsWith('E2E-INTEG-')) continue
    for (const asset of rule.assets ?? []) {
      if (typeof asset.ref === 'string') set.add(asset.ref)
    }
  }
  return set
}

/** --if-fresh：按 staged 测试文件过滤出「该查」的 junit（新鲜 = 改完真跑过）。
 *  返回 null 表示静默通过（无测试文件 staged / 非 git 上下文）。 */
function freshJunitFilter(junitFiles) {
  let staged = []
  try {
    staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { cwd: ROOT, encoding: 'utf-8' })
      .split('\n')
      .filter((f) => /\.test\.tsx?$/.test(f))
  } catch {
    return { pass: true, files: [] }
  }
  if (staged.length === 0) return { pass: true, files: [] }
  const pkgCutoff = new Map() // 包前缀（packages/<pkg> 等）→ staged 文件最新 mtime
  for (const f of staged) {
    const m = f.match(/^(?:packages|apps|extensions)\/[^/]+/)
    if (!m || !existsSync(join(ROOT, f))) continue
    const t = statSync(join(ROOT, f)).mtimeMs
    pkgCutoff.set(m[0], Math.max(pkgCutoff.get(m[0]) ?? 0, t))
  }
  if (pkgCutoff.size === 0) return { pass: true, files: [] }
  const files = []
  const stale = []
  const junitPkgs = new Set()
  for (const junit of junitFiles) {
    const pkgRel = relative(ROOT, dirname(dirname(junit)))
    const cutoff = pkgCutoff.get(pkgRel)
    if (cutoff === undefined) continue // 该包本次无测试改动，不查
    junitPkgs.add(pkgRel)
    if (statSync(junit).mtimeMs >= cutoff) files.push(junit)
    else stale.push(pkgRel)
  }
  for (const [pkgRel, cutoff] of pkgCutoff) {
    if (!junitPkgs.has(pkgRel)) stale.push(pkgRel) // 有 staged 改动但 junit 缺失
  }
  return { pass: false, files, stale }
}

function main() {
  let junitFiles = findJunitFiles(ROOT, [])
  if (IF_FRESH) {
    const filter = freshJunitFilter(junitFiles)
    if (filter.pass) return // 无测试文件 staged：静默通过
    if (filter.stale.length > 0) {
      console.warn(`⚠ [check-slow-tests] junit 缺失或早于 staged 测试文件，跳过这些包的本地慢用例检查（建议提交前重跑对应包测试）：${filter.stale.join('、')}`)
    }
    if (filter.files.length === 0) return // 相关包全部陈旧：提示已给，不拦
    junitFiles = filter.files
  }
  if (junitFiles.length === 0) {
    console.error('[check-slow-tests] 未找到任何 test-results/vitest-junit.xml——先跑测试（junit 由 vitest config 自动落盘）再执行本门禁。')
    process.exit(2)
  }
  const exempt = gatedAssetSet()
  const offenders = []
  let cases = 0
  let exemptedCases = 0
  for (const junit of junitFiles) {
    const pkgDir = dirname(dirname(junit)) // …/<pkg>/test-results → <pkg>
    const pkgRel = relative(ROOT, pkgDir)
    const xml = readFileSync(junit, 'utf8')
    for (const m of xml.matchAll(/<testcase\s+classname="([^"]*)"\s+name="([^"]*)"\s+time="([0-9.]+)"/g)) {
      const [, classname, name, time] = m
      const secs = Number(time)
      if (!Number.isFinite(secs) || secs * 1000 <= MAX_MS) continue
      cases += 1
      const cls = classname.replace(/\\/g, '/').replace(/^\.\//, '')
      const repoRel = cls.startsWith(`${pkgRel}/`) ? cls : `${pkgRel}/${cls}`
      if (exempt.has(repoRel)) {
        exemptedCases += 1
        continue
      }
      offenders.push(`  ${repoRel}  「${name}」  ${secs.toFixed(2)}s`)
    }
  }
  if (offenders.length > 0) {
    console.error(`[check-slow-tests] 默认组存在超 ${MAX_MS}ms 的用例（判据 = docs/TEST-STRATEGY.md「新写测试判据」）：`)
    console.error(offenders.join('\n'))
    console.error('  [恢复动作] 按判据处置：确定性同步化 / 缩数据量 / 挂 TAIJI_TEST_INTEGRATION 门控（并在 e2e-map 登记 E2E-INTEG 规则）；')
    console.error('            真进程或性能水位语义确需保留时挂门控，不留在默认组。')
    process.exit(1)
  }
  const exemptFiles = exempt.size
  console.log(`[check-slow-tests] OK（${junitFiles.length} 份 junit，超阈值 ${cases} 条中 ${exemptedCases} 条为门控资产豁免、默认组零慢用例；豁免清单 = e2e-map E2E-INTEG-* ${exemptFiles} 个文件）`)
}

main()
