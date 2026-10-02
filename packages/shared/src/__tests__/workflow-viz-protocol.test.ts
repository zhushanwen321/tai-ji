/**
 * Workflow 可视化协议契约测试（workflow-visualization 设计 §5-U2——shared 协议类型冻结）。
 *
 * 验证四层：
 * ① DAG RPC 错误码四枚举与 §3.1-5 逐字对齐（快照式锚定 + 类型级双向穷举）+
 *    reply 判别 union 两臂（成功 / 结构化错误）；
 * ② 事件流截断形态与 §3.1-4 逐字对应（白名单四字段 + 2KB 阈值 + truncatedFields
 *    标注形态）+ 事件条目判别联合（跟随 core WorkflowRunEvent 词表）；
 * ③ fold 透出字段（WorkflowAgentCall.attempts/lastRetry + WorkflowRunRecord.phases/
 *    argsSummary）纯加法在盘、既有契约字段不回退；
 * ④ Gantt 分段视图模型（§3.1-2 规则①②③输出形态）+ 两条 RPC 的载体/映射登记与
 *    error envelope 边界（结构化错误 vs 通道错误两形态）。
 * 纯契约层验证，不涉及 runtime 投影编排（U3 交付后另有实装单测）。
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type {
  ClientMessage,
  ReplyPayloadMap,
  ServerMessage,
  WorkflowDagErrorCode,
  WorkflowDagReply,
  WorkflowRunEventsErrorCode,
  WorkflowRunEventsReply,
} from '../protocol'
import {
  WORKFLOW_RUN_EVENT_ENTRY_COVERAGE_LOCK,
  WORKFLOW_RUN_EVENT_TRUNCATED_FIELDS,
  WORKFLOW_RUN_EVENT_TRUNCATE_BYTES,
  WORKFLOW_RUN_EVENT_TYPES_ALL,
} from '../workflow'
import type {
  WorkflowAgentCall,
  WorkflowDag,
  WorkflowDagEdge,
  WorkflowDagNode,
  WorkflowGanttAttemptSegment,
  WorkflowGanttPhaseBand,
  WorkflowGanttPhaseCard,
  WorkflowGanttSegments,
  WorkflowRunAgentSettledEntry,
  WorkflowRunAgentStartedEntry,
  WorkflowRunCreatedEntry,
  WorkflowRunEventEntry,
  WorkflowRunEventType,
  WorkflowRunPhaseFoldEntry,
  WorkflowRunRecord,
} from '../workflow'
// 跨包可达性守卫：index.ts 对 workflow.ts / protocol.ts 均为显式 allowlist（非 export *），
// 下游消费方只能经包根入口取符号——漏登记时值导入在解析期红、类型导入在 tsc 红。
// 别名避免与直连导入同名冲突。
import {
  WORKFLOW_RUN_EVENT_TRUNCATED_FIELDS as TRUNCATED_FIELDS_FROM_ROOT,
  WORKFLOW_RUN_EVENT_TRUNCATE_BYTES as TRUNCATE_BYTES_FROM_ROOT,
  WORKFLOW_RUN_EVENT_TYPES_ALL as EVENT_TYPES_FROM_ROOT,
} from '../index'
import type {
  WorkflowDagErrorCode as WorkflowDagErrorCodeFromRoot,
  WorkflowDagReply as WorkflowDagReplyFromRoot,
  WorkflowRunEventEntry as WorkflowRunEventEntryFromRoot,
  WorkflowRunEventsErrorCode as WorkflowRunEventsErrorCodeFromRoot,
  WorkflowRunEventsReply as WorkflowRunEventsReplyFromRoot,
  WorkflowGanttSegments as WorkflowGanttSegmentsFromRoot,
} from '../index'

/**
 * §3.1-5 DAG 错误码四枚举（逐字）。改码 / 加码须先改设计表，再同步 protocol.ts
 * 与本锚定集（类型级双向穷举让漂移在编译期红，快照式 toEqual 让字面量变动在
 * 运行时红）。
 */
