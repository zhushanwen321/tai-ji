/**
 * EventAdapter 合并测试（cluster runtime-C07：8 文件折叠）。
 *
 * 来源（分节注释见内）：
 * - event-adapter-delta（contentIndex 透传）/ -journal-marker（journal 旁路）
 * - event-adapter-nested-tool-execution（嵌套工具过滤）/ -retry-sound（willRetry 透传）
 * - event-adapter-tool-update（三形态分发）/ -trace-trigger（组合注册）
 * - event-adapter-ttft-anchors（TTFT 锚点）/ -turn-usage-sum（context 占用）
 *
 * journal-marker 节引入顶层 afterEach（setJournalReportSink(null) 全局 sink 清理），
 * 对其余节无副作用，保留在顶层。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventAdapter, translate } from '../event-adapter.js'
import type { PiEvent, PiEventClient, PiMessageUpdateEvent, PiAgentEndEvent, PiTurnStartEvent } from '../pi-protocol.js'
import { setJournalReportSink } from '../../../services/session/journal-report-router.js'
import { SUBAGENT_JOURNAL_MARKER, JOURNAL_REPORT_ACK } from '@zhushanwen/extension-protocol'
import type { SubagentJournalReport } from '@zhushanwen/extension-protocol'
import type { PiExtensionUiRequestEvent } from '../pi-protocol.js'
import { stripAnsi } from '../normalize-tool-result.js'
import { expectCompleteMessage } from './event-adapter-test-helpers'

// ════════════════ 来源: event-adapter-delta.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter delta 透传测试（wave:perf-w07 微项 1）。
// 锁定：message_update 翻译出的 delta 帧对 contentIndex 的透传契约——
// text_delta / thinking_delta / thinking_start 均透传 pi 的 contentIndex，
// 为 W12（D-2 token coalescing，DeltaBuffer 合帧保留首条 contentIndex）保住
// thinking 块的有序插入锚点。renderer 现状 handler 未消费该字段，多余字段无害。
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息。
// /

/** 构造 message_update 事件（assistantMessageEvent 子事件形状）。 */
function messageUpdate(sub: Record<string, unknown>): PiMessageUpdateEvent {
  return { type: 'message_update', assistantMessageEvent: sub } as unknown as PiMessageUpdateEvent
}

/** 从 translate 产出中取出唯一 message（断言前收窄 kind 联合）。 */
function soleMessage(events: ReturnType<typeof translate>) {
  expect(events).toHaveLength(1)
  const [ev] = events
  if (!ev || ev.kind !== 'message') {
    throw new Error(`expected single message event, got: ${JSON.stringify(ev)}`)
  }
  return ev.message
}

describe('EventAdapter delta contentIndex 透传（wave:perf-w07 微项 1）', () => {
  it('W07-5: thinking_delta 透传 contentIndex（对齐 text_delta 契约）', () => {
    const msg = soleMessage(
      translate(messageUpdate({ type: 'thinking_delta', delta: '思考中', contentIndex: 2 }), 's1'),
    )
    expect(msg.type).toBe('message.thinking_delta')
    expect(msg.payload).toEqual({ sessionId: 's1', delta: '思考中', contentIndex: 2 })
  })

  it('W07-5b: thinking_delta 无 contentIndex 时省略字段（向后兼容旧 pi）', () => {
    const msg = soleMessage(translate(messageUpdate({ type: 'thinking_delta', delta: 'x' }), 's1'))
    expect(msg.payload).toEqual({ sessionId: 's1', delta: 'x' })
  })

  it('W07-5c: text_delta 对照组——既有 contentIndex 透传不回归', () => {
    const msg = soleMessage(
      translate(messageUpdate({ type: 'text_delta', delta: 'hi', contentIndex: 0 }), 's1'),
    )
    expect(msg.type).toBe('message.text_delta')
    expect(msg.payload).toEqual({ sessionId: 's1', delta: 'hi', contentIndex: 0 })
  })

  // [HISTORICAL] W07-5d「translate 纯函数同输入同输出」用例已删（2026-09 测试舰队审查 r2-22）：
  // 对任意纯函数恒真，不锁任何 delta 特有行为；纯函数性由全文件 toEqual 精确断言隐式承担。
})

// ════════════════ 来源: event-adapter-journal-marker.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter SUBAGENT_JOURNAL_MARKER 旁路测试（event-push-channel）。
// 覆盖（照 plan-review marker / inflight 测试形态，全部 mock 零真实 pi）：
// - translate 检查分支：marker 帧恒零产出（不进任何前端广播——第二道防线）；
// - attach 旁路：合法报告 → journal-report-router 送达 sink（连接归属 sessionId）
// → 应用成功回 JOURNAL_REPORT_ACK（生效回执 D7）；
// - 路由无消费方（sink 拒绝 / 未注册）→ 帧消费但不 ack（写侧按 D5 失败折叠）；
// - 坏载荷（非 JSON / 形状非法 / sessionId 缺席）→ 帧消费但不 ack，不抛不进翻译；
// - 旁路永不干扰事件流：marker 帧后的普通事件照常 interpret。
// /

const SID_JOURNAL = 'sess-journal-1'

function selectEvent(overrides: Partial<PiExtensionUiRequestEvent> = {}): PiExtensionUiRequestEvent {
  return { type: 'extension_ui_request', method: 'select', id: 'req-1', ...overrides }
}

