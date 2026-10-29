/**
 * workflow-viz 纯逻辑域合并产物（round 6 renderer 测试压缩）：七文件同产物，全零
 * vi.mock（纯函数 + 组件 props 驱动 mount，无依赖 mock 面）。
 *
 * 并入来源（基名）：
 *  - blueprint-match（两级判据/多命中裁决/未匹配分组，13 例）
 *  - gantt-segments（分段派生纯函数 + u0 实采样本，29 例；fixtures 相对 __dirname
 *    读取，产物与原文件同目录，路径不变）
 *  - run-name（normalizeWorkflowScriptName 三形态，6 例）
 *  - workflow-viz-dag-layout（layoutDag/layoutEdges/fit 变换，37 例）
 *  - workflow-viz-dag-legend（七态图例 + tone 同源，6 例）
 *  - workflow-viz-dag（节点状态渲染 + ResizeObserver stub，38 例）
 *  - workflow-viz-gantt（分段行渲染 + 值域，18 例）
 *
 * dag/gantt 子目录成员的相对 import 已按产物目录归一（'../layout' → '../dag/layout' 等）。
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=subagent TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/workflow-viz/__tests__/workflow-viz-pure-bundle.test.ts（本文件登记在 domain-map.json subagent 域，默认档被排除）
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { matchInstancesToNodes, templateLiteralLength } from '../blueprint-match'
import {
  deriveWorkflowGanttSegments,
  deriveCallView,
  deriveNodeStatus,
} from '../gantt-segments'
import { normalizeWorkflowScriptName } from '../run-name'
import { layoutDag, layoutEdges, computeFitTransform, dagNodeHeight, avoidObstructedChannelMid, DAG_NODE_W, DAG_NODE_H, INSTANCE_ROW_H, FIT_PAD_PX, ZOOM_MIN, LANE_STEP_PX } from '../dag/layout'
import WorkflowVizDag from '../dag/WorkflowVizDag.vue'
import { dotTone } from '../dag/tone'
import WorkflowVizOverlay from '../overlay/WorkflowVizOverlay.vue'
import WorkflowVizGantt from '../gantt/WorkflowVizGantt.vue'
import { buildGanttRows, computeGanttDomain, toPercent } from '../gantt/gantt-view'
import type { WorkflowAgentCall, WorkflowDag, WorkflowDagNode, WorkflowRunRecord, WorkflowRunEventEntry, WorkflowGanttSegments } from '@taiji/shared'
import type { DagLayout, DagLayoutEdge, DagLayoutNode, ChannelMember } from '../dag/layout'
import type { WorkflowVizDagNodeStatus } from '../dag/types'

// ═══════════ 来源节：blueprint-match ═══════════

describe('blueprint-match', () => {
function node(id: string, templateName: string, matchPattern: string, phase: string): WorkflowDagNode {
  return { id, kind: 'agent', templateName, matchPattern, phase, line: 1 }
}

function call(id: number, agent: string, phase: string): WorkflowAgentCall {
  return { id, agent, phase, status: 'done' }
}

describe('blueprint-match：D2 两级判据', () => {
  it('先 phase 后正则：同名调用点跨 phase 复用由 phase 判据天然分流', () => {
    const dag = {
      nodes: [
        node('n1', 'reviewer-${…}', '^reviewer-.*$', 'alpha'),
        node('n2', 'reviewer-${…}', '^reviewer-.*$', 'beta'),
      ],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'reviewer-a', 'alpha'), call(1, 'reviewer-b', 'beta')])
    expect(result.byNode.get('n1')?.map((c) => c.id)).toEqual([0])
    expect(result.byNode.get('n2')?.map((c) => c.id)).toEqual([1])
    expect(result.unmatched).toHaveLength(0)
  })

  it('模板正则命中：字面段精确匹配实例名', () => {
    const dag = { nodes: [node('n1', 'dev-${…}', '^dev-.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(0, 'dev-W1', 'p')])
    expect(result.byNode.get('n1')).toHaveLength(1)
    expect(result.unmatched).toHaveLength(0)
  })
})

describe('blueprint-match：D2 多命中裁决', () => {
  it('同词根双调用点：按字面段总长降序取更具体者（S3 场景）', () => {
    const dag = {
      nodes: [
        node('broad', 'reviewer-${…}-a${…}', '^reviewer-.*-a.*$', 'p'),
        node('specific', 'reviewer-security-${…}', '^reviewer-security-.*$', 'p'),
      ],
    }
    // reviewer-security-x 同时命中两模板 → 字面段更长的 specific 胜
    //（broad 字面 = "reviewer--a" 11 字符；specific 字面 = "reviewer-security-" 18 字符）
    const result = matchInstancesToNodes(dag, [call(0, 'reviewer-security-x', 'p')])
    expect(result.byNode.has('specific')).toBe(true)
    expect(result.byNode.has('broad')).toBe(false)
    expect(result.unmatched).toHaveLength(0)
  })

  it('变量段数不同的模板不被 `${…}` 标记长度偏置：真字面长者胜（一致性修复 U3 回归）', () => {
    const dag = {
      nodes: [
        node('many-var', 'r-${…}-${…}-${…}', '^r-.*-.*-.*$', 'p'),
        node('more-literal', 'r-xx-${…}', '^r-xx-.*$', 'p'),
      ],
    }
    // r-xx-1-2 同时命中两模板；字符总数 many-var 14 > more-literal 9（含 `${…}` 标记），
    // 真字面 4 < 5——按字面段总长判 more-literal 更具体
    const result = matchInstancesToNodes(dag, [call(0, 'r-xx-1-2', 'p')])
    expect(result.byNode.has('more-literal')).toBe(true)
    expect(result.byNode.has('many-var')).toBe(false)
  })

  it('全通配 `*`（description 非静态/缺省的 u1 产物）字面 0：与具体模板多命中时具体者胜', () => {
    const dag = {
      nodes: [
        node('wild', '*', '^.*$', 'p'),
        node('specific', 'rev-${…}', '^rev-.*$', 'p'),
      ],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'rev-1', 'p')])
    expect(result.byNode.has('specific')).toBe(true)
    expect(result.byNode.has('wild')).toBe(false)
  })

  it('字面段总长并列的歧义命中 → 进未匹配分组并标注 hitCount，不静默择一', () => {
    const dag = {
      nodes: [
        node('a', 'reviewer-${…}-x', '^reviewer-.*-x$', 'p'),
        node('b', 'reviewer-${…}-x', '^reviewer-.*-x$', 'p'),
      ],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'reviewer-q-x', 'p')])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].ambiguous).toBe(true)
    expect(result.unmatched[0].hitCount).toBe(2)
  })

  it('templateLiteralLength：剥 u1 产物形态 `${…}` 变量段后的字面字符总长', () => {
    expect(templateLiteralLength('reviewer-${…}-a${…}-r${…}')).toBe('reviewer--a-r'.length)
    expect(templateLiteralLength('reviewer-security-${…}')).toBe('reviewer-security-'.length)
    expect(templateLiteralLength('*')).toBe(0) // 非静态表达式整段通配 → 字面 0
    // 变量段数偏置回归：字符总数 14 > 9，真字面 4 < 5——剥标记后按真字面比较
    expect(templateLiteralLength('r-${…}-${…}-${…}')).toBe(4)
    expect(templateLiteralLength('r-xx-${…}')).toBe(5)
  })
})

describe('blueprint-match：未匹配分组（不静默丢弃）', () => {
  it('零命中实例进未匹配分组（hitCount=0）', () => {
    const dag = { nodes: [node('n1', 'dev-${…}', '^dev-.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(0, 'other-agent', 'p')])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toEqual([
      { call: expect.objectContaining({ agent: 'other-agent' }), hitCount: 0, ambiguous: false },
    ])
  })

  it('实例 phase 缺失 → 未匹配分组（不猜解析器缺省分区名）', () => {
    const dag = { nodes: [node('n1', 'dev-${…}', '^dev-.*$', 'p')] }
    const orphan: WorkflowAgentCall = { id: 0, agent: 'dev-W1', status: 'done' }
    const result = matchInstancesToNodes(dag, [orphan])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.unmatched[0].hitCount).toBe(0)
  })

  it('零调用点 run（nodes 空）→ 全部实例进未匹配分组（渲染层空画布 + 居中摘要提示形态）', () => {
    const result = matchInstancesToNodes({ nodes: [] }, [call(0, 'a', 'p'), call(1, 'b', 'p')])
    expect(result.byNode.size).toBe(0)
    expect(result.unmatched).toHaveLength(2)
  })
})

describe('blueprint-match：挂接与防御机制', () => {
  it('同节点实例按 taskIndex（call.id）升序挂接（轮次/维度区分靠实例名自身展示）', () => {
    const dag = { nodes: [node('n1', 'rev-${…}', '^rev-.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(5, 'rev-e', 'p'), call(1, 'rev-a', 'p'), call(3, 'rev-c', 'p')])
    expect(result.byNode.get('n1')?.map((c) => c.id)).toEqual([1, 3, 5])
  })

  it('字面段按正则转义：实例名含 + / ( 等元字符不误匹配（D2① 转义义务的渲染侧消费验证）', () => {
    // 解析器对字面段转义后，`c++` 的 `+` 是字面字符——`.*` 通配不会把 `c++(v1)` 误配到
    // 其他模板（实例名元字符不改变匹配结果集）
    const dag = { nodes: [node('n1', 'build-+c++-${…}', '^build-\\+c\\+\\+.*$', 'p')] }
    const result = matchInstancesToNodes(dag, [call(0, 'build-+c++(v1)', 'p')])
    expect(result.byNode.get('n1')).toHaveLength(1)
  })

  it('坏 matchPattern → 该节点按零命中处理，不拖垮整表', () => {
    const dag = {
      nodes: [node('bad', 'x-${…}', '^([unclosed', 'p'), node('good', 'ok-${…}', '^ok-.*$', 'p')],
    }
    const result = matchInstancesToNodes(dag, [call(0, 'ok-1', 'p'), call(1, 'x-1', 'p')])
    expect(result.byNode.get('good')?.map((c) => c.id)).toEqual([0])
    expect(result.unmatched.map((u) => u.call.id)).toEqual([1])
  })
})
})

// ═══════════ 来源节：gantt-segments ═══════════

describe('gantt-segments', () => {
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
      // agent 在途时中断——本轮 phase 无 settled 帧（resume 样本不含的形态）
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
  it('retrying = attempts 有值（fold 仅由 agent-retrying 帧写入）且派生视图 running；首败重试窗口（attempts=1）覆盖；无 attempts running 不判 retrying；终局态优先', () => {
    expect(deriveCallView({ status: 'running', attempts: 2 }, 'running').status).toBe('retrying')
    // 首败重试窗口（S2 构造场景：mock 首败后成，retrying 帧已落 settled 未落）——attempts 峰值 = 1
    expect(deriveCallView({ status: 'running', attempts: 1 }, 'running').status).toBe('retrying')
    expect(deriveCallView({ status: 'running' }, 'running').status).toBe('running') // 缺省 = 无 retrying 帧
    expect(deriveCallView({ status: 'done', attempts: 3 }, 'running').status).toBe('done')
    expect(deriveCallView({ status: 'failed', attempts: 3 }, 'done').status).toBe('failed')
  })

  it('stoppedInFlight = run 已停止 ∧ call 在途（派生视图 running）；pending 不属在途', () => {
    expect(deriveCallView({ status: 'running' }, 'interrupted').stoppedInFlight).toBe(true)
    expect(deriveCallView({ status: 'running', attempts: 2 }, 'interrupted').stoppedInFlight).toBe(true)
    expect(deriveCallView({ status: 'running' }, 'done').stoppedInFlight).toBe(true) // terminal 终局同判据
    expect(deriveCallView({ status: 'running' }, 'running').stoppedInFlight).toBe(false)
    expect(deriveCallView({ status: 'pending' }, 'done').stoppedInFlight).toBe(false)
    expect(deriveCallView({ status: 'done' }, 'done').stoppedInFlight).toBe(false)
  })

  it('cancelled 直投（§3.3.8 run 终局收尾在途成员——「未交付且非失败」中性档，不冒充 failed/pending）', () => {
    expect(deriveCallView({ status: 'cancelled' }, 'done').status).toBe('cancelled')
    expect(deriveCallView({ status: 'cancelled' }, 'done').stoppedInFlight).toBe(false) // 终局已收束，非在途
  })
})

describe('gantt-segments：D9 节点级派生（deriveNodeStatus）', () => {
  it('skipped 仅 run 终局后零实例；运行中/中断零实例 = pending（防循环重入误判震荡）', () => {
    expect(deriveNodeStatus({ runStatus: 'done', calls: [] })).toBe('skipped')
    expect(deriveNodeStatus({ runStatus: 'running', calls: [] })).toBe('pending')
    expect(deriveNodeStatus({ runStatus: 'interrupted', calls: [] })).toBe('pending')
  })

  it('有实例聚合优先级：retrying > running > failed > cancelled > done > pending', () => {
    const mk = (status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled', attempts?: number) => ({ status, attempts })
    expect(deriveNodeStatus({ runStatus: 'running', calls: [mk('done'), mk('running', 2)] })).toBe('retrying')
    expect(deriveNodeStatus({ runStatus: 'running', calls: [mk('done'), mk('running')] })).toBe('running')
    expect(deriveNodeStatus({ runStatus: 'done', calls: [mk('done'), mk('failed')] })).toBe('failed')
    // cancelled（§3.3.8）：先于 done（含取消实例按中性取消档，不冒充全成功）；
    // failed 仍优先于 cancelled（含失败实例显示失败）。
    expect(deriveNodeStatus({ runStatus: 'done', calls: [mk('done'), mk('cancelled')] })).toBe('cancelled')
    expect(deriveNodeStatus({ runStatus: 'done', calls: [mk('cancelled'), mk('cancelled')] })).toBe('cancelled')
    expect(deriveNodeStatus({ runStatus: 'done', calls: [mk('failed'), mk('cancelled')] })).toBe('failed')
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
})

// ═══════════ 来源节：run-name ═══════════

describe('run-name', () => {
describe('normalizeWorkflowScriptName（三形态互通）', () => {
  it('bare 名保持原样（record.scriptName 存 basename 的基准形态）', () => {
    expect(normalizeWorkflowScriptName('flow-a')).toBe('flow-a')
  })

  it('绝对/相对路径 → basename（正反斜杠均归一）', () => {
    expect(normalizeWorkflowScriptName('/Users/agent/workflows/flow-a.js')).toBe('flow-a')
    expect(normalizeWorkflowScriptName('./workflows/flow-a.js')).toBe('flow-a')
    expect(normalizeWorkflowScriptName('C:\\workflows\\flow-a.js')).toBe('flow-a')
  })

  it('脚本扩展名四族剥除：.js / .mjs / .cjs / .ts（bare 与带扩展名互通）', () => {
    for (const ext of ['.js', '.mjs', '.cjs', '.ts']) {
      expect(normalizeWorkflowScriptName(`flow-a${ext}`)).toBe('flow-a')
    }
  })

  it('非脚本扩展名不剥（.md / .json 等保持完整 basename）', () => {
    expect(normalizeWorkflowScriptName('/docs/flow-a.md')).toBe('flow-a.md')
    expect(normalizeWorkflowScriptName('flow-a.json')).toBe('flow-a.json')
  })

  it('名字自身含点号仅剥末段脚本扩展名', () => {
    expect(normalizeWorkflowScriptName('my.flow-a.js')).toBe('my.flow-a')
  })

  it('空串与裸扩展名不炸（入口侧空值检查在前，此处仅形态确定）', () => {
    expect(normalizeWorkflowScriptName('')).toBe('')
    expect(normalizeWorkflowScriptName('.js')).toBe('')
  })
})
})

// ═══════════ 来源节：workflow-viz-dag-layout ═══════════

describe('workflow-viz-dag-layout', () => {
function node(partial: Partial<WorkflowDagNode> & { id: string }): WorkflowDagNode {
  return {
    kind: 'agent',
    templateName: partial.id,
    matchPattern: '',
    phase: 'p0',
    line: 1,
    ...partial,
  }
}

function dag(partial: Partial<WorkflowDag> = {}): WorkflowDag {
  return {
    nodes: [],
    edges: [],
    phases: [],
    parallelGroups: [],
    loops: [],
    ...partial,
  }
}

describe('layoutDag 列式布局（白盒）', () => {
  it('分区列按 order 升序从左到右排列，列间留水平间距', () => {
    const result = layoutDag(dag({
      phases: [
        { name: 'review', order: 1 },
        { name: 'gate', order: 0 },
      ],
    }))
    expect(result.clusters.map((c) => c.phase)).toEqual(['gate', 'review'])
    const [first, second] = result.clusters
    expect(second.x).toBeGreaterThan(first.x + first.width)
  })

  it('分区内节点按 templateName 词法序垂直排列（同一分区列内）', () => {
    const result = layoutDag(dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [
        node({ id: 'b', templateName: 'reviewer-types' }),
        node({ id: 'a', templateName: 'reviewer-biz' }),
        node({ id: 'c', templateName: 'reviewer-security' }),
      ],
    }))
    const ys = result.nodes.map((ln) => ln.y)
    // 词法序：reviewer-biz(a) < reviewer-security(c) < reviewer-types(b)
    expect(result.nodes.map((ln) => ln.node.id)).toEqual(['a', 'c', 'b'])
    // 垂直步进：后一节点在前一节点下方（步进 ≥ 节点高，同列不重叠）
    expect(ys[1]).toBeGreaterThan(ys[0])
    expect(ys[2]).toBeGreaterThan(ys[1])
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(DAG_NODE_H)
    // 全部节点 x 一致（同列）且含分区左内边距
    expect(new Set(result.nodes.map((ln) => ln.x)).size).toBe(1)
  })

  it('同名分区内词法序并列时按 id 决胜（稳定序）', () => {
    const result = layoutDag(dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'n2', templateName: 'same' }), node({ id: 'n1', templateName: 'same' })],
    }))
    expect(result.nodes.map((ln) => ln.node.id)).toEqual(['n1', 'n2'])
  })

  it('节点归属分区缺失 → 动态补尾部分区，节点不丢弃', () => {
    const result = layoutDag(dag({
      phases: [{ name: 'known', order: 0 }],
      nodes: [node({ id: 'a', phase: 'ghost' })],
    }))
    expect(result.clusters.map((c) => c.phase)).toEqual(['known', 'ghost'])
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0].node.phase).toBe('ghost')
    expect(result.clusters[1].x).toBeGreaterThan(result.clusters[0].x)
  })

  it('零节点 run：空布局 + 最小占位尺寸（居中摘要提示的底板）', () => {
    const result = layoutDag(dag())
    expect(result.nodes).toHaveLength(0)
    expect(result.clusters).toHaveLength(0)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })

  it('分区高度随节点行数增长（行多时覆盖节点堆叠高度）', () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node({ id: `n${i}`, templateName: `agent-${i}` }))
    const result = layoutDag(dag({ phases: [{ name: 'p0', order: 0 }], nodes }))
    expect(result.clusters[0].height).toBeGreaterThanOrEqual(DAG_NODE_H * 5)
  })
})

/**
 * 轴对齐不变量断言：相邻折点恒共享 x 或 y（正交路由「只有横竖」的结构性保证——
 * 不逐字串断 d 形态，改断路由折点序列的几何性质，圆角过渡不破坏轴对齐）。
 */
