#!/usr/bin/env node
/**
 * check-structure-wiring.mjs —— 非 workspace 结构接线对账守卫（S1，PR #20 组 D 守卫化）。
 *
 * 背景：PR #20 的组 D 全部 5 条问题同一形态——新顶层结构（新包/新目录）落线时，
 * 机器管线接线（CI typecheck / coverage 测量面 / 发布线 / 测试装配）漏接，等 PR 期
 * 8 维 review 才发现（ed6735b47 一个 commit 三坑）。本脚本把「新结构必须先登记再
 * 开发」变成机器拦截：管辖区内含 package.json、但不在 pnpm-workspace.yaml globs
 * 内的包，必须在 docs/structure-wiring.json 有接线登记条目，且登记的锚点在目标
 * 文件中真实存在。双向对账：磁盘有而登记无 = 红（新结构未登记）；登记有而磁盘无
 * = 红（删包后残留）。
 *
 * 检查项：
 * 1. 包根枚举：git ls-files 的 package.json 路径 → 最近含 package.json 的祖先目录
 *    （与 coverage-gate.py pkg_dir_of 同思路），须落在管辖区前缀内
 * 2. workspace 覆盖判定：pnpm-workspace.yaml 的 packages globs（单层 * 通配）匹配
 *    即为 workspace 标准成员，免登记
 * 3. 非 workspace 包 ↔ structure-wiring.json 双向对账
 * 4. 锚点真实性：typecheckAnchor 文本在 .github/workflows/ci.yml；testScript 键在
 *    根 package.json scripts；publish=true 时包名在 release-npm.yml 与
 *    release-npm-dev.yml 两份发布线；coverage=true 时包根前缀在
 *    .agents/skills/pr-cr-fix/scripts/coverage-gate.py 的 PKG_PREFIXES 内
 *
 * 零第三方依赖（node:fs/node:path + git ls-files）。退出码：0 = 通过；1 = 违规。
 * 挂载：pre-commit（.githooks/install-hooks.sh）+ CI invariants job。
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

/** 管辖区前缀（与 coverage-gate.py PKG_PREFIXES 同源——coverage=true 的锚点校验在彼处生效，这里只做辖区判定） */
const PKG_PREFIXES = ['packages/', 'extensions/', 'resources/plugins/']
const WIRING_FILE = join(ROOT, 'docs', 'structure-wiring.json')
const WS_FILE = join(ROOT, 'pnpm-workspace.yaml')
const CI_FILE = join(ROOT, '.github', 'workflows', 'ci.yml')
const RELEASE_FILES = [
  join(ROOT, '.github', 'workflows', 'release-npm.yml'),
  join(ROOT, '.github', 'workflows', 'release-npm-dev.yml'),
]
const PKG_JSON = join(ROOT, 'package.json')
const COVERAGE_GATE = join(ROOT, '.agents', 'skills', 'pr-cr-fix', 'scripts', 'coverage-gate.py')

let failed = 0
const fail = (msg) => {
  console.error(`  ✗ ${msg}`)
  failed = 1
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

/** pnpm-workspace.yaml 的 packages globs（只解析 packages: 块下的 '- <glob>' 行，形态固定） */
function workspaceGlobs() {
  const lines = readFileSync(WS_FILE, 'utf-8').split('\n')
  const globs = []
  let inPackages = false
  for (const raw of lines) {
    const line = raw.trim()
    if (line === 'packages:') { inPackages = true; continue }
    if (inPackages) {
      const m = line.match(/^-\s*'([^']+)'/) || line.match(/^-\s*"([^"]+)"/) || line.match(/^-\s*(\S+)/)
      if (m) globs.push(m[1])
      else if (line && !line.startsWith('#')) inPackages = false
    }
  }
  return globs
}

/** 单层 * glob → regex（'packages/*' 匹配 packages/<one-level>；无 ** 支持，pnpm workspace 本仓只用到单层） */
function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')
  return new RegExp(`^${escaped}$`)
}

/** git ls-files 的 package.json → 包根目录（相对路径，POSIX 分隔） */
function packageRoots() {
  const out = execFileSync('git', ['ls-files', '*package.json'], { cwd: ROOT, encoding: 'utf-8' })
  const roots = new Set()
  for (const file of out.split('\n')) {
    if (!file.endsWith('package.json') || file.includes(`node_modules${sep}`) || file.includes('node_modules/')) continue
    const rel = dirname(file)
    // 只收管辖区内的包根
    if (!PKG_PREFIXES.some((p) => rel.startsWith(p))) continue
    roots.add(rel)
  }
  return [...roots]
}

