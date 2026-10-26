#!/usr/bin/env node
/**
 * changeset-check.mjs —— extension 发布改动 changeset 完整性检查（决策 7 唯一实装）。
 *
 * 判定逻辑从 scripts/pr-pre-merge.sh 的 check_changeset()（Step 5，WARN 级）原样抽出为
 * 唯一实现：pr-pre-merge.sh 改调本脚本（--json），Gate-1a.5 与 dev-merge gates 消费其输出。
 * 禁止在任何调用方复制判定逻辑（WARN 文案单源 = 本脚本 lines 字段）。
 *
 * 判定（两个方向，包集合同源）：
 * ① 漏声明（WARN）：diff 触及任一可版本化包的 src/** 且该包无 .changeset/*.md 声明 → WARN 清单。
 *    WARN 不阻断（退出码 0）。包范围 = loadPackageRegistry（@manypkg 枚举 workspace 全量
 *    + config.ignore，经 versionable-packages.mjs 同一出口口径）——历史上本方向持
 *    extensions/ 正则，packages/ 完全不在范围（v0.11.16 六包漏声明直穿终局的根因）；
 *    收敛后目录布局变化自动跟随 workspace 定义。范围仅限可版本化包（private/ignore
 *    包不发 npm、无 changeset 语义），与 check-version-changes.sh 的 pkgOf 对齐。
 * ② 无效声明（FAIL）：.changeset/*.md 声明了不可版本化包（private ∨ config.ignore）→ FAIL。
 *    该声明永不生效（纯 private 被 version 静默跳过残留、混合声明阻断 version），无任何
 *    合法场景，无条件扫描（不依赖 base 解析成功），退出码 1 阻断。判定唯一源 =
 *    scripts/changeset-versionable.mjs（与 pre-commit check_changeset_packages 同源）。
 *
 * 已知口径（与原实现对拍保留，不擅自收紧）：missing 判定是子串匹配（原实现
 * `grep -qF`），包名互为前缀时（pi-foo vs pi-foobar）按「已声明」放行——误放方向，
 * 变更须连带评估 Gate-1a.5 消费行为。
 *
 * 用法：node scripts/changeset-check.mjs [--json]
 *   默认输出人可读文案行；--json 输出单行 JSON：
 *   {status: skip|pass|warn|fail, base, changed: [pkg], missing: [pkg],
 *    unversionable: [{file, name, bumpType}], lines: [文案行]}
 *   lines 与默认输出同源，pr-pre-merge.sh 消费该字段透传（保持 [pr-pre-merge] 前缀与 QUIET 语义）。
 * 退出码：0 = pass/warn/skip；1 = fail（无效声明）；2 = 工具错误（git 异常等）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { relative, resolve } from 'node:path'
import { findUnversionable, loadPackageRegistry, parseChangesetFrontmatter } from './changeset-versionable.mjs'

/**
 * diff 文件清单 → 改动了 src/ 的可版本化包名（去重保序）。
 * pkgEntries = [{ name, dir }]（dir = 仓库相对路径，仅可版本化包，来自 registry）；
 * 文件落在 <dir>/src/ 下才计入（排除 README、docs、examples、workflows）。
 * 嵌套包目录取最长前缀（与 check-version-changes.sh 的 pkgOf 同语义）。
 */
export function extractChangedPkgs(files, pkgEntries) {
  const changed = []
  for (const file of files) {
    let best = null
    for (const entry of pkgEntries) {
      if (file.startsWith(`${entry.dir}/src/`)) {
        if (!best || entry.dir.length > best.dir.length) best = entry
      }
    }
    if (!best) continue
    if (!changed.includes(best.name)) changed.push(best.name)
  }
  return changed
}

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
export function renderLines({ status, changed, missing, unversionable = [] }) {
  if (status === 'skip') return ['↷ skip（找不到 main 分支，无法对比）']
  if (status === 'fail') {
    // 阻断态（退出码 1，pr-pre-merge.sh 置 FAIL）：恢复动作与 pre-commit 消费方
    // .githooks/check_changeset_packages.mjs 同义——无效声明的修法是删声明，不是再跑 pnpm changeset。
    // 本脚本跑在 PR / dev-merge 门禁，changeset 文件通常已提交，删文件用 git rm（非 restore）。
    return [
      `✗ ${unversionable.length} 个 changeset 声明了不可版本化的包（private/config.ignore，声明永不生效）：`,
      ...unversionable.map((d) => `  - ${d.file}: '${d.name}': ${d.bumpType}`),
      '该包不发 npm（private 或 config.ignore 清单内），版本语义由 Electron 发布线承载，不经 changesets：',
      '从该 changeset 的 frontmatter 删除对应行，或删除整个 changeset 文件（git rm .changeset/<文件>），然后重跑本检查',
    ]
  }
  if (status === 'pass' && changed.length === 0) return ['✓ 无发布包 src/ 改动，跳过 changeset 检查']
  if (status === 'pass') return [`✓ 所有改动的发布包都有 changeset（${changed.length} 个包）`]
  return [
    `⚠ ${missing.length} 个发布包改了 src/ 但无 changeset：`,
    ...missing.map((pkg) => `  - ${pkg}`),
    '如需发布，运行: pnpm changeset',
    '如是纯文档/测试/重构改动无需发布，可忽略此警告',
  ]
}

/**
 * 无效声明扫描（方向②，无条件跑）：磁盘 .changeset/*.md 声明中出现 private/ignore 包
 * 即 fail。不依赖 base——残留声明在任何分支状态下都是错的。
 */
export function scanUnversionable(root, registry) {
  let texts = []
  try {
    const csDir = join(root, '.changeset')
    texts = readdirSync(csDir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => ({ file: `.changeset/${f}`, text: readFileSync(join(csDir, f), 'utf-8') }))
  } catch {
    return [] // .changeset/ 缺失 = 无声明
  }
  const out = []
  for (const { file, text } of texts) {
    for (const d of parseChangesetFrontmatter(text)) {
      if (findUnversionable([d.name], registry).length > 0) {
        out.push({ file, name: d.name, bumpType: d.bumpType })
      }
    }
  }
  return out
}

export function runCheck(deps) {
  const root = deps.root
  const registry = deps.loadRegistry ? deps.loadRegistry(root) : loadPackageRegistry(root)
  const unversionable = scanUnversionable(root, registry)
  if (unversionable.length > 0) {
    return { status: 'fail', base: null, changed: [], missing: [], unversionable }
  }
  const base = resolveBase(deps.git)
  if (!base) {
    return { status: 'skip', base: null, changed: [], missing: [], unversionable: [] }
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
  // 方向① 判定输入：可版本化包的仓库相对目录（枚举唯一源 = registry / workspace globs；
  // byName 的 dir 是绝对路径，转仓库相对以匹配 git diff 输出）
  const pkgEntries = []
  for (const [name, meta] of registry.byName) {
    if (meta.private || registry.ignoreSet.has(name)) continue
    pkgEntries.push({ name, dir: relative(root, meta.dir).split('\\').join('/') })
  }
  const changed = extractChangedPkgs(files, pkgEntries)
  if (changed.length === 0) {
    return { status: 'pass', base, changed, missing: [], unversionable: [] }
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
  return { status: missing.length > 0 ? 'warn' : 'pass', base, changed, missing, unversionable: [] }
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
  process.exit(result.status === 'fail' ? 1 : 0) // fail = 无效声明阻断；WARN 不阻断（与原 check_changeset 一致）
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
