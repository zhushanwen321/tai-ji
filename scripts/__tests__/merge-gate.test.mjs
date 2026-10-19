/**
 * merge 管线门禁判定回归（scripts/merge/lib/gate.mjs）。
 *
 * 用例形态全部来自历史事故/边界：PR #45 的「部分结论未出」穿透形态是本组测试的
 * 首要回归目标。等待编排用注入的假 fetcher + 假时钟（sleep 计数）驱动，不触网。
 */
import { describe, it, expect } from 'vitest'
import { judgeRollup, waitForPrChecks, judgeRuns, waitForRuns, filterDependabot } from '../merge/lib/gate.mjs'

let checkSeq = 0
const check = (conclusion, name = `check-${String(checkSeq++)}`) => ({ name, conclusion })

describe('judgeRollup（PR checks 判定）', () => {
  it('全部 success → pass', () => {
    expect(judgeRollup([check('success'), check('success')]).status).toBe('pass')
  })

  it('skipped / neutral 视为通过（与移植前语义一致：fail 词表外即放行）', () => {
    expect(judgeRollup([check('success'), check('skipped'), check('neutral')]).status).toBe('pass')
  })

  it('failure → fail 且列出名称与结论', () => {
    const v = judgeRollup([check('success', 'lint'), check('failure', 'ci (ubuntu)')])
    expect(v.status).toBe('fail')
    expect(v.failing).toEqual([{ name: 'ci (ubuntu)', conclusion: 'failure' }])
  })

  it('timed_out / cancelled 同属失败词表', () => {
    expect(judgeRollup([check('timed_out')]).status).toBe('fail')
    expect(judgeRollup([check('cancelled')]).status).toBe('fail')
  })

  it('全部 conclusion 为 null（checks 注册但都未完成）→ pending', () => {
    expect(judgeRollup([check(null), check(null)]).status).toBe('pending')
  })

  it('【PR #45 回归】部分完成 + 部分 null（原实现 join 成 ",SUCCESS" 穿透放行）→ pending，绝不 pass', () => {
    const v = judgeRollup([check('success'), check(null), check('success')])
    expect(v.status).toBe('pending')
    expect(v.status).not.toBe('pass')
  })

  it('conclusion 为 undefined（字段缺失）同样按 pending 处理', () => {
    expect(judgeRollup([check(undefined)]).status).toBe('pending')
  })

  it('【实测形态】gh statusCheckRollup 返回大写 conclusion（PR #45 实测 SUCCESS/FAILURE/SKIPPED）——归一化后判定正确', () => {
    expect(judgeRollup([check('SUCCESS'), check('SKIPPED')]).status).toBe('pass')
    const v = judgeRollup([check('SUCCESS'), check('FAILURE', 'ci (ubuntu)'), check('SUCCESS')])
    expect(v.status).toBe('fail')
    expect(v.failing).toEqual([{ name: 'ci (ubuntu)', conclusion: 'FAILURE' }])
  })

  it('失败与未完成并存 → 立即 fail（失败判定先于等待判定）', () => {
    expect(judgeRollup([check(null), check('failure')]).status).toBe('fail')
  })

  it('空数组 / null / 非数组 → no-checks（触发空守卫路径）', () => {
    expect(judgeRollup([]).status).toBe('no-checks')
    expect(judgeRollup(null).status).toBe('no-checks')
    expect(judgeRollup(undefined).status).toBe('no-checks')
  })
})

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

describe('waitForPrChecks（等待编排）', () => {
  it('初次即 pass → 直接通过，零等待', async () => {
    const w = fakeWorld([[check('success')]])
    const v = await waitForPrChecks({ fetchRollup: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('pass')
    expect(w.sleeps).toBe(0)
  })

  it('【PR #45 形态】部分未出 → 轮询等到全部出齐且无失败 → pass', async () => {
    const w = fakeWorld([
      [check('success'), check(null)],
      [check('success'), check(null)],
      [check('success'), check('success')],
    ])
    const v = await waitForPrChecks({ fetchRollup: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('pass')
    expect(w.sleeps).toBe(2)
  })

  it('等待中途出现失败 → fail', async () => {
    const w = fakeWorld([
      [check(null)],
      [check('failure', 'build')],
    ])
    const v = await waitForPrChecks({ fetchRollup: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('fail')
    expect(v.failing[0].name).toBe('build')
  })

  it('持续 pending 到 deadline → timeout', async () => {
    const w = fakeWorld([[check(null)]])
    const v = await waitForPrChecks({ fetchRollup: w.fetcher, sleep: w.sleep, deadlineMs: 60_000, pollMs: 30_000 })
    expect(v.status).toBe('timeout')
    expect(w.sleeps).toBe(2) // 0s 与 30s 两轮后 60s ≥ deadline
  })

  it('空 rollup 先重查 4 次；期间 checks 注册 → 继续正常判定', async () => {
    let polls = 0
    const fetcher = async () => {
      polls += 1
      return polls <= 2 ? [] : [check('success')]
    }
    const w = { sleep: async () => {}, get sleeps() { return 0 } }
    const v = await waitForPrChecks({ fetchRollup: fetcher, sleep: w.sleep, emptyPollMs: 0 })
    expect(v.status).toBe('pass')
    expect(polls).toBe(3) // 初次空 + 重查 1 次空 + 重查 2 次有
  })

  it('空 rollup 重查 4 次仍空 → no-checks（不误判为通过）', async () => {
    const w = fakeWorld([[]])
    const v = await waitForPrChecks({ fetchRollup: w.fetcher, sleep: w.sleep, emptyPollMs: 0 })
    expect(v.status).toBe('no-checks')
  })
})

describe('judgeRuns / waitForRuns（commit 维度 runs 判定）', () => {
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

  it('workflowName 缺失时回退 name 字段', () => {
    const v = judgeRuns([{ status: 'completed', conclusion: 'failure', name: 'fallback-name', databaseId: 7 }])
    expect(v.failing[0].name).toBe('fallback-name')
  })

  it('filterDependabot 剔除 Dependabot Updates（机器人红不阻塞发布）', () => {
    const runs = [runItem('completed', 'failure', 'Dependabot Updates', 1), runItem('completed', 'success', 'CI', 2)]
    expect(filterDependabot(runs)).toHaveLength(1)
    expect(filterDependabot(runs)[0].workflowName).toBe('CI')
  })

  it('runs 全部完成且无失败 → pass', async () => {
    const w = fakeWorld([[runItem('completed', 'success')]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('pass')
  })

  it('存在失败 run → fail（附失败清单）', async () => {
    const w = fakeWorld([[runItem('completed', 'success'), runItem('completed', 'timed_out', 'E2E', 9)]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep })
    expect(v.status).toBe('fail')
    expect(v.failing[0]).toMatchObject({ name: 'E2E', conclusion: 'timed_out' })
  })

  it('30s 触发宽限内无 run → 继续等；宽限耗尽仍无 → no-runs（放行形态，由调用方打印指引）', async () => {
    const w = fakeWorld([[]])
    const v = await waitForRuns({ fetchRuns: w.fetcher, sleep: w.sleep, pollMs: 15_000, notTriggeredGraceMs: 30_000 })
    expect(v.status).toBe('no-runs')
    expect(w.sleeps).toBe(2) // 0s、15s 两轮空查后 30s 达宽限上限
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
