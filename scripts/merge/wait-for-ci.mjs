#!/usr/bin/env node
/**
 * wait-for-ci.mjs — 等待 GitHub Actions CI 完成（.agents/skills/merge/scripts/wait-for-ci.sh 的 Node 移植）
 *
 * 用法: wait-for-ci.mjs [<commit-sha>] [--timeout 2400] [--workflow <name>] [--verify-release <tag>] [--repo <owner/repo>]
 *   commit-sha 可省略：读 merge 状态文件（<workspace 根>/.merge-state/current.json）的
 *   mergeSha——且仅当 stage === 'merged' 时消费（merge commit 的 push CI 才是阶段 3 的
 *   判定对象；headSha 是 PR head，判的是阶段 2 已裁决过的 PR 侧 runs，禁止复用）。
 *   状态缺失/未到 merged 态时按 usage 错误退出（要求显式传 sha）。
 *
 * 场景 1: gh pr merge 后，push 到 main 触发 ci.yml
 * 场景 2: 推送修复后等待 CI 重新运行
 * 场景 3: CI 通过后验证 Draft Release 产物（--verify-release v1.2.3）
 *
 * 退出码：0 = CI 通过（或 30s 无 run 视为未触发 CI 放行）/ 1 = CI 失败、参数或前置检查错误、
 *         Release 验证失败 / 2 = 等待超时（timeout，AI 应询问用户）
 *
 * AI 行为约束：
 *   - 此脚本不可跳过
 *   - CI 失败时必须在 main 上修复后重新运行
 *   - 不能因为"CI 不是你触发的"就跳过
 *
 * 依赖说明（相对原 bash 版）：JSON 解析改用 Node 内建 JSON.parse，jq 依赖移除；
 * gh CLI 安装/登录前置检查保留。
 *
 * 日志钩子：环境变量 MERGE_LOG_FILE 非空时，关键节点（等待开始 / CI 失败 / CI 通过 /
 * 等待超时 / Release 验证结论）追加写入该文件，行格式 `[<YYYY-MM-DDTHH:MM:SS>] [CI] <msg>`
 * （本地时间，与 bash `date +%Y-%m-%dT%H:%M:%S` 一致）；未设置时静默跳过，写入失败
 * 不阻塞主流程（对应原 bash `|| return 0` 的静默语义）。
 */
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { run } from './lib/exec.mjs'
import { RED, GREEN, YELLOW, BOLD, NC } from './lib/output.mjs'
import { DEFAULT_REPO } from './lib/repo.mjs'
import { filterDependabot, waitForRuns } from './lib/gate.mjs'
import { findWorkspaceRoot } from './lib/workspace.mjs'
import { readMergeState } from './lib/state.mjs'

const USAGE =
  'Usage: wait-for-ci.mjs [<commit-sha>] [--timeout 2400] [--workflow <name>] [--verify-release <tag>] [--repo <owner/repo>]'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * argv 解析（纯函数，供测试导入）。
 *
 * 返回 { ok: true, sha, timeout, workflow, verifyReleaseTag, repo } 或 { ok: false, error }。
 * 与原 bash 一致：位置参数唯一，多余位置参数与未识别参数一律 Unknown option。
 * 增强点：--timeout 解析期校验为有限数字——原 bash 对非数字值会在数值比较处崩出
 * 晦涩错误，Node 侧 NaN 比较恒 false 会让超时判定永不触发（防线失效），必须前置拒绝。
 * 默认 2400s：main push CI 含 e2e-visual / e2e-behavior 两个 timeout-minutes: 30 的
 * job，600s 必超时（旧默认，已上调——超时应是异常而非常态首跑体验）。
 */
export function parseArgs(argv) {
  const out = { sha: '', timeout: 2400, workflow: '', verifyReleaseTag: '', repo: '' }
  const rest = [...argv]
  while (rest.length > 0) {
    const a = rest.shift()
    if (a === '--timeout' || a === '--workflow' || a === '--verify-release' || a === '--repo') {
      const v = rest.shift()
      if (v === undefined) return { ok: false, error: `Missing value for option: ${a}` }
      if (a === '--timeout') out.timeout = v
      else if (a === '--workflow') out.workflow = v
      else if (a === '--verify-release') out.verifyReleaseTag = v
      else out.repo = v
    } else if (a.startsWith('--') || out.sha !== '') {
      return { ok: false, error: `Unknown option: ${a}` }
    } else {
      out.sha = a
    }
  }
  const timeout = Number(out.timeout)
  if (!Number.isFinite(timeout)) return { ok: false, error: `Invalid --timeout value: ${String(out.timeout)}` }
  return { ok: true, ...out, timeout }
}