const DAG_ERROR_CODES = [
  'parse_failed',
  'no_script_source',
  'record_not_found',
  'path_rejected',
] as const

/**
 * §3.1-4 截断白名单四字段（逐字）：agent-started.input / agent-settled.result /
 * run-created.scriptSource / run-created.args。
 */
const TRUNCATED_FIELD_NAMES = ['input', 'result', 'scriptSource', 'args'] as const

/** §3.1-2① record 事件词表（跟随 core WorkflowRunEvent 联合 10 成员）。 */
const EVENT_TYPE_NAMES = [
  'run-created',
  'phase-started',
  'agent-started',
  'agent-retrying',
  'agent-settled',
  'phase-settled',
  'run-interrupted',
  'run-resumed',
  'run-settled',
  'worker-log',
] as const

/** 联合成员 type 键提取（与 workflow.ts 的编译锁同法，测试侧独立推导）。 */
type EntryTypeOf<T> = T extends { type: infer K } ? K : never
type DagOkArm = Extract<WorkflowDagReply, { dag: WorkflowDag }>
type DagErrArm = Extract<WorkflowDagReply, { code: WorkflowDagErrorCode }>
type EventsOkArm = Extract<WorkflowRunEventsReply, { events: WorkflowRunEventEntry[] }>
type EventsErrArm = Extract<WorkflowRunEventsReply, { code: WorkflowRunEventsErrorCode }>

describe('session.getWorkflowDag 协议契约（U2，设计 §3.1-5 SSOT）', () => {
  it('错误码四枚举：与 §3.1-5 全枚举逐字一致（快照式锚定）', () => {
    expect([...DAG_ERROR_CODES]).toEqual([
      'parse_failed',
      'no_script_source',
      'record_not_found',
      'path_rejected',
    ])
    // 类型级双向穷举：协议联合 ⊇ 且 ⊆ 锚定集
    expectTypeOf<WorkflowDagErrorCode>().toEqualTypeOf<(typeof DAG_ERROR_CODES)[number]>()
  })

  it('reply 判别 union：成功臂 { sessionId, runId, dag }，dag 为完整产物（nodes 空数组 = 零调用点 run）', () => {
    // 两臂覆盖全联合（无第三形态）
    expectTypeOf<DagOkArm | DagErrArm>().toEqualTypeOf<WorkflowDagReply>()

    const zeroCallDag: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }
    const reply: WorkflowDagReply = { sessionId: 's1', runId: 'wf-1', dag: zeroCallDag }
    if ('dag' in reply) {
      expect(reply.dag.nodes).toEqual([])
    } else {
      throw new Error('unreachable：成功臂不可达')
    }
  })

  it.each([...DAG_ERROR_CODES])('reply 判别 union：错误臂 { sessionId, runId, code: %s, message }', (code) => {
    expectTypeOf<DagErrArm['code']>().toEqualTypeOf<WorkflowDagErrorCode>()
    const reply: WorkflowDagReply = { sessionId: 's1', runId: 'wf-1', code, message: '原因说明' }
    if ('code' in reply) {
      expect(reply.code).toBe(code)
      expect(typeof reply.message).toBe('string')
    } else {
      throw new Error('unreachable：错误臂不可达')
    }
  })

  it('边界：parse_failed 可重试语义在类型层无阻碍（成功与错误臂同带 sessionId/runId——renderer 分区路由无需判臂）', () => {
    const ok: DagOkArm = { sessionId: 's1', runId: 'wf-1', dag: { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] } }
    const err: DagErrArm = { sessionId: 's1', runId: 'wf-1', code: 'parse_failed', message: '不支持语法' }
    expect(ok.sessionId).toBe(err.sessionId)
    expect(ok.runId).toBe(err.runId)
  })
})