function reportFrame(report: SubagentJournalReport, id = 'req-1'): PiExtensionUiRequestEvent {
  return selectEvent({ title: SUBAGENT_JOURNAL_MARKER, id, options: [JSON.stringify(report)] })
}

function validReport(): SubagentJournalReport {
  return {
    domain: 'run',
    fileKey: 'wf-1',
    events: [{ type: 'run-created', ts: 1000, seq: 1 }],
    sessionId: SID_JOURNAL,
    emittedAt: 42,
  }
}

/** 可控 sink（记录路由调用，应答由用例裁决）。 */
function makeSink(result = true) {
  const calls: Array<{ sessionId: string; report: SubagentJournalReport }> = []
  setJournalReportSink({
    applyJournalReport: (sessionId, report) => {
      calls.push({ sessionId, report })
      return result
    },
  })
  return calls
}

afterEach(() => {
  setJournalReportSink(null)
})

/** 构造带可控回包通道的 adapter + client（照 rt2-hardening 形态）。 */
function makeAdapter() {
  const interpret = vi.fn()
  const responses: Array<{ id: string; response: unknown }> = []
  const client: PiEventClient = {
    onEvent: (listener) => {
      ;(client as unknown as { listener: (e: unknown) => void }).listener = listener
      return () => undefined
    },
    sendExtensionUiResponse: (id, response) => {
      responses.push({ id, response })
    },
  }
  const adapter = new EventAdapter(SID_JOURNAL, interpret)
  adapter.attach(client)
  const emit = (event: unknown): void => (client as unknown as { listener: (e: unknown) => void }).listener(event)
  return { adapter, interpret, responses, emit }
}

describe('translate 检查分支（marker 帧恒零产出）', () => {
  it('journal marker 帧零产出（不进任何前端广播）', () => {
    const events = translate(
      selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: [JSON.stringify(validReport())] }) as unknown as Parameters<typeof translate>[0],
      SID_JOURNAL,
    )
    expect(events).toHaveLength(0)
  })
})

describe('attach 旁路（路由 + 生效回执）', () => {
  it('合法报告 → sink 以连接 sessionId 路由 → 回 JOURNAL_REPORT_ACK（D7 生效回执）', () => {
    const calls = makeSink(true)
    const { interpret, responses, emit } = makeAdapter()

    emit(reportFrame(validReport()))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.sessionId).toBe(SID_JOURNAL)
    expect(calls[0]!.report.domain).toBe('run')
    expect(calls[0]!.report.fileKey).toBe('wf-1')
    expect(responses).toEqual([{ id: 'req-1', response: JOURNAL_REPORT_ACK }])
    expect(interpret).not.toHaveBeenCalled() // marker 帧不进翻译/编排
  })

  it('sink 拒绝（派生视图未就绪返回 false）→ 帧消费但不 ack（写侧按 D5 失败折叠）', () => {
    makeSink(false)
    const { responses, emit } = makeAdapter()

    emit(reportFrame(validReport()))
    expect(responses).toHaveLength(0)
  })

  it('sink 未注册 → 帧消费但不 ack、不抛', () => {
    setJournalReportSink(null)
    const { responses, emit, interpret } = makeAdapter()

    expect(() => emit(reportFrame(validReport()))).not.toThrow()
    expect(responses).toHaveLength(0)
    expect(interpret).not.toHaveBeenCalled()
  })
})

describe('坏载荷防御（不抛不 ack 不进翻译）', () => {
  it('非 JSON payload → 消费（返回即吞掉）但不 ack', () => {
    makeSink(true)
    const { responses, emit } = makeAdapter()

    emit(selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: ['not-json'] }))
    expect(responses).toHaveLength(0)
  })

  it('形状非法（domain 词表外 / events 缺失）→ 消费但不 ack', () => {
    makeSink(true)
    const { responses, emit } = makeAdapter()

    emit(selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: [JSON.stringify({ domain: 'bogus', fileKey: 'x', events: [], emittedAt: 1 })] }))
    emit(selectEvent({ title: SUBAGENT_JOURNAL_MARKER, options: [JSON.stringify({ domain: 'run', fileKey: 'wf-1', emittedAt: 1 })] }))
    expect(responses).toHaveLength(0)
  })

  it('sessionId 缺席 → 无法归属，整帧丢弃（消费但不 ack，不路由）', () => {
    const calls = makeSink(true)
    const { responses, emit } = makeAdapter()

    const frame = validReport()
    delete (frame as { sessionId?: string }).sessionId
    emit(reportFrame(frame))
    expect(calls).toHaveLength(0)
    expect(responses).toHaveLength(0)
  })
})

describe('旁路不干扰事件流', () => {
  it('marker 帧后的普通事件照常 interpret（隔离边界内零传染）', () => {
    makeSink(true)
    const { interpret, emit } = makeAdapter()

    emit(reportFrame(validReport()))
    emit({ type: 'agent_start' })

    expect(interpret).toHaveBeenCalledTimes(1)
  })
})

