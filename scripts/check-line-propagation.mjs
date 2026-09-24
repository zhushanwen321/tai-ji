#!/usr/bin/env node
/**
 * check-line-propagation.mjs —— 集成线传播守卫（ADR-0076 / C-proc-30）。
 *
 * 背景：多条 dev-x.x.x 集成线数周并行 + 修复落在其中一条 + 打包/合并从另一条，
 * 传播全靠人记——2026-09-24 dev-0.10.6 打包版事故（review-fix-loop 全员
 * review-failure，根因 = 修复只活在 dev-0.10.5，dev-0.10.6 与 main 均无）。
 * 本守卫把「目标线不得落后 main」「兄弟线未传播 commit 可见」变成打包/集成合并
 * 前的机器检查。
 *
 * 两级检查（exit code 只由硬检查决定，软提示恒不阻塞）：
 * 1. 硬检查：git merge-base --is-ancestor main <target>——目标线 ⊇ main 不成立
 *    即红：列出 git log <target>..main 缺失提交 + 恢复指引（merge main），exit 1。
 *    --allow-diverged 一次性越过硬检查（打印警示，软提示照常执行；不做持久豁免
 *    登记——本地豁免档案不跨机器，已被设计否决）。
 * 2. 软提示：枚举 git branch --list 'dev-*' 兄弟线，取 git log <target>..<sibling>
 *    --no-merges 中「commit 触及文件 ∩ 目标线树（git ls-tree -r --name-only
 *    <target>）≠ ∅」的 commit，按提交时间倒序呈报（commit 总量 + 最老停留天数
 *    头条 + 明细）。无状态恒常呈报：不做增量对比、无本地基线文件。新文件-only
 *    commit（目标线无此文件）不出现在清单。文件清单用 git log --name-only
 *    --no-renames 单进程批量取（与逐 commit git diff-tree --name-only -r 对
 *    非 merge commit 语义等价，--no-merges 已滤掉 merge）。
 *
 * 用法：node scripts/check-line-propagation.mjs [--target <ref>] [--allow-diverged]
 *   --target 默认 HEAD。挂接约定（prerelease / dev-merge skill）一律在目标线
 *   worktree 内以 --target HEAD 运行——bare+worktree 拓扑下 worktree 内默认 cwd
 *   即可，main / dev-* 经 .bare 共享 refs 可见。禁止把 --target 写死为 'main'
 *   字面量：它在任何 worktree 跑都恒绿，接线即空转。
 *
 * 退出码：0 = 通过（或 --allow-diverged 越过）；1 = 硬检查红；2 = 用法/基础设施错误。
 * 挂载：prerelease / dev-merge skill 前置步骤（人工触发，非 pre-commit——本守卫
 * 语义是打包/集成线门，不是逐 commit 门）。
 *
 * 只读 git（branch / merge-base / log / ls-tree），零写操作、零第三方依赖。
 */
import { execFileSync, spawnSync } from 'node:child_process'

const SIBLING_PATTERN = 'dev-*'

/** 执行 git 并返回 stdout；失败时抛错（调用方决定如何处置）。stdio 显式捕获防子进程 stderr 直通 */
function gitOut(args) {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 执行 git 只取退出码（merge-base --is-ancestor 用 0/1 传达判定，非错误） */
function gitStatus(args) {
  const r = spawnSync('git', args, { encoding: 'utf-8' })
  return { status: r.status, stderr: (r.stderr || '').trim() }
}

function usageError(msg) {
  console.error(`用法错误：${msg}`)
  console.error('用法：node scripts/check-line-propagation.mjs [--target <ref>] [--allow-diverged]')
  process.exit(2)
}

function parseArgs(argv) {
  const out = { target: 'HEAD', allowDiverged: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') {
      const v = argv[i + 1]
      if (!v || v.startsWith('--')) usageError('--target 需要一个 ref 参数')
      out.target = v
      i++
    } else if (a === '--allow-diverged') {
      out.allowDiverged = true
    } else {
      usageError(`未知参数 ${a}`)
    }
  }
  return out
}

