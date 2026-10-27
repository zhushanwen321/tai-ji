#!/usr/bin/env node
/**
 * select-affected-domain.mjs — 功能域感知调度器（消费 docs/testing/domain-slices/ 切片 SSOT）
 *
 * 「改了哪些文件 → 跑哪些功能域的单测」的机器对账入口（Wave4 触发链路）：
 *   - 选择：diff 文件 → 命中域（scope 或 tests 覆盖，∪ sharedBy 反查）→ 契约闭包
 *     （受影响域的 contracts 逐条附加对侧域，fixpoint）→ 输出受影响域 + 逐域触发原因
 *     + 可执行命令 `pnpm test:domain a b c`
 *   - 广播：diff 命中 _meta.json 的 broadcastCarriers（基础层契约枢纽）→ 输出
 *     「建议全量 pnpm test」并退出（宁全勿缺，与 e2e-map 保守策略同款）
 *   - --check 门禁：watched roots 下且不被任何域/池覆盖的变更文件 → exit 1（防漏归域）
 *   - --staged 暂存门禁：同 --check 判定，输入换 git diff --cached（--diff-filter=AR，
 *     新增/改名进看护根才产生登记义务）——pre-commit 形态（接线归批 D，pre-commit 2f-4）
 *
 * 与 select-affected-e2e.mjs 的关系：平行机制，复用模式不共用代码（两者回答不同问题、
 * map 结构不同；匹配语义与门禁形态照抄其已验证设计：prefix/** startsWith + 精确路径
 * 全等、纯函数导出供 scripts/__tests__ 单测、零依赖）。
 *
 * watched roots = 全部代码根（packages/<pkg>/src/、packages/runtime/test/、apps/<app>/main/、
 * extensions/{universal,taiji,shared}/<ext>/src/），docs、scripts 配置文件不产生登记义务。
 *
 * 用法：
 *   node scripts/select-affected-domain.mjs                  # diff = origin/main...HEAD（默认）
 *   node scripts/select-affected-domain.mjs --base <ref>     # 显式 base ref
 *   node scripts/select-affected-domain.mjs --check          # 门禁：未归域的 watched 文件 → exit 1
 *   node scripts/select-affected-domain.mjs --staged         # pre-commit 暂存门禁（同判定）
 *
 * 退出码：0 成功 / 1 --check、--staged 检出未归域文件 / 2 环境错误（注册表缺失、git ref 无效）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const REGISTRY_DIR = join(REPO_ROOT, 'docs', 'testing', 'domain-slices')

// ---------- 纯函数（scripts/__tests__/select-affected-domain.test.mjs 消费） ----------

/** glob 匹配：'<prefix>/**' → startsWith(prefix/) 或全等 prefix；精确路径 → 全等。 */
export function globCovers(globList, file) {
  return (globList ?? []).some((s) => {
    if (s.endsWith('/**')) return file.startsWith(s.slice(0, -3) + '/') || file === s.slice(0, -3)
    return s === file
  })
}

/** 域切片覆盖判定：scope（全部层摊平）∪ tests 的 glob 并集覆盖。 */
export function sliceCovers(slice, file) {
  const scopeGlobs = Object.values(slice.scope ?? {}).flat()
  return globCovers([...scopeGlobs, ...(slice.tests ?? [])], file)
}

/** sharedBy 反查：file 是某 owner 域注记的跨域混合文件时，返回注记域集合（不含 owner 自身）。 */
export function sharedByDomains(slices, file) {
  const out = new Set()
  for (const s of slices) {
    const noted = s.sharedBy?.[file]
    if (Array.isArray(noted)) for (const d of noted) if (d !== s.name) out.add(d)
  }
  return [...out]
}

/**
 * 选择核心（两级）：
 *  一级：diff 文件 f → 域集合 = { X : sliceCovers(X, f) } ∪ sharedBy 反查域；
 *  二级（契约闭包）：受影响域的 contracts 条目逐条附加对侧域，迭代至 fixpoint
 *  （A→B、B→C 契约在 A 受影响时级联触达 C）。
 * 返回 { affected: 域名数组（排序）, reasons: Map<域名, {file,glob,via}[]>, broadcastHits: string[] }。
 * broadcastHits = diff 中命中 _meta.json broadcastCarriers 的文件（宁全勿缺，建议全量）。
 */
