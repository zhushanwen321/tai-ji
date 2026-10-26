/**
 * merge 管线门禁判定回归（scripts/merge/lib/gate.mjs）。
 *
 * 判定唯一数据源 = workflow runs（「有 runs 必等全部完成才裁决」）——check-rollup
 * 轨已删除（双轨归一）。用例形态全部来自历史事故/边界：PR #45 的 rollup「部分结论
 * 未出」穿透与 v0.11.16 的半注册窗口误判（两形态均由 runs 轨语义结构性覆盖）。
 * 等待编排用注入的假 fetcher + 假时钟（sleep 计数）驱动，不触网。
 */
import { describe, it, expect } from 'vitest'
import { judgeRuns, waitForRuns, filterDependabot } from '../merge/lib/gate.mjs'

/** 假时钟 + 可编排的假 fetcher：seq 依次返回，耗尽后重复末项。 */
function fakeWorld(seq) {
  let cursor = 0
  let sleeps = 0
  const fetcher = async () => {
    const item = seq[Math.min(cursor, seq.length - 1)]
    cursor += 1
    return item
  }
  const sleep = async () => {
    sleeps += 1
  }
  return { fetcher, sleep, get sleeps() { return sleeps } }
}

describe('judgeRuns（runs 判定）', () => {
  const runItem = (status, conclusion, workflowName = 'CI', databaseId = 1) => ({ status, conclusion, workflowName, name: `${workflowName} job`, databaseId })

  it('success + skipped 计为通过；未完成计为 pending', () => {
    const v = judgeRuns([runItem('completed', 'success'), runItem('completed', 'skipped'), runItem('in_progress', null)])
    expect(v).toMatchObject({ total: 3, completed: 2, pending: 1, passed: 2 })
    expect(v.failing).toHaveLength(0)
  })

  it('completed 且非 success/skipped → 失败项（含 run id 供查看日志）', () => {
    const v = judgeRuns([runItem('completed', 'failure', 'Release', 42)])
    expect(v.failing).toEqual([{ name: 'Release', conclusion: 'failure', databaseId: 42 }])
  })

  it('conclusion 大写形态（历史 rollup 轨实测）归一化后判定正确', () => {
    const v = judgeRuns([runItem('completed', 'FAILURE', 'CI', 7)])
    expect(v.failing).toHaveLength(1)
    expect(judgeRuns([runItem('completed', 'SUCCESS'), runItem('completed', 'SKIPPED')]).failing).toHaveLength(0)
  })

  it('workflowName 缺失时回退 name 字段', () => {
    const v = judgeRuns([{ status: 'completed', conclusion: 'failure', name: 'fallback-name', databaseId: 7 }])
    expect(v.failing[0].name).toBe('fallback-name')
  })

  it('filterDependabot 剔除 Dependabot Updates（机器人红不阻塞发布）', () => {
    const runs = [runItem('completed', 'failure', 'Dependabot Updates', 1), runItem('completed', 'success', 'CI', 2)]
    expect(filterDependabot(runs)).toHaveLength(1)
    expect(filterDependabot(runs)[0].workflowName).toBe('CI')
  })
})

