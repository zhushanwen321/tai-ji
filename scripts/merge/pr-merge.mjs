#!/usr/bin/env node
// fallow-ignore-file unused-file — 本文件由 .agents/skills/merge/scripts/pr-merge.sh 薄壳
// 经 shell exec node 调起（用法见文件尾注），静态 import 分析不可见，非死代码
/**
 * pr-merge.mjs — merge 流程阶段 2：PR CI 等待 + 合并 + sync 本地 main
 *
 * 做什么：
 *   1. 等待 PR CI 通过（判定数据 = head SHA 的 workflow runs，与阶段 3 wait-for-ci
 *      同源；等全部 run 完成才裁决，上限 30 分钟。机器人检查（Greptile 等 check
 *      run）不进判定——CI 门禁只看本仓 workflow）
 *   2. gh pr merge --merge --delete-branch --match-head-commit <sha>（merge commit，
 *      绝不 squash；match-head-commit 保证「判定时的 head = 合并时的 head」——判定
 *      通过后 PR 又被推新提交时 gh 拒绝合并，封住客户端侧的检查-合并竞态窗口）
 *   3. sync 本地 main（fetch + 领先防护 + reset --hard github/main——本地 main 领先
 *      远端时 fail-fast，见 lib/sync.mjs）
 *   4. main 依赖补装（lockfile 变化时；一致时快速跳过）
 *
 * 前置：阶段 0（init）已执行，PR 处于 OPEN 状态
 * 用法: node scripts/merge/pr-merge.mjs <pr-number>
 * 退出码：0 = 成功，1 = 失败
 *
 * 由 .agents/skills/merge/scripts/pr-merge.sh（薄壳）经 main worktree 调起——
 * 实现恒取 main 分支最新版，不受 feature worktree 的分支新旧影响。
 */
import { existsSync } from 'node:fs'
import { run } from './lib/exec.mjs'
import { RED, GREEN, YELLOW, BOLD, NC } from './lib/output.mjs'
import { DEFAULT_REPO } from './lib/repo.mjs'
import { filterDependabot, waitForRuns } from './lib/gate.mjs'
import { findWorkspaceRoot, mainWorktreePath } from './lib/workspace.mjs'
import { writeMergeState, readMergeState } from './lib/state.mjs'
import { syncMain } from './lib/sync.mjs'

const GH_REMOTE = 'github'

function fail(message) {
  console.error(`${RED}${message}${NC}`)
}

const PR_NUMBER = process.argv[2]
if (!PR_NUMBER || !/^\d+$/.test(PR_NUMBER)) {
  fail('Usage: pr-merge.mjs <pr-number>')
  process.exit(1)
}

function fetchPr(fields) {
  const res = run(
    'gh',
    ['pr', 'view', PR_NUMBER, '--repo', DEFAULT_REPO, '--json', fields.join(',')],
    { stdio: 'capture' },
  )
  if (!res.ok) return null
  try {
    return JSON.parse(res.stdout)
  } catch {
    return null
  }
}

const pr = fetchPr(['state', 'title', 'headRefOid', 'headRefName'])
const PR_STATE = pr?.state ?? 'UNKNOWN'
const PR_TITLE = pr?.title ?? ''
const HEAD_SHA = pr?.headRefOid ?? ''
const HEAD_BRANCH = pr?.headRefName ?? ''

console.log(`${BOLD}═══ 阶段 2: PR CI + 合并 ═══${NC}`)
console.log(`  PR: #${PR_NUMBER} — ${PR_TITLE}`)
console.log(`  状态: ${PR_STATE}`)