/**
 * Release 产物判定（纯函数，供测试导入）。
 *
 * payload 形态 = gh release view --json tagName,isDraft,assets 的映射结果
 * { tag, draft, asset_count, assets: [name...] }；null = 轮询期内 Release 未出现。
 * 判定顺序与原 bash 一致：未出现 → tag 不匹配 → 产物数量 0 → 通过。
 */
export function verifyReleasePayload(payload, expectedTag) {
  if (payload == null) return { status: 'missing' }
  if (payload.tag !== expectedTag) return { status: 'mismatch', actualTag: String(payload.tag) }
  const count = payload.asset_count ?? 0
  if (!Number.isFinite(count) || count <= 0) return { status: 'no-assets' }
  return { status: 'ok' }
}

function localTimestamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 日志通道工厂：MERGE_LOG_FILE 未设置时为 no-op；写入失败静默（不阻塞主流程）。 */
function makeCiLog(file) {
  if (!file) return () => {}
  return (msg) => {
    try {
      appendFileSync(file, `[${localTimestamp()}] [CI] ${msg}\n`)
    } catch {
      // 日志是辅助通道，失败不拖垮主流程
    }
  }
}

/** gh release view 的 JSON 映射为 { tag, draft, asset_count, assets:[name] }；失败/未创建 → null。 */
function fetchReleasePayload(tag, repo) {
  const args = ['release', 'view', tag]
  if (repo !== '') args.push('--repo', repo)
  args.push('--json', 'tagName,isDraft,assets')
  const res = run('gh', args, { stdio: 'capture' })
  if (!res.ok) return null
  try {
    const j = JSON.parse(res.stdout)
    const assets = Array.isArray(j.assets) ? j.assets : []
    return { tag: j.tagName, draft: j.isDraft, asset_count: assets.length, assets: assets.map((a) => a?.name ?? '') }
  } catch {
    return null
  }
}

/**
 * 无参路径的判定对象裁决（纯函数，供测试导入）。
 * 只接受 stage === 'merged' 且有 mergeSha 的状态——merge commit 的 push CI 才是
 * 阶段 3 要等的对象；headSha（PR head）是阶段 2 已裁决过的 PR 侧 runs，禁止复用。
 */
export function resolveShaFromState(state) {
  if (state?.stage === 'merged' && typeof state?.mergeSha === 'string' && state.mergeSha !== '') {
    return { ok: true, sha: state.mergeSha, pr: state.pr ?? null }
  }
  return {
    ok: false,
    reason: state?.stage === 'merged'
      ? '状态已到 merged 但无 mergeSha（pr-merge 旧版写入，或写入失败）'
      : `状态 stage 为 ${state?.stage ?? '无'}（未到 merged——阶段 2 未跑或状态属上一轮管线）`,
  }
}

/** ── 定位 commit：显式 sha 优先；缺省读 merge 状态文件的 mergeSha（经 stage 门）── */
function resolveRefOrFail(parsed) {
  if (parsed.sha) return parsed.sha
  const root = findWorkspaceRoot()
  const resolved = resolveShaFromState(root === null ? null : readMergeState(root))
  if (!resolved.ok) {
    console.error(USAGE)
    console.error(`（未提供 commit-sha，且 merge 状态不可作为判定对象：${resolved.reason}）`)
    console.error('  恢复：显式传入 main 最新 commit sha 重跑——git -C <main-worktree> rev-parse HEAD')
    process.exit(1)
  }
  console.log(`  从 merge 状态读取 mergeSha=${resolved.sha}（PR #${resolved.pr ?? '?'} 的 merge commit）`)
  return resolved.sha
}

/** ── 前置检查：gh 安装/登录（原 bash 的 jq 检查随 JSON.parse 移除，见文件头）── */
function assertGhCliReady() {
  const ghProbe = run('gh', ['--version'], { stdio: 'ignore' })
  if (ghProbe.error !== null || ghProbe.code !== 0) {
    console.error('Error: gh CLI 未安装')
    process.exit(1)
  }
  const authProbe = run('gh', ['auth', 'status'], { stdio: 'ignore' })
  if (authProbe.error !== null || !authProbe.ok) {
    console.error('Error: gh CLI 未登录')
    process.exit(1)
  }
}

