/**
 * EventAdapter UI_FORM_MARKER 检测路由测试（ui-presentation-protocol u2）。
 *
 * 覆盖（照 plan-review / ask-user 检测测试形态，全部 mock 零真实 pi）：
 * - title=UI_FORM_MARKER 的 select 事件 → 成对产出 extension-ui kind + extension.ui_request
 *   广播帧，payload 含 form:true 标记 + formQuestions（守卫过滤后的合法项）+ allowCancel
 * - 消费端守卫失败策略（设计 D2 末条，与 ask-user 整体判否不同）：isFormQuestion 逐项过滤，
 *   混合数组仅保留合法项；全不合法 / 非 JSON / formQuestions 非数组 → 降级普通 select
 * - kind 双事件断言：extension-ui kind（watchdog 暂停 + server 跟踪 + pending 缓存的编排
 *   入口，interpreter 路由 onExtensionUIRequest）+ message kind（前端广播帧）成对且字段一致
 * - 既有 marker 分支无回归（D7：ASK_USER / SCHEDULE_CREATE 分支原样保留零改动）
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-ui-form-marker.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { translate } from '../event-adapter.js'
import { UI_FORM_MARKER, ASK_USER_MARKER, SCHEDULE_CREATE_MARKER } from '@zhushanwen/extension-protocol'
import { EventInterpreter } from '../../../services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { PiExtensionUiRequestEvent } from '../pi-protocol.js'
import type { PiTranslatedEvent } from '../../../services/session/types.js'

const SID = 'sess-ui-form-1'

function selectEvent(overrides: Partial<PiExtensionUiRequestEvent> = {}): PiExtensionUiRequestEvent {
  return { type: 'extension_ui_request', method: 'select', id: 'req-1', ...overrides }
}

/** 从 translate 结果取 message kind 事件的 payload（extension.ui_request 广播帧）。 */
function broadcastPayload(events: PiTranslatedEvent[]): Record<string, unknown> | undefined {
  const frame = events.find((e) => e.kind === 'message')
  if (!frame || frame.kind !== 'message') return undefined
  return frame.message.payload as Record<string, unknown>
}

/** 三类型合法问题集（choice / text / schedule 各一，全可选字段覆盖验证保真） */
function makeValidQuestions(): unknown[] {
  return [
    { type: 'choice', header: 'db', question: '选哪个数据库?', context: '迁移目标', options: [{ label: 'PG', description: '成熟' }, { label: 'MySQL' }], multi: true, allowOther: false },
    { type: 'text', header: 'note', question: '备注什么?' },
    { type: 'schedule', header: 'task', question: '确认定时任务', initial: { kind: 'once', schedule: '0 30 9 20 9 *', prompt: '跑一次备份', models: ['glm-5'] } },
  ]
}

describe('EventAdapter UI_FORM_MARKER 检测路由（u2）', () => {
  it('合法 formQuestions → 双事件：extension-ui kind + 广播帧，form:true + 合法项透传 + allowCancel 保真', () => {
    const questions = makeValidQuestions()
    const events = translate(
      selectEvent({ id: 'req-form', title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: questions, allowCancel: false })] }),
      SID,
    )

    // 成对产出：extension-ui kind（interpreter 挂起跟踪 + pending 缓存编排入口）+ message kind（前端广播帧）
    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.method).toBe('select')
    expect(uiEvent.requestId).toBe('req-form')
    expect(uiEvent.sessionId).toBe(SID)
    expect(uiEvent.payload['form']).toBe(true)
    expect(uiEvent.payload['formQuestions']).toEqual(questions)
    expect(uiEvent.payload['allowCancel']).toBe(false)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['form']).toBe(true)
    expect(payload?.['formQuestions']).toEqual(questions)
    expect(payload?.['allowCancel']).toBe(false)
    expect(payload?.['sessionId']).toBe(SID)
    expect(payload?.['requestId']).toBe('req-form')
    expect(payload?.['method']).toBe('select')
    // 与 ask-user 分支同构：不传 title/options（避免前端把 JSON payload 当下拉选项/标题）
    expect(payload?.['title']).toBeUndefined()
    expect(payload?.['options']).toBeUndefined()
    // 与既有富交互字段互不串扰
    expect(payload?.['askUser']).toBeUndefined()
    expect(payload?.['askUserQuestions']).toBeUndefined()
    expect(payload?.['scheduleCreate']).toBeUndefined()
    expect(payload?.['scheduleDraft']).toBeUndefined()
  })

  it('allowCancel 缺省 → 默认 true（与 askUserInteract 现状一致）', () => {
    const events = translate(
      selectEvent({ title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: [{ type: 'text', question: 'q' }] })] }),
      SID,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['allowCancel']).toBe(true)
  })

  it('混合数组仅保留合法项（逐项过滤，不合法项剔除且合法项顺序保持）', () => {
    const validChoice = { type: 'choice', question: '合法单选', options: [{ label: 'A' }] }
    const invalidNoQuestion = { type: 'choice', options: [{ label: 'B' }] } // 缺 question
    const validText = { type: 'text', question: '合法文本' }
    const invalidBadOptions = { type: 'choice', question: 'options 非法', options: 'not-array' }
    const events = translate(
      selectEvent({
        title: UI_FORM_MARKER,
        options: [JSON.stringify({ formQuestions: [validChoice, invalidNoQuestion, validText, invalidBadOptions] })],
      }),
      SID,
    )

    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBe(true)
    // 仅两项合法项保留，顺序与原数组一致
    expect(payload?.['formQuestions']).toEqual([validChoice, validText])
  })

  it('全不合法（合法 JSON 但每项都过不了 isFormQuestion）→ 降级普通 select', () => {
    const badPayload = JSON.stringify({ formQuestions: [{ type: 'choice', question: 'x', options: 42 }, 'not-a-question'] })
    const events = selectTranslate(badPayload)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['formQuestions']).toBeUndefined()
    // 降级 = plain dialog 形态：title/options 原样透传（options 经 .map(String)，前端 band 渲染）
    expect(payload?.['title']).toBe(UI_FORM_MARKER)
    expect(payload?.['options']).toEqual([badPayload])
    // 降级路径仍产 extension-ui kind（plain dialog 路径同款，select 挂起语义不丢）
    const uiEvent = events.find((e) => e.kind === 'extension-ui')
    expect(uiEvent).toBeDefined()
  })

  it('非 JSON payload → 降级普通 select', () => {
    const events = translate(selectEvent({ title: UI_FORM_MARKER, options: ['not-json{'] }), SID)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['options']).toEqual(['not-json{'])
  })

  it('formQuestions 非数组（合法 JSON 但字段形态错）→ 降级普通 select', () => {
    const events = selectTranslate(JSON.stringify({ formQuestions: { type: 'text', question: 'q' } }))
    expect(broadcastPayload(events)?.['form']).toBeUndefined()
  })

  it('formQuestions 空数组 → 降级普通 select（逐项过滤后合法项为 0）', () => {
    const events = selectTranslate(JSON.stringify({ formQuestions: [] }))
    expect(broadcastPayload(events)?.['form']).toBeUndefined()
  })

  it('confirm + title 碰巧是 marker（method≠select）→ 不进 marker 分支', () => {
    const events = translate(
      {
        type: 'extension_ui_request',
        method: 'confirm',
        id: 'req-confirm',
        title: UI_FORM_MARKER,
        message: 'sure?',
        options: [JSON.stringify({ formQuestions: makeValidQuestions() })],
      } as PiExtensionUiRequestEvent,
      SID,
    )

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['method']).toBe('confirm')
    expect(payload?.['form']).toBeUndefined()
  })

  it('普通 select（title 非 marker）→ 无 form 字段（不误伤普通下拉）', () => {
    const events = translate(selectEvent({ title: 'Pick a color', options: ['red', 'green'] }), SID)
    const payload = broadcastPayload(events)
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['options']).toEqual(['red', 'green'])
  })

  /** 辅助：marker title + 指定 payload 字符串翻译 */
  function selectTranslate(payloadJson: string): PiTranslatedEvent[] {
    return translate(selectEvent({ title: UI_FORM_MARKER, options: [payloadJson] }), SID)
  }
})

