/**
 * gantt-segments 分段派生纯函数测试（workflow-visualization U5——设计 §3.1-2 语义规则
 * ①-④ + §4「单测化路径」断言清单逐条 + §3.3-D9 渲染层状态派生）。
 *
 * 数据源两层：
 * - u0 采集的真实引擎样本（__tests__/fixtures/*.jsonl——rebuild 隐式代际 / resume 显式
 *   中断边界），断言帧序级口径以实装为准；
 * - 手工 fixture（内联事件帧工厂）覆盖样本不含的断言清单剩余项：retrying 变体、aborted
 *   终局、started 缺行降级、纯脚本多轮、重放空段、多轮 attempt 反推公式、运行中无锚段。
 *
 * 断言清单对照（设计 §4 单测化路径 / impl-plan u5 验收①）：
 * - call 级：隐式代际边界（两代际段并存且不相连）/ 旧代际段终点 = 该代际最后一个自有
 *   agent-* 帧 ts（重落 phase-started 不参与锚定；含旧代际末帧为 agent-retrying 变体——
 *   段终点 = retrying.ts）/ 新段起点 = 隐式边界 agent-started.ts / 中断旧代际段终点 =
 *   run-interrupted.ts / aborted 在途末段终点 = run-settled.ts / attempt 反推公式
 *   （失败终点 = retrying.ts − backoffMs、下一起点 = retrying.ts、终局终点 = settled.ts）/
 *   started 缺行降级不分段
 * - phase 级：重放空段不绘制不计轮次（判据两级化）/ 轮次计数 = 非空段段数 / 纯脚本
 *   phase 多轮段全绘制且计数 = 段数 / 重放段无 settled 帧时段终点 = 本段之后第一个
 *   phase 级或 run 级转移帧 ts / 头卡聚合区间 + 最新非空段收束态
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/gantt-segments.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  deriveWorkflowGanttSegments,
  deriveCallView,
  deriveNodeStatus,
} from '../gantt-segments'
import type { WorkflowRunEventEntry } from '@taiji/shared'

// ── u0 真实样本读取（采集器 = packages/subagent-core rebuild-sample-fixture.test.ts）──

function readSample(name: string): WorkflowRunEventEntry[] {
  // vitest（vite-node）提供 CJS interop 的 __dirname（相对本测试文件解析，不依赖 cwd）
  const text = readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8')
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as WorkflowRunEventEntry)
}

const rebuildSample = readSample('rebuild-generation.record.jsonl')
const resumeSample = readSample('resume-generation.record.jsonl')

// rebuild 样本关键帧 ts（来自实采 record，断言写死期望值对账）
const RB = {
  alphaBand1Start: 1790879967259, // seq 2 phase-started alpha
  ti0Start: 1790879967260, // seq 3
  ti0Settled: 1790879967261, // seq 4
  alphaBand1End: 1790879967261, // seq 5 phase-settled alpha
  ti1Gen1Start: 1790879967261, // seq 6 —— 崩溃代际（第一代际）
  alphaReplayStart: 1790879967474, // seq 7 —— rebuild 重落 phase-started（无 run 级转移帧夹其间）
  ti1Gen2Start: 1790879967475, // seq 8 —— 隐式边界（新代际）
  ti1Gen2Settled: 1790879967476, // seq 9
  betaStart: 1790879967476, // seq 10 phase-started beta
  ti2Start: 1790879967476, // seq 11 attempt 1
  ti2Retry: 1790879968477, // seq 12 backoffMs 1001
  ti2Settled: 1790879968478, // seq 13 attempt 2
  betaEnd: 1790879968478, // seq 14 phase-settled beta
}

const RS = {
  alphaBand1Start: 1790879968647,
  ti0Start: 1790879968648,
  alphaBand1End: 1790879968648,
  ti1Gen1Start: 1790879968648,
  interruptedTs: 1790879968658, // seq 7 run-interrupted（显式边界）
  alphaReplayStart: 1790879968676, // seq 9 resume 后新落 phase-started
  ti1Gen2Start: 1790879968677,
  alphaBand2End: 1790879968677,
}

// ── 手工 fixture 工厂（内联事件帧；字段形态跟随 shared WorkflowRunEventEntry）──────

let seqCounter = 0
function resetSeq(): void {
  seqCounter = 0
}
function frame<T extends object>(type: string, extra: T): WorkflowRunEventEntry {
  seqCounter += 1
  return { type, seq: seqCounter, ts: 0, ...extra } as WorkflowRunEventEntry
}

describe('gantt-segments：call 级 attempt 分段（规则①，rebuild 真实样本）', () => {
  const { attemptSegments } = deriveWorkflowGanttSegments(rebuildSample)

  it('隐式代际边界生效：taskIndex 1 两代际段并存且不相连', () => {
    const ti1 = attemptSegments.filter((s) => s.taskIndex === 1)
    expect(ti1).toHaveLength(2)
    expect(ti1[0].generation).toBe(1)
    expect(ti1[1].generation).toBe(2)
    // 两代际段不相连（崩溃空隙可见：gen1 终点 < gen2 起点）
    expect(ti1[0].endTs).toBeLessThan(ti1[1].startTs)
  })

  it('旧代际段终点 = 该代际最后一个自有 agent-* 帧 ts；重落 phase-started 行不参与锚定', () => {
    const gen1 = attemptSegments.find((s) => s.taskIndex === 1 && s.generation === 1)
    expect(gen1).toBeDefined()
    // 该代际（seq 6 started）之后唯一的帧是 seq 7 重落 phase-started（非 agent-* 帧）——
    // 段终点锚 started.ts 自身，不得锚到重落 phase-started.ts（7474）或新代际帧
    expect(gen1?.startTs).toBe(RB.ti1Gen1Start)
    expect(gen1?.endTs).toBe(RB.ti1Gen1Start)
    expect(gen1?.endTs).not.toBe(RB.alphaReplayStart)
    // 崩溃形态未收束段 state 恒 'running'（停止着色归消费方，D9）
    expect(gen1?.state).toBe('running')
  })

  it('新段起点 = 隐式边界 agent-started.ts，终局段终点 = settled.ts', () => {
    const gen2 = attemptSegments.find((s) => s.taskIndex === 1 && s.generation === 2)
    expect(gen2?.startTs).toBe(RB.ti1Gen2Start)
    expect(gen2?.endTs).toBe(RB.ti1Gen2Settled)
    expect(gen2?.state).toBe('done')
    expect(gen2?.attempt).toBe(1)
  })

  it('attempt 反推公式：attempt 1 失败终点 = retrying.ts − backoffMs、attempt 2 起点 = retrying.ts', () => {
    const ti2 = attemptSegments.filter((s) => s.taskIndex === 2)
    expect(ti2).toHaveLength(2)
    // 首段起点 = agent-started.ts
    expect(ti2[0].startTs).toBe(RB.ti2Start)
    // attempt 1 失败终点 = retrying.ts − backoffMs（1790879968477 − 1001）
    expect(ti2[0].endTs).toBe(RB.ti2Retry - 1001)
    expect(ti2[0].state).toBe('failed') // 失败 attempt 红段
    // attempt 2 起点 = retrying.ts（退避空档为相邻段间隙，数据层不表达——两段不相连）
    expect(ti2[1].startTs).toBe(RB.ti2Retry)
    expect(ti2[1].endTs).toBe(RB.ti2Settled)
    expect(ti2[1].state).toBe('done')
    expect(ti2[1].attempt).toBe(2)
  })

  it('无重试 call 的单段形态：起点 = started.ts、终点 = settled.ts', () => {
    const ti0 = attemptSegments.filter((s) => s.taskIndex === 0)
    expect(ti0).toHaveLength(1)
    expect(ti0[0]).toMatchObject({
      taskIndex: 0,
      generation: 1,
      attempt: 1,
      startTs: RB.ti0Start,
      endTs: RB.ti0Settled,
      state: 'done',
    })
  })

  it('输出按 taskIndex → generation 升序（数值序确定性排序，消费方无需再排）', () => {
    const keys = attemptSegments.map((s) => [s.taskIndex, s.generation, s.attempt] as const)
    const sorted = [...keys].sort((a, b) =>
      a[0] !== b[0] ? a[0] - b[0] : a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2],
    )
    expect(keys).toEqual(sorted)
  })
})

describe('gantt-segments：call 级 attempt 分段（规则①，resume 真实样本——显式中断边界）', () => {
  const { attemptSegments } = deriveWorkflowGanttSegments(resumeSample)

  it('中断前在途 call 旧代际段终点 = run-interrupted.ts，重派新段起点 = 本代际首帧 started.ts', () => {
    const ti1 = attemptSegments.filter((s) => s.taskIndex === 1)
    expect(ti1).toHaveLength(2)
    expect(ti1[0].startTs).toBe(RS.ti1Gen1Start)
    expect(ti1[0].endTs).toBe(RS.interruptedTs) // 显式边界锚 run-interrupted 帧
    expect(ti1[0].state).toBe('running')
    expect(ti1[1].startTs).toBe(RS.ti1Gen2Start)
    expect(ti1[1].endTs).toBe(RS.ti1Gen2Start) // settled 同 ts
    expect(ti1[1].state).toBe('done')
    // 两段间中断空隙可见不相连
    expect(ti1[0].endTs).toBeLessThan(ti1[1].startTs)
  })
})

describe('gantt-segments：call 级 attempt 分段（手工 fixture——断言清单剩余项）', () => {
  it('retrying 变体：崩溃旧代际末帧为 agent-retrying 帧时段终点 = retrying.ts', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      frame('phase-started', { phase: 'p', ts: 1010 }),
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1020 }),
      frame('agent-retrying', { taskIndex: 0, attempt: 1, backoffMs: 300, reason: 'boom', ts: 1050 }),
      // worker 在退避中崩溃 → rebuild 重派（隐式边界，无 run 级转移帧）
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 2000 }),
      frame('agent-settled', { taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 5, ts: 2010 }),
      frame('phase-settled', { phase: 'p', ts: 2010 }),
      frame('run-settled', { outcome: 'done', reason: 'completed', artifactsDir: '/tmp/x', ts: 2020 }),
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    expect(attemptSegments).toHaveLength(2)
    // 旧代际：窗口（started → 下一 started）内无 run 转移帧 → 锚最后自有 agent-* 帧 = retrying.ts
    expect(attemptSegments[0]).toMatchObject({ generation: 1, startTs: 1020, endTs: 1050, state: 'running' })
    expect(attemptSegments[1]).toMatchObject({ generation: 2, startTs: 2000, endTs: 2010, state: 'done' })
  })

  it('aborted 终局 run：在途 call 未收束段终点 = run-settled.ts', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      frame('phase-started', { phase: 'p', ts: 1010 }),
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1020 }),
      // abort 终局：closeOutInFlightCalls 只写内存不落帧 → 无 settled 帧
      frame('run-settled', { outcome: 'cancelled', reason: 'aborted', artifactsDir: '/tmp/x', ts: 1100 }),
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    expect(attemptSegments).toHaveLength(1)
    expect(attemptSegments[0]).toMatchObject({ startTs: 1020, endTs: 1100, state: 'running' })
  })

  it('started 帧缺行 → 该 call 降级零分段、不判损坏（其余 call 正常分段）', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      frame('agent-retrying', { taskIndex: 7, attempt: 1, backoffMs: 100, reason: 'x', ts: 1020 }),
      frame('agent-settled', { taskIndex: 7, attempt: 2, outcome: 'failed', durationMs: 5, ts: 1200 }),
      frame('agent-started', { taskIndex: 8, agentName: 'b', attempt: 1, phase: 'p', ts: 1025 }),
      frame('agent-settled', { taskIndex: 8, attempt: 1, outcome: 'done', durationMs: 5, ts: 1030 }),
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    // taskIndex 7 无 started 帧 → 零产出；taskIndex 8 正常
    expect(attemptSegments.filter((s) => s.taskIndex === 7)).toHaveLength(0)
    expect(attemptSegments.filter((s) => s.taskIndex === 8)).toHaveLength(1)
  })

  it('多轮重试反推公式：各 attempt 段按 retrying_N 链式反推、终局段收束', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1000 }),
      frame('agent-retrying', { taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'r1', ts: 2000 }),
      frame('agent-retrying', { taskIndex: 0, attempt: 2, backoffMs: 800, reason: 'r2', ts: 4000 }),
      frame('agent-settled', { taskIndex: 0, attempt: 3, outcome: 'done', durationMs: 10, ts: 6000 }),
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    expect(attemptSegments).toHaveLength(3)
    expect(attemptSegments[0]).toEqual({
      taskIndex: 0, generation: 1, attempt: 1, startTs: 1000, endTs: 1500, state: 'failed',
    })
    expect(attemptSegments[1]).toEqual({
      taskIndex: 0, generation: 1, attempt: 2, startTs: 2000, endTs: 3200, state: 'failed',
    })
    expect(attemptSegments[2]).toEqual({
      taskIndex: 0, generation: 1, attempt: 3, startTs: 4000, endTs: 6000, state: 'done',
    })
  })

  it('中断发生在退避等待中：attempt N+1 无执行事实 → 未收束代际恒单段锚 run-interrupted.ts', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1000 }),
      frame('agent-retrying', { taskIndex: 0, attempt: 1, backoffMs: 500, reason: 'r', ts: 1500 }),
      frame('run-interrupted', { errorCode: 'user', reason: 'stop', ts: 1800 }), // 退避中被中断
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    // 不开「attempt 2 起点 = retrying.ts」的悬空段——单段 [started, interrupted]
    expect(attemptSegments).toHaveLength(1)
    expect(attemptSegments[0]).toEqual({
      taskIndex: 0, generation: 1, attempt: 1, startTs: 1000, endTs: 1800, state: 'running',
    })
  })

  it('墙钟倒挂防御：反推终点早于段起点时钳到段起点（不产出逆序段）', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1000 }),
      frame('agent-retrying', { taskIndex: 0, attempt: 1, backoffMs: 9999, reason: 'r', ts: 1100 }),
      frame('agent-settled', { taskIndex: 0, attempt: 2, outcome: 'done', durationMs: 1, ts: 1200 }),
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    expect(attemptSegments[0].endTs).toBe(1000) // max(1100-9999, 1000)
    expect(attemptSegments[0].endTs).toBeGreaterThanOrEqual(attemptSegments[0].startTs)
  })

  it('settled outcome 映射：cancelled → cancelled', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1000 }),
      frame('agent-settled', { taskIndex: 0, attempt: 1, outcome: 'cancelled', durationMs: 1, ts: 1100 }),
    ]
    const { attemptSegments } = deriveWorkflowGanttSegments(events)
    expect(attemptSegments[0].state).toBe('cancelled')
  })

  it('空事件流 → 全空容器（合法输出非错误）', () => {
    const segments = deriveWorkflowGanttSegments([])
    expect(segments).toEqual({ attemptSegments: [], phaseBands: [], phaseCards: [] })
  })
})

describe('gantt-segments：phase 级色带（规则②，rebuild/resume 真实样本）', () => {
  it('rebuild 样本：alpha 两段独立、重落段内有新代际执行（非空段）；beta 单段', () => {
    const { phaseBands, phaseCards } = deriveWorkflowGanttSegments(rebuildSample)
    const alpha = phaseBands.filter((b) => b.phase === 'alpha')
    expect(alpha).toHaveLength(2)
    expect(alpha[0]).toMatchObject({
      startTs: RB.alphaBand1Start, endTs: RB.alphaBand1End, emptyReplay: false, state: 'settled',
    })
    // 重落段：终点 = 本段之后第一个 phase 级转移帧（beta phase-started），非空（新代际帧 seq 8/9 在区间内）
    expect(alpha[1]).toMatchObject({
      startTs: RB.alphaReplayStart, endTs: RB.betaStart, emptyReplay: false, state: 'settled',
    })
    const beta = phaseBands.filter((b) => b.phase === 'beta')
    expect(beta).toHaveLength(1)
    expect(beta[0]).toMatchObject({ startTs: RB.betaStart, endTs: RB.betaEnd, emptyReplay: false, state: 'settled' })

    const alphaCard = phaseCards.find((c) => c.phase === 'alpha')
    // 聚合区间 = 非空段首尾：起点 = 首轮 started（259）、终点 = 末轮收束（alpha 段 2 终点 = beta started 7476）
    expect(alphaCard).toMatchObject({ startTs: RB.alphaBand1Start, endTs: RB.betaStart, turnCount: 2, state: 'settled', scriptOnly: false })
  })

  it('resume 样本：alpha 两段（旧段收束 + resume 后新落段），头卡聚合区间不逆序、轮次 = 2', () => {
    const { phaseBands, phaseCards } = deriveWorkflowGanttSegments(resumeSample)
    const alpha = phaseBands.filter((b) => b.phase === 'alpha')
    expect(alpha).toHaveLength(2)
    expect(alpha[0]).toMatchObject({ startTs: RS.alphaBand1Start, endTs: RS.alphaBand1End, state: 'settled' })
    expect(alpha[1]).toMatchObject({ startTs: RS.alphaReplayStart, endTs: RS.alphaBand2End, state: 'settled' })

    const card = phaseCards.find((c) => c.phase === 'alpha')
    expect(card).toMatchObject({
      startTs: RS.alphaBand1Start,
      endTs: RS.alphaBand2End,
      turnCount: 2,
      state: 'settled',
      scriptOnly: false,
    })
    expect(card!.startTs).toBeLessThanOrEqual(card!.endTs) // 聚合区间起止不逆序（S7）
  })
})

describe('gantt-segments：phase 级色带（手工 fixture——空段判据/纯脚本/转移帧终点）', () => {
  it('重放空段：phase 历史有 agent 事件 ∧ 本段区间零 agent 事件 → emptyReplay、不计轮次', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      // 第一轮：真实执行（有 agent 事件）
      frame('phase-started', { phase: 'review', ts: 1010 }),
      frame('agent-started', { taskIndex: 0, agentName: 'rev', attempt: 1, phase: 'review', ts: 1020 }),
      frame('agent-settled', { taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 5, ts: 1030 }),
      frame('phase-settled', { phase: 'review', ts: 1030 }),
      // 重放轮：worker 重跑途经已完成 phase，重落 phase-started 但 call 经 replay 回话零新帧
      frame('phase-started', { phase: 'review', ts: 2000 }),
      frame('phase-started', { phase: 'next', ts: 2100 }),
      frame('phase-settled', { phase: 'next', ts: 2110 }),
      frame('run-settled', { outcome: 'done', reason: 'completed', artifactsDir: '/tmp/x', ts: 2120 }),
    ]
    const { phaseBands, phaseCards } = deriveWorkflowGanttSegments(events)
    const review = phaseBands.filter((b) => b.phase === 'review')
    expect(review).toHaveLength(2)
    expect(review[0]).toMatchObject({ emptyReplay: false, state: 'settled' })
    // 重放段终点 = 本段之后第一个 phase 级转移帧（next phase-started ts 2100）
    expect(review[1]).toMatchObject({ startTs: 2000, endTs: 2100, emptyReplay: true, state: 'settled' })

    const card = phaseCards.find((c) => c.phase === 'review')
    expect(card).toMatchObject({ startTs: 1010, endTs: 1030, turnCount: 1, state: 'settled' }) // 轮次不含重放空段、聚合区间不含
  })

  it('纯脚本 phase（全历史零 agent 事件）：多轮段全绘制、emptyReplay 恒 false、轮次 = 段数', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      frame('phase-started', { phase: 'gate', ts: 1010 }),
      frame('phase-settled', { phase: 'gate', ts: 1050 }),
      frame('phase-started', { phase: 'gate', ts: 2000 }),
      frame('phase-settled', { phase: 'gate', ts: 2050 }),
      frame('run-settled', { outcome: 'done', reason: 'completed', artifactsDir: '/tmp/x', ts: 2060 }),
    ]
    const { phaseBands, phaseCards } = deriveWorkflowGanttSegments(events)
    expect(phaseBands).toHaveLength(2)
    expect(phaseBands[0]).toMatchObject({ startTs: 1010, endTs: 1050, emptyReplay: false, state: 'settled' })
    expect(phaseBands[1]).toMatchObject({ startTs: 2000, endTs: 2050, emptyReplay: false, state: 'settled' })
    expect(phaseCards).toHaveLength(1)
    expect(phaseCards[0]).toMatchObject({ phase: 'gate', startTs: 1010, endTs: 2050, turnCount: 2, state: 'settled', scriptOnly: true })
  })

  it('运行中无锚段：无 settled 且无转移帧 → state running、终点 = 最后已知帧、区间判定含末帧 agent 事件', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      frame('phase-started', { phase: 'run', ts: 1010 }),
      frame('agent-started', { taskIndex: 0, agentName: 'w', attempt: 1, phase: 'run', ts: 1020 }), // 恰为事件流末帧
    ]
    const { phaseBands, phaseCards } = deriveWorkflowGanttSegments(events)
    expect(phaseBands).toHaveLength(1)
    expect(phaseBands[0]).toMatchObject({ phase: 'run', startTs: 1010, endTs: 1020, emptyReplay: false, state: 'running' })
    expect(phaseCards[0]).toMatchObject({ turnCount: 1, state: 'running', scriptOnly: false })
  })

  it('中断+resume 形态：本轮无 settled 的段终点 = run-interrupted.ts，不越过中断帧采重放轮 settled', () => {
    resetSeq()
    const events: WorkflowRunEventEntry[] = [
      frame('run-created', { runId: 'wf-t', workflowName: 't', argsSummary: '{}', ts: 1000 }),
      frame('phase-started', { phase: 'fix', ts: 1010 }),
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'fix', ts: 1015 }),
      // agent 在飞时中断——本轮 phase 无 settled 帧（resume 样本不含的形态）
      frame('run-interrupted', { errorCode: 'user', reason: 'stop', ts: 1100 }),
      frame('run-resumed', { reason: 'resume plan', host: 'h', ts: 1200 }),
      frame('phase-started', { phase: 'fix', ts: 1210 }),
      frame('agent-started', { taskIndex: 0, agentName: 'a', attempt: 1, phase: 'fix', ts: 1215 }),
      frame('agent-settled', { taskIndex: 0, attempt: 1, outcome: 'done', durationMs: 5, ts: 1300 }),
      frame('phase-settled', { phase: 'fix', ts: 1310 }),
      frame('run-settled', { outcome: 'done', reason: 'completed', artifactsDir: '/tmp/x', ts: 1320 }),
    ]
    const { phaseBands, phaseCards } = deriveWorkflowGanttSegments(events)
    const fix = phaseBands.filter((b) => b.phase === 'fix')
    expect(fix).toHaveLength(2)
    // 段 1 终点 = run-interrupted.ts（同名 settled 搜索以转移帧为上界），非空（agent 帧 1015 在区间内）
    expect(fix[0]).toMatchObject({ startTs: 1010, endTs: 1100, emptyReplay: false, state: 'settled' })
    // 段 2 正常收束于本轮 settled
    expect(fix[1]).toMatchObject({ startTs: 1210, endTs: 1310, emptyReplay: false, state: 'settled' })
    // 两段不重叠——中断空隙可见（越界采重放轮 settled 会得 [1010,1310] 与段 2 完全重叠）
    expect(fix[0].endTs).toBeLessThan(fix[1].startTs)
    expect(phaseCards.find((c) => c.phase === 'fix')).toMatchObject({ turnCount: 2, state: 'settled' })
  })

  it('缺 seq 旧格式行：区间判定降级 ts 半开区间（起点帧自身不计入本段区间）', () => {
    // 手工构造无 seq 的事件（W1 前旧格式）——ts 相邻帧用半开区间归属
    const events: WorkflowRunEventEntry[] = [
      { type: 'phase-started', phase: 'p', ts: 1000 },
      { type: 'agent-started', taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1000 }, // 与 started 同 ts
      { type: 'phase-settled', phase: 'p', ts: 1100 },
    ]
    const { phaseBands } = deriveWorkflowGanttSegments(events)
    expect(phaseBands[0].emptyReplay).toBe(false) // agent 帧 ts ∈ [1000, 1100) → 非空
  })

  it('混合形态（区间中部缺 seq、边界帧有 seq）：整体降级 ts 半开区间，中部帧不丢', () => {
    // 只查边界帧会把中部缺 seq 的旧格式 agent 帧留在 seq 模式下——frameInInterval
    // 对无 seq 帧恒 false → 本段误判重放空段（隐藏、不计轮次）
    const events: WorkflowRunEventEntry[] = [
      { type: 'phase-started', phase: 'p', ts: 1000, seq: 1 },
      { type: 'agent-started', taskIndex: 0, agentName: 'a', attempt: 1, phase: 'p', ts: 1020 }, // 中部缺 seq
      { type: 'phase-settled', phase: 'p', ts: 1100, seq: 3 },
    ]
    const { phaseBands } = deriveWorkflowGanttSegments(events)
    expect(phaseBands[0].emptyReplay).toBe(false) // ts 模式下 1020 ∈ [1000, 1100) → 非空
  })
})

// ── §3.3-D9：渲染层状态派生（trace 表与 DAG 共用）────────────────────────────

describe('gantt-segments：D9 call 级派生（deriveCallView）', () => {
  it('retrying = attempts 有值（fold 仅由 agent-retrying 帧写入）且投影 running；首败重试窗口（attempts=1）覆盖；无 attempts running 不判 retrying；终局态优先', () => {
    expect(deriveCallView({ status: 'running', attempts: 2 }, 'running').status).toBe('retrying')
    // 首败重试窗口（S2 构造场景：mock 首败后成，retrying 帧已落 settled 未落）——attempts 峰值 = 1
    expect(deriveCallView({ status: 'running', attempts: 1 }, 'running').status).toBe('retrying')
    expect(deriveCallView({ status: 'running' }, 'running').status).toBe('running') // 缺省 = 无 retrying 帧
    expect(deriveCallView({ status: 'done', attempts: 3 }, 'running').status).toBe('done')
    expect(deriveCallView({ status: 'failed', attempts: 3 }, 'done').status).toBe('failed')
  })

  it('stoppedInFlight = run 已停止 ∧ call 在途（投影 running）；pending 不属在途', () => {
    expect(deriveCallView({ status: 'running' }, 'interrupted').stoppedInFlight).toBe(true)
    expect(deriveCallView({ status: 'running', attempts: 2 }, 'interrupted').stoppedInFlight).toBe(true)
    expect(deriveCallView({ status: 'running' }, 'done').stoppedInFlight).toBe(true) // terminal 终局同判据
    expect(deriveCallView({ status: 'running' }, 'running').stoppedInFlight).toBe(false)
    expect(deriveCallView({ status: 'pending' }, 'done').stoppedInFlight).toBe(false)
    expect(deriveCallView({ status: 'done' }, 'done').stoppedInFlight).toBe(false)
  })
})

describe('gantt-segments：D9 节点级派生（deriveNodeStatus）', () => {
  it('skipped 仅 run 终局后零实例；运行中/中断零实例 = pending（防循环重入误判震荡）', () => {
    expect(deriveNodeStatus({ runStatus: 'done', calls: [] })).toBe('skipped')
    expect(deriveNodeStatus({ runStatus: 'running', calls: [] })).toBe('pending')
    expect(deriveNodeStatus({ runStatus: 'interrupted', calls: [] })).toBe('pending')
  })

  it('有实例聚合优先级：retrying > running > failed > done > pending', () => {
    const mk = (status: 'pending' | 'running' | 'done' | 'failed', attempts?: number) => ({ status, attempts })
    expect(deriveNodeStatus({ runStatus: 'running', calls: [mk('done'), mk('running', 2)] })).toBe('retrying')
    expect(deriveNodeStatus({ runStatus: 'running', calls: [mk('done'), mk('running')] })).toBe('running')
    expect(deriveNodeStatus({ runStatus: 'done', calls: [mk('done'), mk('failed')] })).toBe('failed')
    expect(deriveNodeStatus({ runStatus: 'done', calls: [mk('done'), mk('done')] })).toBe('done')
    expect(deriveNodeStatus({ runStatus: 'running', calls: [mk('pending'), mk('pending')] })).toBe('pending')
  })

  it('停止叠加：终局 run 中在途实例 → 节点 running 态保留（停止着色由消费方按 stoppedInFlight 叠加）', () => {
    // deriveNodeStatus 输出运行语义态；「不显示蓝脉冲」的停止着色是消费方按 D9 stoppedInFlight
    // 叠加的展示决策——本断言锁定数据层不吞 running 态（消费方可判 stoppedInFlight）
    const node = deriveNodeStatus({ runStatus: 'done', calls: [{ status: 'running' }] })
    expect(node).toBe('running')
    expect(deriveCallView({ status: 'running' }, 'done').stoppedInFlight).toBe(true)
  })
})