// ════════════════ 来源: event-adapter-nested-tool-execution.test.ts ════════════════
// ---- 原文件头注释 ----
// 嵌套工具调用产块事件过滤测试（codemode u5 / 设计 D4，live ≡ reload 对齐）。
// 判据来源（pi 1.0.0 dist 实证；非 codemode 专属逻辑——本注释防止未来被误判为
// codemode 专属而错误放行）：工具经 ctx.executeTool() 发起的嵌套调用，其
// tool_execution_start / tool_execution_update / tool_execution_end 事件一律携带
// parentToolCallId（pi dist/core/nested-tool-calls.js 三处 emit 点，嵌套 id 形态
// `${parentToolCallId}/${n}`），且嵌套调用不落独立 transcript 条目
// （pi dist/core/extensions/types.d.ts executeTool 契约「It does not appear in the
// transcript」——仅外层 result message 的 nestedCalls 保留有界记录）。
// 过滤语义 = 与 transcript 派生视图对齐：reload 后嵌套调用只有外层一个
// 工具块，live 期放行 start/end 会各产独立工具块 → 「live ≡ reload」破缺
// （AGENTS.md 关键规则 9 / codemode 设计 §3.3 D4）。
// 本层（runtime event-adapter）表驱动覆盖：
// - 嵌套 start / 嵌套 end → 过滤（零产出）；
// - 嵌套 update → 豁免（照常映射 message.tool_call_update——它是 subagent 翻译层
// 活性信号载体，U-A6 无进展守护刷新通道，丢弃会复发守护误杀）；
// - 非嵌套 start / end / update → 零影响；
// - parentToolCallId 空串按非嵌套放行（'' 属畸形值：误滤顶层块是数据损失，
// 误放行至多多一个重复块，两害取轻）。
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出。
// /

const NESTED_PARENT_ID = 'call_outer_1'

/** 构造 tool_execution_start 事件（parentToolCallId 缺省 = 顶层调用）。 */
function startEvent(parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_start',
    toolCallId: parentToolCallId !== undefined ? `${NESTED_PARENT_ID}/1` : 'call_top',
    toolName: 'bash',
    args: { script: 'await tools.read({ path: "a" })' },
    ...(parentToolCallId !== undefined && { parentToolCallId }),
  }
}

/** 构造 tool_execution_end 事件（result 形态对齐 pi AgentToolResult）。 */
function endEvent(parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: parentToolCallId !== undefined ? `${NESTED_PARENT_ID}/1` : 'call_top',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'ok' }], details: null },
    isError: false,
    ...(parentToolCallId !== undefined && { parentToolCallId }),
  }
}

/** 构造 tool_execution_update 事件（嵌套 id 形态对齐 pi nested-tool-calls.js）。 */
function updateEvent(toolCallId: string, parentToolCallId?: string): PiEvent {
  return {
    type: 'tool_execution_update',
    toolCallId,
    toolName: 'bash',
    partialResult: { content: [{ type: 'text', text: 'partial' }], details: null },
    ...(parentToolCallId !== undefined && { parentToolCallId }),
  }
}

/** 行期望：filtered = 零产出；其余 = 产出的判别形态。 */
type RowExpectation =
  | { out: 'filtered' }
  | { out: 'tool-call-start'; toolCallId: string }
  | { out: 'tool-call-end'; toolCallId: string }
  | { out: 'tool-call-update'; toolCallId: string }

const ROWS: Array<{ name: string; event: PiEvent; expected: RowExpectation }> = [
  {
    name: '嵌套 start（parentToolCallId 在场）→ 过滤，零产出',
    event: startEvent(NESTED_PARENT_ID),
    expected: { out: 'filtered' },
  },
  {
    name: '嵌套 end → 过滤，零产出',
    event: endEvent(NESTED_PARENT_ID),
    expected: { out: 'filtered' },
  },
  {
    name: '嵌套 update → 豁免（不产块事件，照常映射 message.tool_call_update）',
    event: updateEvent(`${NESTED_PARENT_ID}/1`, NESTED_PARENT_ID),
    expected: { out: 'tool-call-update', toolCallId: `${NESTED_PARENT_ID}/1` },
  },
  {
    name: '非嵌套 start → 零影响（tool-call-start 照常产出）',
    event: startEvent(),
    expected: { out: 'tool-call-start', toolCallId: 'call_top' },
  },
  {
    name: '非嵌套 end → 零影响（tool-call-end 照常产出）',
    event: endEvent(),
    expected: { out: 'tool-call-end', toolCallId: 'call_top' },
  },
  {
    name: '非嵌套 update → 零影响（message.tool_call_update 照常产出）',
    event: updateEvent('call_top'),
    expected: { out: 'tool-call-update', toolCallId: 'call_top' },
  },
  {
    name: '边界：parentToolCallId 空串按非嵌套放行（畸形值宁放行不误丢顶层块）',
    event: startEvent(''),
    expected: { out: 'tool-call-start', toolCallId: `${NESTED_PARENT_ID}/1` },
  },
]