function expectAxisAligned(points: Array<{ x: number; y: number }>): void {
  expect(points.length).toBeGreaterThanOrEqual(2)
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]
    expect(prev.x === cur.x || prev.y === cur.y).toBe(true)
  }
}

/**
 * 路由画布一体的取样样板：构造 dag → 布局 → 装配边 → 按 id 索引节点几何。
 * geo 取代的 filter 取样缺 id 时返回 undefined，用例内以非空断言取值——边有产出
 * 即端点必然在布局内，缺端点时后续属性访问抛错让用例失败（语义自暴露）。
 */
function buildRoutedCanvas(partial: Partial<WorkflowDag> = {}): {
  d: WorkflowDag
  layout: DagLayout
  geo: Map<string, DagLayoutNode>
  edges: DagLayoutEdge[]
} {
  const d = dag(partial)
  const layout = layoutDag(d)
  return {
    d,
    layout,
    geo: new Map(layout.nodes.map((ln) => [ln.node.id, ln])),
    edges: layoutEdges(d, layout.nodes),
  }
}

/** 全图最深节点底（loop-back 横行总线 y 的断言锚）。 */
function deepestBottomOf(layout: DagLayout): number {
  return Math.max(...layout.nodes.map((ln) => ln.y + ln.h))
}

/**
 * 跨列路由用例共用底座：3 phase（p0/p1/p2）× 4 节点（a→p0，r1/r2→p1，f→p2）。
 * p1 列预置 r2 作堆叠遮挡、f 压底（词法序最后），edges 由用例注入。
 */
function crossColumnCanvas(edges: WorkflowDag['edges']): Partial<WorkflowDag> {
  return {
    phases: [
      { name: 'p0', order: 0 },
      { name: 'p1', order: 1 },
      { name: 'p2', order: 2 },
    ],
    nodes: [
      node({ id: 'a', phase: 'p0' }),
      node({ id: 'r1', templateName: 'ra', phase: 'p1' }),
      node({ id: 'r2', templateName: 'rb', phase: 'p1' }),
      node({ id: 'f', templateName: 'zz', phase: 'p2' }),
    ],
    edges,
  }
}