// 幂等：已合并则跳过
if (PR_STATE === 'MERGED') {
  console.log(`${GREEN}⏭️  PR 已合并，跳过${NC}`)
} else if (PR_STATE !== 'OPEN') {
  fail(`Error: PR 状态为 ${PR_STATE}，无法处理（需 OPEN 或 MERGED；gh 调用失败时也落此处——检查 gh 登录态）`)
  process.exit(1)
} else {
  // ── PR CI 门禁（判定实现 = lib/gate.mjs；数据源 = head SHA 的 workflow runs，
  //    与阶段 3 wait-for-ci 同源——「有 runs 必等全部完成才裁决」，不依赖
  //    check-rollup 的注册窗口形状；机器人检查 run（非本仓 workflow）不进判定）──
  if (!HEAD_SHA) {
    fail('Error: 未取到 PR head commit sha，无法按 commit 查询 CI runs（检查 gh 登录态）')
    process.exit(1)
  }
  console.log(`  检查 PR CI 状态（head ${HEAD_SHA.slice(0, 8)} 的 workflow runs）...`)
  const fetchRunsRaw = async () => {
    const res = run(
      'gh',
      ['run', 'list', '--commit', HEAD_SHA, '--repo', DEFAULT_REPO, '--json', 'databaseId,status,conclusion,name,workflowName'],
      { stdio: 'capture' },
    )
    if (!res.ok) {
      console.log(`  ${YELLOW}Warning: 无法获取 CI runs，按未触发处理${NC}`)
      return []
    }
    try {
      return JSON.parse(res.stdout) ?? []
    } catch {
      return []
    }
  }

  const verdict = await waitForRuns({
    fetchRuns: async () => filterDependabot(await fetchRunsRaw()),
    // PR CI 最长 job 是 e2e-visual/e2e-behavior（timeout-minutes: 30），10min 默认
    // 必然不够；30min 与最长 job 预算同值仍贴线（runner 排队另计），超时是 exit 1
    // 人工介入语义，宁可宽
    deadlineMs: 1_800_000,
    log: (m) => console.log(`  ${m}`),
  })

  if (verdict.status === 'no-runs') {
    fail('❌ 30 秒内未检测到本次 head commit 触发的 workflow run，无法确认 PR CI 状态')
    console.log('  排查指引:')
    console.log('    1. 确认是否触发了 CI（ci.yml 路径过滤：只改 docs/ 或 .md 可能不触发）:')
    console.log(`       gh run list --repo ${DEFAULT_REPO} --commit ${HEAD_SHA}`)
    console.log('    2. 确认无需 CI 时（如纯文档 PR）人工执行合并，不依赖本脚本的自动判定')
    process.exit(1)
  }
  if (verdict.status === 'fail') {
    fail('❌ PR CI 有失败项:')
    for (const f of verdict.failing) {
      console.log(`    ❌ ${f.name} (${f.conclusion})`)
      if (f.databaseId != null) console.log(`       日志: gh run view ${f.databaseId} --repo ${DEFAULT_REPO} --log-failed`)
    }
    process.exit(1)
  }
  if (verdict.status === 'timeout') {
    fail('❌ PR CI 在 30 分钟内未完成（runs 仍未全部结束）')
    console.log(`  排查: gh run list --repo ${DEFAULT_REPO} --commit ${HEAD_SHA}`)
    process.exit(1)
  }

  console.log(`${GREEN}✅ PR CI 通过，开始合并${NC}`)
  const mergeRes = run(
    'gh',
    [
      'pr', 'merge', PR_NUMBER, '--repo', DEFAULT_REPO,
      '--merge', '--delete-branch', '--match-head-commit', HEAD_SHA,
    ],
  )
  if (!mergeRes.ok) {
    const after = fetchPr(['state'])
    if (after?.state === 'MERGED') {
      console.log(`${GREEN}PR 已合并（可能被其他进程合并）${NC}`)
    } else {
      fail('Error: PR 合并失败')
      console.log('  若 head 在 CI 判定后被推了新提交（--match-head-commit 拒绝合并），直接重跑本脚本（幂等）')
      process.exit(1)
    }
  }
  console.log(`${GREEN}✅ PR #${PR_NUMBER} 已合并${NC}`)
}