describe('嵌套工具调用产块事件过滤（codemode u5 / D4，表驱动）', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const events = translate(row.event, 's1')
      if (row.expected.out === 'filtered') {
        expect(events).toEqual([])
        return
      }
      expect(events).toHaveLength(1)
      const ev = events[0]
      switch (row.expected.out) {
        case 'tool-call-start':
          expect(ev?.kind).toBe('tool-call-start')
          expect(ev?.kind === 'tool-call-start' && ev.toolCallId).toBe(row.expected.toolCallId)
          break
        case 'tool-call-end':
          expect(ev?.kind).toBe('tool-call-end')
          expect(ev?.kind === 'tool-call-end' && ev.toolCallId).toBe(row.expected.toolCallId)
          break
        case 'tool-call-update':
          expect(ev?.kind).toBe('message')
          if (ev?.kind === 'message') {
            expect(ev.message.type).toBe('message.tool_call_update')
            expect((ev.message.payload as Record<string, unknown>).toolCallId).toBe(row.expected.toolCallId)
          }
          break
      }
    })
  }

  it('混合序列：外层产块与嵌套过滤逐事件独立——外层两块照常、嵌套零产出', () => {
    const events = [
      ...translate(startEvent(), 's1'),
      ...translate(startEvent(NESTED_PARENT_ID), 's1'),
      ...translate(endEvent(NESTED_PARENT_ID), 's1'),
      ...translate(endEvent(), 's1'),
    ]
    expect(events.map((e) => e.kind)).toEqual(['tool-call-start', 'tool-call-end'])
  })
})

// ════════════════ 来源: event-adapter-retry-sound.test.ts ════════════════
// ---- 原文件头注释 ----
// [retry-sound] agent_end → message.complete 的 willRetry 透传回归锁。
// 背景：pi 每个 LLM attempt 失败都结束当次 agent loop 并发 agent_end（重试经
// agent.continue() 续跑），且 agent_end 恒带 willRetry（pi-protocol.ts PiAgentEndEvent，
// W6 A-10 探针验证）。此前 handleAgentEnd 丢弃该字段 → 前端把「中间失败」当终态，
// 完成提示音误响（重试成功双响 / 多次重试连响）。本锁保证 payload.willRetry 不再丢失：
// - willRetry=true（pi 将自动重试）→ 前端静音中间失败（useCompletionNotify 门控）；
// - willRetry=false（终态：成功/重试用尽/不可重试错误）→ 前端正常发声；
// - 空 messages 降级路径 → willRetry=false（拿不到 pi 字段，按不重试终态处理）。
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出（同
// event-adapter-trace-trigger.test.ts 范式）。
// /

const SID_RETRY = 's-retry-sound'

/**
 * 构造 agent_end 事件：lastMsg 取 messages 末位（与 handleAgentEnd 取法一致）。
 * errorMessage 是 pi 运行时扩展字段（超出 PiAgentEndMessage 声明，event-adapter 经
 * AgentEndRuntimeExtras as 提取）——测试构造同样以扩展形态传入。
 */
function agentEndEvent(
  willRetry: boolean,
  lastMsg: PiAgentEndEvent['messages'][number] & { errorMessage?: string },
): PiAgentEndEvent {
  return { type: 'agent_end', messages: [lastMsg], willRetry } as PiAgentEndEvent
}

/** 从 translate 产物中取 turn-end 的 message.complete 帧（共享单源，只取 payload）。 */
function completeOf(translated: ReturnType<typeof translate>): { payload: Record<string, unknown> } {
  return expectCompleteMessage(translated)
}

describe('[retry-sound] agent_end willRetry 透传 message.complete payload', () => {
  it('中间失败：willRetry=true + stopReason=error → payload.willRetry=true 透传', () => {
    const message = completeOf(
      translate(
        agentEndEvent(true, {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          errorMessage: 'Provider 500',
        }),
        SID_RETRY,
      ),
    )
    expect(message.payload.stopReason).toBe('error')
    expect(message.payload.willRetry).toBe(true)
    expect(message.payload.errorMessage).toBe('Provider 500')
  })

  it('重试用尽终态：willRetry=false + stopReason=error → payload.willRetry=false', () => {
    const message = completeOf(
      translate(
        agentEndEvent(false, {
          role: 'assistant',
          content: [],
          stopReason: 'error',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
          errorMessage: 'Provider 500',
        }),
        SID_RETRY,
      ),
    )
    expect(message.payload.stopReason).toBe('error')
    expect(message.payload.willRetry).toBe(false)
  })

  it('成功终态：willRetry=false + stopReason=stop → payload.willRetry=false', () => {
    const message = completeOf(
      translate(
        agentEndEvent(false, {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'stop',
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
        }),
        SID_RETRY,
      ),
    )
    expect(message.payload.stopReason).toBe('end_turn')
    expect(message.payload.willRetry).toBe(false)
  })

  it('空 messages 降级路径 → payload.willRetry=false（按不重试终态处理）', () => {
    const message = completeOf(
      translate({ type: 'agent_end', messages: [], willRetry: false } as unknown as PiAgentEndEvent, SID_RETRY),
    )
    expect(message.payload.stopReason).toBe('error')
    expect(message.payload.willRetry).toBe(false)
  })
})

// ════════════════ 来源: event-adapter-tool-update.test.ts ════════════════
// ---- 原文件头注释 ----
// handleToolExecutionUpdate 流式输出归一测试（bash-running-stream-output U1）。
// 锁定设计 §6.1 判别式 + §6.4 D4 两分支截断：
// - 三形态分发：content 数组 → output/outputRaw/detail；string → 仅 detail；
// 无 content 数组对象 → detail = 整个对象、无 output。
// - 尾窗截断不变式：截断后原文 ≤ cap 无例外；当 outputRaw 存在时
// output === stripAnsi(outputRaw)（截断在 stripAnsi 之前的原文上做，同源派生）。
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息。
// /

