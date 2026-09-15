#!/usr/bin/env node
/**
 * check-extension-files.mjs —— extension npm 发布 files 白名单守卫。
 *
 * 背景：pi-subagent-workflow@8.8.1 事故——重构新增 src/session-lifecycle.ts 被
 * src/index.ts 引用，但该包 files 白名单是逐文件枚举（全仓唯一），新文件未同步
 * 白名单导致 npm tarball 缺文件，用户侧 `pi update` 后 extension 加载即崩。
 * 宽口径白名单（src/ 整目录或 src 递归 glob）的包不受影响，逐文件枚举的包每次新增顶层
 * 文件都必须手动同步——本脚本让漏同步在 commit/CI 阶段红，而不是在用户端崩。
 *
 * 检查项（对 extensions/ 下每个声明了 files 白名单的包）：
 * 1. import 闭包 ⊆ files 白名单：从发布入口（main + pi.extensions）出发解析静态
 *    相对 import（import/export from、动态 import），每个可达文件必须命中白名单
 *    （npm 打包语义：白名单外的文件不进 tarball，运行时即缺文件）
 * 2. pi.skills / pi.agents / pi.workflows 指向的每个文件 ⊆ 白名单（pi 运行时资源）
 * 3. 白名单条目真实存在：精确/目录条目查磁盘，glob 条目须至少命中一个文件（防幽灵条目）
 *
 * npm files 语义实现范围（本项目实际用到的子集，零第三方依赖）：
 * - 目录条目 `src/host/`：递归包含
 * - 精确文件条目 `src/index.ts`
 * - glob 条目（如 src 递归 .ts）：minimatch 语义，globstar 可匹配零层目录
 * - 无 files 字段的包跳过（npm 默认全打包，不存在漏文件问题）
 *
 * 挂载：pre-commit（install-hooks.sh，extensions/** staged 时触发）+
 *       preflight-check.sh [10/10]（CI: build.yml）。退出码：0 = 通过；1 = 违规。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const EXT_DIR = join(ROOT, 'extensions')

let failed = 0
const fail = (pkgName, msg) => {
  console.error(`  ✗ ${pkgName}: ${msg}`)
  failed = 1
}

// ── npm files 白名单匹配 ────────────────────────────────────────────
function inWhitelist(relPath, files) {
  for (const f of files) {
    if (f.endsWith('/')) {
      // 目录条目：递归包含
      if (relPath === f.slice(0, -1) || relPath.startsWith(f)) return true
    } else if (f.includes('*')) {
      // glob 条目：minimatch 语义，**/ 可匹配零层目录，* 不跨目录段
      const pattern = f
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
      if (new RegExp(`^${pattern}$`).test(relPath)) return true
    } else if (relPath === f) {
      return true
    }
  }
  return false
}

// ── 静态相对 import 提取（import/export ... from + 动态 import）──────
function extractRelativeImports(src) {
  const specs = new Set()
  const patterns = [
    /(?:^|[\s;}])import\s[^"'`]*?from\s*["']([^"']+)["']/g,
    /(?:^|[\s;}])export\s[^"'`]*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(src))) specs.add(m[1])
  }
  return [...specs].filter((s) => s.startsWith('.'))
}

// 包以 .ts 源码直发，pi 加载器按 TS 规则解析：./x.js 显式后缀映射到同路径 .ts
function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const jsToTs = spec.endsWith('.js') ? [base.replace(/\.js$/, '.ts')] : []
  const candidates = [base, ...jsToTs, `${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile())
}

function listDirFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out
}

// ── 逐包校验 ────────────────────────────────────────────────────────
const pkgDirs = []
for (const group of readdirSync(EXT_DIR, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  const groupDir = join(EXT_DIR, group.name)
  for (const dir of readdirSync(groupDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const pkgFile = join(groupDir, dir.name, 'package.json')
    if (existsSync(pkgFile)) pkgDirs.push(pkgFile)
  }
}

let checked = 0
for (const pkgFile of pkgDirs) {
  const pkgDir = dirname(pkgFile)
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) continue
  checked++

  // 白名单条目是 package.json 里的 POSIX 形态（src/、src/*.ts），inWhitelist 全按 "/" 匹配；
  // path.relative 在 Windows 返回 "\" 分隔路径，统一规范化，否则 win 上 26 包全量误报
  const rel = (abs) => relative(pkgDir, abs).split(sep).join('/')
  const missing = new Set()

  // 1. import 闭包：从 main + pi.extensions 出发 BFS
  const entries = [...(pkg.main ? [pkg.main] : []), ...(pkg.pi?.extensions ?? [])]
  if (entries.length === 0) entries.push('index.ts')
  const queue = entries
    .map((e) => resolve(pkgDir, e))
    .filter((p) => existsSync(p) && statSync(p).isFile())
  const seen = new Set(queue)
  while (queue.length > 0) {
    const file = queue.shift()
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue
    const relFile = rel(file)
    if (!inWhitelist(relFile, pkg.files)) missing.add(relFile)
    for (const spec of extractRelativeImports(readFileSync(file, 'utf-8'))) {
      const target = resolveSpecifier(file, spec)
      if (!target) missing.add(`${relFile} 引用了不存在的相对模块 "${spec}"`)
      else if (!seen.has(target)) {
        seen.add(target)
        queue.push(target)
      }
    }
  }

  // 2. pi 运行时资源（skills/agents/workflows）逐文件校验
  const resourceFields = [
    ['pi.skills', pkg.pi?.skills],
    ['pi.agents', pkg.pi?.agents],
    ['pi.workflows', pkg.pi?.workflows],
  ]
  for (const [field, vals] of resourceFields) {
    for (const v of [vals].flat().filter(Boolean)) {
      const abs = resolve(pkgDir, v)
      if (!existsSync(abs)) {
        missing.add(`pi 资源 ${field} → "${v}" 在磁盘上不存在`)
        continue
      }
      const targets = statSync(abs).isDirectory() ? listDirFiles(abs) : [abs]
      for (const t of targets) {
        if (!inWhitelist(rel(t), pkg.files)) missing.add(`pi 资源 ${field} → ${rel(t)} 不在 files 白名单`)
      }
    }
  }

  // 3. 白名单条目真实性：精确/目录条目查磁盘，glob 条目须至少命中一个文件
  for (const f of pkg.files) {
    if (f.includes('*')) continue // glob 条目在下方按命中数统一核查
    if (!existsSync(resolve(pkgDir, f))) missing.add(`files 白名单条目 "${f}" 在磁盘上不存在`)
  }
  const globHits = new Map(pkg.files.filter((f) => f.includes('*')).map((f) => [f, 0]))
  if (globHits.size > 0) {
    for (const file of listDirFiles(pkgDir)) {
      const relFile = rel(file)
      for (const g of globHits.keys()) {
        if (inWhitelist(relFile, [g])) globHits.set(g, globHits.get(g) + 1)
      }
    }
    for (const [g, hits] of globHits) {
      if (hits === 0) missing.add(`files 白名单 glob 条目 "${g}" 未命中任何文件`)
    }
  }

  for (const m of missing) fail(pkg.name, m)
}

if (failed === 0) {
  console.log(`✓ extension files 白名单一致（${checked} 包 × import 闭包/pi 资源/条目真实性校验通过）`)
  process.exit(0)
}
console.error('extension files 白名单与发布闭包不一致，修复后重跑（见上方 ✗ 明细）')
process.exit(1)