/** 解析 git log --name-only 自定义 format 输出为 [{hash, date, subject, files}] */
function parseLogRecords(out) {
  const records = []
  for (const line of out.split('\n')) {
    if (line.startsWith('C\x1f')) {
      const [, hash, date, subject] = line.split('\x1f')
      records.push({ hash, date, subject, files: [] })
    } else if (line && records.length > 0) {
      records[records.length - 1].files.push(line)
    }
  }
  return records
}

function daysSince(isoDate) {
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000)
}

function main() {
  const { target, allowDiverged } = parseArgs(process.argv.slice(2))

  // target ref 可解析性前置（log -1 即解析；不可解析给出可操作报错而非 git 堆栈）
  try {
    gitOut(['log', '-1', '--format=%H', target])
  } catch {
    usageError(`--target ${target} 无法解析（ref 不存在？）——在目标线 worktree 内运行或传分支名`)
  }

  // ---- 硬检查：target ⊇ main ----
  let hardRed = false
  const mb = gitStatus(['merge-base', '--is-ancestor', 'main', target])
  if (mb.status === 0) {
    console.log('[硬检查] 目标线 ⊇ main：通过')
  } else if (mb.status === 1) {
    hardRed = true
    const missing = gitOut(['log', `${target}..main`, '--oneline'])
    const count = missing.trim() ? missing.trim().split('\n').length : 0
    console.error(`[硬检查] 目标线 ${target} 落后 main ${count} 个提交（已进 main 的提交未被目标线吸收）：`)
    for (const line of missing.trim().split('\n')) {
      if (line) console.error(`    ${line}`)
    }
    console.error('    恢复指引：在目标线 worktree 内 git merge main 后重跑本守卫；')
    console.error('    确有正当理由一次性越过：node scripts/check-line-propagation.mjs --target <ref> --allow-diverged')
  } else {
    console.error(`[硬检查] git merge-base 执行失败（main 或 ${target} 不可读？）：${mb.stderr}`)
    process.exit(2)
  }

  if (hardRed && allowDiverged) {
    console.warn('[警示] --allow-diverged：硬检查被一次性越过（不登记持久豁免），软提示照常执行。')
  }

  // ---- 软提示：兄弟线未传播 commit（恒常呈报，不阻塞） ----
  const siblings = gitOut(['branch', '--list', SIBLING_PATTERN, '--format=%(refname:short)'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  // 目标线树文件全集（交集判据的一侧）
  const targetFiles = new Set(
    gitOut(['ls-tree', '-r', '--name-only', target])
      .split('\n')
      .filter(Boolean),
  )

  console.log('[软提示] 兄弟线未传播 commit（不阻塞，供人工裁决；裁决粒度 = 线粒度：吸收 / 暂缓）')
  if (siblings.length === 0) {
    console.log('    无 dev-* 兄弟线。')
  }
  for (const sibling of siblings) {
    // 兄弟线与目标线相同时 range 为空，结构性自排除，无需特判
    let records
    try {
      records = parseLogRecords(
        gitOut(['log', `${target}..${sibling}`, '--no-merges', '--name-only', '--no-renames', '--format=C\x1f%H\x1f%cI\x1f%s']),
      )
    } catch (e) {
      console.error(`    [${sibling}] git log 读取失败，跳过该线：${e.message.split('\n')[0]}`)
      continue
    }
    const shared = records.filter((r) => r.files.some((f) => targetFiles.has(f)))
    if (shared.length === 0) {
      console.log(`    [${sibling}] 无触及目标线共享文件的未传播 commit。`)
      continue
    }
    // git log 默认新→旧；最老 = 末条
    const oldest = shared[shared.length - 1]
    console.log(`    [${sibling}] ${shared.length} 个 commit 触及目标线也存在的文件，最老停留 ${daysSince(oldest.date)} 天：`)
    for (const r of shared) {
      const day = r.date.slice(0, 10)
      console.log(`      ${r.hash.slice(0, 10)} ${day} ${r.subject}`)
    }
  }

  process.exit(hardRed && !allowDiverged ? 1 : 0)
}

main()