const CAP = 8 * 1024

/** 构造 tool_execution_update 事件。 */
function toolUpdate(partialResult: unknown): PiEvent {
  return { type: 'tool_execution_update', toolCallId: 'call-1', partialResult } as unknown as PiEvent
}

/** 从 translate 产出中取出唯一 message（payload 收窄为 Record，运行时 guard）。 */
function soleToolMessage(
  events: ReturnType<typeof translate>,
): { type: string; payload: Record<string, unknown> } {
  expect(events).toHaveLength(1)
  const [ev] = events
  if (!ev || ev.kind !== 'message') {
    throw new Error(`expected single message event, got: ${JSON.stringify(ev)}`)
  }
  if (typeof ev.message.payload !== 'object' || ev.message.payload === null) {
    throw new Error(`expected object payload, got: ${JSON.stringify(ev.message.payload)}`)
  }
  return ev.message as { type: string; payload: Record<string, unknown> }
}

describe('handleToolExecutionUpdate 三形态分发（判别式）', () => {
  it('content 数组形态 → detail=details + output + outputRaw（含 ANSI）', () => {
    const partialResult = {
      content: [{ type: 'text', text: '\x1b[32mstep-1\x1b[0m\nstep-2' }],
      details: { truncation: { originalLength: 100 } },
    }
    const msg = soleToolMessage(translate(toolUpdate(partialResult), 's1'))
    expect(msg.type).toBe('message.tool_call_update')
    expect(msg.payload.detail).toEqual({ truncation: { originalLength: 100 } })
    expect(msg.payload.output).toBe('step-1\nstep-2')
    expect(msg.payload.outputRaw).toBe('\x1b[32mstep-1\x1b[0m\nstep-2')
  })

  it('string 形态 → 仅 detail 原样，无 output/outputRaw', () => {
    const msg = soleToolMessage(translate(toolUpdate('running 42%'), 's1'))
    expect(msg.payload).toEqual({ sessionId: 's1', toolCallId: 'call-1', detail: 'running 42%' })
  })

  it('无 content 数组对象形态 → detail = 整个对象，无 output', () => {
    const partialResult = { progress: 0.5, label: 'half' }
    const msg = soleToolMessage(translate(toolUpdate(partialResult), 's1'))
    expect(msg.payload).toEqual({ sessionId: 's1', toolCallId: 'call-1', detail: partialResult })
  })

  it('content 空数组（pi bash 首帧）→ output 为显式空串也下发', () => {
    const partialResult = { content: [] }
    const msg = soleToolMessage(translate(toolUpdate(partialResult), 's1'))
    expect(msg.payload.detail).toEqual({ content: [] }) // 无 details → fallback 整对象
    expect(msg.payload.output).toBe('')
    expect('outputRaw' in msg.payload).toBe(false)
  })
})

describe('D4 尾窗截断两分支', () => {
  it('换行锚分支：超 cap 且截断点后有换行 → 尾窗从首个换行起整行保留', () => {
    const line = 'x'.repeat(100) + '\n'
    const rawText = line.repeat(200) // 20200 chars > cap
    const msg = soleToolMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    const output = msg.payload.output as string
    expect(output.length).toBeLessThanOrEqual(CAP)
    expect(output.length).toBeGreaterThan(CAP - 300) // 丢掉的只是不足一行的头部
    expect(rawText.endsWith(output)).toBe(true) // 尾窗 = 原文后缀
    expect(output.startsWith('x')).toBe(true) // 不劈行
  })

  it('硬切分支：无换行单行 → 恰好 cap 尾窗', () => {
    const rawText = 'a'.repeat(2_000_000)
    const msg = soleToolMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    expect(msg.payload.output).toBe(rawText.slice(-CAP))
  })

  it('硬切分支：截断点劈开代理对 → 码点边界回退（尾窗首字符是完整码点）', () => {
    // 截断点 = len - cap。构造 emoji 区横跨截断点且截断点落在低代理上（奇数下标）：
    // len = 1000 + 8187 = 9187，cut = 995 < 1000（emoji 区内，奇数 → 孤儿低代理）
    const rawText = '😀'.repeat(500) + 'b'.repeat(8187)
    const msg = soleToolMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    const output = msg.payload.output as string
    expect(output.length).toBe(CAP - 1) // 孤儿低代理被跳过
    // 尾窗首码元不是孤儿低代理（不劈开代理对）
    const first = output.charCodeAt(0)
    expect(first >= 0xdc00 && first <= 0xdfff).toBe(false)
    expect(rawText.endsWith(output)).toBe(true)
  })

  it('硬切分支：截断点落在 CSI 序列中段 → ANSI 残片推进到终止字节之后', () => {
    // 构造：无换行长文本，一个参数超长的 CSI 序列（中段全 ';' = 0x3B < 0x40 非终止字节）横跨截断点。
    // len = 100 + 502 + 8092 = 8694，cut = 502 ∈ CSI 区 [100, 602)
    const csi = '\x1b[' + ';'.repeat(500) + 'm'
    const rawText = 'c'.repeat(100) + csi + '\x1b[31mRED\x1b[0m' + 'q'.repeat(8080)
    const msg = soleToolMessage(
      translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
    )
    const output = msg.payload.output as string
    expect(output.length).toBeLessThanOrEqual(CAP)
    // 尾窗从残缺 CSI 终止字节 'm' 之后起步：不含半截序列，以 RED 开头
    expect(output.startsWith('RED')).toBe(true)
    // 同源派生不变式（outputRaw 存在时）
    const outputRaw = msg.payload.outputRaw as string
    expect(output).toBe(stripAnsi(outputRaw))
    expect(outputRaw.endsWith('RED\x1b[0m' + 'q'.repeat(8080))).toBe(true)
  })

  it('不变式：任意形态下 output 存在时截断后原文 ≤ cap，且 outputRaw 存在时 output === stripAnsi(outputRaw)', () => {
    const cases = [
      '\n'.repeat(50_000),
      'z'.repeat(50_000),
      '\x1b[32mg\x1b[0m'.repeat(10_000) + 'x'.repeat(9_000),
      '😀'.repeat(6_000),
    ]
    for (const rawText of cases) {
      const msg = soleToolMessage(
        translate(toolUpdate({ content: [{ type: 'text', text: rawText }] }), 's1'),
      )
      const output = msg.payload.output as string
      const outputRaw = msg.payload.outputRaw as string | undefined
      const rawSource = outputRaw ?? output
      expect(rawSource.length).toBeLessThanOrEqual(CAP)
      if (outputRaw !== undefined) {
        expect(output).toBe(stripAnsi(outputRaw))
      }
      expect(rawText.endsWith(rawSource)).toBe(true) // 尾部保留语义
    }
  })
})