describe('layoutEdges 正交路由（白盒）', () => {
  it('顺序边：锚点 = 源右边缘中心 → 目标左边缘中心，d 无三次贝塞尔（C 指令）', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })]
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        { ...nodes[0], phase: 'p0' },
        { ...nodes[1], phase: 'p1' },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'sequence' }],
    })
    const layout = layoutDag(d)
    const [la, lb] = layout.nodes
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points[0]).toEqual({ x: la.x + DAG_NODE_W, y: la.y + DAG_NODE_H / 2 })
    expect(edge.points[edge.points.length - 1]).toEqual({ x: lb.x, y: lb.y + DAG_NODE_H / 2 })
    expect(edge.d).not.toContain('C ')
    expect(edge.labelX).toBeDefined()
    expect(edge.labelY).toBeDefined()
  })

  it('不同行顺序边：经中位竖线的三段折线，全部折点轴对齐（横竖不变量）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', templateName: 'zb', phase: 'p1' }),
        node({ id: 'c', templateName: 'zc', phase: 'p1' }),
      ],
      // c 在 p1 列第二行（与 a 不同行）→ 走中位竖线折线
      edges: [{ id: 'e1', from: 'a', to: 'c', kind: 'dataflow' }],
    })
    const layout = layoutDag(d)
    const [la] = layout.nodes.filter((ln) => ln.node.id === 'a')
    const [lc] = layout.nodes.filter((ln) => ln.node.id === 'c')
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points).toHaveLength(4)
    expectAxisAligned(edge.points)
    // 独占通道的边错开位 = 默认中位（两锚点中位，竖线落在列间距带内）
    expect(edge.points[1].x).toBe((la.x + DAG_NODE_W + lc.x) / 2)
    expect(edge.points[1].x).toBe(edge.points[2].x)
  })

  it('同行边退化为直线（2 折点，无竖直段）', () => {
    const nodes = [node({ id: 'a' }), node({ id: 'b' })]
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        { ...nodes[0], phase: 'p0' },
        { ...nodes[1], phase: 'p1' },
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'sequence' }],
    })
    const layout = layoutDag(d)
    const [edge] = layoutEdges(d, layout.nodes)
    // 两分区各 1 节点，同列高 → y 相等 → 直线
    expect(edge.points).toHaveLength(2)
    expect(edge.points[0].y).toBe(edge.points[1].y)
    expectAxisAligned(edge.points)
  })

  it('loop-back 边：横行走全图最深节点下方总线（不穿任何节点），起终锚在两节点底边', () => {
    const { layout, geo, edges } = buildRoutedCanvas({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', templateName: 'zb', phase: 'p1' }),
        node({ id: 'c', templateName: 'zc', phase: 'p1' }),
      ],
      edges: [{ id: 'loop', from: 'b', to: 'a', kind: 'loop-back' }],
    })
    const lb = geo.get('b')!
    const deepest = deepestBottomOf(layout)
    const [edge] = edges
    expect(edge.points[0].y).toBe(lb.y + lb.h)
    // 横行总线 y 压在全图最深节点底之下（busY = deepest + LOOP_DROP）
    const busY = edge.points[3].y
    expect(busY).toBeGreaterThan(deepest)
    expect(edge.points[3].y).toBe(edge.points[4].y)
    expectAxisAligned(edge.points)
    expect(edge.labelX).toBeUndefined()
  })

  it('跨列 loop-back：下降/上升段走源/目标列侧向细道（节点列之外），不穿同列堆叠节点', () => {
    const { layout, geo, edges } = buildRoutedCanvas(
      crossColumnCanvas([{ id: 'loop', from: 'f', to: 'r1', kind: 'loop-back' }]),
    )
    const lr1 = geo.get('r1')!
    const lf = geo.get('f')!
    const deepest = deepestBottomOf(layout)
    const [edge] = edges
    expect(edge.points).toHaveLength(8)
    expectAxisAligned(edge.points)
    // 上升段 x 在目标列右缘细道（节点右缘之外、分区内边距带 CLUSTER_PAD_X=12 内）
    // ——不再沿目标底中心上升、穿过同列上方堆叠的节点卡片
    const riseX = edge.points[4].x
    expect(riseX).toBeGreaterThan(lr1.x + DAG_NODE_W)
    expect(riseX).toBeLessThan(lr1.x + DAG_NODE_W + 12)
    // 下降段 x 在源列左缘细道
    const dropX = edge.points[2].x
    expect(dropX).toBeGreaterThan(lf.x - 12)
    expect(dropX).toBeLessThan(lf.x)
    // 总线仍压在全图最深节点底之下
    expect(edge.points[3].y).toBeGreaterThan(deepest)
    // 贴边横行段下移进底边下方空隙带（回归锚定：旧实现横行段 y=节点底边，压边框）
    const fromLaneY = edge.points[1].y
    expect(fromLaneY).toBeGreaterThan(lf.y + lf.h)
    expect(fromLaneY).toBeLessThan(lf.y + lf.h + 12)
    const toLaneY = edge.points[6].y
    expect(toLaneY).toBeGreaterThan(lr1.y + lr1.h)
    expect(toLaneY).toBeLessThan(lr1.y + lr1.h + 12)
    // 终锚 = 目标底中心（细道上升 → 空隙带短横 → 底中点收锚）
    expect(edge.points[7]).toEqual({ x: lr1.x + DAG_NODE_W / 2, y: lr1.y + lr1.h })
  })

  it('跨列 loop-back（两端下方无堆叠）：四折点直连，进出垂直于底边中点、节点附近无横行段', () => {
    const { layout, geo, edges } = buildRoutedCanvas(
      crossColumnCanvas([{ id: 'loop', from: 'f', to: 'a', kind: 'loop-back' }]),
    )
    const la = geo.get('a')!
    const lf = geo.get('f')!
    const deepest = deepestBottomOf(layout)
    const [edge] = edges
    // p1 列的 r1/r2 既非端点也不在端点列——两端中轴无遮挡 → 四折点直连
    expect(edge.points).toEqual([
      { x: lf.x + DAG_NODE_W / 2, y: lf.y + lf.h },
      { x: lf.x + DAG_NODE_W / 2, y: deepest + 28 },
      { x: la.x + DAG_NODE_W / 2, y: deepest + 28 },
      { x: la.x + DAG_NODE_W / 2, y: la.y + la.h },
    ])
    expectAxisAligned(edge.points)
  })

  it('自环回边（from===to）：不产出几何（无合法四中点正交环，循环语义由重试状态呈现）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' })],
      edges: [{ id: 'self', from: 'a', to: 'a', kind: 'loop-back' }],
    })
    const layout = layoutDag(d)
    expect(layoutEdges(d, layout.nodes)).toHaveLength(0)
  })

  it('同列前向边：列右缘细道绕行（右中点出 → 右中点入），任何段不穿卡片', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' }), node({ id: 'b', templateName: 'zb' })],
      edges: [{ id: 'e-same', from: 'a', to: 'b', kind: 'conditional', predicate: 'commitPlan.stagePaths.length === 0' }],
    })
    const layout = layoutDag(d)
    const [la, lb] = layout.nodes
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points).toHaveLength(4)
    expectAxisAligned(edge.points)
    // 出锚 = 源右中点，入锚 = 目标右中点（朝向细道一侧——入左中点会让末段横线
    // 从右侧细道横穿整张目标卡片，箭头被绘制顺序遮住，回归锚定 dmg-r1-2）
    expect(edge.points[0]).toEqual({ x: la.x + DAG_NODE_W, y: la.y + la.h / 2 })
    expect(edge.points[3]).toEqual({ x: lb.x + DAG_NODE_W, y: lb.y + lb.h / 2 })
    // 末段从细道到入锚的短横线在节点右缘之外（不进入卡片 x 区间）
    expect(edge.points[2].x).toBeGreaterThan(lb.x + DAG_NODE_W)
    // 细道 x 在节点右缘之外、分区内边距带内（CLUSTER_PAD_X=12）——竖线段不穿卡片
    const gutterX = edge.points[1].x
    expect(gutterX).toBe(edge.points[2].x)
    expect(gutterX).toBeGreaterThan(la.x + DAG_NODE_W)
    expect(gutterX).toBeLessThan(la.x + DAG_NODE_W + 12)
    // 谓词标注锚在细道旁（节点列之外，不再落进卡片内部）
    expect(edge.labelX).toBe(gutterX + 5)
    expect(edge.labelY).toBe((la.y + la.h / 2 + lb.y + lb.h / 2) / 2)
  })

  it('同通道并行边（fan-in）：竖线段按错开位居中错开，不再重合成一根线', () => {
    const { layout, geo, edges } = buildRoutedCanvas({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', templateName: 'aa', phase: 'p0' }),
        node({ id: 'b', templateName: 'bb', phase: 'p0' }),
        node({ id: 'c', templateName: 'cc', phase: 'p0' }),
        // 目标列占位节点：把 f 排到第 4 行——三条边源行各不同且都不与 f 同行
        //（同行退化为直线不进通道，测不到错开分配）
        node({ id: 't0', templateName: 'pa', phase: 'p1' }),
        node({ id: 't1', templateName: 'pb', phase: 'p1' }),
        node({ id: 't2', templateName: 'pc', phase: 'p1' }),
        node({ id: 'f', templateName: 'zz', phase: 'p1' }),
      ],
      edges: [
        { id: 'e1', from: 'a', to: 'f', kind: 'dataflow' },
        { id: 'e2', from: 'b', to: 'f', kind: 'dataflow' },
        { id: 'e3', from: 'c', to: 'f', kind: 'dataflow' },
      ],
    })
    const la = geo.get('a')!
    const lf = geo.get('f')!
    const routed = edges.filter((le) => le.edge.id.startsWith('e'))
    expect(routed).toHaveLength(3)
    const laneXs = routed.map((le) => le.points[1].x)
    // 三根竖线 x 互不相同（默认中位竖线重合缺陷已修）
    expect(new Set(laneXs).size).toBe(3)
    // 错开位以默认中位为中心、按 LANE_STEP_PX 居中分布，且跟随源 y 序（横支互不交叉）
    const midX = (la.x + DAG_NODE_W + lf.x) / 2
    const sorted = [...laneXs].sort((x, y) => x - y)
    expect(sorted[0]).toBeCloseTo(midX - LANE_STEP_PX, 6)
    expect(sorted[1]).toBeCloseTo(midX, 6)
    expect(sorted[2]).toBeCloseTo(midX + LANE_STEP_PX, 6)
    for (const le of routed) expectAxisAligned(le.points)
  })

  it('同列 loop-back：走分区左内边距侧向细道（不在节点列内折返），贴边段不压底边框', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' }), node({ id: 'b', templateName: 'zb' })],
      edges: [{ id: 'loop', from: 'b', to: 'a', kind: 'loop-back' }],
    })
    const layout = layoutDag(d)
    const [la] = layout.nodes.filter((ln) => ln.node.id === 'a')
    const [lb] = layout.nodes.filter((ln) => ln.node.id === 'b')
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.points).toHaveLength(6)
    expectAxisAligned(edge.points)
    // 侧向细道 x 在节点左缘与分区左缘之间（内边距带内）
    const sideX = edge.points[2].x
    expect(sideX).toBeLessThan(la.x)
    expect(sideX).toBeGreaterThan(la.x - 12)
    // 贴边横行段各自下移进所属节点底边下方空隙带（源 b 在下、目标 a 在上，不压边框）
    const fromLaneY = edge.points[2].y
    expect(fromLaneY).toBeGreaterThan(lb.y + lb.h)
    expect(fromLaneY).toBeLessThan(lb.y + lb.h + 12)
    const toLaneY = edge.points[3].y
    expect(toLaneY).toBeGreaterThan(la.y + la.h)
    expect(toLaneY).toBeLessThan(la.y + la.h + 12)
    expect(edge.points[5]).toEqual({ x: la.x + DAG_NODE_W / 2, y: la.y + la.h })
  })

  it('连线锚点纪律：全部边首末折点只落在节点四条边的中点（4 个连线点）', () => {
    const { layout, geo, edges } = buildRoutedCanvas(crossColumnCanvas([
      { id: 'e-seq', from: 'a', to: 'r1', kind: 'sequence' },
      { id: 'e-df', from: 'r2', to: 'f', kind: 'dataflow' },
      { id: 'loop-x', from: 'f', to: 'r1', kind: 'loop-back' },
      { id: 'loop-same', from: 'r2', to: 'r1', kind: 'loop-back' },
    ]))
    const midpoints = (ln: { x: number; y: number; h: number }) => [
      { x: ln.x + DAG_NODE_W / 2, y: ln.y },
      { x: ln.x + DAG_NODE_W / 2, y: ln.y + ln.h },
      { x: ln.x, y: ln.y + ln.h / 2 },
      { x: ln.x + DAG_NODE_W, y: ln.y + ln.h / 2 },
    ]
    for (const le of edges) {
      const from = geo.get(le.edge.from)
      const to = geo.get(le.edge.to)
      expect(from).toBeDefined()
      expect(to).toBeDefined()
      const first = le.points[0]
      const last = le.points[le.points.length - 1]
      expect(midpoints(from!).some((m) => m.x === first.x && m.y === first.y)).toBe(true)
      expect(midpoints(to!).some((m) => m.x === last.x && m.y === last.y)).toBe(true)
    }
  })

  it('条件边谓词标注锚在中位竖线旁（labelX = 竖线 x + 间隙）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }, { name: 'p1', order: 1 }],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', templateName: 'zb', phase: 'p1' }),
      ],
      edges: [{ id: 'e-cond', from: 'a', to: 'b', kind: 'conditional', predicate: 'fixMode' }],
    })
    const layout = layoutDag(d)
    const [edge] = layoutEdges(d, layout.nodes)
    expect(edge.labelX).toBeDefined()
    expect(edge.labelY).toBeDefined()
  })

  it('端点缺失的边跳过不抛（防御解析器缺口）', () => {
    const d = dag({
      phases: [{ name: 'p0', order: 0 }],
      nodes: [node({ id: 'a' })],
      edges: [{ id: 'e-bad', from: 'a', to: 'missing', kind: 'sequence' }],
    })
    const layout = layoutDag(d)
    expect(() => layoutEdges(d, layout.nodes)).not.toThrow()
    expect(layoutEdges(d, layout.nodes)).toHaveLength(0)
  })
})

