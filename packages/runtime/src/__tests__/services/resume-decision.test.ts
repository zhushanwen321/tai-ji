/**
 * resume-decision 单元测试（交付单元 u4，设计 D4②）。
 *
 * 锁定判定三条件（manual + 非 runtime 发起 + compaction_start 前 turn 被掐断）与两条投递口径
 * （经内核 FIFO / 队列里已有用户消息时跳过）的**全部组合路径**，以及孤儿 compaction-end 容错。
 * deps 全部 fake（无 fs / 无 pi / 无内核）：本模块是纯判定逻辑，投递出口以 spy 断言调用形态
 * （用户可见面 = 唯一经内核 FIFO 的续跑投递文本）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/services/resume-decision.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createResumeDecision,
  RESUME_DELIVERY_TEXT,
  type ObservedEvent,
  type ResumeDecisionDeps,
} from '../../services/session/resume-decision.js'

/** 事件构造器（只含判定读取的字段，与翻译层结构子集同形）。 */
const turnEnd = (stopReason?: string): ObservedEvent => ({ kind: 'turn-end', stopReason })
const compactionStart = (reason = 'manual'): ObservedEvent => ({ kind: 'compaction-start', reason })
const compactionEnd = (reason = 'manual'): ObservedEvent => ({ kind: 'compaction-end', reason })

interface Harness {
  deps: ResumeDecisionDeps
  decision: ReturnType<typeof createResumeDecision>
  submits: Array<{ sessionId: string; content: string }>
  logs: string[]
  /** 内核活跃条目（可变，测「队列里已有用户消息」跳过路径）。 */
  entries: Array<{ state: 'queued' | 'in-flight' | 'delivered' | 'failed' | 'cancelled' }>
}

function makeHarness(): Harness {
  const submits: Array<{ sessionId: string; content: string }> = []
  const logs: string[] = []
  const entries: Harness['entries'] = []
  const deps: ResumeDecisionDeps = {
    listDeliveryEntries: vi.fn(() => entries),
    submitResumeDelivery: vi.fn((sessionId: string, content: string) => {
      submits.push({ sessionId, content })
    }),
    log: (message: string) => logs.push(message),
  }
  return { deps, decision: createResumeDecision(deps), submits, logs, entries }
}

const SID = 'session-1'

/** 完整事件批：观察 + 收口（组合根接线形态）。 */
function runBatch(h: Harness, events: ObservedEvent[], sessionId = SID): void {
  h.decision.observe(sessionId, events)
  h.decision.settle(sessionId)
}