describe('session.getWorkflowRunEvents 协议契约（U2，设计 §3.1-4 SSOT）', () => {
  it('结构化错误码闭集 = record_not_found 单码（降级路径错误二分的结构化半边）', () => {
    expectTypeOf<WorkflowRunEventsErrorCode>().toEqualTypeOf<'record_not_found'>()
    const reply: WorkflowRunEventsReply = {
      sessionId: 's1',
      runId: 'wf-1',
      code: 'record_not_found',
      message: '该 run 无事件流记录（旧格式或已清理）',
    }
    if ('code' in reply) expect(reply.code).toBe('record_not_found')
    else throw new Error('unreachable：错误臂不可达')
  })

  it('reply 判别 union：成功臂 { sessionId, runId, events }，两臂覆盖全联合', () => {
    expectTypeOf<EventsOkArm | EventsErrArm>().toEqualTypeOf<WorkflowRunEventsReply>()
    expectTypeOf<EventsOkArm['events']>().toEqualTypeOf<WorkflowRunEventEntry[]>()
  })

  it('C-comm-05 会话隔离：两 reply 判别 union 的四个臂均必带 sessionId（对齐 session.workflows 等同族先例）', () => {
    expectTypeOf<DagOkArm['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<DagErrArm['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<EventsOkArm['sessionId']>().toEqualTypeOf<string>()
    expectTypeOf<EventsErrArm['sessionId']>().toEqualTypeOf<string>()
  })

  it('截断形态：白名单四字段与 §3.1-4 截断清单逐字一致（快照式锚定 + 类型域穷举）', () => {
    expect([...WORKFLOW_RUN_EVENT_TRUNCATED_FIELDS]).toEqual([...TRUNCATED_FIELD_NAMES])
    expectTypeOf<WorkflowRunEventEntry['truncatedFields']>().toEqualTypeOf<
      (typeof TRUNCATED_FIELD_NAMES)[number][] | undefined
    >()
  })

  it('截断阈值：2KB 常量在盘（= 2048 字节，实装归 U3——本层只冻结形态）', () => {
    expect(WORKFLOW_RUN_EVENT_TRUNCATE_BYTES).toBe(2048)
  })

  it('事件类型全集：10 成员与 core WorkflowRunEvent 词表锚定一致 + 覆盖编译锁在盘', () => {
    expect([...WORKFLOW_RUN_EVENT_TYPES_ALL]).toEqual([...EVENT_TYPE_NAMES])
    expectTypeOf<WorkflowRunEventType>().toEqualTypeOf<(typeof EVENT_TYPE_NAMES)[number]>()
    // 联合成员 type 键的双向穷举（与 workflow.ts 编译锁同判据的测试侧镜像）
    expectTypeOf<EntryTypeOf<WorkflowRunEventEntry>>().toEqualTypeOf<WorkflowRunEventType>()
    expect(WORKFLOW_RUN_EVENT_ENTRY_COVERAGE_LOCK).toBe(true)
  })

  it('事件条目构造：大字段截断值形态（文本前缀值 + truncatedFields 逐行标注）', () => {
    // run-created：scriptSource/args 为截断值（文本形态），truncatedFields 标注两字段
    const created: WorkflowRunCreatedEntry = {
      type: 'run-created',
      seq: 1,
      ts: 1700000000000,
      runId: 'wf-1',
      workflowName: 'pr-lifecycle',
      argsSummary: '{"target":"main"}',
      args: '{"target":"main","files":["a.ts","b.ts","c.ts"…',
      scriptSource: '// workflow script 第一行…',
      truncatedFields: ['args', 'scriptSource'],
    }
    expect(created.truncatedFields).toEqual(['args', 'scriptSource'])
    expect(typeof created.args).toBe('string')
    expect(typeof created.scriptSource).toBe('string')

    // agent-started：input 截断值 + 骨架字段（ts/type/taskIndex/attempt/phase）齐备
    const started: WorkflowRunAgentStartedEntry = {
      type: 'agent-started',
      seq: 7,
      ts: 1700000001000,
      taskIndex: 3,
      agentName: 'reviewer-security-a1-r1',
      attempt: 1,
      phase: 'review',
      input: '{"prompt":"审查…"',
      truncatedFields: ['input'],
    }
    expect(started.taskIndex).toBe(3)
    expect(started.truncatedFields).toEqual(['input'])

    // agent-settled：result 截断值 + 终局载荷
    const settled: WorkflowRunAgentSettledEntry = {
      type: 'agent-settled',
      seq: 9,
      ts: 1700000009000,
      taskIndex: 3,
      attempt: 2,
      outcome: 'done',
      durationMs: 8000,
      result: '{"summary":"审查通过…"',
      truncatedFields: ['result'],
    }
    expect(settled.outcome).toBe('done')
    expect(settled.truncatedFields).toEqual(['result'])
  })

  it('事件条目判别联合：switch (entry.type) 可收窄（判别键 = type），信封字段全成员齐备', () => {
    const entry: WorkflowRunEventEntry = {
      type: 'phase-started',
      seq: 2,
      ts: 1700000000500,
      phase: 'review',
    }
    switch (entry.type) {
      case 'phase-started':
        expect(entry.phase).toBe('review')
        break
      default:
        throw new Error('unreachable：判别键收窄失败')
    }
    // 信封可缺省字段：旧格式行无 seq / 无截断行无 truncatedFields
    const legacy: WorkflowRunEventEntry = { type: 'phase-settled', ts: 1700000000600, phase: 'review' }
    expect(legacy.seq).toBeUndefined()
    expect(legacy.truncatedFields).toBeUndefined()
  })
})

describe('fold 透出字段（U2 纯加法）与既有契约不回退', () => {
  it('WorkflowAgentCall.attempts / lastRetry{attempt, backoffMs, reason} 可选字段形态', () => {
    const call: WorkflowAgentCall = {
      id: 3,
      agent: 'reviewer-security-a1-r1',
      status: 'running',
      attempts: 2,
      lastRetry: { attempt: 1, backoffMs: 2000, reason: 'rate_limited' },
    }
    expect(call.attempts).toBe(2)
    expect(call.lastRetry?.backoffMs).toBe(2000)
    // 缺省 = 旧投影无此字段
    const legacy: WorkflowAgentCall = { id: 1, agent: 'dev-W1', status: 'done' }
    expect(legacy.attempts).toBeUndefined()
    expect(legacy.lastRetry).toBeUndefined()
  })

  it('WorkflowRunRecord.phases / argsSummary 可选字段形态（phases = last-wins 单行快照语义）', () => {
    const phaseFold: WorkflowRunPhaseFoldEntry = { phase: 'review', startedAt: 1700000000500, settledAt: 1700000009000 }
    const unsettledFold: WorkflowRunPhaseFoldEntry = { phase: 'fix', startedAt: 1700000010000 }
    const record: WorkflowRunRecord = {
      runId: 'wf-1',
      scriptName: 'pr-lifecycle',
      status: 'running',
      startedAt: '2026-10-02T00:00:00.000Z',
      agentCalls: [],
      stateFilePath: '/records/wf-1.record.jsonl',
      phases: [phaseFold, unsettledFold],
      argsSummary: '{"target":"main"}',
    }
    expect(record.phases).toHaveLength(2)
    expect(record.argsSummary).toBe('{"target":"main"}')
    expect(unsettledFold.settledAt).toBeUndefined()
    // 缺省 = 旧投影无此字段
    const legacy: WorkflowRunRecord = {
      runId: 'wf-1',
      scriptName: 'pr-lifecycle',
      status: 'done',
      reason: 'completed',
      startedAt: '2026-10-02T00:00:00.000Z',
      agentCalls: [],
      stateFilePath: '',
    }
    expect(legacy.phases).toBeUndefined()
    expect(legacy.argsSummary).toBeUndefined()
  })

  it('既有契约不回退：WorkflowAgentCall / WorkflowRunRecord 既有字段类型签名不变（纯加法核验的测试侧锚）', () => {
    // 既有字段抽查（字段存在性 + 类型不变——误删/改形时本用例编译红）
    expectTypeOf<WorkflowAgentCall['status']>().toEqualTypeOf<'pending' | 'running' | 'done' | 'failed'>()
    expectTypeOf<WorkflowAgentCall['inputTokens']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<WorkflowAgentCall['lastProgressAt']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<WorkflowRunRecord['status']>().toEqualTypeOf<'running' | 'interrupted' | 'done'>()
    expectTypeOf<WorkflowRunRecord['agentCalls']>().toEqualTypeOf<WorkflowAgentCall[]>()
    expectTypeOf<WorkflowRunRecord['errorCode']>().toEqualTypeOf<string | undefined>()
  })
})

describe('Gantt 分段视图模型（U2，设计 §3.1-2 规则①②③输出形态）', () => {
  it('call 级 attempt 分段：代际划分 + 起止 + 收束态（各代际段独立保留不相连）', () => {
    const seg1: WorkflowGanttAttemptSegment = {
      taskIndex: 3,
      generation: 1,
      attempt: 1,
      startTs: 1700000001000,
      // 反推公式：attempt 失败终点 = retrying.ts − backoffMs
      endTs: 1700000004000 - 2000,
      state: 'failed',
    }
    const seg2: WorkflowGanttAttemptSegment = {
      taskIndex: 3,
      generation: 1,
      attempt: 2,
      startTs: 1700000004000, // 新 attempt 起点 = retrying.ts
      endTs: 1700000009000, // 终局段终点 = settled.ts
      state: 'done',
    }
    // resume 重派 = 新代际（段独立保留，中断空隙可见）
    const segGen2: WorkflowGanttAttemptSegment = {
      taskIndex: 3,
      generation: 2,
      attempt: 1,
      startTs: 1700000010000,
      endTs: 1700000012000, // 未收束段锚定 = run 级转移帧 ts
      state: 'running',
    }
    expect(seg1.endTs).toBe(1700000002000)
    expect(seg2.startTs).toBe(1700000004000)
    expect(segGen2.generation).toBe(2)
    expectTypeOf<WorkflowGanttAttemptSegment['state']>().toEqualTypeOf<
      'running' | 'done' | 'failed' | 'cancelled'
    >()
  })

  it('phase 级色带段：空段判定结果 + 收束态（重放空段 = 不绘制不计轮次的判定随段透出）', () => {
    const normal: WorkflowGanttPhaseBand = {
      phase: 'review',
      startTs: 1700000000500,
      endTs: 1700000009000,
      emptyReplay: false,
      state: 'settled',
    }
    const replayEmpty: WorkflowGanttPhaseBand = {
      phase: 'review',
      startTs: 1700000010000,
      endTs: 1700000010500,
      emptyReplay: true, // phase 历史有 agent 事件 ∧ 本段区间零 agent 事件
      state: 'settled',
    }
    expect(replayEmpty.emptyReplay).toBe(true)
    expect(normal.emptyReplay).toBe(false)
  })

  it('phase 头卡：跨轮聚合区间 + 轮次计数（非空段段数）+ 状态 + 纯脚本标记', () => {
    const card: WorkflowGanttPhaseCard = {
      phase: 'review',
      startTs: 1700000000500,
      endTs: 1700000010500,
      turnCount: 2, // 两轮实际执行（空段不计）
      state: 'settled',
      scriptOnly: false,
    }
    const scriptCard: WorkflowGanttPhaseCard = {
      phase: 'lint',
      startTs: 1700000000000,
      endTs: 1700000000400,
      turnCount: 1, // 纯脚本 phase 段数即轮数
      state: 'settled',
      scriptOnly: true, // 全历史零 agent 事件——斜纹绘制依据
    }
    expect(card.turnCount).toBe(2)
    expect(scriptCard.scriptOnly).toBe(true)
    expectTypeOf<WorkflowGanttPhaseCard['state']>().toEqualTypeOf<'running' | 'settled'>()
  })

  it('容器：三成员 = 派生函数输出形态（U4 展示组件与 U5 派生函数共用契约）', () => {
    const view: WorkflowGanttSegments = { attemptSegments: [], phaseBands: [], phaseCards: [] }
    expectTypeOf<WorkflowGanttSegments['attemptSegments']>().toEqualTypeOf<WorkflowGanttAttemptSegment[]>()
    expectTypeOf<WorkflowGanttSegments['phaseBands']>().toEqualTypeOf<WorkflowGanttPhaseBand[]>()
    expectTypeOf<WorkflowGanttSegments['phaseCards']>().toEqualTypeOf<WorkflowGanttPhaseCard[]>()
    expect(Object.keys(view).sort()).toEqual(['attemptSegments', 'phaseBands', 'phaseCards'])
  })
})

describe('WorkflowDag 静态解析产物（U2，设计 §3.1-3）', () => {
  it('节点/边/phase 分区/并行组/循环标注构造性用例（调用点行号 + 模板正则 + 四边类）', () => {
    const node: WorkflowDagNode = {
      id: 'call-1',
      kind: 'agent',
      templateName: 'reviewer-<维度>-a<n>-r<轮>',
      matchPattern: '^reviewer\\-.+\\-a\\d+\\-r\\d+$',
      phase: 'review',
      line: 42,
    }
    const step: WorkflowDagNode = { id: 'gate-1', kind: 'script-step', templateName: 'lint', matchPattern: '^lint$', phase: 'lint', line: 10 }
    const edges: WorkflowDagEdge[] = [
      { id: 'e1', from: 'gate-1', to: 'call-1', kind: 'sequence' },
      { id: 'e2', from: 'call-1', to: 'gate-1', kind: 'dataflow' },
      { id: 'e3', from: 'gate-1', to: 'call-1', kind: 'conditional', predicate: 'needsFix' },
      { id: 'e4', from: 'call-1', to: 'gate-1', kind: 'loop-back' },
    ]
    const dag: WorkflowDag = {
      nodes: [node, step],
      edges,
      phases: [
        { name: 'lint', order: 0 },
        { name: 'review', order: 1 },
      ],
      parallelGroups: [{ nodeIds: ['call-1'] }],
      loops: [{ id: 'loop-1', nodeIds: ['call-1', 'gate-1'], backEdgeId: 'e4', label: 'while needsFix' }],
    }
    expect(dag.nodes).toHaveLength(2)
    expect(dag.edges.filter((e) => e.kind === 'conditional').every((e) => typeof e.predicate === 'string')).toBe(true)
    expect(dag.phases.map((p) => p.order)).toEqual([0, 1])
    expect(dag.loops[0]?.backEdgeId).toBe('e4')
    // matchPattern 可编译（正则源文本契约）
    expect(() => new RegExp(node.matchPattern)).not.toThrow()
  })

  it('零调用点 run：nodes 空数组形态合法（渲染层出空画布 + 居中摘要提示）', () => {
    const dag: WorkflowDag = { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] }
    expect(dag.nodes).toEqual([])
  })
})