export function selectAffectedDomains(slices, broadcastCarriers, files) {
  const reasons = new Map()
  const add = (domain, reason) => {
    if (!reasons.has(domain)) reasons.set(domain, [])
    reasons.get(domain).push(reason)
  }
  for (const file of files) {
    for (const s of slices) {
      const scopeGlobs = Object.values(s.scope ?? {}).flat()
      const glob = [...scopeGlobs, ...(s.tests ?? [])].find((g) =>
        g.endsWith('/**')
          ? file.startsWith(g.slice(0, -3) + '/') || file === g.slice(0, -3)
          : g === file,
      )
      if (glob !== undefined) add(s.name, { file, glob, via: 'scope/tests' })
    }
    for (const d of sharedByDomains(slices, file)) add(d, { file, glob: `sharedBy:${file}`, via: 'sharedBy' })
  }
  // 契约闭包：fixpoint 迭代（受影响域的 contracts → 对侧域，直至不再新增）
  let grew = true
  while (grew) {
    grew = false
    for (const s of slices) {
      if (!reasons.has(s.name)) continue
      for (const c of s.contracts ?? []) {
        for (const target of c.on ?? []) {
          if (!reasons.has(target)) {
            add(target, { file: c.carrier, glob: `contracts:${s.name}→${target}`, via: 'contracts' })
            grew = true
          }
        }
      }
    }
  }
  const broadcastHits = files.filter((f) => globCovers(broadcastCarriers, f))
  return { affected: [...reasons.keys()].sort(), reasons, broadcastHits }
}

/** --check/--staged 核心：watched root 下且不被任何域/池覆盖（scope ∪ tests ∪ sharedBy 键）的文件。 */
export function unregisteredWatchedFiles(slices, roots, files) {
  return files.filter(
    (f) => roots.some((r) => f.startsWith(r)) && !slices.some((s) => sliceCovers(s, f) || Boolean(s.sharedBy?.[f])),
  )
}

/** 目录存在且为目录（watched roots 推导用）。 */
function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * watched roots 推导（目录结构事实，非注册表内容）：全部代码根——
 * packages/<pkg>/src/、packages/runtime/test/、apps/<app>/main/、
 * extensions/{universal,taiji,shared}/<ext>/src/。docs、scripts 配置文件不产生登记义务。
 */
export function watchedRoots(repoRoot) {
  const roots = []
  const pkgs = join(repoRoot, 'packages')
  if (isDir(pkgs)) {
    for (const name of readdirSync(pkgs)) {
      if (isDir(join(pkgs, name, 'src'))) roots.push(`packages/${name}/src/`)
    }
    if (isDir(join(pkgs, 'runtime', 'test'))) roots.push('packages/runtime/test/')
  }
  const apps = join(repoRoot, 'apps')
  if (isDir(apps)) {
    for (const name of readdirSync(apps)) {
      if (isDir(join(apps, name, 'main'))) roots.push(`apps/${name}/main/`)
    }
  }
  for (const group of ['universal', 'taiji', 'shared']) {
    const groupDir = join(repoRoot, 'extensions', group)
    if (!isDir(groupDir)) continue
    for (const name of readdirSync(groupDir)) {
      if (isDir(join(groupDir, name, 'src'))) roots.push(`extensions/${group}/${name}/src/`)
    }
  }
  return roots.sort()
}

/** 注册表加载：docs/testing/domain-slices/ 下全部 <domain>.json + _meta.json。
 * 结构合法性由 check-domain-slices 负责，此处只做最小形状防御（name/summary/tests 存在）。 */
export function loadRegistry(registryDir = REGISTRY_DIR) {
  if (!isDir(registryDir)) {
    console.error(`[select-affected-domain] 注册表目录不存在：${registryDir}`)
    console.error('  恢复动作：确认 docs/testing/domain-slices/ 存在且含各域 JSON（健康度跑 node scripts/check-domain-slices.mjs）')
    process.exit(2)
  }
  const slices = []
  let meta = { broadcastCarriers: [] }
  for (const name of readdirSync(registryDir)) {
    if (!name.endsWith('.json')) continue
    const p = join(registryDir, name)
    let doc
    try {
      doc = JSON.parse(readFileSync(p, 'utf-8'))
    } catch (err) {
      console.error(`[select-affected-domain] JSON 解析失败：${p}（${err.message}）`)
      process.exit(2)
    }
    if (name === '_meta.json') {
      meta = doc
      continue
    }
    if (typeof doc?.name === 'string' && typeof doc?.summary === 'string' && Array.isArray(doc?.tests)) {
      slices.push({ scope: {}, sharedBy: {}, contracts: [], ...doc })
    }
  }
  return { slices, meta }
}

