/**
 * pi1-disposition-chat-flow U4⑥：D6 映射表全覆盖 + stdout 单通路「恰一次」断言。
 *
 * D6 映射表（设计 §3.3，对账底表）——pi method × taiji 出口：
 * | pi method        | 出口                                        |
 * |------------------|---------------------------------------------|
 * | select/confirm/input/editor（无 marker） | extension.dialog 帧（载荷 dialogKind，taiji 词表） |
 * | notify           | extension:notify 帧（出口与载荷零变化）      |
 * | setWidget        | extension:widget 帧（出口与载荷零变化，无 kind） |
 * | setStatus        | status-set 内部事件 + extension:status 帧（双出口载荷零变化，无 kind） |
 * | set_editor_text  | extension:setEditorText 帧（出口与载荷零变化，无 kind） |
 * | setTitle         | warn + noop（宿主不实现，pi fire-and-forget 无损失） |
 * | select + SESSION_MANAGER_MARKER | session-manager-ui 内部 kind（不广播前端） |
 * | select + SUBAGENT_INFLIGHT_MARKER | 旁路消费，零翻译输出 |
 * | select + UI_FORM_MARKER | extension.dialog + form:true（dialogKind='select'） |
 *
 * 恰一次断言：六类迁移事件（agent_start / agent_end / message_end / turn_end /
 * tool_execution_start / tool_execution_end）各自对 onPiEvent 钩子恰触发一次——
 * bridge 转发链退役后插件事件感知单一通路 = stdout（event-interpreter 登记点族），
 * 「恰一次」= 单事件恰一次触发、无重复通知形态。
 *
 * marker 家族 title 判定保留在 event-adapter（合法持有点内的翻译逻辑）；普通对话框
 * title 随帧透传纯展示（D6③，前端不再按 title marker 识别路由）。
 */
import { describe, it, expect, vi } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import { EventInterpreter } from '../src/services/session/event-interpreter.js'
import { ASK_USER_MARKER, SESSION_MANAGER_MARKER, SUBAGENT_INFLIGHT_MARKER, UI_FORM_MARKER } from '@zhushanwen/extension-protocol'
import type { ServerMessage } from '@taiji/shared'

type PiTestEvent = Record<string, unknown>

const SID = 'sess-d6'

// ── D6 映射表全覆盖（translate 纯函数层）────────────────────────

describe('D6 mapping table: dialog family → extension.dialog', () => {
  const dialogCases = [
    { method: 'select', extras: { options: ['a', 'b'] } },
    { method: 'confirm', extras: { message: 'sure?' } },
    { method: 'input', extras: { placeholder: 'type here' } },
    { method: 'editor', extras: { prefill: 'draft' } },
  ] as const

  for (const { method, extras } of dialogCases) {
    it(`${method} → extension.dialog with dialogKind='${method}' (no pi method name in frame)`, () => {
      const events = translate({ type: 'extension_ui_request', method, id: 'req-1', title: 'T', ...extras } as PiTestEvent as never, SID)
      const frames = events.filter((e) => e.kind === 'message')
      expect(frames).toHaveLength(1)
      const msg = (frames[0] as { message: ServerMessage }).message
      expect(msg.type).toBe('extension.dialog')
      const payload = msg.payload as Record<string, unknown>
      expect(payload.dialogKind).toBe(method)
      // pi 词汇止点：帧载荷不携带 method 字段
      expect(payload).not.toHaveProperty('method')
      expect(payload.sessionId).toBe(SID)
      expect(payload.requestId).toBe('req-1')
      // title 随帧透传（纯展示；marker 约定串不落在本用例——普通对话框 title 无路由职责）
      expect(payload.title).toBe('T')
    })
  }

  it('dialog frame pairs with the internal extension-ui routing event (dialogKind + method in sync)', () => {
    const events = translate({ type: 'extension_ui_request', method: 'confirm', id: 'req-2' } as PiTestEvent as never, SID)
    const internal = events.find((e) => e.kind === 'extension-ui') as { method: string; payload: Record<string, unknown> }
    expect(internal).toBeTruthy()
    expect(internal.method).toBe('confirm') // runtime 内部回调参数（通用词）
    expect(internal.payload.dialogKind).toBe('confirm') // wire 帧字段（taiji 词表）
  })

  it('select + UI_FORM_MARKER → extension.dialog + form:true + dialogKind=select', () => {
    const formPayload = JSON.stringify({ formQuestions: [{ type: 'text', question: 'q1' }], allowCancel: false })
    const events = translate({ type: 'extension_ui_request', method: 'select', id: 'req-3', title: UI_FORM_MARKER, options: [formPayload] } as PiTestEvent as never, SID)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension.dialog')
    const payload = msg.payload as Record<string, unknown>
    expect(payload.form).toBe(true)
    expect(payload.dialogKind).toBe('select')
    expect(payload).not.toHaveProperty('method')
    expect(Array.isArray(payload.formQuestions)).toBe(true)
  })
})