// ════════════════ 来源: event-adapter-trace-trigger.test.ts ════════════════
// ---- 原文件头注释 ----
// withTraceTrigger 组合点回归测试（session-trace A33，round3 review S2 / mutation M4）。
// 锁定：message_end / agent_settled / entry_appended 三事件经 translate() 输出
// 同时**含 main 侧 handler 产物（W21 实时 feed / W1 bash flush / W18 派生缓存失效）
// 与** trace-trigger 中间事件（interpreter 调 onTraceSync 做追赶式 since 拉取），
// 且 main 产物在前、trace-trigger 追加在后。[reload-closeout D2] 起 agent_settled
// 在 trace-trigger 之后**再**追加 record-reconcile-trigger（onRecordReconcile 送达
// 水位对账路径，只挂 agent_settled——run 级联结束边界信号）。
// 回归背景：本 PR merge 曾修「两组 DISPATCHER.set 叠加互相覆盖」bug（Map 后写覆盖
// 前写，丢一组产物）。若退回单 handler 覆盖形态（丢 trace-trigger 追加），本文件
// 用例必须红——session-trace.test.ts 只测 interpreter 消费侧（直接喂构造好的
// trace-trigger 事件），adapter 产出侧此前零锚定。
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出。

const SID_TRACE = 's-trace-trigger'

describe('withTraceTrigger 组合注册不互相覆盖（session-trace A33 回归锁）', () => {
  it('组合注册不互相覆盖：三事件输出 main handler + trace-trigger（agent_settled 另追加 record-reconcile-trigger）', () => {
    // message_end：main = W21 实时 feed（message.message_end entry 帧）
    const messageEnd = translate(
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 1755700000000 },
      } as unknown as PiMessageEndEvent,
      SID_TRACE,
    )
    expect(messageEnd).toHaveLength(2)
    expect(messageEnd[0]).toMatchObject({
      kind: 'message',
      message: {
        type: 'message.message_end',
        payload: {
          sessionId: SID_TRACE,
          entry: { type: 'message', message: { role: 'assistant' } },
        },
      },
    })
    expect(messageEnd[1]).toEqual({ kind: 'trace-trigger', trigger: 'message_end' })

    // agent_settled：main = W1 bash flush 信号（agent-settled 中间事件）+ trace-trigger
    // + record-reconcile-trigger（[reload-closeout D2] 送达水位对账路径第三层组合，只挂
    // agent_settled——run 级联结束边界信号）
    const settled = translate({ type: 'agent_settled' } as PiAgentSettledEvent, SID_TRACE)
    expect(settled).toEqual([
      { kind: 'agent-settled' },
      { kind: 'trace-trigger', trigger: 'agent_settled' },
      { kind: 'record-reconcile-trigger' },
    ])

    // entry_appended：main = W18 派生缓存失效（record-entry-appended）
    const appended = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'subagent-record' } } as unknown as PiEntryAppendedEvent,
      SID_TRACE,
    )
    expect(appended).toEqual([
      { kind: 'record-entry-appended', customType: 'subagent-record' },
      { kind: 'trace-trigger', trigger: 'entry_appended' },
    ])
  })

  it('trace 路径独立于 main 路径：entry_appended 非 record customType 时 main 产出失效事件，trace-trigger 仍追加在后', () => {
    // 放宽（D5「失效转发的三段链路」①）：任何 custom entry 均产出失效信号，
    // 「避免无关 entry 触发拉取」由派发层订阅者存在性守住（原三字面量过滤删除）。
    // 组合语义不变：main 路径产失效事件不拖累 trace 路径——trace 视图仍需感知
    // extension appendEntry 触发追赶拉取；main 产物在前、trace-trigger 追加在后。
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'demo:other' } } as unknown as PiEntryAppendedEvent,
      SID_TRACE,
    )
    expect(events).toEqual([
      { kind: 'record-entry-appended', customType: 'demo:other' },
      { kind: 'trace-trigger', trigger: 'entry_appended' },
    ])
  })

  it('放宽：非 record customType（如 pi-scheduler:task）产出失效事件且 customType 正确透传', () => {
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'pi-scheduler:task' } } as unknown as PiEntryAppendedEvent,
      SID_TRACE,
    )
    expect(events[0]).toEqual({ kind: 'record-entry-appended', customType: 'pi-scheduler:task' })
  })

  it('放宽边界：customType 非 string（extension 第三方脏数据）→ main 走 noop，trace-trigger 仍追加', () => {
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 42 } } as unknown as PiEntryAppendedEvent,
      SID_TRACE,
    )
    expect(events).toEqual([{ kind: 'noop' }, { kind: 'trace-trigger', trigger: 'entry_appended' }])
  })

  it('非触发事件不追加 trace-trigger（组合点只注册三事件，检查不扩大）', () => {
    const events = translate(
      {
        type: 'message_end',
        message: { role: 'user', content: 'hi' },
      } as unknown as PiEvent,
      SID_TRACE,
    )
    expect(events).toHaveLength(2)
    // message_end 恒触发；换一个非触发事件对照（status）
    const status = translate({ type: 'status', status: 'busy' } as unknown as PiEvent, SID_TRACE)
    expect(status.every((e) => e.kind !== 'trace-trigger')).toBe(true)
  })

  it('entry_appended 对 workflow-record 同样双产物（W18 两类派生缓存）', () => {
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'workflow-record' } } as unknown as PiEntryAppendedEvent,
      SID_TRACE,
    )
    expect(events).toEqual([
      { kind: 'record-entry-appended', customType: 'workflow-record' },
      { kind: 'trace-trigger', trigger: 'entry_appended' },
    ])
  })

  it('entry_appended 对 plan-state 同样双产物（plan 模式重设计 D1① 白名单第三员）', () => {
    const events = translate(
      { type: 'entry_appended', entry: { type: 'custom', customType: 'plan-state' } } as unknown as PiEntryAppendedEvent,
      SID_TRACE,
    )
    expect(events).toEqual([
      { kind: 'record-entry-appended', customType: 'plan-state' },
      { kind: 'trace-trigger', trigger: 'entry_appended' },
    ])
  })
})