// ── sync 本地 main（gh pr merge 直接合到 github/main，不更新本地 main）──
console.log('')
console.log('  sync 本地 main...')
const WS_ROOT = findWorkspaceRoot()
if (WS_ROOT === null) {
  fail('Error: 未找到 workspace 根（向上查找含 .bare/ 的目录失败）——请在 worktree 内运行')
  process.exit(1)
}
const MAIN_WT = mainWorktreePath(WS_ROOT)
if (!existsSync(MAIN_WT)) {
  fail(`Error: main worktree 不存在（${MAIN_WT}）——手动执行 sync: git -C <main-wt> fetch ${GH_REMOTE} main && git -C <main-wt> reset --hard ${GH_REMOTE}/main`)
  process.exit(1)
}

const sync = syncMain({ run, mainWt: MAIN_WT, ghRemote: GH_REMOTE })
if (!sync.ok) {
  if (sync.step === 'ahead-guard') {
    fail(`Error: 本地 main 领先 ${GH_REMOTE}/main ${sync.ahead} 个未 push 的 commit，reset --hard 会丢弃它们（仅 reflog 可恢复）`)
    console.log('  领先 = 疑似发布在途（阶段 4 bump / 阶段 5 notes 已 commit 未 push）或未知本地改动。处置:')
    console.log(`    1. 在途发布: 先完成后续阶段（push: git -C ${MAIN_WT} push ${GH_REMOTE} main），再重跑本脚本`)
    console.log(`    2. 确认丢弃: git -C ${MAIN_WT} reset --hard ${GH_REMOTE}/main（丢弃后重跑，幂等）`)
  } else if (sync.hint !== undefined) {
    fail(`Error: main 同步在 ${sync.step} 步失败`)
    console.log(`  手动恢复后重跑本脚本（幂等，已合并的 PR 会跳过合并步骤）: ${sync.hint}`)
  } else {
    fail(`Error: main 同步在 ${sync.step} 步失败——手动检查: git -C ${MAIN_WT} status`)
  }
  process.exit(1)
}
console.log(`${GREEN}✅ 本地 main 已同步到 ${GH_REMOTE}/main（HEAD ${sync.mainSha.slice(0, 8)}）${NC}`)

// 依赖一致性：合入可能前进 main 的 lockfile（集成分支带新依赖/版本 bump），
// node_modules 已存在时 pre-merge-check 的缺失性安装不会触发——此处按 lockfile 补装。
// 一致时为快速 no-op（几秒）；不一致且漏装时 pi 实装版本滞留旧版，会被 pi-semantics
// 守卫拦截（v0.10.14 发布轮实例：合入后 node_modules 停留旧 pi）。
console.log('')
console.log('  同步 main 依赖（lockfile 变化时补装，一致时快速跳过）...')
const installRes = run(
  'pnpm',
  ['install', '--frozen-lockfile'],
  {
    cwd: MAIN_WT,
    stdio: 'ignore',
    env: { ...process.env, CI: 'true', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
  },
)
if (!installRes.ok) {
  fail('Error: main worktree 依赖安装失败')
  console.log(`  手动执行: cd ${MAIN_WT} && CI=true ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile`)
  console.log('  恢复后重跑本脚本（幂等，已合并的 PR 会跳过合并步骤）')
  process.exit(1)
}
console.log(`${GREEN}✅ main 依赖与 lockfile 一致${NC}`)

// ── 状态落盘（供后续阶段消费：wait-for-ci 无参时校验 stage=merged 后读 mergeSha）──
// reset 开启：清掉上一轮 release 的 tag/releasedAt 等字段（跨轮残留会让读者无法分辨
// 管线归属）；pipelineId 若阶段 0（init）已写入则延续，否则此处生成
const prevState = readMergeState(WS_ROOT)
const written = writeMergeState(WS_ROOT, {
  pipelineId: prevState?.pipelineId ?? `${Date.now()}-${process.pid}`,
  branch: HEAD_BRANCH || prevState?.branch || '',
  pr: Number(PR_NUMBER),
  headSha: HEAD_SHA || prevState?.headSha || '',
  mergeSha: sync.mainSha,
  stage: 'merged',
  mergedAt: new Date().toISOString(),
}, { reset: true })
if (written === null) {
  console.log(`  ${YELLOW}Warning: merge 状态写入失败（不影响本阶段；后续阶段需手传 commit sha）${NC}`)
}

process.exit(0)