describe('resume-decision：D4② 三条件判定', () => {
  it('工具压缩掐断活跃 turn（aborted turn-end + manual + 非 runtime 发起）→ 经内核提交续跑投递', () => {
    const h = makeHarness()
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toEqual([{ sessionId: SID, content: RESUME_DELIVERY_TEXT }])
  })

  it('自动压缩（threshold / overflow）不触发——auto 路径不掐 turn（F6/F14）', () => {
    const h = makeHarness()
    runBatch(h, [turnEnd('aborted'), compactionStart('threshold'), compactionEnd('threshold')])
    runBatch(h, [turnEnd('aborted'), compactionStart('overflow'), compactionEnd('overflow')])
    expect(h.submits).toHaveLength(0)
  })

  it('compaction 前无掐断 turn（前一个 turn 正常结束）→ 不投递', () => {
    const h = makeHarness()
    runBatch(h, [turnEnd('end_turn'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('no cut turn'))).toBe(true)
  })

  it('runtime 发起（beginRuntimeCompact 在途）→ 跳过（用户显式 /compact 不要续跑）', () => {
    const h = makeHarness()
    const release = h.decision.beginRuntimeCompact(SID)
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('runtime-initiated'))).toBe(true)
    release()
  })

  it('runtime compact 标记消费不跨压缩：一次 RPC = 一次跳过；后续工具压缩照常触发', () => {
    const h = makeHarness()
    const release = h.decision.beginRuntimeCompact(SID)
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    release() // RPC 结束（compaction_end 之后）
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(1)
  })

  it('用户 abort 后 runtime /compact（先掐断后压缩）→ 仍跳过（条件② 覆盖条件③ 的模糊性）', () => {
    const h = makeHarness()
    runBatch(h, [turnEnd('aborted')]) // 用户停止生成（无压缩）
    const release = h.decision.beginRuntimeCompact(SID)
    runBatch(h, [compactionStart('manual'), compactionEnd('manual')])
    release()
    expect(h.submits).toHaveLength(0)
  })

  it('压缩失败（failed 形态同为 compaction-end{manual}）→ 照常触发：turn 已被掐断与成败无关', () => {
    const h = makeHarness()
    // 失败/aborted 不影响判定输入——事件面只读 reason（errorMessage 不进本模块观察面）
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(1)
  })

  it('孤儿 compaction-end（无前置 start，overflow 早退形态）→ 不判定', () => {
    const h = makeHarness()
    runBatch(h, [turnEnd('aborted'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(0)
  })

  it('掐断事实由新 turn-end 刷新：正常 turn 收尾后再压缩 → 不投递', () => {
    const h = makeHarness()
    runBatch(h, [turnEnd('aborted')])
    runBatch(h, [turnEnd('end_turn')]) // 后续正常 turn 收尾
    runBatch(h, [compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(0)
  })
})

describe('resume-decision：D4② 投递口径', () => {
  it('内核队列已有用户消息（queued / in-flight）→ 跳过（它们自然起 run，通知随 nextTurn 附着）', () => {
    const h = makeHarness()
    h.entries.push({ state: 'queued' })
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(0)
    expect(h.logs.some((l) => l.includes('pending user message'))).toBe(true)

    const h2 = makeHarness()
    h2.entries.push({ state: 'in-flight' })
    runBatch(h2, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h2.submits).toHaveLength(0)
  })

  it('failed 条目不计数（不会起 run，等用户处置）→ 照常投递', () => {
    const h = makeHarness()
    h.entries.push({ state: 'failed' })
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(1)
  })

  it('pendingResume 一次性消费：重复 settle 不重复投递', () => {
    const h = makeHarness()
    h.decision.observe(SID, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    h.decision.settle(SID)
    h.decision.settle(SID)
    expect(h.submits).toHaveLength(1)
  })

  it('空事件批为 no-op（不建 session 态、不投递）', () => {
    const h = makeHarness()
    h.decision.observe(SID, [])
    h.decision.settle(SID)
    expect(h.submits).toHaveLength(0)
  })

  it('同批多事件按到达序 fold（compaction-start 快照读的是更早 turn-end 的事实）', () => {
    const h = makeHarness()
    // 批内序：turn-end(aborted) 在 compaction-start 之前 → 快照命中
    runBatch(h, [turnEnd('aborted'), compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(1)
    // 反向批内序（同批内 compaction-start 先到）→ 快照读不到掐断事实（保守不投递）
    const h2 = makeHarness()
    runBatch(h2, [compactionStart('manual'), turnEnd('aborted'), compactionEnd('manual')])
    expect(h2.submits).toHaveLength(0)
  })

  it('dispose 清理 session 态（销毁后不再投递）', () => {
    const h = makeHarness()
    h.decision.observe(SID, [turnEnd('aborted')])
    h.decision.dispose(SID)
    runBatch(h, [compactionStart('manual'), compactionEnd('manual')])
    expect(h.submits).toHaveLength(0)
  })

  it('session 隔离：A 的掐断事实不触发 B 的投递', () => {
    const h = makeHarness()
    h.decision.observe('session-A', [turnEnd('aborted')])
    runBatch(h, [compactionStart('manual'), compactionEnd('manual')], 'session-B')
    expect(h.submits).toHaveLength(0)
  })
})