// ── 通道竖线避让 + 同行直线绕行（workflow-viz-fit-and-routing 设计残余 3/5，白盒）──

describe('layoutEdges 通道竖线避让（残余 3，白盒）', () => {
  /** 走廊带中心（按布局产物几何推算，不手算绝对坐标）：lo = 左列节点右缘，hi = 右列节点左缘。 */
  function corridorCenter(left: DagLayoutNode, right: DagLayoutNode): number {
    return (left.x + DAG_NODE_W + right.x) / 2
  }

  it('隔列边中位竖线穿中间列节点带 → 整体迁移到唯一零穿卡走廊（三段全程校验）', () => {
    // a(row1, y=70) → f(p2 row3, y=194)：p1 两行节点（row2 [110,154] 被中位 302 竖线穿过）；
    // 408 走廊的「源右缘→竖线」横段 @70 被 p1 row1 节点挡（走查反例：横段也要查），
    // 196 走廊零穿卡 → 迁移到 196
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'm0', phase: 'p1' }),
        node({ id: 'm', templateName: 'zm', phase: 'p1' }),
        node({ id: 'fa', phase: 'p2' }),
        node({ id: 'fb', templateName: 'zfa', phase: 'p2' }),
        node({ id: 'f', templateName: 'zz', phase: 'p2' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const expected = corridorCenter(geo.get('a')!, geo.get('m0')!)
    expect(edge.points[1].x).toBe(expected)
    expect(edge.points[2].x).toBe(expected)
    expectAxisAligned(edge.points)
  })

  it('两走廊均零穿卡且等距 → 取较大 x（等距裁决）', () => {
    // a(p0 row2, y=132) → f(p2 row4, y=256)：中位 302 竖线被 p2 row2 [110,154] 穿过
    //（p1 仅 row1 [48,92]，不拦 132/256）；196 与 408 走廊均零穿卡、距中位各 106
    // → 等距取较大 x（408）
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'p0f', templateName: 'a0', phase: 'p0' }),
        node({ id: 'a', templateName: 'a1', phase: 'p0' }),
        node({ id: 'm', phase: 'p1' }),
        node({ id: 'p2a', templateName: 'b0', phase: 'p2' }),
        node({ id: 'p2b', templateName: 'b1', phase: 'p2' }),
        node({ id: 'p2c', templateName: 'b2', phase: 'p2' }),
        node({ id: 'f', templateName: 'b3', phase: 'p2' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const corridorNear = corridorCenter(geo.get('p0f')!, geo.get('m')!)
    const corridorFar = corridorCenter(geo.get('m')!, geo.get('p2a')!)
    const midX = (geo.get('a')!.x + DAG_NODE_W + geo.get('f')!.x) / 2
    // 等距前提自证：两走廊距原中位相等
    expect(midX - corridorNear).toBeCloseTo(corridorFar - midX, 6)
    expect(edge.points[1].x).toBe(corridorFar)
    expect(edge.points[2].x).toBe(corridorFar)
    expectAxisAligned(edge.points)
  })

  it('同通道双成员迁移：整体平移同一差值，车道相对错开保持', () => {
    // 双车道通道（e1=[70,194] 与 e2=[132,256] 纵向跨度重叠 → 两个游程两条车道）：
    // 中位竖线分别被 p1 row1（e1 段）与 p2 row2（e2 段）穿过 → 迁移到 196 走廊后
    // 两成员 laneX 差仍为一个 LANE_STEP
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'c', phase: 'p0' }),
        node({ id: 'a', templateName: 'za', phase: 'p0' }),
        node({ id: 'm', phase: 'p1' }),
        node({ id: 'p2a', templateName: 'b0', phase: 'p2' }),
        node({ id: 'p2b', templateName: 'b1', phase: 'p2' }),
        node({ id: 'g', templateName: 'b2', phase: 'p2' }),
        node({ id: 'f', templateName: 'b3', phase: 'p2' }),
      ],
      edges: [
        { id: 'e1', from: 'c', to: 'g', kind: 'dataflow' },
        { id: 'e2', from: 'a', to: 'f', kind: 'dataflow' },
      ],
    })
    const routed = edges.filter((le) => le.edge.id.startsWith('e'))
    expect(routed).toHaveLength(2)
    const byId = new Map(routed.map((le) => [le.edge.id, le]))
    const laneC = byId.get('e1')!.points[1].x
    const laneA = byId.get('e2')!.points[1].x
    expect(Math.abs(laneA - laneC)).toBeCloseTo(LANE_STEP_PX, 6)
    // 整体落在 p0|p1 走廊（唯一零穿卡候选）内
    const corridor = corridorCenter(geo.get('c')!, geo.get('m')!)
    expect(Math.min(laneA, laneC)).toBeGreaterThan(corridor - LANE_STEP_PX)
    expect(Math.max(laneA, laneC)).toBeLessThan(corridor + LANE_STEP_PX + 0.5)
    expectAxisAligned(byId.get('e1')!.points)
    expectAxisAligned(byId.get('e2')!.points)
  })

  it('无零穿卡候选 → 取穿卡线段数最少者（残留分支；并列时等距取较大 x）', () => {
    // a(row1, y=70) → j(p3 row3, y=194)，四列中位 = 408：196 = seg3@194（p1c+p2c）1 段；
    // 408 = seg1@70 + seg3@194 = 2 段；620 = seg1@70（p1a+p2a）= 1 段——
    // 最少穿卡并列 {196, 620}，距中位 408 各 212 等距 → 取较大 x = 620
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
        { name: 'p3', order: 3 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'p1a', phase: 'p1' }),
        node({ id: 'p1b', templateName: 'pb', phase: 'p1' }),
        node({ id: 'p1c', templateName: 'pc', phase: 'p1' }),
        node({ id: 'p2a', templateName: 'qa', phase: 'p2' }),
        node({ id: 'p2b', templateName: 'qb', phase: 'p2' }),
        node({ id: 'p2c', templateName: 'qc', phase: 'p2' }),
        node({ id: 'p3a', templateName: 'ra', phase: 'p3' }),
        node({ id: 'p3b', templateName: 'rb', phase: 'p3' }),
        node({ id: 'j', templateName: 'rc', phase: 'p3' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'j', kind: 'dataflow' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const expected = corridorCenter(geo.get('p2c')!, geo.get('j')!)
    expect(edge.points[1].x).toBe(expected)
    expectAxisAligned(edge.points)
  })

  it('走廊容不下车道铺开（≥11 游程）→ 降级单线宽并线到零穿卡走廊中心', () => {
    // 11 条错位目标边（源 row k → 目标 row k+11）：纵向跨度两两相交 → 11 个游程
    // → 车道铺开 60px > 走廊 56 − 2×2 净距 → 无可容纳候选 → 全体并线到走廊中心
    const rowName = (k: number): string => `n${String(k).padStart(2, '0')}`
    const p0Nodes = Array.from({ length: 11 }, (_, i) => node({ id: `s${rowName(i + 1)}`, templateName: rowName(i + 1), phase: 'p0' }))
    const p1Nodes = Array.from({ length: 22 }, (_, i) => node({ id: `t${rowName(i + 1)}`, templateName: rowName(i + 1), phase: 'p1' }))
    const edges = Array.from({ length: 11 }, (_, i) => ({
      id: `e${i}`,
      from: `s${rowName(i + 1)}`,
      to: `t${rowName(i + 12)}`,
      kind: 'dataflow' as const,
    }))
    const { geo, edges: routed } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
      ],
      nodes: [...p0Nodes, ...p1Nodes],
      edges,
    })
    const laneXs = routed.map((le) => le.points[1].x)
    expect(laneXs).toHaveLength(11)
    // 并线：全部车道重合于走廊中心（原铺开 ±30 不可容纳）
    const anySource = geo.get(`s${rowName(1)}`)!
    const anyTarget = geo.get(`t${rowName(12)}`)!
    const midX = (anySource.x + DAG_NODE_W + anyTarget.x) / 2
    for (const lane of laneXs) expect(lane).toBeCloseTo(midX, 6)
    for (const le of routed) expectAxisAligned(le.points)
  })

  it('降级并线仍无零穿卡走廊 → 保持车道分配原状（中位残留分支，白盒直喂几何输入）', () => {
    // 「仍无」分支在标准网格不可达（seg3 的 y2 恒为自身目标行，p1 节点拦不住）——
    // 按设计 U3「纯函数直喂几何输入的白盒用例」原意直接构造通道：车道铺开 60 不可
    // 容纳 → 并线重评时 196 被 e1 seg3@132（p1 row2）挡、408 被 e1 seg1@70（p1 row1）
    // 挡 → 两走廊均非零穿卡 → 保持原车道 [166, 196, 226]
    const nodes: DagLayoutNode[] = [
      { node: node({ id: 'src', phase: 'p0' }), x: 12, y: 48, h: 44 },
      { node: node({ id: 'm0', phase: 'p1' }), x: 224, y: 48, h: 44 },
      { node: node({ id: 'm2', phase: 'p1' }), x: 224, y: 110, h: 44 },
      { node: node({ id: 'm3', phase: 'p1' }), x: 224, y: 172, h: 44 },
      { node: node({ id: 'dst', phase: 'p2' }), x: 436, y: 48, h: 44 },
    ]
    const members: ChannelMember[] = [
      { x1: 168, y1: 70, x2: 436, y2: 132, lo: 70, hi: 132, laneX: 166, fromId: 'src', toId: 'dst' },
      { x1: 168, y1: 194, x2: 436, y2: 256, lo: 194, hi: 256, laneX: 196, fromId: 'src', toId: 'dst' },
      { x1: 168, y1: 318, x2: 436, y2: 380, lo: 318, hi: 380, laneX: 226, fromId: 'src', toId: 'dst' },
    ]
    avoidObstructedChannelMid(new Map([['168|436', members]]), nodes)
    expect(members.map((m) => m.laneX)).toEqual([166, 196, 226])
  })
})

