#!/usr/bin/env node
/**
 * cross-branch-overlap.mjs —— 当前线 diff 与未合并兄弟线 diff 的修改文件交集（决策 2）。
 *
 * 确定性计算（纯 git diff --name-only 求交集），产出供 dev-merge 1.8 传播守卫的兄弟线
 * 摘要呈报，由人裁决是否吸收（线粒度：吸收 / 暂缓）；无 LLM、恒不阻塞（exit 0）。
 *
 * 口径与 scripts/check-line-propagation.mjs 对齐：
 *   兄弟线枚举 = `git branch --list 'dev-*'`（排除当前分支自身）；
 *   「未合并」= `git merge-base --is-ancestor <sibling> <branch>` 退出码非 0
 *   （sibling 已完全合入当前线的，交集无裁决意义，排除）。
 *   当前线 diff = `git diff <base>...<branch> --name-only`；兄弟线 diff 同款口径。
 *
 * 用法：node scripts/cross-branch-overlap.mjs [--base <ref>] [--branch <ref>] [--json]
 *   --base 默认 main（fallback github/main，与 changeset-check 同款解析顺序）；
 *   --branch 默认 HEAD。
 * 退出码：0 = 正常呈报（含空交集）；2 = 用法/工具错误（base 无法解析、ref 异常等）
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const SIBLING_PATTERN = 'dev-*'

function gitOut(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function gitStatus(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return r.status
}

/** diff --name-only → 文件名集合 */
function diffNames(git, base, ref) {
  return new Set(
    git(['diff', `${base}...${ref}`, '--name-only'])
      .split('\n').map((s) => s.trim()).filter(Boolean),
  )
}

/** 交集（排序数组）——纯函数，单测锚点 */
export function computeOverlap(currentFiles, siblingFiles) {
  return [...currentFiles].filter((f) => siblingFiles.has(f)).sort()
}

export function parseArgs(argv) {
  const out = { base: null, branch: 'HEAD', json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') {
      out.base = argv[++i]
      if (!out.base) throw usageError('--base 需要一个 ref 参数')
    } else if (a === '--branch') {
      out.branch = argv[++i]
      if (!out.branch) throw usageError('--branch 需要一个 ref 参数')
    } else if (a === '--json') {
      out.json = true
    } else {
      throw usageError(`未知参数：${a}`)
    }
  }
  return out
}

function usageError(msg) {
  const err = new Error(`用法错误：${msg}。用法：node scripts/cross-branch-overlap.mjs [--base <ref>] [--branch <ref>] [--json]`)
  err.exitCode = 2
  return err
}

/**
 * 聚合逻辑（deps.git / deps.gitStatus 注入，单测不跑真 git）。
 * 返回 { base, branch, rows: [{sibling, status: merged|clean|overlap, files}] }
 */
export function runOverlap(deps, { base: explicitBase, branch }) {
  let base = explicitBase
  if (!base) {
    for (const ref of ['main', 'github/main']) {
      try {
        deps.git(['rev-parse', '--verify', ref])
        base = ref
        break
      } catch {
        // 试下一个
      }
    }
  }
  if (!base) {
    throw usageError(
      'base 解析失败：main 与 github/main 均不可解析——交集无从算起。' +
        '恢复：用 --base <ref> 显式指定共同基点',
    )
  }

  const currentFiles = diffNames(deps.git, base, branch)
  const currentBranchName = safeShowCurrent(deps)

  const siblings = deps.git(['branch', '--list', SIBLING_PATTERN, '--format=%(refname:short)'])
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((s) => s !== currentBranchName && s !== branch) // 自身排除（当前线不是自己的兄弟线）

  const rows = []
  for (const sibling of siblings) {
    const anc = deps.gitStatus(['merge-base', '--is-ancestor', sibling, branch])
    if (anc === 0) {
      rows.push({ sibling, status: 'merged', files: [] }) // 已完全合入当前线，无裁决意义
      continue
    }
    if (anc !== 1) {
      const err = new Error(
        `git merge-base --is-ancestor ${sibling} ${branch} 异常（exit=${anc}）——ref 可能不存在。` +
          '恢复：git branch -l 核对兄弟线后重跑',
      )
      err.exitCode = 2
      throw err
    }
    const files = computeOverlap(currentFiles, diffNames(deps.git, base, sibling))
    rows.push({ sibling, status: files.length > 0 ? 'overlap' : 'clean', files })
  }
  return { base, branch, rows }
}

function safeShowCurrent(deps) {
  try {
    return deps.git(['branch', '--show-current']).trim()
  } catch {
    return '' // detached HEAD 等形态：靠 --branch 显式名排除
  }
}

export function renderLines({ base, branch, rows }) {
  const out = []
  out.push(`[cross-branch-overlap] base=${base} branch=${branch}（人裁决消费，恒不阻塞；裁决粒度 = 线粒度：吸收 / 暂缓）`)
  const overlapRows = rows.filter((r) => r.status === 'overlap')
  const mergedCount = rows.filter((r) => r.status === 'merged').length
  if (rows.length === 0) {
    out.push('  无 dev-* 兄弟线（无重叠面）。')
    return out
  }
  if (overlapRows.length === 0) {
    out.push(`  各兄弟线与当前线无修改文件交集（已合并跳过 ${mergedCount} 条）。`)
  }
  for (const r of rows) {
    if (r.status === 'merged') {
      out.push(`  ${r.sibling}: 已合入当前线，跳过`)
    } else if (r.status === 'clean') {
      out.push(`  ${r.sibling}: 无重叠`)
    } else {
      out.push(`  ${r.sibling}: ${r.files.length} 个文件与当前线重叠——吸收进本次合入或确认知情暂缓：`)
      for (const f of r.files) out.push(`    - ${f}`)
    }
  }
  return out
}

function createDefaultDeps(cwd = process.cwd()) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
  return {
    root,
    git: (args) => gitOut(args, root),
    gitStatus: (args) => gitStatus(args, root),
  }
}

export function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(String(e.message || e))
    process.exit(e.exitCode || 2)
  }
  const deps = createDefaultDeps()
  let result
  try {
    result = runOverlap(deps, args)
  } catch (e) {
    console.error(String(e.message || e))
    process.exit(e.exitCode || 2)
  }
  if (args.json) console.log(JSON.stringify(result))
  else for (const line of renderLines(result)) console.log(line)
  process.exit(0) // 呈报不阻塞（人裁决消费）
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