// ════════════════ 来源: event-adapter-ttft-anchors.test.ts ════════════════
// ---- 原文件头注释 ----
// EventAdapter TTFT 锚点翻译测试（composer-genstats-ttft U2，设计 §3.2）。
// 锁定：
// - turn_start 移出 NULL_EVENTS → 翻译为 llm-request-start（TTFT 起算锚点，无前端行为）
// - text_start / thinking_start / toolcall_start 三子类型追加 llm-first-output（首输出信号，
// 单点收）；既有行为不变——text/toolcall 原 noop 保留、message.thinking_start 帧行为保留
// - delta / end / error 子类型不产 llm-first-output（否决表 E：无 delta 兜底钩——adapter 是
// 唯一信号源，delta 路径零新增开销）
// translate 是纯函数（event-adapter.ts 头注释），直接调用断言产出消息。
// /

/** 构造 message_update 事件（assistantMessageEvent 子事件形状）。 */
/** 构造 turn_start 事件（wire 无 payload）。 */
function turnStart(): PiTurnStartEvent {
  return { type: 'turn_start' } as unknown as PiTurnStartEvent
}

/** 取产出中的 llm-first-output 个数。 */
function firstOutputCount(events: ReturnType<typeof translate>): number {
  return events.filter((e) => e.kind === 'llm-first-output').length
}

/** 取产出中的 llm-request-start 个数。 */
function requestStartCount(events: ReturnType<typeof translate>): number {
  return events.filter((e) => e.kind === 'llm-request-start').length
}