describe('layoutEdges 同行直线边绕行（残余 5，白盒）', () => {
  it('同行隔列边中间列有节点 → 升级上下绕行 4 折线（等距取上），不穿卡', () => {
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'm', phase: 'p1' }),
        node({ id: 'f', phase: 'p2' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'conditional', predicate: 'fixMode' }],
    })
    const [edge] = edges.filter((le) => le.edge.id === 'e1')
    const lm = geo.get('m')!
    // 上下等距（障碍行底 +12 与行顶 −12 距边 y 相等）→ 取上
    const yB = lm.y - 12
    expect(edge.points).toHaveLength(4)
    expect(edge.points[1]).toEqual({ x: edge.points[0].x, y: yB })
    expect(edge.points[2]).toEqual({ x: edge.points[3].x, y: yB })
    expectAxisAligned(edge.points)
    // conditional 谓词标注锚随迁绕行横段（中点 x、横段 y）
    expect(edge.labelY).toBe(yB)
    expect(edge.labelX).toBe((edge.points[0].x + edge.points[3].x) / 2)
  })

  it('无障碍同行边保持直线零扰动（labelX/labelY 现行公式不变）', () => {
    const { geo, edges } = buildRoutedCanvas({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
      ],
      nodes: [
        node({ id: 'a', phase: 'p0' }),
        node({ id: 'b', phase: 'p1' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'b', kind: 'sequence' }],
    })
    const [edge] = edges
    expect(edge.points).toHaveLength(2)
    expect(edge.labelX).toBe((edge.points[0].x + edge.points[1].x) / 2)
    expect(edge.labelY).toBe(edge.points[0].y)
  })

  it('上方绕行带被高个节点覆盖 → 落到下方绕行带（近者规则的方向回退）', () => {
    // a/f 在 row2（y=132），p2 的 m(row2) 是障碍；p1 的 th(row1) 加高到 [48,128]
    // 覆盖上方带 110−12=98 → 回退下方 154+12=166（p1 无 row2 节点，无覆盖）
    const canvas = dag({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
        { name: 'p3', order: 3 },
      ],
      nodes: [
        node({ id: 'p0f', templateName: 'a0', phase: 'p0' }),
        node({ id: 'a', templateName: 'a1', phase: 'p0' }),
        node({ id: 'th', phase: 'p1' }),
        node({ id: 'p2f', templateName: 'b0', phase: 'p2' }),
        node({ id: 'm', templateName: 'b1', phase: 'p2' }),
        node({ id: 'p3f', templateName: 'c0', phase: 'p3' }),
        node({ id: 'f', templateName: 'c1', phase: 'p3' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    })
    const layout = layoutDag(canvas, new Map([['th', dagNodeHeight(2)]]))
    const lm = layout.nodes.find((ln) => ln.node.id === 'm')!
    const [edge] = layoutEdges(canvas, layout.nodes).filter((le) => le.edge.id === 'e1')
    const yB = lm.y + lm.h + 12
    expect(edge.points).toHaveLength(4)
    expect(edge.points[1].y).toBe(yB)
    expect(edge.points[2].y).toBe(yB)
    expect(edge.labelY).toBe(yB)
    expectAxisAligned(edge.points)
  })

  it('上下绕行带均被覆盖 → 保持直线登记残留（现行直线公式不变）', () => {
    // 同上图但 p1 增补 row2 节点 tm [146,190] 覆盖下方带 166 → 两方向均败 → 直线
    const layout = layoutDag(dag({
      phases: [
        { name: 'p0', order: 0 },
        { name: 'p1', order: 1 },
        { name: 'p2', order: 2 },
        { name: 'p3', order: 3 },
      ],
      nodes: [
        node({ id: 'p0f', templateName: 'a0', phase: 'p0' }),
        node({ id: 'a', templateName: 'a1', phase: 'p0' }),
        node({ id: 'th', phase: 'p1' }),
        node({ id: 'tm', templateName: 'tb', phase: 'p1' }),
        node({ id: 'p2f', templateName: 'b0', phase: 'p2' }),
        node({ id: 'm', templateName: 'b1', phase: 'p2' }),
        node({ id: 'p3f', templateName: 'c0', phase: 'p3' }),
        node({ id: 'f', templateName: 'c1', phase: 'p3' }),
      ],
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    }), new Map([
      ['th', dagNodeHeight(2)],
      ['tm', dagNodeHeight(2)],
    ]))
    const [edge] = layoutEdges(dag({
      phases: layout.clusters.map((c, i) => ({ name: c.phase, order: i })),
      nodes: layout.nodes.map((ln) => ln.node),
      edges: [{ id: 'e1', from: 'a', to: 'f', kind: 'dataflow' }],
    }), layout.nodes)
    expect(edge.points).toHaveLength(2)
    expect(edge.labelY).toBe(edge.points[0].y)
    expect(edge.labelX).toBe((edge.points[0].x + edge.points[1].x) / 2)
  })
})

describe('dagNodeHeight 节点高（实例数派生）', () => {
  it('0/1 实例 = 基准高（单实例 agent 名直接作标题，不另起行）', () => {
    expect(dagNodeHeight(0)).toBe(DAG_NODE_H)
    expect(dagNodeHeight(1)).toBe(DAG_NODE_H)
  })

  it('≥2 实例 = 基准高 + 实例行区（每实例一行）', () => {
    expect(dagNodeHeight(2)).toBe(DAG_NODE_H + 2 * INSTANCE_ROW_H + 4)
    expect(dagNodeHeight(5)).toBe(DAG_NODE_H + 5 * INSTANCE_ROW_H + 4)
  })
})

describe('layoutDag nodeHeights 高度表消费', () => {
  it('增高节点占据更大纵向步进，分区高度随之增长（卡片与布局同表不溢出）', () => {
    const nodes = [node({ id: 'a', templateName: 'aa' }), node({ id: 'b', templateName: 'zb' })]
    const d = dag({ phases: [{ name: 'p0', order: 0 }], nodes })
    const tall = dagNodeHeight(3)
    const layout = layoutDag(d, new Map([['a', tall]]))
    const [la, lb] = layout.nodes
    expect(la.h).toBe(tall)
    expect(lb.h).toBe(DAG_NODE_H)
    // b 的 y = a 底 + 行距（步进按实际高度累加）
    expect(lb.y).toBe(la.y + tall + 18)
    expect(layout.clusters[0].height).toBeGreaterThanOrEqual(tall + DAG_NODE_H + 18)
  })
})

describe('computeFitTransform fit-to-view（默认打开全图居中、四周 FIT_PAD_PX 留白）', () => {
  it('内容小于视口：k 封顶 1 不放大，两轴居中', () => {
    const fit = computeFitTransform(1000, 800, 180, 100)
    expect(fit.k).toBe(1)
    expect(fit.tx).toBe((1000 - 180) / 2)
    expect(fit.ty).toBe((800 - 100) / 2)
  })

  it('内容某轴超出视口：缩到该轴 pad 内贴边，另一轴居中', () => {
    const fit = computeFitTransform(800, 300, 392, 352)
    expect(fit.k).toBeCloseTo((300 - FIT_PAD_PX * 2) / 352, 6)
    expect(fit.tx).toBeGreaterThan(FIT_PAD_PX)
    expect(fit.ty).toBeCloseTo(FIT_PAD_PX, 6)
  })

  it('超大内容：缩放下限 ZOOM_MIN 兜底（仍居中，pan 可达）', () => {
    const fit = computeFitTransform(100, 100, 2000, 2000)
    expect(fit.k).toBe(ZOOM_MIN)
    expect(fit.tx).toBeCloseTo((100 - 2000 * ZOOM_MIN) / 2, 6)
  })

  it('容器无布局环境（两轴缺失）：退化 k=1 平移 0，不破坏渲染', () => {
    expect(computeFitTransform(0, 0, 180, 100)).toEqual({ k: 1, tx: 0, ty: 0 })
  })

  it('单轴缺失：该轴不参与缩放约束且偏移 0，另一轴正常 fit', () => {
    const fit = computeFitTransform(1000, 0, 180, 100)
    expect(fit.k).toBe(1)
    expect(fit.tx).toBe((1000 - 180) / 2)
    expect(fit.ty).toBe(0)
  })
})
})

// ═══════════ 来源节：workflow-viz-dag-legend ═══════════

describe('workflow-viz-dag-legend', () => {
/** 七态词表序（图例条目序；cancelled 为 §3.3.8 新增中性档；tone 同源断言逐一覆盖）。 */
const STATES: WorkflowVizDagNodeStatus[] = ['pending', 'running', 'done', 'failed', 'retrying', 'cancelled', 'skipped']

function stateNode(state: WorkflowVizDagNodeStatus, line: number): WorkflowDagNode {
  return { id: `n-${state}`, kind: 'agent', templateName: state, matchPattern: '', phase: 'p', line }
}

function stateDag(): WorkflowDag {
  return {
    phases: [{ name: 'p', order: 0 }],
    nodes: STATES.map((state, i) => stateNode(state, i + 1)),
    edges: [],
    parallelGroups: [],
    loops: [],
  }
}

function run(): WorkflowRunRecord {
  return {
    runId: 'wf-1',
    scriptName: 'pr-lifecycle',
    slug: 'pr-lifecycle-7f3a',
    status: 'running',
    startedAt: '2026-10-02T00:00:00Z',
    agentCalls: [],
    stateFilePath: '',
  }
}

function mountLegend(props: Record<string, unknown> = {}) {
  return mount(WorkflowVizOverlay, {
    props: {
      open: true,
      run: run(),
      dag: stateDag(),
      nodeStates: Object.fromEntries(STATES.map((state) => [`n-${state}`, state])),
      dagError: null,
      ...props,
    },
  })
}

describe('WorkflowVizDag 图例（workflow-overlay-refine D4）', () => {
  it('V3-wf① tone 同源：图例七态 dot 与 DAG 节点 dot 的 fill 类逐一相同，且图例 dot 无脉冲类', () => {
    const wrapper = mountLegend()
    for (const state of STATES) {
      const nodeDot = wrapper.find(`[data-testid="wfvz-dag-node-n-${state}"] circle`)
      const legendDot = wrapper.find(`[data-testid="wfvz-dag-legend-dot-${state}"]`)
      expect(legendDot.exists()).toBe(true)
      // 节点 dot 的全部 fill 类（静态基础类 + tone 类）都必须出现在图例 dot 上
      // ——「图例 = DAG 的图例」由类名同源构造性保证（dag/tone.ts dotTone 单源）
      const nodeFills = nodeDot.classes().filter((cls) => cls.startsWith('fill-['))
      expect(nodeFills.length).toBeGreaterThan(0)
      for (const cls of nodeFills) {
        expect(legendDot.classes()).toContain(cls)
      }
      // 脉冲是节点态、不是图例态：图例 dot 恒静态色
      expect(legendDot.classes().some((cls) => cls.includes('wfvz-node-pulse'))).toBe(false)
    }
  })

  it('V3-wf① 图例七态 dot 各恰一个 fill 类且为 tone 色（无基础中性类竞争——单 fill 类消发射序覆盖）', () => {
    const wrapper = mountLegend()
    for (const state of STATES) {
      const dot = wrapper.find(`[data-testid="wfvz-dag-legend-dot-${state}"]`)
      const fills = dot.classes().filter((cls) => cls.startsWith('fill-['))
      expect(fills).toHaveLength(1)
      expect(fills[0]).toBe(dotTone(state))
    }
  })

  it('V3-wf① 图例七态词可见（现值词族 + skipped / cancelled 新词）', () => {
    const wrapper = mountLegend()
    const text = wrapper.find('[data-testid="wfvz-dag-legend"]').text()
    expect(text).toContain('等待中')
    expect(text).toContain('运行中')
    expect(text).toContain('完成')
    expect(text).toContain('失败')
    expect(text).toContain('重试中')
    expect(text).toContain('已取消')
    expect(text).toContain('已跳过')
  })

  it('V3-wf② 停止叠加两档说明由图例容器 title 承载（neutral / failed 档位不入常驻图例）', () => {
    const wrapper = mountLegend()
    const title = wrapper.find('[data-testid="wfvz-dag-legend"]').attributes('title') ?? ''
    expect(title).toContain('已中断')
    expect(title).toContain('超时')
    // 两档说明在 title，不作为图例条目渲染（图例只含七态 dot）
    expect(wrapper.find('[data-testid="wfvz-dag-legend"]').findAll('circle')).toHaveLength(7)
  })

  it('V3-wf⑤ 图例绝对定位层不拦截交互：pointer-events-none + 节点点击上抛照常 + wheel 缩放照常', async () => {
    const wrapper = mountLegend()
    const legend = wrapper.find('[data-testid="wfvz-dag-legend"]')
    expect(legend.classes()).toContain('pointer-events-none')
    expect(legend.classes()).toContain('absolute')
    // 图例在场时 pending 节点点击照常上抛（phase 语义；[2026-10-19] agent 语义已删）
    const pendingNode = wrapper.find('[data-testid="wfvz-dag-node-n-pending"]')
    await pendingNode.trigger('pointerdown')
    await pendingNode.trigger('pointerup')
    const events = wrapper.emitted('select')
    expect(events).toHaveLength(1)
    expect(events?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'p' })
    // 图例在场时 wheel 缩放照常生效（视口 transform 偏离初始 1:1）
    const viewport = wrapper.find('[data-testid="wfvz-dag-viewport"]')
    expect(viewport.attributes('transform')).toContain('scale(1)')
    await wrapper.find('[data-testid="wfvz-dag-svg"]').trigger('wheel', { deltaY: -240 })
    expect(viewport.attributes('transform')).not.toContain('scale(1)')
  })

  it('图例仅随 DAG 画布在场：DAG 不可得降级形态（dagError）无图例', () => {
    const wrapper = mountLegend({ dag: null, dagError: { code: 'record_not_found', message: 'no record' } })
    expect(wrapper.find('[data-testid="wfvz-dag-legend"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-overlay-dag-fallback"]').exists()).toBe(true)
  })
})
})