describe('EventAdapter form 帧的 pending 缓存编排入口（interpreter 路由）', () => {
  let sent: ServerMessage[]
  let send: (msg: ServerMessage) => void

  beforeEach(() => {
    sent = []
    send = (msg) => { sent.push(msg) }
  })

  it('extension-ui kind 经 interpreter 路由 onExtensionUIRequest（server 跟踪 + pending 缓存的编排入口）', () => {
    const onExtensionUIRequest = vi.fn()
    const interpreter = new EventInterpreter(SID, { send, onExtensionUIRequest })

    const questions = makeValidQuestions()
    const events = translate(
      selectEvent({ id: 'req-pending', title: UI_FORM_MARKER, options: [JSON.stringify({ formQuestions: questions })] }),
      SID,
    )
    interpreter.interpret(events)

    // onExtensionUIRequest 是 server 侧 trackRequest + pending 缓存的编排入口：
    // 携带完整 form payload（form/formQuestions/allowCancel），切回 session 后可经
    // extension.getPendingRequests 恢复
    expect(onExtensionUIRequest).toHaveBeenCalledTimes(1)
    const [requestId, sessionId, method, payload] = onExtensionUIRequest.mock.calls[0]
    expect(requestId).toBe('req-pending')
    expect(sessionId).toBe(SID)
    expect(method).toBe('select')
    expect(payload).toMatchObject({ form: true, allowCancel: true })
    expect(payload.formQuestions).toEqual(questions)

    // 广播帧同步送出（message kind 经 interpreter send）
    expect(sent).toHaveLength(1)
    expect(sent[0].type).toBe('extension.ui_request')
  })
})

// ── 既有 marker 分支回归（D7：legacy 窗口原样保留，u2 只增分支不改分支）──────────────

describe('EventAdapter 既有 marker 分支回归（UI_FORM 分支加员后）', () => {
  it('ASK_USER_MARKER 富交互分流照常（askUser:true + questions 透传，无 form 字段）', () => {
    const questions = [{ header: 'db', question: '选哪个?', options: [{ label: 'PG' }] }]
    const events = translate(
      selectEvent({ title: ASK_USER_MARKER, options: [JSON.stringify({ questions, allowCancel: true })] }),
      SID,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['askUser']).toBe(true)
    expect(payload?.['askUserQuestions']).toEqual(questions)
    expect(payload?.['form']).toBeUndefined()
    expect(payload?.['formQuestions']).toBeUndefined()
  })

  it('SCHEDULE_CREATE_MARKER 创建确认分流照常（scheduleCreate:true + draft 透传，无 form 字段）', () => {
    const draft = { kind: 'once', schedule: '0 0 9 19 9 *', prompt: '提醒我喝水', models: ['m1'] }
    const events = translate(
      selectEvent({ title: SCHEDULE_CREATE_MARKER, options: [JSON.stringify(draft)] }),
      SID,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['scheduleCreate']).toBe(true)
    expect(payload?.['scheduleDraft']).toEqual(draft)
    expect(payload?.['form']).toBeUndefined()
  })
})