/** gh run list 查询闭包：gh 失败按无 runs 处理（走 30s 触发宽限路径）。 */
function makeFetchRuns({ REF, WORKFLOW, GH_REPO }) {
  return async () => {
    const args = ['run', 'list', '--commit', REF]
    if (WORKFLOW !== '') args.push('--workflow', WORKFLOW)
    if (GH_REPO !== '') args.push('--repo', GH_REPO)
    args.push('--json', 'databaseId,status,conclusion,name,workflowName')
    const res = run('gh', args, { stdio: 'capture' })
    // 对应原 bash `|| echo "[]"`：gh 失败按无 runs 处理（走 30s 触发宽限路径）
    if (!res.ok) return []
    try {
      const runs = JSON.parse(res.stdout)
      if (!Array.isArray(runs)) return []
      // [2026-10-13] 过滤 Dependabot Updates：event=dynamic 的平台侧依赖机器人任务
      // （updater 容器对个别依赖如 electron 偶发 unknown_error 失败），不是本次合并的
      // 代码验证线——计入判定会让发布恒被与代码无关的机器人红阻塞。
      // WORKFLOW 显式指定时不过滤（用户点名）。
      return WORKFLOW !== '' ? runs : filterDependabot(runs)
    } catch {
      return []
    }
  }
}

function printNoRunsDetected() {
  console.log(`  ${YELLOW}⚠️  30秒后仍未检测到 CI workflow。${NC}`)
  console.log(`  ${YELLOW}可能该 commit 没有触发 CI（如 ci.yml 只在 PR 时运行）。${NC}`)
  console.log(`  ${YELLOW}跳过 CI 等待，继续后续流程。${NC}`)
  process.exit(0)
}

function printCiFailure(verdict, ciLog) {
  console.log('')
  console.log(`${RED}${BOLD}⛔ CI 有失败的检查项！${NC}`)
  ciLog(`CI 失败: ${verdict.failing.length} failed, ${verdict.passed} passed`)
  console.log('')
  console.log('失败的 workflow runs:')
  for (const f of verdict.failing) {
    console.log(`  ❌ ${f.name}: ${f.conclusion}`)
  }
  console.log('')
  console.log('查看失败日志:')
  for (const f of verdict.failing) {
    console.log(`  gh run view ${f.databaseId} --log-failed`)
  }
  console.log('')
  const SEP = '━'.repeat(50)
  console.log(`${RED}${BOLD}${SEP}${NC}`)
  console.log(`${RED}${BOLD}AI 行为约束（不可违反）:${NC}`)
  console.log('  1. 必须查看失败日志并修复问题')
  console.log('  2. 修复后推送到 main，重新运行本脚本')
  console.log('  3. 不得跳过 CI 失败继续 publish')
  console.log('  4. 如果无法在 main 上直接修复，需要 revert 合并')
  console.log(`${RED}${BOLD}${SEP}${NC}`)
  process.exit(1)
}

function printCiTimeout(verdict, TIMEOUT, REF, ciLog) {
  console.log('')
  console.log(`${YELLOW}${BOLD}⚠️  CI 等待超时（${TIMEOUT}s）${NC}`)
  ciLog(`CI 等待超时 (${TIMEOUT}s), ${verdict.pending} pending`)
  console.log(`  仍有 ${verdict.pending} 个 workflow 在运行中`)
  console.log('')
  console.log('  建议:')
  console.log(`    1. 手动检查: gh run list --commit ${REF}`)
  console.log(`    2. 增加超时: wait-for-ci.mjs ${REF} --timeout 3600`)
  console.log('    3. 确认通过后继续后续流程')
  process.exit(2) // exit 2 = timeout, AI 应询问用户
}

/**
 * 验证 Draft Release 产物（CI 通过后的可选检查）：轮询等待 Draft Release 出现
 * （120s 超时，10s 间隔）→ missing / tag mismatch / 无产物三分支各自 fatal。
 */