/** git ls-files 在极简环境（无 git）下不可用时的说明——本守卫只在仓库内运行 */
if (!existsSync(join(ROOT, '.git')) && !existsSync(join(ROOT, '.bare'))) {
  console.error('check-structure-wiring: 不在仓库内运行（无 .git/.bare）')
  process.exit(1)
}

const globs = workspaceGlobs()
const globRegexes = globs.map(globToRegex)
ok(`workspace globs：${globs.join(' ')}`)

const roots = packageRoots()
const nonWorkspace = roots.filter((rel) => !globRegexes.some((re) => re.test(rel)))

const wiring = JSON.parse(readFileSync(WIRING_FILE, 'utf-8'))
const registered = wiring.nonWorkspacePackages ?? {}
const regKeys = Object.keys(registered)
const exempt = wiring.exempt ?? {}

const requireRegistration = nonWorkspace.filter((rel) => !(rel in exempt))
console.log(`辖区包根 ${roots.length} 个，其中非 workspace ${nonWorkspace.length} 个（显式豁免 ${nonWorkspace.length - requireRegistration.length}），登记 ${regKeys.length} 条`)

// ── 1. 正向：磁盘非 workspace 包 → 必须已登记（豁免清单除外） ─────────
for (const rel of requireRegistration) {
  if (!registered[rel]) {
    fail(
      `${rel} 是管辖区内含 package.json 的非 workspace 包，但 docs/structure-wiring.json 无登记条目。` +
        `恢复：在 nonWorkspacePackages 补 ${rel} 条目（typecheckAnchor/testScript/publish/coverage 按实际接线声明）` +
        `并跑 node scripts/check-structure-wiring.mjs 自检——新顶层结构第一笔 commit 只做接线与登记（S1）`,
    )
  }
}

// ── 2. 反向：登记/豁免条目 → 磁盘必须存在 ──────────────────────────
for (const key of [...regKeys, ...Object.keys(exempt)]) {
  if (!roots.includes(key)) {
    const kind = key in exempt ? '豁免' : '登记'
    fail(`${key} 已${kind}但磁盘上不存在（包被删/改名后残留）——从 docs/structure-wiring.json 移除该条目`)
  }
}

// ── 3. 锚点真实性 ──────────────────────────────────────────────────
const ciText = readFileSync(CI_FILE, 'utf-8')
const rootScripts = JSON.parse(readFileSync(PKG_JSON, 'utf-8')).scripts ?? {}
const coverageGateText = readFileSync(COVERAGE_GATE, 'utf-8')

for (const [rel, entry] of Object.entries(registered)) {
  if (roots.includes(rel)) {
    ok(`${rel} 登记 ↔ 磁盘一致`)
  }
  const anchor = entry.typecheckAnchor
  if (typeof anchor === 'string' && anchor.length > 0 && !ciText.includes(anchor)) {
    fail(`${rel} 的 typecheckAnchor "${anchor}" 在 .github/workflows/ci.yml 中不存在（step 改名/删除后锚点漂移）`)
  }
  const ts = entry.testScript
  if (typeof ts === 'string' && ts.length > 0 && !(ts in rootScripts)) {
    fail(`${rel} 的 testScript "${ts}" 不在根 package.json scripts 中`)
  }
  if (entry.publish === true) {
    for (const rf of RELEASE_FILES) {
      const text = readFileSync(rf, 'utf-8')
      if (!text.includes(rel)) {
        fail(`${rel} publish=true 但 ${basename(rf)} 中无该包路径——发布线成员漂移（正式线与 dev 线两份都要接）`)
      }
    }
  }
  if (entry.coverage === true) {
    const prefixHit = PKG_PREFIXES.filter((p) => rel.startsWith(p)).some((p) => coverageGateText.includes(`"${p}"`))
    if (!prefixHit) {
      fail(`${rel} coverage=true 但 coverage-gate.py PKG_PREFIXES 不含其前缀——该包不在增量覆盖率测量面`)
    }
  }
}

function basename(p) {
  return p.split('/').pop()
}

if (failed) {
  console.error('check-structure-wiring: FAIL（见上方 ✗ 条目）')
  process.exit(1)
}
console.log('check-structure-wiring: OK（非 workspace 结构接线全部对账一致）')