// ═══════════ 来源节：workflow-viz-dag ═══════════

describe('workflow-viz-dag', () => {
function node(partial: Partial<WorkflowDagNode> & { id: string }): WorkflowDagNode {
  return {
    kind: 'agent',
    templateName: partial.id,
    matchPattern: '',
    phase: 'gate',
    line: 1,
    ...partial,
  }
}

function sampleDag(): WorkflowDag {
  return {
    phases: [
      { name: 'gate', order: 0 },
      { name: 'review', order: 1 },
    ],
    nodes: [
      node({ id: 'n-gate', templateName: 'preflight', kind: 'script-step', phase: 'gate' }),
      node({ id: 'n-biz', templateName: 'reviewer-biz', phase: 'review' }),
      node({ id: 'n-sec', templateName: 'reviewer-sec', phase: 'review' }),
    ],
    edges: [
      { id: 'e-seq', from: 'n-gate', to: 'n-biz', kind: 'sequence' },
      { id: 'e-cond', from: 'n-biz', to: 'n-sec', kind: 'conditional', predicate: 'fixMode === apply' },
      { id: 'e-loop', from: 'n-sec', to: 'n-biz', kind: 'loop-back' },
    ],
    parallelGroups: [],
    loops: [],
  }
}

function mountDag(dagInput: WorkflowDag | null = sampleDag(), props: Record<string, unknown> = {}) {
  return mount(WorkflowVizDag, {
    props: { dag: dagInput, ...props },
  })
}

/** 解析 viewport transform（jsdom 下数值断言用，避免浮点字面量碎支）。 */
function readViewport(wrapper: ReturnType<typeof mountDag>): { k: number; tx: number; ty: number } {
  const raw = wrapper.find('[data-testid="wfvz-dag-viewport"]').attributes('transform') ?? ''
  const m = raw.match(/translate\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\) scale\((\d+(?:\.\d+)?)\)/)
  expect(m).not.toBeNull()
  return { tx: Number(m?.[1]), ty: Number(m?.[2]), k: Number(m?.[3]) }
}

describe('WorkflowVizDag 画布（黑盒 DOM）', () => {
  it('渲染 phase 分区列与全部节点卡片（用户可见：分区标题与节点名）', () => {
    const wrapper = mountDag()
    expect(wrapper.find('[data-testid="wfvz-dag-root"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-review"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').exists()).toBe(true)
    // 节点名可见（截断前缀）
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').text()).toContain('preflight')
    // 三条边（顺序/条件/回边）渲染
    expect(wrapper.find('[data-testid="wfvz-dag-edge-e-seq"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-edge-e-cond"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-edge-e-loop"]').exists()).toBe(true)
  })

  it('边带方向箭头：marker 定义存在，每条边 path 挂 marker-end（流向 = 目标锚点）', () => {
    const wrapper = mountDag()
    const marker = wrapper.find('[data-testid="wfvz-dag-arrow-def"]')
    expect(marker.exists()).toBe(true)
    // context-stroke 继承各边 kind 描边色（箭头颜色随边色，不另设 4 份 marker）
    expect(marker.find('path').attributes('fill')).toBe('context-stroke')
    for (const id of ['e-seq', 'e-cond', 'e-loop']) {
      expect(wrapper.find(`[data-testid="wfvz-dag-edge-${id}"]`).attributes('marker-end')).toBe(
        'url(#wfvz-dag-arrow)',
      )
    }
  })

  it('六态点亮：nodeStates 映射到节点 data-state（观察者形态）', () => {
    const nodeStates: Record<string, WorkflowVizDagNodeStatus> = {
      'n-gate': 'done',
      'n-biz': 'running',
      'n-sec': 'retrying',
    }
    const wrapper = mountDag(sampleDag(), { nodeStates })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').attributes('data-state')).toBe('done')
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-state')).toBe('running')
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-sec"]').attributes('data-state')).toBe('retrying')
  })

  it('缺失映射的节点按 pending 兜底（run 运行中零实例节点一律 pending）', () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-gate': 'done' } })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').attributes('data-state')).toBe('done')
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-state')).toBe('pending')
  })

  it('pending 节点卡片有中性描边（卡片 fill 与分区背景同为 surface，缺描边即隐形）', () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-gate': 'done' } })
    const rect = wrapper.find('[data-testid="wfvz-dag-node-n-biz"] rect')
    expect(rect.classes()).toContain('stroke-[var(--neutral-dim)]')
  })

  it('当前 phase 分区高亮：activePhase 命中分区 data-active（观察者形态）', () => {
    const wrapper = mountDag(sampleDag(), { activePhase: 'review' })
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-review"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').attributes('data-active')).toBeUndefined()
  })

  it('agent 节点点击 no-op（[2026-10-19] agent 钻取语义删除——节点纯展示，钻取入口 = 实例 trace 行）', async () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-biz': 'done' } })
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerup')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('pending 节点点击 = phase 语义（零实例、无对话可看）', async () => {
    const wrapper = mountDag(sampleDag())
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'review' })
  })

  it('run 终局后 skipped 节点点击 = phase 语义（与 pending 同路由，非静默 no-op）', async () => {
    const wrapper = mountDag(sampleDag(), { nodeStates: { 'n-biz': 'skipped' } })
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'review' })
  })

  it('phase 分区点击 → select phase 语义', async () => {
    const wrapper = mountDag(sampleDag())
    await wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').trigger('pointerup')
    expect(wrapper.emitted('select')?.[0]?.[0]).toEqual({ semantic: 'phase', phase: 'gate' })
  })

  it('条件边谓词标注可见（用户可见：predicate 截断文本）', () => {
    const wrapper = mountDag(sampleDag())
    const labels = wrapper.findAll('text').filter((t) => t.text().includes('fixMode'))
    expect(labels.length).toBeGreaterThan(0)
  })
})

describe('WorkflowVizDag 停止叠加（D9 着色映射）', () => {
  it('run 运行中：无停止叠加（在途节点正常蓝脉冲）', () => {
    const wrapper = mountDag(sampleDag(), { runStatus: 'running' })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBeUndefined()
  })

  it('interrupted 暂停态：在途节点叠加中性暗（stopTone=neutral）', () => {
    const wrapper = mountDag(sampleDag(), { runStatus: 'interrupted' })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('neutral')
  })

  it('done + failed/time_limited 终局：叠加失败色系（stopTone=failed）', () => {
    const failed = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'failed' })
    expect(failed.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('failed')
    const limited = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'time_limited' })
    expect(limited.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('failed')
  })

  it('done + cancelled 终局：取消色中性暗（stopTone=neutral，tray-tone 同语义同色先例）', () => {
    const wrapper = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'cancelled' })
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').attributes('data-stop-tone')).toBe('neutral')
  })

  it('正常完成 run（outcome=done）：无叠加（done 节点 success 六态自明，D9 done=success 供扫读）', () => {
    const states: Record<string, WorkflowVizDagNodeStatus> = { 'n-gate': 'done', 'n-biz': 'skipped' }
    const wrapper = mountDag(sampleDag(), { runStatus: 'done', runOutcome: 'done', nodeStates: states })
    const node = wrapper.find('[data-testid="wfvz-dag-node-n-biz"]')
    expect(node.attributes('data-stop-tone')).toBeUndefined()
    // dot 单 fill 类 = tone 色（无基础中性类竞争——D3 剧本实锤的中性灰根因已修）
    const dot = node.find('circle')
    expect(dot.classes().filter((c) => c.startsWith('fill-['))).toEqual(['fill-[var(--neutral-dim)]'])
    // done 节点 dot 恢复 success 绿
    const doneDot = wrapper.find('[data-testid="wfvz-dag-node-n-gate"] circle')
    expect(doneDot.classes()).toContain('fill-[var(--success)]')
    expect(doneDot.classes().filter((c) => c.startsWith('fill-['))).toHaveLength(1)
  })
})

describe('WorkflowVizDag 节点级渲染边界与零节点形态', () => {
  it('单节点 SVG 生成失败 = 节点占位错误态，其余节点不受影响', async () => {
    const bad = sampleDag()
    // 模拟渲染违约节点：id 空串触发节点组件 fail-fast 检查（布局产物正常不可达；
    // 防御路径 = WorkflowVizDagNodeGuard 捕获后渲染占位错误态）
    bad.nodes = [...bad.nodes, node({ id: '' })]
    const wrapper = mountDag(bad)
    // 占位错误态出现（failed 置位 → 重渲染在下一 tick）
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="wfvz-dag-node-error"]').exists()).toBe(true)
    // 其余节点正常挂载（故障隔离粒度 = 单节点）
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-gate"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').exists()).toBe(true)
  })

  it('零节点 run（纯门禁脚本）：居中摘要提示「本脚本无 agent 调用点」', () => {
    const empty: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }
    const wrapper = mountDag(empty)
    expect(wrapper.find('[data-testid="wfvz-dag-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-empty"]').text()).toContain('本脚本无 agent 调用点')
  })

  it('切换 run（dag 引用变化）后画布可用（单例切内容的画布面）', async () => {
    const wrapper = mountDag(sampleDag())
    const next: WorkflowDag = {
      phases: [{ name: 'solo', order: 0 }],
      nodes: [node({ id: 'solo', phase: 'solo' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: next })
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-solo"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-node-solo"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-cluster-gate"]').exists()).toBe(false)
  })
})