describe('两条 RPC 的载体与登记（U2）', () => {
  it('request 序列化往返：getWorkflowRunEvents / getWorkflowDag 经 WS JSON 无损', () => {
    for (const type of ['session.getWorkflowRunEvents', 'session.getWorkflowDag'] as const) {
      const msg: ClientMessage = { type, id: 'req-1', payload: { sessionId: 's1', runId: 'wf-1' } }
      const round = JSON.parse(JSON.stringify(msg)) as typeof msg
      expect(round).toEqual(msg)
      const payload = (round as Extract<ClientMessage, { type: typeof type }>).payload
      expect(payload).toEqual({ sessionId: 's1', runId: 'wf-1' })
    }
  })

  it('ServerMessage 载体 + ReplyPayloadMap 登记（command 返回类型推导源）', () => {
    const dagReply: ServerMessage<'session.workflowDag'> = {
      type: 'session.workflowDag',
      id: 'r1',
      payload: { sessionId: 's1', runId: 'wf-1', dag: { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] } },
    }
    const eventsReply: ServerMessage<'session.workflowRunEvents'> = {
      type: 'session.workflowRunEvents',
      id: 'r2',
      payload: { sessionId: 's1', runId: 'wf-1', events: [] },
    }
    // payload 为判别联合，in 收窄成功臂后断言
    if ('dag' in dagReply.payload) expect(dagReply.payload.dag.nodes).toEqual([])
    else throw new Error('unreachable：成功臂不可达')
    if ('events' in eventsReply.payload) expect(eventsReply.payload.events).toEqual([])
    else throw new Error('unreachable：成功臂不可达')
    expectTypeOf<ReplyPayloadMap['session.getWorkflowDag']>().toEqualTypeOf<WorkflowDagReply>()
    expectTypeOf<ReplyPayloadMap['session.getWorkflowRunEvents']>().toEqualTypeOf<WorkflowRunEventsReply>()
  })

  it('error envelope 边界：结构化领域错误（reply 内嵌 code 闭集）与通道错误（error envelope，code 开放 string）两形态并存', () => {
    // 形态一：设计内领域回执——getWorkflowDag/getWorkflowRunEvents 的 reply 错误臂
    //（code 为闭集词表；renderer 按码分流降级形态）
    const structured: WorkflowDagReply = { sessionId: 's1', runId: 'wf-1', code: 'record_not_found', message: '已清理' }
    // 形态二：RPC 通道错误——service 抛错走 server 中央 catch 的统一 error envelope
    //（payload.code: string 开放域，非本设计的领域码闭集）；renderer 侧两通道经同一
    // 错误适配函数归一（设计 §3.1-5）。此处锚定 envelope 形态未被本单元改动：
    const envelope: { code: string; message: string; sessionId?: string; details?: Record<string, unknown> } = {
      code: 'handler_error',
      message: '内部错误',
    }
    if ('code' in structured) {
      expect(DAG_ERROR_CODES).toContain(structured.code) // 领域码 ∈ 闭集
    }
    expect(DAG_ERROR_CODES).not.toContain(envelope.code as never) // 通道错误码不在领域闭集内
    expect(typeof envelope.code).toBe('string') // envelope 的 code 是开放 string 域
  })
})

