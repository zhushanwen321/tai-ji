/**
 * W18 tests：EventInterpreter workflow 事件 → 派生缓存失效信号。
 *
 * 背景（W18 data-source-governance P3.1，D4）：workflow 列表数据源切换为
 * 「entry_appended 失效 → get_entries(since) 增量重拉 → entry 扫描派生缓存」。
 * interpreter 的 workflow 事件流（tool-call-end 发起 running / workflow-result 终态）
 * **直写退役**——降级为失效信号（onRecordEntriesInvalidated）。增量信号帧
 * session.workflowUpdate 的发布归 sessionService 拉取收敛后的状态 diff（含
 * running/done/reason 语义，见 session-record-entries.test.ts）。
 *
 * U1：workflow tool-call-end → 失效回调（不产 session.workflowUpdate 帧）
 * U2：workflow-result customStart → 失效回调 + customStart 帧照发前端
 * U3：非 workflow tool / 无关 customType 不触发失效
 * U4：W09 快速路径 customType 护栏（带 customType 的 delta 回落完整检查路径）
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · workflow 事件 → 派生缓存失效（W18 直写退役）', () => {
  let sent: ServerMessage[]
  let invalidations: Array<{ sessionId: string; customType: string }>
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    invalidations = []
    send = (msg) => { sent.push(msg) }
  })

  function makeInterpreter(sessionId: string): EventInterpreter {
    return new EventInterpreter(sessionId, {
      send,
      onRecordEntriesInvalidated: (sid, customType) => { invalidations.push({ sessionId: sid, customType }) },
    })
  }

  /** 构造 workflow tool-call-end 事件（W12 曾直写 running 信号的事件流） */
  function workflowEnd(details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId: 'call-wf-1',
      toolName: 'workflow',
      output: JSON.stringify(details),
      details,
      images: undefined,
      isError: false,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId: 'call-wf-1', toolName: 'workflow', content: JSON.stringify(details), isError: false, details, timestamp: 0 },
      },
    }
  }

  /** 构造 customStart message 事件 */
  function customStart(customType: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: {
          sessionId: 'sid-wf',
          customType,
          content: 'test',
          details,
        },
      },
    }
  }

  /** 从 sent 里提取 session.workflowUpdate 消息 */
  function findWorkflowUpdate(): ServerMessage | undefined {
    return sent.find((m) => m.type === 'session.workflowUpdate')
  }

  // ── U1：workflow tool-call-end → 失效回调 ──────────────────────
  it('U1: workflow tool-call-end → 失效 workflow-record，不产 session.workflowUpdate 帧（直写退役）', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      workflowEnd({ action: 'run', runId: 'wf-test-001', status: 'running', name: 'deploy-flow' }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'workflow-record' }])
    expect(findWorkflowUpdate()).toBeUndefined()
    // 通用 tool_call_end WS 帧照常产出
    expect(sent.some((m) => m.type === 'message.tool_call_end')).toBe(true)
  })

  // ── U2：workflow-result customStart → 失效回调 + 帧照发 ────────
  it('U2: workflow-result customStart → 失效 + customStart 帧转发前端（完成 turn 注入渲染不受影响）', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      customStart('workflow-result', {
        runId: 'wf-test-002',
        name: 'test-flow',
        status: 'done',
        reason: 'completed',
        traceLength: 3,
      }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'workflow-record' }])
    const frames = sent.filter((m) => m.type === 'message.customStart')
    expect(frames).toHaveLength(1)
    expect((frames[0]!.payload as { customType?: string }).customType).toBe('workflow-result')
    expect(findWorkflowUpdate()).toBeUndefined()
  })

  // ── U3：守卫语义保持 ────────────────────────────────────────────
  it('U3: 非 workflow tool 的 tool-call-end 不触发失效', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      {
        kind: 'tool-call-end',
        toolCallId: 'call-other',
        toolName: 'read',
        output: 'ok',
        details: { action: 'run', runId: 'wf-x', status: 'running' },
        images: undefined,
        isError: false,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'call-other', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, details: { action: 'run', runId: 'wf-x', status: 'running' }, timestamp: 0 },
        },
      },
    ])

    expect(invalidations).toHaveLength(0)
  })

  it('U3b: 无关 customType（subagent-bg-notify）不触发 workflow 失效（定向守卫保持）', () => {
    const interpreter = makeInterpreter('sid-wf')

    interpreter.interpret([
      customStart('subagent-bg-notify', { id: 'bg-1', status: 'closed' }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'subagent-record' }])
  })

  // ── U4：W09 快速路径 customType 护栏 ───────────────────────────
  describe('W09 微项 4 快速路径 customType 护栏', () => {
    /** 构造 text_delta message 事件（可选注入 customType 模拟未来新增产出点） */
    function textDelta(payloadExtra?: Record<string, unknown>): PiTranslatedEvent {
      return {
        kind: 'message',
        message: {
          type: 'message.text_delta',
          payload: { sessionId: 'sid-wf', delta: 'x', ...payloadExtra },
        },
      }
    }

    it('无 customType 的 text_delta 走快速路径：只 send 一次，零失效（纯转发）', () => {
      const interpreter = makeInterpreter('sid-wf')

      interpreter.interpret([textDelta()])

      expect(sent).toHaveLength(1)
      expect(sent[0]!.type).toBe('message.text_delta')
      expect(invalidations).toHaveLength(0)
    })

    it('带 customType 的 text_delta 回落完整检查路径：workflow-result 失效生效', () => {
      const interpreter = makeInterpreter('sid-wf')

      // 模拟未来新增「带 customType 的 delta 产出点」：护栏必须使其绕开快速路径，
      // 否则 workflow 检查函数被静默跳过（W09 review 指出的绕过风险）。
      interpreter.interpret([
        textDelta({ customType: 'workflow-result', details: { runId: 'wf-guard-1', status: 'done', reason: 'completed' } }),
      ])

      // delta 本身仍被转发（完整路径的 message 分支同样 send）+ 失效被触发
      expect(sent).toHaveLength(1)
      expect(sent[0]!.type).toBe('message.text_delta')
      expect(invalidations).toEqual([{ sessionId: 'sid-wf', customType: 'workflow-record' }])
    })
  })
})