describe('waitForRuns（等待编排——PR 合并判定与 wait-for-ci 共用）', () => {
  const runItem = (status, conclusion, workflowName = 'CI', databaseId = 1) => ({ status, conclusion, workflowName, name: `${workflowName} job`, databaseId })

  it('runs 全部完成且无失败 → pass', async () => {
    const w = fakeWorld([[runItem('completed', 'success')]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('pass')
  })

  it('【v0.11.16 半注册窗口回归】run 已创建但在跑 → 等待到全部完成才裁决，绝不因「已存在的都绿」判过', async () => {
    // 旧 rollup 轨事故形态：判定起于 CI 刚触发、检查项未注册 + 只含已结论的机器人
    // 检查 → 16 秒即判「全绿」合并。runs 轨下同一时刻 = run in_progress → pending。
    const w = fakeWorld([
      [runItem('in_progress', null)],
      [runItem('in_progress', null)],
      [runItem('completed', 'success')],
    ])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('pass')
    expect(w.sleeps).toBe(2)
  })

  it('【PR #45 同族回归】多个 run：一个完成一个在跑 → 仍 pending，全部出齐且无失败才 pass', async () => {
    const w = fakeWorld([
      [runItem('completed', 'success'), runItem('queued', null, 'CI', 2)],
      [runItem('completed', 'success'), runItem('completed', 'success', 'CI', 2)],
    ])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('pass')
    expect(w.sleeps).toBe(1)
  })

  it('存在失败 run → fail（附失败清单与 databaseId）', async () => {
    const w = fakeWorld([[runItem('completed', 'success'), runItem('completed', 'timed_out', 'E2E', 9)]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('fail')
    expect(v.failing[0]).toMatchObject({ name: 'E2E', conclusion: 'timed_out' })
  })

  it('等待中途完成且失败 → fail', async () => {
    const w = fakeWorld([
      [runItem('in_progress', null)],
      [runItem('completed', 'failure', 'CI', 3)],
    ])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('fail')
    expect(v.failing[0].databaseId).toBe(3)
  })

  it('【审查修复回归】已检测到 runs 后查询抖动（空结果）→ 继续轮询不回退 no-runs；恢复后正常裁决', async () => {
    // 审查发现 1：旧实现把「gh 失败/解析失败归一的空」当「CI 未触发」，宽限耗尽后判
    // no-runs——wait-for-ci 侧是 exit 0 放行语义，一次抖动即跳过 CI 验证
    const seq = [
      [runItem('in_progress', null)],
      [],                                  // 抖动：曾检测到 runs 后的空结果
      [runItem('in_progress', null)],
      [runItem('completed', 'success')],
    ]
    let cursor = 0
    const fetcher = async () => { const v = seq[Math.min(cursor, seq.length - 1)]; cursor += 1; return v }
    const v = await waitForRuns({ fetchRuns: fetcher, sleep: async () => {}, pollMs: 15_000, notTriggeredGraceMs: 30_000 })
    expect(v.status).toBe('pass')
  })

  it('【审查修复回归】已检测到 runs 后持续空结果 → timeout（绝不 no-runs 放行）', async () => {
    const w = fakeWorld([[runItem('in_progress', null)], []])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep, deadlineMs: 60_000, pollMs: 15_000, notTriggeredGraceMs: 30_000 })
    expect(v.status).toBe('timeout')
  })

  it('30s 触发宽限内无 run → 继续等；宽限耗尽仍无 → no-runs（PR 侧 exit 1 人工确认 / main 侧 exit 0 放行，由调用方定）', async () => {
    const w = fakeWorld([[]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep, pollMs: 15_000, notTriggeredGraceMs: 30_000 })
    expect(v.status).toBe('no-runs')
    expect(w.sleeps).toBe(2) // 0s、15s 两轮空查后 30s 达宽限上限
  })

  it('宽限内 run 出现 → 进入正常等待', async () => {
    let polls = 0
    const fetcher = async () => {
      polls += 1
      return polls <= 1 ? [] : [runItem('completed', 'success')]
    }
    const v = await waitForRuns({ fetchRuns: fetcher, sleep: async () => {}, pollMs: 15_000, notTriggeredGraceMs: 30_000 })
    expect(v.status).toBe('pass')
    expect(polls).toBe(2)
  })

  it('有 run 但持续未完成到 deadline → timeout（wait-for-ci 的 exit 2 语义来源）', async () => {
    const w = fakeWorld([[runItem('queued', null)]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep, deadlineMs: 60_000, pollMs: 15_000 })
    expect(v.status).toBe('timeout')
    expect(v.pending).toBe(1)
  })

  it('fetchRuns 抛错/返回非数组 → 按 no-runs 宽限路径处理（对应原 `|| echo "[]"`）', async () => {
    const w = { sleep: async () => {} }
    const v = await waitForRuns({ fetchRuns: async () => undefined, sleep: w.sleep, pollMs: 0, notTriggeredGraceMs: 0 })
    expect(v.status).toBe('no-runs')
  })
})