async function verifyDraftRelease(VERIFY_RELEASE_TAG, GH_REPO, ciLog) {
  console.log('')
  console.log(`${BOLD}验证 Release 产物...${NC}`)
  console.log(`  Tag: ${VERIFY_RELEASE_TAG}`)

  const VERIFY_TIMEOUT = 120
  let verifyElapsed = 0
  let payload = null
  while (verifyElapsed < VERIFY_TIMEOUT) {
    payload = fetchReleasePayload(VERIFY_RELEASE_TAG, GH_REPO)
    if (payload !== null) break
    console.log(`  ⏳ Release 尚未创建，等待中... (${verifyElapsed}s/${VERIFY_TIMEOUT}s)`)
    await sleep(10_000)
    verifyElapsed += 10
  }

  const v = verifyReleasePayload(payload, VERIFY_RELEASE_TAG)
  if (v.status === 'missing') {
    console.log(`  ${RED}❌ Release ${VERIFY_RELEASE_TAG} 在 ${VERIFY_TIMEOUT}s 后仍未出现${NC}`)
    console.log('  可能原因：')
    console.log('    1. CI 的 release job 创建了错误 tag 的 release（版本号不一致）')
    console.log('    2. release job 被跳过或失败')
    console.log('    3. tag 未正确推送')
    console.log('')
    console.log('  排查命令:')
    // 原 bash 直接拼 $GH_REPO，未设 --repo 时会拼出 repos//releases 空段——移植时以
    // DEFAULT_REPO 兜底，保证排查指引可直接复制执行
    const repoForHint = GH_REPO !== '' ? GH_REPO : DEFAULT_REPO
    console.log(`    gh api repos/${repoForHint}/releases --jq '.[] | "\\(.tag_name) draft=\\(.draft) assets=\\(.assets | length)"' | head -5`)
    process.exit(1)
  }

  console.log(`  Tag: ${payload.tag}`)
  console.log(`  Draft: ${payload.draft}`)
  console.log(`  产物数量: ${payload.asset_count}`)
  console.log(`  产物: ${payload.assets.join(', ')}`)

  if (v.status === 'mismatch') {
    console.log(`  ${RED}❌ Release tag 不匹配: 期望 ${VERIFY_RELEASE_TAG}, 实际 ${v.actualTag}${NC}`)
    ciLog(`Release 验证失败: tag mismatch (${v.actualTag} != ${VERIFY_RELEASE_TAG})`)
    console.log('  根因：CI 的 apps/electron/package.json 版本号与根 package.json 不一致')
    console.log('  修复：同步版本号后重新触发 CI')
    process.exit(1)
  }

  if (v.status === 'no-assets') {
    console.log(`  ${YELLOW}⚠️  Release 无构建产物（只有 source code）${NC}`)
    ciLog('Release 验证失败: 无构建产物')
    console.log('  可能原因：build job 失败或 artifact upload 被跳过')
    console.log('  排查：gh run list --workflow Release --limit 3')
    process.exit(1)
  }

  console.log(`  ${GREEN}✅ Release 验证通过${NC}`)
  ciLog(`Release 验证通过: tag=${VERIFY_RELEASE_TAG}, assets=${payload.asset_count}`)
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exit(1)
  }
  const TIMEOUT = parsed.timeout
  const WORKFLOW = parsed.workflow
  const VERIFY_RELEASE_TAG = parsed.verifyReleaseTag
  const GH_REPO = parsed.repo
  const ciLog = makeCiLog(process.env.MERGE_LOG_FILE)

  const REF = resolveRefOrFail(parsed)

  assertGhCliReady()

  console.log(`${BOLD}等待 CI 完成...${NC}`)
  ciLog(`等待 CI: commit=${REF}, workflow=${WORKFLOW || 'all'}, timeout=${TIMEOUT}s`)
  console.log(`  Commit: ${REF}`)
  if (WORKFLOW !== '') {
    console.log(`  Workflow: ${WORKFLOW}`)
  }
  console.log(`  超时: ${TIMEOUT}s`)
  console.log('')

  const fetchRuns = makeFetchRuns({ REF, WORKFLOW, GH_REPO })

  const waitStartMs = Date.now()
  const verdict = await waitForRuns({
    fetchRuns,
    deadlineMs: TIMEOUT * 1000,
    log: (m) => console.log(`  ${m}`),
  })
  // 耗时用于 CI 通过的日志行（原 bash 为 poll 间隔累计值，此处取墙钟差，语义等价）
  const waitElapsedS = Math.round((Date.now() - waitStartMs) / 1000)

  if (verdict.status === 'no-runs') printNoRunsDetected()

  if (verdict.status === 'fail') printCiFailure(verdict, ciLog)

  if (verdict.status === 'timeout') printCiTimeout(verdict, TIMEOUT, REF, ciLog)

  // status === 'pass'
  console.log('')
  console.log(`${GREEN}${BOLD}✅ CI 全部通过！${NC} (${verdict.passed}/${verdict.total})`)
  ciLog(`CI 通过: ${verdict.passed}/${verdict.total} (耗时 ${waitElapsedS}s)`)

  // ── 验证 Draft Release 产物（CI 通过后，可选检查 Draft Release 是否创建成功）──
  if (VERIFY_RELEASE_TAG !== '') {
    await verifyDraftRelease(VERIFY_RELEASE_TAG, GH_REPO, ciLog)
  }

  process.exit(0)
}

// 直接执行（node scripts/merge/wait-for-ci.mjs ...）时进入主流程；被测试 import 纯函数时不触发
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