describe('EventAdapter TTFT 锚点翻译（composer-genstats-ttft U2）', () => {
  it('T1: turn_start → 恰一个 llm-request-start（sessionId 归属，无其他产出）', () => {
    const events = translate(turnStart(), 's1')
    expect(events).toEqual([{ kind: 'llm-request-start', sessionId: 's1' }])
    expect(requestStartCount(events)).toBe(1)
  })

  it('T2: text_start → noop 保留 + 追加 llm-first-output（原 noop 行为不变，仅追加）', () => {
    const events = translate(messageUpdate({ type: 'text_start', contentIndex: 0 }), 's1')
    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'llm-first-output', sessionId: 's1' },
    ])
  })

  it('T3: toolcall_start → noop 保留 + 追加 llm-first-output（纯 tool_call 响应的唯一首输出子类型）', () => {
    const events = translate(messageUpdate({ type: 'toolcall_start', contentIndex: 3 }), 's1')
    expect(events).toEqual([
      { kind: 'noop' },
      { kind: 'llm-first-output', sessionId: 's1' },
    ])
  })

  it('T4: thinking_start → message.thinking_start 帧行为不变（含 contentIndex 透传）+ 追加 llm-first-output', () => {
    const events = translate(messageUpdate({ type: 'thinking_start', contentIndex: 2 }), 's1')
    expect(events).toEqual([
      {
        kind: 'message',
        message: {
          type: 'message.thinking_start',
          payload: { sessionId: 's1', contentIndex: 2 },
        },
      },
      { kind: 'llm-first-output', sessionId: 's1' },
    ])
  })

  it('T4b: thinking_start 无 contentIndex → payload 省略字段（既有形态不变）', () => {
    const events = translate(messageUpdate({ type: 'thinking_start' }), 's1')
    expect(events[0]).toEqual({
      kind: 'message',
      message: { type: 'message.thinking_start', payload: { sessionId: 's1' } },
    })
    expect(firstOutputCount(events)).toBe(1)
  })

  it('E1 否决表 E 钉：delta 子类型不产 llm-first-output（text/thinking/toolcall delta 零新增）', () => {
    expect(firstOutputCount(translate(messageUpdate({ type: 'text_delta', delta: 'hi' }), 's1'))).toBe(0)
    expect(firstOutputCount(translate(messageUpdate({ type: 'thinking_delta', delta: '思考' }), 's1'))).toBe(0)
    expect(firstOutputCount(translate(messageUpdate({ type: 'toolcall_delta', delta: '{"a"' }), 's1'))).toBe(0)
  })

  it('E2: end 子类型不产 llm-first-output（text_end / thinking_end / toolcall_end）', () => {
    expect(firstOutputCount(translate(messageUpdate({ type: 'text_end' }), 's1'))).toBe(0)
    expect(firstOutputCount(translate(messageUpdate({ type: 'thinking_end' }), 's1'))).toBe(0)
    // toolcall_end 既有产 tool-call-index 顺序锚点行为不变，无 first-output
    const events = translate(
      messageUpdate({ type: 'toolcall_end', contentIndex: 1, toolCall: { id: 'tc-1' } }),
      's1',
    )
    expect(events).toEqual([{ kind: 'tool-call-index', toolCallId: 'tc-1', contentIndex: 1 }])
  })

  it('E3: error 子类型产 message.stream_error 不产 llm-first-output（错误流非输出信号）', () => {
    // wire 真实字段 = {reason, error:{errorMessage}}（PiErrorSubEvent，dev RT-2#2 修复后的读取路径）
    const events = translate(messageUpdate({ type: 'error', reason: 'error', error: { errorMessage: 'boom' } }), 's1')
    expect(events).toEqual([{
      kind: 'message',
      message: { type: 'message.stream_error', payload: { sessionId: 's1', content: 'boom', kind: 'error' } },
    }])
  })

  it('E4 回归：message_update 子事件缺 assistantMessageEvent 仍 noop（防御分支不变）', () => {
    const events = translate({ type: 'message_update' } as unknown as PiMessageUpdateEvent, 's1')
    expect(events).toEqual([{ kind: 'noop' }])
    expect(firstOutputCount(events)).toBe(0)
  })
})

// ════════════════ 来源: event-adapter-turn-usage-sum.test.ts ════════════════
// ---- 原文件头注释 ----
// [turn-badge-tokens → chat-flow-consistency D3 规则 5] agent_end 翻译的 usage 语义回归锁。
// [HISTORICAL] payload.usage（message.complete 回合级累计，sumTurnUsage 发端）已随
// chat-flow-consistency D3 规则 5 退役：usage/endedAt 由 message_end(assistant) 逐条载荷
// 唯一承担（core apply-entry-convert usageField 消费，live ≡ reload 同一转换函数）——
// message.complete 回合级覆写与发端 payload.usage 死链同批删除（core 消费端 readUsage 与
// 本发端在终态同步 F1-21/F1-26 清理），本文件不再断言 payload.usage。
// 现存断言：turn-end 顶层 inputTokens/totalTokens（context 占用）= 末次调用 totalTokens
// （calculateContextTokens 同源语义，不随多调用累计变化）。
// /

const SID_USAGE = 's-turn-usage-sum'

function assistantMsg(usage: { input: number; output: number; totalTokens: number } | undefined) {
  return { role: 'assistant', content: [], stopReason: 'stop', ...(usage ? { usage } : {}) }
}

function agentEnd(messages: unknown[], willRetry = false): PiAgentEndEvent {
  return { type: 'agent_end', messages, willRetry } as unknown as PiAgentEndEvent
}

describe('[turn-badge-tokens] agent_end turn-end context 占用（payload.usage 发端已退役）', () => {
  it('turn-end 顶层 inputTokens/totalTokens（context 占用）仍 = 末次调用 totalTokens，不随累计变化', () => {
    const turnEnd = translate(
      agentEnd([
        assistantMsg({ input: 400, output: 500, totalTokens: 900 }),
        assistantMsg({ input: 50, output: 30, totalTokens: 80 }),
      ]),
      SID_USAGE,
    ).find((e) => e.kind === 'turn-end') as { inputTokens?: number; totalTokens?: number }
    expect(turnEnd.inputTokens).toBe(80)
    expect(turnEnd.totalTokens).toBe(80)
  })

  it('message.complete payload 不再携带 usage（D3 规则 5 逐条载荷唯一承担）', () => {
    const payload = translate(
      agentEnd([assistantMsg({ input: 400, output: 500, totalTokens: 900 })]),
      SID_USAGE,
    ).find((e) => e.kind === 'turn-end') as { message?: { payload?: Record<string, unknown> } }
    expect(payload.message?.payload?.usage).toBeUndefined()
  })
})
