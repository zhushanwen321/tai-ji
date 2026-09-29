#!/usr/bin/env node
/**
 * changeset-check.mjs —— extension 发布改动 changeset 完整性检查（决策 7 唯一实装）。
 *
 * 判定逻辑从 scripts/pr-pre-merge.sh 的 check_changeset()（Step 5，WARN 级）原样抽出为
 * 唯一实现：pr-pre-merge.sh 改调本脚本（--json），Gate-1a.5 与 dev-merge gates 消费其输出。
 * 禁止在任何调用方复制判定逻辑（WARN 文案单源 = 本脚本 lines 字段）。
 *
 * 判定：diff 触及 extensions/<pkg>/src/** 且该包无 .changeset/*.md 声明 → WARN 清单。
 * WARN 不阻断（退出码 0），与现行 check_changeset 行为一致。
 *
 * 已知口径（与原实现对拍保留，不擅自收紧）：missing 判定是子串匹配（原实现
 * `grep -qF`），包名互为前缀时（pi-foo vs pi-foobar）按「已声明」放行——误放方向，
 * 变更须连带评估 Gate-1a.5 消费行为。
 *
 * 用法：node scripts/changeset-check.mjs [--json]
 *   默认输出人可读文案行；--json 输出单行 JSON：
 *   {status: skip|pass|warn, base, changed: [pkg], missing: [pkg], lines: [文案行]}
 *   lines 与默认输出同源，pr-pre-merge.sh 消费该字段透传（保持 [pr-pre-merge] 前缀与 QUIET 语义）。
 * 退出码：0 = pass/warn/skip；2 = 工具错误（git 异常等）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// 三种包目录布局：旧扁平 extensions/<name>/、2026-08-22 分组后 extensions/<group>/<name>/
// （group ∈ shared|taiji|universal）。[HISTORICAL] 曾只特判 shared/ 一个分组，
// universal/ taiji/ 下的包全被漏检（WARN 少报 6 包）。
// match[0] = 含 extensions/ 前缀的包目录路径段（与原实现 pkg_dir 同值）
const PKG_DIR_RE = /^extensions\/(?:(?:shared|taiji|universal)\/[^/]+|[^/]+)\//
const PKG_SRC_RE = /^extensions\/(?:(?:shared|taiji|universal)\/[^/]+|[^/]+)\/src\//

function gitOut(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 解析 diff 基点：main 优先、github/main 兜底（与原实现 verify 顺序一致）；都无 → null（skip）。 */
export function resolveBase(git) {
  for (const ref of ['main', 'github/main']) {
    try {
      git(['rev-parse', '--verify', ref])
      return ref
    } catch {
      // 试下一个
    }
  }
  return null
}

/**
 * diff 文件清单 → 改动了 src/ 的包名（去重保序）。
 * readPkgName(pkgDirRel) 返回包名或 null——包目录读不到 package.json（含已删除的包）
 * 时自然跳过，与原实现 `node -p ... || echo ""` 行为一致。
 */
export function extractChangedPkgs(files, readPkgName) {
  const changed = []
  for (const file of files) {
    const m = file.match(PKG_DIR_RE)
    if (!m) continue
    if (!PKG_SRC_RE.test(file)) continue // 只关心改了 src/ 的（排除 README、docs、examples、workflows）
    // 包目录 = 完整 repo 相对路径（含 extensions/ 前缀，与原实现 pkg_dir 一致：
    // 原 sh 读 './<pkg_dir>/package.json'）
    const pkgDirRel = m[0].replace(/\/$/, '')
    const name = readPkgName(pkgDirRel)
    if (!name) continue
    if (!changed.includes(name)) changed.push(name)
  }
  return changed
}

/** .changeset/*.md 全文 → 声明的包名（单双引号 frontmatter 两种格式，sort -u 语义）。 */
export function extractDeclaredPkgs(texts) {
  const out = new Set()
  for (const text of texts) {
    for (const m of text.matchAll(/['"]@[^'"]+['"]/g)) {
      out.add(m[0].slice(1, -1))
    }
  }
  return [...out].sort()
}

/**
 * missing = changed 中未被任何 declared 声明的包。
 * 对拍原实现 `grep -qF`：子串语义（declared 条目包含 pkg 即视为已声明）。
 */
export function computeMissing(changed, declared) {
  return changed.filter((pkg) => !declared.some((d) => d.includes(pkg)))
}

/** 文案行单源（与原 check_changeset 的 log 文案逐字一致，缺前缀——前缀由宿主 log() 加）。 */
export function renderLines({ status, changed, missing }) {
  if (status === 'skip') return ['↷ skip（找不到 main 分支，无法对比）']
  if (status === 'pass' && changed.length === 0) return ['✓ 无 extension src/ 改动，跳过 changeset 检查']
  if (status === 'pass') return [`✓ 所有改动的 extension 包都有 changeset（${changed.length} 个包）`]
  return [
    `⚠ ${missing.length} 个 extension 改了 src/ 但无 changeset：`,
    ...missing.map((pkg) => `  - ${pkg}`),
    '如需发布，运行: pnpm changeset',
    '如是纯文档/测试/重构改动无需发布，可忽略此警告',
  ]
}

export function runCheck(deps) {
  const root = deps.root
  const base = resolveBase(deps.git)
  if (!base) {
    return { status: 'skip', base: null, changed: [], missing: [] }
  }
  let files = []
  try {
    files = deps.git(['diff', `${base}...HEAD`, '--name-only'])
      .split('\n').map((s) => s.trim()).filter(Boolean)
  } catch (e) {
    // base 已 verify 存在，diff 失败 = 真异常（不静默 PASS——静默路径只保留「无 main」一种）
    const err = new Error(`git diff ${base}...HEAD 失败：${e.message}。恢复：确认 git 状态后重跑`)
    err.exitCode = 2
    throw err
  }
  const changed = extractChangedPkgs(files, (pkgDirRel) => {
    const pkgJson = join(root, pkgDirRel, 'package.json')
    if (!existsSync(pkgJson)) return null
    try {
      const name = JSON.parse(readFileSync(pkgJson, 'utf-8')).name
      return typeof name === 'string' && name ? name : null
    } catch {
      return null
    }
  })
  if (changed.length === 0) {
    return { status: 'pass', base, changed, missing: [] }
  }
  let texts = []
  try {
    const csDir = join(root, '.changeset')
    texts = readdirSync(csDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(csDir, f), 'utf-8'))
  } catch {
    texts = [] // .changeset/ 缺失 = 无声明
  }
  const declared = extractDeclaredPkgs(texts)
  const missing = computeMissing(changed, declared)
  return { status: missing.length > 0 ? 'warn' : 'pass', base, changed, missing }
}

function createDefaultDeps(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  return {
    root,
    git: (args) => gitOut(args, root),
  }
}

export function main(argv) {
  const json = argv.includes('--json')
  const deps = createDefaultDeps()
  let result
  try {
    result = runCheck(deps)
  } catch (e) {
    console.error(String(e.message || e))
    process.exit(e.exitCode || 2)
  }
  if (json) {
    console.log(JSON.stringify({ ...result, lines: renderLines(result) }))
  } else {
    for (const line of renderLines(result)) console.log(line)
  }
  process.exit(0) // WARN 不阻断（与原 check_changeset 一致）
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
