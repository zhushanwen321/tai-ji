/**
 * W18 tests：EventInterpreter subagent 事件 → 派生缓存失效信号。
 *
 * 背景（W18 data-source-governance P3.1，D4）：subagent 列表数据源切换为
 * 「entry_appended 失效 → get_entries(since) 增量重拉 → entry 扫描派生缓存」。
 * interpreter 的 subagent 事件流（tool-call-end 建 running / bg-notify 合并终态）
 * **直写退役**——全部降级为失效信号（onRecordEntriesInvalidated，组合根注入
 * sessionService.invalidateRecordEntries）。数据合并语义（status 归一 / agent 覆盖 /
 * closedReason 投影 / batch 合并）由 entry 扫描承载（subagent-extractor.test.ts 的
 * scanSubagentEntries 用例 + session-record-entries.test.ts 的拉取收敛用例）。
 *
 * U1：subagent tool-call-end → 失效回调（不产 session.subagents 帧）
 * U2：bg-notify（single/batch）customStart → 失效回调 + customStart 帧照发前端
 * U3：非 subagent 工具不触发失效
 * U4：record-entry-appended 主信号 → 失效回调
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiTranslatedEvent } from '../src/services/session/types.js'

describe('EventInterpreter · subagent 事件 → 派生缓存失效（W18 直写退役）', () => {
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

  /** 构造 subagent tool-call-end 事件（W12 曾直写建 running 记录的事件流） */
  function subagentEnd(toolCallId: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'tool-call-end',
      toolCallId,
      toolName: 'subagent',
      output: JSON.stringify(details),
      details,
      images: undefined,
      isError: false,
      entry: {
        type: 'message',
        parentId: null,
        timestamp: new Date(0).toISOString(),
        message: { role: 'toolResult', toolCallId, toolName: 'subagent', content: JSON.stringify(details), isError: false, details, timestamp: 0 },
      },
    }
  }

  /** 构造 customStart message 事件（bg-notify 载体） */
  function customStart(sessionId: string, customType: string, details: Record<string, unknown>): PiTranslatedEvent {
    return {
      kind: 'message',
      message: {
        type: 'message.customStart',
        payload: { sessionId, customType, details },
      } as ServerMessage,
    }
  }

  // ── U1：subagent tool-call-end → 失效回调 ──────────────────────
  it('U1: subagent tool-call-end → 失效 subagent-record，不产 session.subagents 帧（直写退役）', () => {
    const interpreter = makeInterpreter('sid-u1')

    interpreter.interpret([
      subagentEnd('call-1', {
        action: 'start',
        subagentId: 'bg-1-123',
        sessionFile: '/data/sub.jsonl',
        bgResponse: { status: 'running', message: 'detached' },
      }),
    ])

    expect(invalidations).toEqual([{ sessionId: 'sid-u1', customType: 'subagent-record' }])
    // 数据不进事件侧缓存：无 session.subagents 帧（发布归 sessionService 拉取收敛后）
    expect(sent.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
    // 通用 tool_call_end WS 帧照常产出
    expect(sent.some((m) => m.type === 'message.tool_call_end')).toBe(true)
  })

  // ── U2：bg-notify → 失效回调 + customStart 帧照发 ──────────────
  describe('U2: bg-notify customStart → 失效回调（数据合并归 entry 扫描）', () => {
    it('single 形态 bg-notify → 失效 + customStart 帧转发前端（BgNotifyCard 渲染不受退役影响）', () => {
      const interpreter = makeInterpreter('sid-u2')

      interpreter.interpret([
        customStart('sid-u2', 'subagent-bg-notify', {
          id: 'bg-1-123', status: 'closed', agent: 'reviewer', model: 'glm-5.2',
          startedAt: 1000, endedAt: 2000, closedReason: 'gc',
        }),
      ])

      expect(invalidations).toEqual([{ sessionId: 'sid-u2', customType: 'subagent-record' }])
      const frames = sent.filter((m) => m.type === 'message.customStart')
      expect(frames).toHaveLength(1)
      expect((frames[0]!.payload as { customType?: string }).customType).toBe('subagent-bg-notify')
      expect(sent.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
    })

    it('batch 形态 bg-notify → 同样一次失效（防抖合并由 sessionService 承接）', () => {
      const interpreter = makeInterpreter('sid-u2b')

      interpreter.interpret([
        customStart('sid-u2b', 'subagent-bg-notify', {
          batch: true,
          items: [
            { id: 'bg-a-1', status: 'closed', agent: 'worker', startedAt: 1000, endedAt: 2000 },
            { id: 'bg-b-2', status: 'closed', agent: 'researcher', startedAt: 1100, endedAt: 2200 },
          ],
        }),
      ])

      expect(invalidations).toEqual([{ sessionId: 'sid-u2b', customType: 'subagent-record' }])
    })
  })

  // ── U3：非 subagent 工具不触发失效 ─────────────────────────────
  it('U3: 非 subagent 工具的 tool-call-end 不触发失效', () => {
    const interpreter = makeInterpreter('sid-u3')

    interpreter.interpret([
      {
        kind: 'tool-call-end',
        toolCallId: 'call-other',
        toolName: 'read',
        output: 'ok',
        details: { action: 'start', subagentId: 'bg-x' },
        images: undefined,
        isError: false,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'toolResult', toolCallId: 'call-other', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 },
        },
      },
    ])

    expect(invalidations).toHaveLength(0)
  })

  // ── U4：record-entry-appended 主信号 ───────────────────────────
  it('U4: record-entry-appended（entry_appended 主信号翻译产物）→ 失效回调', () => {
    const interpreter = makeInterpreter('sid-u4')

    interpreter.interpret([{ kind: 'record-entry-appended', customType: 'subagent-record' }])

    expect(invalidations).toEqual([{ sessionId: 'sid-u4', customType: 'subagent-record' }])
    expect(sent.filter((m) => m.type === 'session.subagents')).toHaveLength(0)
  })

  it('U5: 无关 customType 的 customStart 不触发失效（守卫保持）', () => {
    const interpreter = makeInterpreter('sid-u5')

    interpreter.interpret([customStart('sid-u5', 'unrelated-notify', { id: 'x' })])

    expect(invalidations).toHaveLength(0)
  })
})