describe('跨包可达性（包根入口 allowlist 登记）', () => {
  it('新增符号经 src/index.ts 可导入且与直连导入形状一致', () => {
    expect([...TRUNCATED_FIELDS_FROM_ROOT]).toEqual([...TRUNCATED_FIELD_NAMES])
    expect(TRUNCATE_BYTES_FROM_ROOT).toBe(2048)
    expect([...EVENT_TYPES_FROM_ROOT]).toEqual([...EVENT_TYPE_NAMES])
    expectTypeOf<WorkflowDagErrorCodeFromRoot>().toEqualTypeOf<WorkflowDagErrorCode>()
    expectTypeOf<WorkflowDagReplyFromRoot>().toEqualTypeOf<WorkflowDagReply>()
    expectTypeOf<WorkflowRunEventsErrorCodeFromRoot>().toEqualTypeOf<WorkflowRunEventsErrorCode>()
    expectTypeOf<WorkflowRunEventsReplyFromRoot>().toEqualTypeOf<WorkflowRunEventsReply>()
    expectTypeOf<WorkflowRunEventEntryFromRoot>().toEqualTypeOf<WorkflowRunEventEntry>()
    expectTypeOf<WorkflowGanttSegmentsFromRoot>().toEqualTypeOf<WorkflowGanttSegments>()
  })
})
