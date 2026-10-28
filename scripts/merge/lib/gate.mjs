/**
 * CI 门禁判定与等待（merge 管线的唯一裁判实现）。
 *
 * 判定唯一数据源 = workflow runs（gh run list --commit <sha>，按 commit 一手拉取）；
 * 语义 = 「有 runs 必等全部完成才裁决」。check-rollup 轨已删除（双轨归一）：
 * rollup 是平台聚合的二手视图，注册时机不受本仓控制——PR #45 的「部分结论未出」
 * 穿透形态与 v0.11.16 的半注册窗口形态（CI check runs 尚未注册进 rollup、只含
 * 已结论的第三方机器人检查被判全绿、16 秒即合并）都源于在窗口上打形状补丁；
 * 「等全部完成才裁决」不依赖任何窗口形状，两类形态结构性不可表达。
 *
 * fail = completed 且 conclusion ∉ {success, skipped}；pending = status 未
 * completed——GitHub 对未完成 run 的 conclusion 返回 null，显式 null 比对。
 *
 * fetchers 与 sleep 全部注入：等待编排可用假时钟 + 假数据序列做回归测试
 * （scripts/__tests__/merge-gate.test.mjs 固化全部历史事故形态）。
 */

/** conclusion 归一化：gh 对 run list 返回小写（success/failure）——统一转小写比对，
 *  保持大小写不敏感语义（历史 rollup 轨曾返回大写，归一化口径沿用）。 */
function norm(conclusion) {
  return conclusion == null ? null : String(conclusion).toLowerCase()
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const defaultLog = () => {}

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
 * fetchRuns 契约（三态，两类空结果绝不容许混淆）：返回 runs 数组 = 查询成功
 * （空数组 = 查询成功且该 commit 无 run）；返回 null / 抛错 / 返回非数组 =
 * 查询失败（gh 网络/限流/登录态/输出畸形）。no-runs 在 wait-for-ci 侧是
 * exit 0 放行语义，查询失败被归一成「无 runs」会让首窗持续失败的 gh 查询
 * 在 30s 宽限耗尽后静默跳过 main push CI 验证——失败必须分流到 fetch-error。
 *
 * 时序与移植前一致：15s 轮询；「查询成功且空」给 30s 触发宽限（查询失败轮次
 * 不消耗宽限），超宽限返回 { status: 'no-runs' }——语义由调用方定：
 * wait-for-ci（main）按「该 commit 未触发 CI 属预期」exit 0 放行；pr-merge
 * （PR 合并判定）exit 1 人工确认（paths-ignore 的纯文档 PR 走此分支，不自动
 * 放行合并）。查询失败持续到 deadline 返回 { status: 'fetch-error' }（工具
 * 错误，调用方按不可判定处理，绝不放行）。超时返回 { status: 'timeout' }。
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
  // 「查询成功且空」的累计时长：no-runs 宽限只由这类轮次消耗，查询失败轮次
  // 不消耗——否则 gh 抖动 30s 后首次查到空会被立刻判成「CI 未触发」放行
  let emptyQueryElapsedMs = 0
  let announcedRuns = false
  for (;;) {
    let runs
    try {
      runs = await fetchRuns()
    } catch {
      runs = null
    }
    if (!Array.isArray(runs)) {
      // 查询失败（null/非数组/抛错归一）：不是「CI 未触发」，不推进 no-runs 宽限，
      // 持续轮询到 deadline 返回 fetch-error——绝不走 no-runs 的 exit 0 放行路径
      log(`⚠️ runs 查询失败（gh 网络/限流/输出畸形），继续重试... (${String(Math.round(elapsedMs / 1000))}s/${String(Math.round(deadlineMs / 1000))}s)`)
      if (elapsedMs >= deadlineMs) return { status: 'fetch-error' }
      await sleep(pollMs)
      elapsedMs += pollMs
      continue
    }
    if (runs.length === 0) {
      // 曾检测到 runs 之后出现的空结果 = 查询抖动，不是「CI 未触发」——继续轮询到
      // deadline，绝不回退成 no-runs（该分支在 wait-for-ci 侧是 exit 0 放行语义，
      // 一次 gh 抖动误放行 = 跳过 CI 验证）
      if (announcedRuns) {
        log(`⏳ runs 查询返回空（疑似抖动），继续等待... (${String(Math.round(elapsedMs / 1000))}s/${String(Math.round(deadlineMs / 1000))}s)`)
        if (elapsedMs >= deadlineMs) return { status: 'timeout' }
        await sleep(pollMs)
        elapsedMs += pollMs
        continue
      }
      if (emptyQueryElapsedMs < notTriggeredGraceMs) {
        log(`⏳ CI 尚未触发，宽限等待中... (${String(Math.round(emptyQueryElapsedMs / 1000))}s/${String(Math.round(notTriggeredGraceMs / 1000))}s，超限判 no-runs)`)
        await sleep(pollMs)
        elapsedMs += pollMs
        emptyQueryElapsedMs += pollMs
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