describe('D6 mapping table: notify / setWidget / setStatus / set_editor_text / setTitle', () => {
  it('notify → extension:notify（出口与载荷零变化：sessionId/message/level，无 kind/dialogKind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'notify', id: 'req-n', message: 'hello', notifyType: 'warning' } as PiTestEvent as never, SID)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:notify')
    expect(msg.payload).toEqual({ sessionId: SID, message: 'hello', level: 'warn' })
  })

  it('setWidget（纯文本）→ extension:widget（载荷零变化：sessionId/widgetKey/lines，无 kind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'setWidget', id: 'req-w', widgetKey: 'k', widgetLines: ['l1'] } as PiTestEvent as never, SID)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:widget')
    expect(msg.payload).toEqual({ sessionId: SID, widgetKey: 'k', lines: ['l1'] })
  })

  it('setStatus → status-set 内部事件 + extension:status 帧双出口（载荷零变化，均无 kind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'setStatus', id: 'req-s', statusKey: 'model', statusText: 'gpt-x' } as PiTestEvent as never, SID)
    // 内部路由事件（interpreter → server.handleStatusSetUpdate）
    const statusSet = events.find((e) => e.kind === 'status-set') as { key: string; text: string; sessionId: string } | undefined
    expect(statusSet).toEqual({ kind: 'status-set', sessionId: SID, key: 'model', text: 'gpt-x', textRaw: 'gpt-x' })
    // WS 广播帧
    const frames = events.filter((e) => e.kind === 'status-broadcast')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:status')
    expect(msg.payload).toEqual({ sessionId: SID, statusKey: 'model', text: 'gpt-x', textRaw: 'gpt-x' })
  })

  it('set_editor_text → extension:setEditorText（载荷零变化，无 kind）', () => {
    const events = translate({ type: 'extension_ui_request', method: 'set_editor_text', id: 'req-e', text: 'body' } as PiTestEvent as never, SID)
    const frames = events.filter((e) => e.kind === 'message')
    expect(frames).toHaveLength(1)
    const msg = (frames[0] as { message: ServerMessage }).message
    expect(msg.type).toBe('extension:setEditorText')
    expect(msg.payload).toEqual({ sessionId: SID, text: 'body' })
  })

  it('setTitle → warn + noop（宿主不实现，无出口）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = translate({ type: 'extension_ui_request', method: 'setTitle', id: 'req-t', title: 'win title' } as PiTestEvent as never, SID)
      expect(events).toEqual([{ kind: 'noop' }])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      // warn 形态：前缀串 + method 值两参（保留 pi 升级语义可诊断）
      expect(warnSpy.mock.calls[0]?.slice(0, 2).join(' ')).toContain('setTitle')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('未知 method → warn + noop（兜底保持）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const events = translate({ type: 'extension_ui_request', method: 'future_method', id: 'req-u' } as PiTestEvent as never, SID)
      expect(events).toEqual([{ kind: 'noop' }])
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe('D6 mapping table: runtime-internal marker channels (no frontend broadcast)', () => {
  it('select + SESSION_MANAGER_MARKER → session-manager-ui 内部 kind，零 WS 帧', () => {
    const payload = JSON.stringify({ action: 'list', params: {} })
    const events = translate({ type: 'extension_ui_request', method: 'select', id: 'req-sm', title: SESSION_MANAGER_MARKER, options: [payload] } as PiTestEvent as never, SID)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('session-manager-ui')
    expect(events.filter((e) => e.kind === 'message')).toHaveLength(0)
  })

  it('select + SUBAGENT_INFLIGHT_MARKER → 翻译层守卫零输出（旁路消费）', () => {
    const payload = JSON.stringify({ sessionId: 'p1', records: [] })
    const events = translate({ type: 'extension_ui_request', method: 'select', id: 'req-inf', title: SUBAGENT_INFLIGHT_MARKER, options: [payload] } as PiTestEvent as never, SID)
    expect(events).toEqual([])
  })
})

// ── stdout 单通路「恰一次」断言（interpreter 层）────────────────

/**
 * 装配最小 interpreter：只统计 executeHooks('onPiEvent', …) 触发与 WS 帧。
 */
function setup() {
  const hookCalls: Array<{ hookType: string; context: Record<string, unknown> }> = []
  const sent: ServerMessage[] = []
  const interpreter = new EventInterpreter(SID, {
    send: (msg) => { sent.push(msg) },
    executeHooks: async (hookType: string, context: Record<string, unknown>) => {
      hookCalls.push({ hookType, context })
      return { blocked: false }
    },
  })
  return { interpreter, hookCalls, sent }
}

describe('stdout single-path exactly-once (six migrated event families)', () => {
  it('agent_start / agent_end / message_end / turn_end / tool_execution_start / tool_execution_end 各恰一次 onPiEvent', async () => {
    const { interpreter, hookCalls } = setup()
    const piEventNames = (ctx: Record<string, unknown>) => String(ctx.event)

    // 逐类投递单个事件（经 translate 全链路：构造 pi 原始事件形态 → interpreter.interpret）
    const feeds: PiTestEvent[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant' } }, // assistant turn 开始（产出 turn-start + message.message_start）
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } },
      { type: 'tool_execution_start', toolCallId: 'tc-1', toolName: 'bash', args: { cmd: 'ls' } },
      { type: 'tool_execution_end', toolCallId: 'tc-1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } },
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() },
      },
      { type: 'turn_end', message: { usage: { input: 1, output: 1, totalTokens: 2 } } },
      {
        type: 'agent_end',
        willRetry: false,
        messages: [{ stopReason: 'stop', usage: { input: 1, output: 1, totalTokens: 3 }, content: [{ type: 'text', text: 'hi' }] }],
      },
    ]
    for (const ev of feeds) {
      // 直用 translate：与生产 EventAdapter.attach 同一翻译入口（纯函数，无旁路消费差异）
      interpreter.interpret(translate(ev as never, SID))
    }
    // tool-call-* 的 hook 改写是异步 handler（void 调用）——flush microtasks 后断言
    await new Promise((r) => setTimeout(r, 0))

    const onPiCalls = hookCalls.filter((c) => c.hookType === 'onPiEvent')
    const byEvent = new Map<string, number>()
    for (const c of onPiCalls) {
      const name = piEventNames(c.context)
      byEvent.set(name, (byEvent.get(name) ?? 0) + 1)
    }

    // 六类迁移事件各自恰一次（bridge 曾转发 → 现在 stdout 单通路零重复）
    for (const name of ['agent_start', 'agent_end', 'message_end', 'turn_end', 'tool_execution_start', 'tool_execution_end']) {
      expect(byEvent.get(name)).toBe(1)
    }
    // 无其他事件名混入（六类迁移事件是本次断言全集；tool_execution_update 等不在迁移清单）
    expect(byEvent.size).toBe(6)
  })

  it('message_end 登记点载荷 = 帧携带的 entry（与 reload 同构）', async () => {
    const { interpreter, hookCalls } = setup()
    const entry = { type: 'message', parentId: null, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [] } }
    interpreter.interpret([
      { kind: 'message', message: { type: 'message.message_end', payload: { sessionId: SID, entry } } } as never,
    ])
    const call = hookCalls.find((c) => c.hookType === 'onPiEvent' && c.context.event === 'message_end')
    expect(call).toBeTruthy()
    expect(call!.context.entry).toEqual(entry)
  })

  it('同一 pi 事件批次内 message_end 恰一次（batch 复投不双触发）', async () => {
    const { interpreter, hookCalls } = setup()
    const ev = { type: 'message_end', message: { role: 'assistant', content: [], timestamp: Date.now() } }
    interpreter.interpret(translate(ev as never, SID))
    const count = hookCalls.filter((c) => c.hookType === 'onPiEvent' && c.context.event === 'message_end').length
    expect(count).toBe(1)
  })
})