// ---------- main ----------

function changedFiles(base) {
  try {
    // --diff-filter=d 排除已删除文件：删除不产生归域义务（与 select-affected-e2e 同款口径）
    return execSync(`git diff --name-only --diff-filter=d ${base}...HEAD`, { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  } catch {
    console.error(`[select-affected-domain] git diff ${base}...HEAD 失败：base ref 不存在或仓库状态异常`)
    console.error('  恢复动作：git fetch origin main 后重试，或显式指定存在的 ref：node scripts/select-affected-domain.mjs --base <ref>')
    process.exit(2)
  }
}

/** 门禁判定专用输入源：仅新增/改名（--diff-filter=AR）——修改存量文件不产生登记义务。 */
function addedFiles(gitSpec) {
  return execSync(gitSpec, { cwd: REPO_ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function renderReasons(reasons) {
  const lines = []
  for (const domain of [...reasons.keys()].sort()) {
    lines.push(`- ${domain}`)
    for (const r of reasons.get(domain)) lines.push(`  - ${r.file} ← ${r.glob}（${r.via}）`)
  }
  return lines.join('\n')
}

function failUnregistered(unregistered, mode) {
  console.error(`[select-affected-domain] ${mode} FAIL：以下文件落在 watched roots 内但不被任何域/池覆盖（防漏归域）：`)
  for (const f of unregistered) console.error(`  - ${f}`)
  console.error('  恢复动作：把该文件的归属 glob 登记进对应域的 docs/testing/domain-slices/<domain>.json（scope/tests），')
  console.error('  无法唯一归类时登记进 uncategorized.json（精确路径 + 必要时 sharedBy 注记内含域），然后重试。')
  process.exit(1)
}

function main() {
  const args = process.argv.slice(2)
  function argValue(name) {
    const i = args.indexOf(name)
    return i !== -1 ? args[i + 1] : undefined
  }
  const base = argValue('--base') ?? 'origin/main'
  const { slices, meta } = loadRegistry()

  // --staged：pre-commit 门禁形态——只做防漏归域判定，不渲染受影响清单
  if (args.includes('--staged')) {
    const unregistered = unregisteredWatchedFiles(slices, watchedRoots(REPO_ROOT), addedFiles('git diff --cached --name-only --diff-filter=AR'))
    if (unregistered.length > 0) failUnregistered(unregistered, '--staged')
    console.log('domain-slices staged check PASS')
    return
  }

  const files = changedFiles(base)
  const { affected, reasons, broadcastHits } = selectAffectedDomains(slices, meta.broadcastCarriers ?? [], files)

  console.log('# 受影响功能域（select-affected-domain）\n')
  console.log(`- 变更范围：\`git diff ${base}...HEAD\`，共 ${files.length} 个文件`)
  console.log(`- 受影响域：${affected.length} 个${affected.length > 0 ? `（${affected.join('、')}）` : ''}`)
  if (affected.length > 0) console.log(`- 执行命令：\`pnpm test:domain ${affected.join(' ')}\``)
  if (reasons.size > 0) console.log(`\n## 逐域触发原因\n\n${renderReasons(reasons)}`)

  if (broadcastHits.length > 0) {
    console.error(`\n[select-affected-domain] 广播载体命中（基础层契约枢纽，宁全勿缺）：`)
    for (const f of broadcastHits) console.error(`  - ${f}`)
    console.error('  建议全量：pnpm test')
  }

  if (args.includes('--check')) {
    const unregistered = unregisteredWatchedFiles(slices, watchedRoots(REPO_ROOT), addedFiles(`git diff --name-only --diff-filter=AR ${base}...HEAD`))
    if (unregistered.length > 0) failUnregistered(unregistered, '--check')
    console.log('\ndomain-slices-check PASS')
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(join(process.argv[1])).href
if (isMain) main()