describe('WorkflowVizDag 视口 fit-to-view（2026-10 用户裁决：默认打开全图居中、四周 FIT_PAD_PX 留白）', () => {
  it('无布局环境（jsdom clientWidth/Height 缺失）退化为 k=1 贴左上，渲染不破坏', () => {
    const wrapper = mountDag()
    expect(wrapper.find('[data-testid="wfvz-dag-viewport"]').attributes('transform')).toBe('translate(0,0) scale(1)')
  })

  it('run 切换重置：内容小于容器 k=1 水平居中（tx=(容器宽−画布宽)/2，单分区宽 180）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]').element
    Object.defineProperty(svg, 'clientWidth', { value: 1000 })
    const solo: WorkflowDag = {
      phases: [{ name: 'solo', order: 0 }],
      nodes: [node({ id: 'solo', phase: 'solo' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: solo })
    const vp = readViewport(wrapper)
    expect(vp.k).toBe(1)
    expect(vp.tx).toBeCloseTo((1000 - 180) / 2, 6)
  })

  it('画布宽于容器：缩放至下限 ZOOM_MIN 后居中（内容完整可达，pan 可平移；不再贴 0 裁切）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]').element
    Object.defineProperty(svg, 'clientWidth', { value: 100 })
    const next: WorkflowDag = {
      phases: [{ name: 'wide', order: 0 }, { name: 'tail', order: 1 }],
      nodes: [node({ id: 'w0', phase: 'wide' }), node({ id: 't0', phase: 'tail' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: next })
    const vp = readViewport(wrapper)
    expect(vp.k).toBe(0.35)
    // 内容 392*0.35 超出容器 100 → 居中即轻微负偏移（两侧均匀出界，pan 可达）
    expect(vp.tx).toBeCloseTo((100 - 392 * 0.35) / 2, 6)
  })

  it('容器高度参与 fit：竖向超高内容缩至高度内贴边，纵向居中', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]').element
    Object.defineProperty(svg, 'clientWidth', { value: 1000 })
    Object.defineProperty(svg, 'clientHeight', { value: 200 })
    const tall: WorkflowDag = {
      phases: [{ name: 'col', order: 0 }],
      nodes: Array.from({ length: 5 }, (_, i) => node({ id: `n${i}`, templateName: `a${i}`, phase: 'col' })),
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    await wrapper.setProps({ dag: tall })
    const vp = readViewport(wrapper)
    // 高 352 > 容器 200 → k = (200-40)/352，横向内容远小于容器 k 封顶不影响
    expect(vp.k).toBeCloseTo((200 - 40) / 352, 6)
    expect(vp.ty).toBeCloseTo(20, 6)
  })

  it('容器零尺寸挂载（overlay 过渡态）不 fit；持续 ResizeObserver 在 fit 态下就绪补 fit、后续尺寸变化追 fit', async () => {
    // jsdom 无 ResizeObserver——stub 捕获回调手动派发（模拟挂载后布局就绪与容器变化）
    const observers: { cb: ResizeObserverCallback; disconnected: boolean }[] = []
    class FakeResizeObserver {
      cb: ResizeObserverCallback
      disconnected = false
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
        observers.push(this)
      }
      observe(): void {}
      disconnect(): void {
        this.disconnected = true
      }
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      const solo: WorkflowDag = {
        phases: [{ name: 'solo', order: 0 }],
        nodes: [node({ id: 'solo', phase: 'solo' })],
        edges: [],
        parallelGroups: [],
        loops: [],
      }
      const wrapper = mountDag(solo)
      const svg = wrapper.find('[data-testid="wfvz-dag-svg"]').element
      // 挂载时零尺寸 → 不 fit（初始视口保持退化形态）+ 持续观察器已挂上
      expect(readViewport(wrapper)).toEqual({ k: 1, tx: 0, ty: 0 })
      expect(observers).toHaveLength(1)
      // 布局就绪（宽 1000）→ 派发观察器回调 → 补 fit（DOM 更新经 nextTick 刷入）
      Object.defineProperty(svg, 'clientWidth', { value: 1000, configurable: true })
      observers[0]!.cb([], {} as ResizeObserver)
      await nextTick()
      const vp = readViewport(wrapper)
      expect(vp.k).toBe(1)
      expect(vp.tx).toBeCloseTo((1000 - 180) / 2, 6)
      // 持续观察：观察器不断开，fit 态下后续容器变化（宽 2000）追 fit 重新居中
      expect(observers[0]!.disconnected).toBe(false)
      Object.defineProperty(svg, 'clientWidth', { value: 2000, configurable: true })
      observers[0]!.cb([], {} as ResizeObserver)
      await nextTick()
      expect(readViewport(wrapper).tx).toBeCloseTo((2000 - 180) / 2, 6)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('WorkflowVizDag 视口 fit/free 状态机（fit 不追打：接管转 free、回到全景/切 run 回 fit）', () => {
  /** 独子 DAG（单列宽 180，fit 数值断言口径与 fit-to-view 组一致）。 */
  function soloDag(): WorkflowDag {
    return {
      phases: [{ name: 'solo', order: 0 }],
      nodes: [node({ id: 'solo', phase: 'solo' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
  }

  /** wheel 接管手势（jsdom getBoundingClientRect 全 0：指针画布坐标 = client 坐标）。 */
  async function seizeByWheel(wrapper: ReturnType<typeof mountDag>): Promise<void> {
    await wrapper.find('[data-testid="wfvz-dag-svg"]').trigger('wheel', { deltaY: -120, clientX: 300, clientY: 200 })
  }

  it('pan 接管：拖拽位移超阈值 → free 态（回到全景入口出现、提示角标让位、视口随 pan 平移）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]')
    await svg.trigger('pointerdown', { clientX: 0, clientY: 0 })
    await svg.trigger('pointermove', { clientX: 60, clientY: 0 })
    expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-dag-hint"]').exists()).toBe(false)
    // 挂载零尺寸退化 tx=0、k=1 → pan 平移 = 起始 tx + 位移/k = 60
    expect(readViewport(wrapper).tx).toBeCloseTo(60, 6)
  })

  it('pointerdown 未移动不算接管（位移低于阈值仍 fit 态，纯点击语义不受影响）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]')
    await svg.trigger('pointerdown', { clientX: 0, clientY: 0 })
    // 位移 3 < PAN_THRESHOLD_PX(5)：pan.moved 不置位
    await svg.trigger('pointermove', { clientX: 3, clientY: 0 })
    expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-dag-hint"]').exists()).toBe(true)
  })

  it('wheel 接管 → free 态；free 态下容器尺寸变化不追 fit（自动 fit 停用）', async () => {
    const observers: { cb: ResizeObserverCallback }[] = []
    class FakeResizeObserver {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
        observers.push(this)
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      const wrapper = mountDag(soloDag())
      const svg = wrapper.find('[data-testid="wfvz-dag-svg"]')
      Object.defineProperty(svg.element, 'clientWidth', { value: 1000, configurable: true })
      await seizeByWheel(wrapper)
      expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(true)
      // wheel 以指针为缩放中心改写视口（与 fit 形态可区分）
      const seized = readViewport(wrapper)
      expect(seized.tx).not.toBeCloseTo((1000 - 180) / 2, 6)
      // 容器尺寸变化（宽 2000）→ free 态观察器回调 no-op（视口不动）
      Object.defineProperty(svg.element, 'clientWidth', { value: 2000, configurable: true })
      observers[0]!.cb([], {} as ResizeObserver)
      await nextTick()
      expect(readViewport(wrapper)).toEqual(seized)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('回到全景：free 态点击回 fit 态并 fit 一次（视口回全图居中、入口消失、提示角标回归）', async () => {
    const wrapper = mountDag(soloDag())
    Object.defineProperty(wrapper.find('[data-testid="wfvz-dag-svg"]').element, 'clientWidth', {
      value: 1000,
      configurable: true,
    })
    await seizeByWheel(wrapper)
    expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(true)
    await wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').trigger('click')
    await nextTick()
    const vp = readViewport(wrapper)
    expect(vp.k).toBe(1)
    expect(vp.tx).toBeCloseTo((1000 - 180) / 2, 6)
    expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="wfvz-dag-hint"]').exists()).toBe(true)
  })

  it('切 run 重置：free 态下 dag 引用变化 → 回 fit 态 + 新蓝图 fit（此前接管放弃）', async () => {
    const wrapper = mountDag()
    const svg = wrapper.find('[data-testid="wfvz-dag-svg"]')
    Object.defineProperty(svg.element, 'clientWidth', { value: 1000, configurable: true })
    await seizeByWheel(wrapper)
    expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(true)
    await wrapper.setProps({ dag: soloDag() })
    const vp = readViewport(wrapper)
    expect(vp.k).toBe(1)
    expect(vp.tx).toBeCloseTo((1000 - 180) / 2, 6)
    expect(wrapper.find('[data-testid="wfvz-dag-back-to-fit"]').exists()).toBe(false)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkflowVizDag 执行实例行（实际 agent 画进图，2026-10 用户裁决）', () => {
  function call(id: number, agent: string, status: WorkflowAgentCall['status'] = 'done'): WorkflowAgentCall {
    return { id, agent, status }
  }

  it('恰 1 实例：节点标题 = 实例 agent 名（固定 agent 名，不再露模板通配形）', () => {
    const wrapper = mountDag(sampleDag(), {
      instancesByNode: new Map([['n-biz', [call(7, 'reviewer-alpha-r1')]]]),
    })
    const node = wrapper.find('[data-testid="wfvz-dag-node-n-biz"]')
    expect(node.text()).toContain('reviewer-alpha-r1')
    // 模板名不再是标题（同一信息不双轨；模板名 ≠ 实例名）
    expect(node.text()).not.toContain('reviewer-biz')
  })

  it('≥2 实例：标题保持调用点模板名，主体下方每实例一行（agent 名 + 实例状态点）', () => {
    const wrapper = mountDag(sampleDag(), {
      nodeStates: { 'n-sec': 'running' },
      instancesByNode: new Map([
        ['n-sec', [call(3, 'reviewer-sec-a1-r1'), call(9, 'reviewer-sec-a2-r2', 'running')]],
      ]),
    })
    const node = wrapper.find('[data-testid="wfvz-dag-node-n-biz"]')
    expect(node.text()).toContain('reviewer-biz')
    const rowA = wrapper.find('[data-testid="wfvz-dag-instance-3"]')
    const rowB = wrapper.find('[data-testid="wfvz-dag-instance-9"]')
    expect(rowA.text()).toContain('reviewer-sec-a1-r1')
    expect(rowA.attributes('data-state')).toBe('done')
    expect(rowB.text()).toContain('reviewer-sec-a2-r2')
    expect(rowB.attributes('data-state')).toBe('running')
  })

  it('≥2 实例 + 全通配模板 *：标题改用实例派生摘要（首名 +N），不再露零信息通配符', () => {
    const wildcardDag: WorkflowDag = {
      phases: [{ name: 'review', order: 0 }],
      nodes: [node({ id: 'n-w', templateName: '*', phase: 'review' })],
      edges: [],
      parallelGroups: [],
      loops: [],
    }
    const wrapper = mountDag(wildcardDag, {
      nodeStates: { 'n-w': 'running' },
      instancesByNode: new Map([
        ['n-w', [call(3, 'reviewer-arch-a1-r1'), call(9, 'reviewer-sec-a1-r1', 'running')]],
      ]),
    })
    const nodeEl = wrapper.find('[data-testid="wfvz-dag-node-n-w"]')
    // 预算内截断：后缀 +N 恒可见（首名超预算时 … 收敛，总宽 ≤ NAME_MAX_CHARS=18）
    expect(nodeEl.text()).toContain('reviewer-arch-… +1')
    expect(nodeEl.text()).not.toContain('*')
  })

  it('≥2 实例 + 有字面段模板：标题保持模板名（调用点身份可读，实例名在行区）', () => {
    const wrapper = mountDag(sampleDag(), {
      nodeStates: { 'n-sec': 'running' },
      instancesByNode: new Map([
        ['n-sec', [call(3, 'commit-env-fix-b1'), call(9, 'commit-env-fix-b2', 'running')]],
      ]),
    })
    // sampleDag n-sec 模板名 reviewer-sec（非通配）——标题保持模板，不摘要
    const node = wrapper.find('[data-testid="wfvz-dag-node-n-sec"]')
    expect(node.text()).toContain('reviewer-sec')
    expect(node.text()).not.toContain('+1')
  })

  it('实例行点击 no-op（[2026-10-19] agent 钻取入口收归实例 trace 行——实例行纯展示）', async () => {
    const wrapper = mountDag(sampleDag(), {
      nodeStates: { 'n-sec': 'running' },
      instancesByNode: new Map([
        ['n-sec', [call(3, 'reviewer-sec-a1-r1'), call(9, 'reviewer-sec-a2-r2', 'running')]],
      ]),
    })
    await wrapper.find('[data-testid="wfvz-dag-instance-9"]').trigger('pointerdown')
    await wrapper.find('[data-testid="wfvz-dag-instance-9"]').trigger('pointerup')
    expect(wrapper.emitted('select')).toBeUndefined()
  })

  it('≥2 实例节点增高进布局（rect 高于基准高——实例行画在节点卡片内，不溢出分区）', () => {
    const wrapper = mountDag(sampleDag(), {
      instancesByNode: new Map([
        ['n-sec', [call(3, 'reviewer-sec-a1-r1'), call(9, 'reviewer-sec-a2-r2', 'running')]],
      ]),
    })
    const rect = wrapper.find('[data-testid="wfvz-dag-node-n-sec"] rect')
    expect(Number(rect.attributes('height'))).toBeGreaterThan(44)
  })

  it('无实例数据（缺省）：全部节点零实例形态（模板名标题，零实例行 DOM）', () => {
    const wrapper = mountDag(sampleDag())
    expect(wrapper.find('[data-testid="wfvz-dag-node-n-biz"]').text()).toContain('reviewer-biz')
    expect(wrapper.findAll('[data-wfvz-instance]')).toHaveLength(0)
  })
})

describe('WorkflowVizDag 画布视觉（workflow-overlay-refine D3）', () => {
  it('V1-wf③ 标签/节点分层：分区标签 2xs/font-medium/0.03em 字距、节点名 3xs（字号档 class 断言）', () => {
    const wrapper = mountDag()
    const label = wrapper.find('[data-testid="wfvz-dag-cluster-gate"] text')
    expect(label.classes()).toContain('text-[length:var(--text-2xs)]')
    expect(label.classes()).toContain('font-medium')
    expect(label.classes()).toContain('tracking-[0.03em]')
    // 节点名与分区标签拉开半档（节点名恒 3xs——分层的另一侧基准）
    const nodeName = wrapper.find('[data-testid="wfvz-dag-node-n-gate"] text')
    expect(nodeName.classes()).toContain('text-[length:var(--text-3xs)]')
  })

  it('分区虚线描边升 border-strong 级 + dasharray 保留（弱化「面板感」、强化「分组感」）', () => {
    const wrapper = mountDag()
    const rect = wrapper.find('[data-testid="wfvz-dag-cluster-gate"] rect')
    expect(rect.classes()).toContain('stroke-border-strong')
    expect(rect.classes()).toContain('[stroke-dasharray:5_4]')
    // 描边升级不回退既有 hairline
    expect(rect.classes()).not.toContain('stroke-border-hairline')
  })
})
})

// ═══════════ 来源节：workflow-viz-gantt ═══════════

describe('workflow-viz-gantt', () => {
const T0 = 1_700_000_000_000

function segments(partial: Partial<WorkflowGanttSegments> = {}): WorkflowGanttSegments {
  return {
    attemptSegments: [],
    phaseBands: [],
    phaseCards: [],
    ...partial,
  }
}

describe('buildGanttRows 行分组（白盒）', () => {
  it('按 taskIndex 分组、行内按 generation/attempt 升序、行按 taskIndex 升序', () => {
    const rows = buildGanttRows([
      { taskIndex: 2, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
      { taskIndex: 1, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 50, state: 'done' },
      { taskIndex: 2, generation: 1, attempt: 2, startTs: T0 + 160, endTs: T0 + 200, state: 'done' },
    ])
    expect(rows.map((r) => r.taskIndex)).toEqual([1, 2])
    expect(rows[1].segments.map((s) => s.attempt)).toEqual([1, 2])
  })

  it('同代际相邻段间隙 → 退避琥珀段（宽 = backoffMs）', () => {
    const rows = buildGanttRows([
      { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
      // attempt 2 起点 = retrying.ts：退避间隙 = T0+100 → T0+150（backoff 50ms）
      { taskIndex: 0, generation: 1, attempt: 2, startTs: T0 + 150, endTs: T0 + 300, state: 'done' },
    ])
    expect(rows[0].backoffGaps).toEqual([{ generation: 1, startTs: T0 + 100, endTs: T0 + 150 }])
  })

  it('跨代际间隙是中断/崩溃空隙：不产退避段（段不相连、空隙可见）', () => {
    const rows = buildGanttRows([
      { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
      { taskIndex: 0, generation: 2, attempt: 1, startTs: T0 + 5_000, endTs: T0 + 6_000, state: 'done' },
    ])
    expect(rows[0].backoffGaps).toEqual([])
  })
})

describe('computeGanttDomain 时间域（白盒）', () => {
  it('全部段起止并集 + 2% 边距；游标参与域（运行中游标可超最后事件）', () => {
    const d = computeGanttDomain({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'done' },
      ],
      phaseBands: [{ phase: 'p', startTs: T0 - 200, endTs: T0 + 800, emptyReplay: false, state: 'settled' }],
    }, T0 + 2_000)
    expect(d).not.toBeNull()
    expect(d!.startTs).toBeLessThan(T0 - 200)
    expect(d!.endTs).toBeGreaterThan(T0 + 2_000)
  })

  it('分段全空且无游标 → null（调用方出空态）', () => {
    expect(computeGanttDomain({ attemptSegments: [], phaseBands: [] })).toBeNull()
  })

  it('toPercent：域内线性映射、越界钳制', () => {
    const d = { startTs: 0, endTs: 100 }
    expect(toPercent(50, d)).toBe(50)
    expect(toPercent(-10, d)).toBe(0)
    expect(toPercent(110, d)).toBe(100)
  })
})

// ── 组件黑盒 ──

function mountGantt(segs: WorkflowGanttSegments, props: Record<string, unknown> = {}) {
  return mount(WorkflowVizGantt, { props: { segments: segs, ...props } })
}

describe('WorkflowVizGantt 组件（黑盒 DOM）', () => {
  it('call 横条按 attempt 分段渲染（行 + 段 + 段状态用户可见）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
        { taskIndex: 0, generation: 1, attempt: 2, startTs: T0 + 150, endTs: T0 + 300, state: 'done' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-row-0"]').exists()).toBe(true)
    const segs = wrapper.findAll('[data-testid="wfvz-gantt-seg"]')
    expect(segs).toHaveLength(2)
    expect(segs[0].attributes('data-attempt')).toBe('1')
    expect(segs[0].attributes('data-state')).toBe('failed')
    expect(segs[1].attributes('data-state')).toBe('done')
    // 段 title 用户可见（attempt 词 + 状态词）
    expect(segs[1].attributes('title')).toContain('第 2 次尝试')
  })

  it('退避琥珀段渲染（同代际相邻 attempt 间隙）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
        { taskIndex: 0, generation: 1, attempt: 2, startTs: T0 + 150, endTs: T0 + 300, state: 'done' },
      ],
    }))
    const backoff = wrapper.find('[data-testid="wfvz-gantt-backoff"]')
    expect(backoff.exists()).toBe(true)
    expect(backoff.attributes('data-generation')).toBe('1')
    expect(backoff.attributes('title')).toContain('退避重试等待')
  })

  it('跨代际中断空隙不产退避段（空隙保留可见）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'failed' },
        { taskIndex: 0, generation: 2, attempt: 1, startTs: T0 + 5_000, endTs: T0 + 6_000, state: 'done' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-backoff"]').exists()).toBe(false)
  })

  it('phase 色带渲染；重放空段（emptyReplay）不绘制', () => {
    const wrapper = mountGantt(segments({
      phaseBands: [
        { phase: 'real', startTs: T0, endTs: T0 + 500, emptyReplay: false, state: 'settled' },
        { phase: 'ghost', startTs: T0 + 600, endTs: T0 + 700, emptyReplay: true, state: 'settled' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-band-real"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-gantt-band-ghost"]').exists()).toBe(false)
  })

  it('纯脚本 phase 色带带斜纹标注（scriptOnly → data-script-only）', () => {
    const wrapper = mountGantt(segments({
      phaseBands: [{ phase: 'gate', startTs: T0, endTs: T0 + 500, emptyReplay: false, state: 'settled' }],
      phaseCards: [{ phase: 'gate', startTs: T0, endTs: T0 + 500, turnCount: 1, state: 'settled', scriptOnly: true }],
    }))
    const band = wrapper.find('[data-testid="wfvz-gantt-band-gate"]')
    expect(band.attributes('data-script-only')).toBe('true')
  })

  it('运行中游标随 nowMs 推进（nowMs 参与时间域）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'running', nowMs: T0 + 2_000 })
    const cursor = wrapper.find('[data-testid="wfvz-gantt-cursor"]')
    expect(cursor.exists()).toBe(true)
    expect(cursor.attributes('data-frozen')).toBeUndefined()
    // 运行中段带全局 keyframes 脉冲类（style.css wfvz-gantt-pulse）；未停止（无 data-stopped）
    const seg = wrapper.find('[data-testid="wfvz-gantt-seg"]')
    expect(seg.classes().join(' ')).toContain('wfvz-gantt-pulse')
    expect(seg.attributes('data-stopped')).toBeUndefined()
  })

  it('run 停止（interrupted）：游标冻结于最后事件 ts（data-frozen）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'interrupted', nowMs: T0 + 999_999 })
    const cursor = wrapper.find('[data-testid="wfvz-gantt-cursor"]')
    expect(cursor.attributes('data-frozen')).toBe('true')
    // 冻结位置 = 最后事件 ts（T0+1000），与注入的 nowMs 无关——停走语义。
    // 域 = [T0, T0+1000] 外扩 2%：pct(T0+1000) = 1020/1040 ≈ 98.08
    expect(parseFloat(cursor.element.style.left)).toBeCloseTo(98.08, 0)
  })

  it('run 停止（done+failed 终局）：未收束段不脉冲、着色失败色系（D9 停止着色）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'done', runOutcome: 'failed' })
    const seg = wrapper.find('[data-testid="wfvz-gantt-seg"]')
    expect(seg.attributes('data-stopped')).toBe('true')
    // 失败色系着色（bg-danger）且不脉冲（无 wfvz-gantt-pulse 动画类）
    expect(seg.classes().join(' ')).toContain('bg-danger')
    expect(seg.classes().join(' ')).not.toContain('wfvz-gantt-pulse')
  })

  it('run 停止（done+cancelled 终局）：未收束段着色中性暗（tray-tone 同语义同色）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 1_000, state: 'running' },
      ],
    }), { runStatus: 'done', runOutcome: 'cancelled' })
    const seg = wrapper.find('[data-testid="wfvz-gantt-seg"]')
    expect(seg.classes().join(' ')).toContain('bg-neutral-dim')
    expect(seg.attributes('data-stopped')).toBe('true')
  })

  it('callLabels 提供时行标签显示 agent 名（用户可见），缺省显示 #taskIndex', () => {
    const segs = segments({
      attemptSegments: [
        { taskIndex: 3, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 100, state: 'done' },
      ],
    })
    const withLabels = mountGantt(segs, { callLabels: { 3: 'reviewer-sec' } })
    expect(withLabels.find('[data-testid="wfvz-gantt-row-3"]').text()).toContain('reviewer-sec')
    const withoutLabels = mountGantt(segs)
    expect(withoutLabels.find('[data-testid="wfvz-gantt-row-3"]').text()).toContain('#3')
  })

  it('分段全空：空态文案（无时间线数据）', () => {
    const wrapper = mountGantt(segments())
    expect(wrapper.find('[data-testid="wfvz-gantt-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="wfvz-gantt-empty"]').text()).toContain('暂无时间线数据')
  })

  it('时间轴刻度渲染（用户可见相对时长标签）', () => {
    const wrapper = mountGantt(segments({
      attemptSegments: [
        { taskIndex: 0, generation: 1, attempt: 1, startTs: T0, endTs: T0 + 60_000, state: 'done' },
      ],
    }))
    expect(wrapper.find('[data-testid="wfvz-gantt-axis"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="wfvz-gantt-tick"]').length).toBeGreaterThan(0)
  })
})
})

