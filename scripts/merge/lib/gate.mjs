/**
 * CI 门禁判定与等待（merge 管线的唯一裁判实现）。
 *
 * 判定口径（与移植前 bash 语义一致，穿透缺陷已结构性修复）：
 * - fail   = conclusion ∈ {failure, timed_out, cancelled}（立即失败，先于等待判定）
 * - pending = conclusion == null——GitHub 对未完成检查返回 null 而非 "pending" 字符串，
 *   原实现把 conclusions 数组 join 成字符串再 grep 词表，null 被 join 成空串：
 *   「部分完成部分未出」形态（如 ",SUCCESS"）非空、不含词表词、也无 failure，
 *   三道防线全部漏过直接放行合并（PR #45 事故）。JSON 解析 + 显式 null 比较后
 *   该缺陷形态无法表达。
 * - pass   = 其余非 null 结论（success / skipped / neutral 均放行，与原语义一致）
 *
 * fetchers 与 sleep 全部注入：等待编排可用假时钟 + 假数据序列做回归测试
 * （scripts/__tests__/merge-gate.test.mjs 固化全部历史事故形态）。
 */

/** conclusion 归一化：gh 对 statusCheckRollup 返回大写（SUCCESS/FAILURE，PR #45 实测）、
 *  对 run list 返回小写（success/failure）——统一转小写比对，与原 bash grep -qi 的
 *  大小写不敏感语义一致。 */
function norm(conclusion) {
  return conclusion == null ? null : String(conclusion).toLowerCase()
}

/** PR checks 判定（数据源 = gh pr view --json statusCheckRollup）。 */
export function judgeRollup(rollup) {
  const checks = Array.isArray(rollup) ? rollup : []
  if (checks.length === 0) return { status: 'no-checks', failing: [], total: 0 }
  const failing = checks
    .filter((c) => {
      const v = norm(c.conclusion)
      return v === 'failure' || v === 'timed_out' || v === 'cancelled'
    })
    .map((c) => ({ name: c.name ?? '(unnamed)', conclusion: c.conclusion }))
  if (failing.length > 0) return { status: 'fail', failing, total: checks.length }
  if (checks.some((c) => c.conclusion == null)) {
    return { status: 'pending', failing: [], total: checks.length }
  }
  return { status: 'pass', failing: [], total: checks.length }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaultLog = () => {}

/**
 * 等待 PR checks 到达终态。
 *
 * 时序与移植前一致：空 rollup 先重查 4 次（15s 间隔，共 60s）；有 checks 后
 * 失败立即返回；pending 按轮询间隔等到 deadline；超时返回 { status: 'timeout' }。
 */
export async function waitForPrChecks(opts) {
  const {
    fetchRollup,
    deadlineMs = 600_000,
    pollMs = 30_000,
    emptyRetries = 4,
    emptyPollMs = 15_000,
    sleep = defaultSleep,
    log = defaultLog,
  } = opts

  let verdict = judgeRollup(await fetchRollup())
  if (verdict.status === 'no-checks') {
    let retries = 0
    while (verdict.status === 'no-checks' && retries < emptyRetries) {
      retries += 1
      await sleep(emptyPollMs)
      verdict = judgeRollup(await fetchRollup())
      log(`⏳ checks 重查 ${retries}/${emptyRetries}...`)
    }
    if (verdict.status === 'no-checks') return verdict
  }

  let elapsedMs = 0
  let announcedWait = false
  for (;;) {
    if (verdict.status === 'fail' || verdict.status === 'pass') return verdict
    // verdict.status === 'pending'
    if (!announcedWait) {
      log(`⏳ PR CI 仍在运行，等待最多 ${String(Math.round(deadlineMs / 1000))}s...`)
      announcedWait = true
    }
    if (elapsedMs >= deadlineMs) return { status: 'timeout', failing: [], total: verdict.total }
    await sleep(pollMs)
    elapsedMs += pollMs
    verdict = judgeRollup(await fetchRollup())
    log(`⏳ 等待中... (${String(Math.round(elapsedMs / 1000))}s/${String(Math.round(deadlineMs / 1000))}s)`)
  }
}

/** 过滤平台侧依赖机器人（计入判定会让发布恒被与代码无关的机器人红阻塞）。 */
export function filterDependabot(runs) {
  return (runs ?? []).filter((r) => r.workflowName !== 'Dependabot Updates')
}

/** workflow runs 判定（数据源 = gh run list --commit <sha>；conclusion 同样归一化比对）。 */
export function judgeRuns(runs) {
  const list = Array.isArray(runs) ? runs : []
  const completed = list.filter((r) => r.status === 'completed')
  const failing = completed
    .filter((r) => {
      const v = norm(r.conclusion)
      return v !== 'success' && v !== 'skipped'
    })
    .map((r) => ({ name: r.workflowName ?? r.name ?? '(unnamed)', conclusion: r.conclusion, databaseId: r.databaseId }))
  return {
    total: list.length,
    completed: completed.length,
    pending: list.length - completed.length,
    passed: completed.length - failing.length,
    failing,
  }
}

/**
 * 等待 commit 上的 workflow runs 全部完成。
 *
 * 时序与移植前一致：15s 轮询；runs 为空给 30s 触发宽限，超宽限返回
 * { status: 'no-runs' }（调用方打印指引后 exit 0 放行——30s 无 run 视为该
 * commit 未触发 CI，属预期形态而非 CI 通过）；超时返回 { status: 'timeout' }。
 */
export async function waitForRuns(opts) {
  const {
    fetchRuns,
    deadlineMs = 600_000,
    pollMs = 15_000,
    notTriggeredGraceMs = 30_000,
    sleep = defaultSleep,
    log = defaultLog,
  } = opts

  let elapsedMs = 0
  let announcedRuns = false
  for (;;) {
    const runs = await fetchRuns()
    if (!Array.isArray(runs) || runs.length === 0) {
      if (elapsedMs < notTriggeredGraceMs) {
        log(`⏳ CI 尚未触发，等待中... (${String(Math.round(elapsedMs / 1000))}s/${String(Math.round(deadlineMs / 1000))}s)`)
        await sleep(pollMs)
        elapsedMs += pollMs
        continue
      }
      return { status: 'no-runs' }
    }
    if (!announcedRuns) {
      log(`📋 检测到 ${String(runs.length)} 个 workflow run(s)`)
      announcedRuns = true
    }
    const v = judgeRuns(runs)
    log(
      `📊 Runs: ${String(v.total)} total, ${String(v.passed)} passed, ${String(v.failing.length)} failed, `
      + `${String(v.pending)} pending (${String(Math.round(elapsedMs / 1000))}s/${String(Math.round(deadlineMs / 1000))}s)`,
    )
    if (v.pending === 0) {
      return v.failing.length > 0 ? { status: 'fail', ...v } : { status: 'pass', ...v }
    }
    if (elapsedMs >= deadlineMs) return { status: 'timeout', ...v }
    await sleep(pollMs)
    elapsedMs += pollMs
  }
}
