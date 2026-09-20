/**
 * event-adapter 第 4 marker 分支：schedule 创建确认（SCHEDULE_CREATE_MARKER）翻译测试。
 *
 * 设计 scheduler-create-confirm-modal §3.4 / U5 验收：
 * - 合法 draft → 翻译为 extension.ui_request 帧（scheduleCreate: true + scheduleDraft 字段保真）
 *   + extension-ui kind 事件（watchdog 暂停 + pending 跟踪，S4）
 * - 检测失败（非合法 JSON / draft 缺字段）→ 降级普通 select（S2 同款兜底）
 * - 既有三 marker 分支回归：SESSION_MANAGER / BRIDGE / ASK_USER 翻译行为不变（只增分支不改分支）
 */

import { describe, it, expect } from 'vitest'
import { translate } from '../src/infra/pi/event-adapter.js'
import { SCHEDULE_CREATE_MARKER, ASK_USER_MARKER, SESSION_MANAGER_MARKER, BRIDGE_MARKER } from '@zhushanwen/extension-protocol'
import type { ScheduleDraft } from '@zhushanwen/extension-protocol'
import type { PiTranslatedEvent } from '../src/services/session/types.js'
import type { PiEvent } from '../src/infra/pi/pi-protocol.js'

// ── 辅助：构造 pi extension_ui_request{method:'select'} 事件 ──
function makeSelectEvent(title: string, options: unknown[], id = 'req-x'): PiEvent {
  return {
    type: 'extension_ui_request',
    method: 'select',
    id,
    title,
    options,
  } as PiEvent
}

/** 辅助：从 translate 结果中提取 message 事件（前端 WS 广播帧） */
function findMessage(results: PiTranslatedEvent[]):
  { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined {
  return results.find(r => r.kind === 'message') as
    { kind: 'message'; message: { type: string; payload: Record<string, unknown> } } | undefined
}

/** 辅助：从 translate 结果中提取 extension-ui kind 事件 */
function findExtensionUi(results: PiTranslatedEvent[]): PiTranslatedEvent | undefined {
  return results.find(r => r.kind === 'extension-ui')
}

/** 辅助：构造合法 ScheduleDraft（含全部可选字段，验证字段保真） */
function makeFullDraft(): ScheduleDraft {
  return {
    kind: 'recurring',
    schedule: '0 9 * * 1-5',
    model: 'deepseek-flash',
    prompt: '总结昨天的工作进展',
    name: 'daily-summary',
    expires: '7d',
    models: ['deepseek-flash', 'glm-5'],
    currentModel: 'glm-5',
  }
}

describe('event-adapter: schedule-create SCHEDULE_CREATE_MARKER 检测（第 4 marker 分支）', () => {
  it('合法 draft → 帧 scheduleCreate=true + scheduleDraft 字段保真 + extension-ui kind 事件', () => {
    const draft = makeFullDraft()
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [JSON.stringify(draft)], 'req-sched')

    const results = translate(event, 'sess-1')

    // extension-ui kind 事件必须存在（EventInterpreter 暂停 watchdog + pending 跟踪，S4）
    const extUi = findExtensionUi(results)
    expect(extUi).toBeDefined()

    // message 帧：extension.ui_request + scheduleCreate=true + scheduleDraft 透传
    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.ui_request')
    expect(msg!.message.payload.scheduleCreate).toBe(true)
    expect(msg!.message.payload.method).toBe('select')
    expect(msg!.message.payload.requestId).toBe('req-sched')
    expect(msg!.message.payload.sessionId).toBe('sess-1')
    // scheduleDraft 字段保真（深比较全字段，含可选字段）
    expect(msg!.message.payload.scheduleDraft).toEqual(draft)
    // 与 ask-user 分支同构：不传 title/options（避免前端把 JSON payload 当下拉选项/标题）
    expect(msg!.message.payload.options).toBeUndefined()
    expect(msg!.message.payload.title).toBeUndefined()
    // 与 ask-user 字段互不串扰
    expect(msg!.message.payload.askUser).toBeUndefined()
    expect(msg!.message.payload.askUserQuestions).toBeUndefined()
  })

  it('最小合法 draft（仅必填字段）→ 翻译成功，可选字段缺省透传 undefined 不在场', () => {
    const draft: ScheduleDraft = { kind: 'once', schedule: '0 0 9 19 9 *', prompt: '提醒我喝水', models: ['m1'] }
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [JSON.stringify(draft)], 'req-min')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBe(true)
    expect(msg!.message.payload.scheduleDraft).toEqual(draft)
  })

  it('once 模式 draft（schedule 为折叠 cron）→ 字段保真透传', () => {
    const draft: ScheduleDraft = {
      kind: 'once',
      schedule: '30 14 20 9 *',
      prompt: '跑一次数据备份',
      models: ['glm-5'],
      currentModel: 'glm-5',
    }
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [JSON.stringify(draft)], 'req-once')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleDraft).toEqual(draft)
  })

  it('title=marker 但 options[0] 非法 JSON → 降级普通 select（无 scheduleCreate/scheduleDraft）', () => {
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, ['not-valid-json{'], 'req-bad')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.ui_request')
    expect(msg!.message.payload.method).toBe('select')
    // 降级为普通 select（无 schedule-create 专有字段）
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
    // options 经 .map(String) 透传（普通 select 路径行为）
    expect(msg!.message.payload.options).toEqual(['not-valid-json{'])
    // 降级路径不产 extension-ui kind 差异：普通 select 同样产 extension-ui kind（plain dialog 路径）
    expect(findExtensionUi(results)).toBeDefined()
  })

  it('JSON 合法但 draft 缺必填字段（缺 prompt）→ 降级普通 select', () => {
    const badDraft = JSON.stringify({ kind: 'recurring', schedule: '0 9 * * *', models: ['m1'] })
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [badDraft], 'req-missing')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
    expect(msg!.message.payload.options).toEqual([badDraft])
  })

  it('JSON 合法但 draft models 非字符串数组 → 降级普通 select', () => {
    const badDraft = JSON.stringify({ kind: 'once', schedule: '0 0 9 19 9 *', prompt: 'x', models: 'glm-5' })
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [badDraft], 'req-bad-models')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })

  it('JSON 合法但 draft kind 非法值 → 降级普通 select', () => {
    const badDraft = JSON.stringify({ kind: 'daily', schedule: '0 9 * * *', prompt: 'x', models: [] })
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [badDraft], 'req-bad-kind')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })

  it('title=marker 但 options 为空数组 → 降级普通 select', () => {
    const event = makeSelectEvent(SCHEDULE_CREATE_MARKER, [], 'req-empty')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
  })

  it('confirm + title 碰巧是 marker（method≠select）→ 不进 marker 分支', () => {
    const event = {
      type: 'extension_ui_request',
      method: 'confirm',
      id: 'req-confirm',
      title: SCHEDULE_CREATE_MARKER,
      message: 'sure?',
    } as PiEvent

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.method).toBe('confirm')
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })

  it('普通 select（title 非 marker）→ 无 scheduleCreate 字段（不误伤普通下拉）', () => {
    const event = makeSelectEvent('Pick a color', ['red', 'green'], 'req-plain')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.options).toEqual(['red', 'green'])
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
  })
})

// ── 既有三 marker 分支回归（只增分支不改分支：三分支翻译行为不变）──────────────

describe('event-adapter: 既有 marker 分支回归（U5 改动后行为不变）', () => {
  it('SESSION_MANAGER_MARKER → session-manager-ui kind + 无前端广播帧（runtime 内部消化）', () => {
    const payload = JSON.stringify({ action: 'list', params: {} })
    const event = makeSelectEvent(SESSION_MANAGER_MARKER, [payload], 'req-sm')

    const results = translate(event, 'sess-1')

    const smUi = results.find(r => r.kind === 'session-manager-ui') as
      | { kind: 'session-manager-ui'; requestId: string; sessionId: string; action: string; params: Record<string, unknown> }
      | undefined
    expect(smUi).toBeDefined()
    expect(smUi!.requestId).toBe('req-sm')
    expect(smUi!.action).toBe('list')
    expect(smUi!.params).toEqual({})
    // [HISTORICAL] 不发前端广播：session-manager 请求由 handler 应答，广播会产生空壳 dialog
    expect(findMessage(results)).toBeUndefined()
  })

  it('SESSION_MANAGER_MARKER 非法 action → 折叠 __malformed__ 哨兵', () => {
    const payload = JSON.stringify({ action: 'evil', params: {} })
    const event = makeSelectEvent(SESSION_MANAGER_MARKER, [payload], 'req-sm-bad')

    const results = translate(event, 'sess-1')

    const smUi = results.find(r => r.kind === 'session-manager-ui') as
      | { kind: 'session-manager-ui'; action: string }
      | undefined
    expect(smUi).toBeDefined()
    expect(smUi!.action).toBe('__malformed__')
  })

  it('BRIDGE_MARKER 合法 method → bridge-ui kind + 无前端广播帧', () => {
    const payload = JSON.stringify({ method: 'bridge:tool_execute', toolName: 'bash', toolCallId: 'tc-1', params: { cmd: 'ls' } })
    const event = makeSelectEvent(BRIDGE_MARKER, [payload], 'req-bridge')

    const results = translate(event, 'sess-1')

    const bridgeUi = results.find(r => r.kind === 'bridge-ui') as
      | { kind: 'bridge-ui'; requestId: string; sessionId: string; method: string; data: Record<string, unknown> }
      | undefined
    expect(bridgeUi).toBeDefined()
    expect(bridgeUi!.method).toBe('bridge:tool_execute')
    expect(bridgeUi!.data.toolName).toBe('bash')
    expect(findMessage(results)).toBeUndefined()
  })

  it('BRIDGE_MARKER 非法 JSON → 折叠 bridge:malformed 哨兵', () => {
    const event = makeSelectEvent(BRIDGE_MARKER, ['{not json'], 'req-bridge-bad')

    const results = translate(event, 'sess-1')

    const bridgeUi = results.find(r => r.kind === 'bridge-ui') as
      | { kind: 'bridge-ui'; method: string }
      | undefined
    expect(bridgeUi).toBeDefined()
    expect(bridgeUi!.method).toBe('bridge:malformed')
  })

  it('ASK_USER_MARKER 合法 questions → askUser=true + questions 透传 + extension-ui kind', () => {
    const questions = [{ header: 'db', question: '选哪个?', options: [{ label: 'PG' }] }]
    const payload = JSON.stringify({ questions, allowCancel: false })
    const event = makeSelectEvent(ASK_USER_MARKER, [payload], 'req-ask')

    const results = translate(event, 'sess-1')

    const extUi = findExtensionUi(results)
    expect(extUi).toBeDefined()
    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.type).toBe('extension.ui_request')
    expect(msg!.message.payload.askUser).toBe(true)
    expect(msg!.message.payload.askUserQuestions).toEqual(questions)
    expect(msg!.message.payload.allowCancel).toBe(false)
    expect(msg!.message.payload.options).toBeUndefined()
    // ask-user 专有字段与 schedule-create 互不串扰
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
    expect(msg!.message.payload.scheduleDraft).toBeUndefined()
  })

  it('ASK_USER_MARKER 非法 JSON → 降级普通 select（askUser 缺省）', () => {
    const event = makeSelectEvent(ASK_USER_MARKER, ['not-valid-json{'], 'req-ask-bad')

    const results = translate(event, 'sess-1')

    const msg = findMessage(results)
    expect(msg).toBeDefined()
    expect(msg!.message.payload.askUser).toBeUndefined()
    expect(msg!.message.payload.options).toEqual(['not-valid-json{'])
    expect(msg!.message.payload.scheduleCreate).toBeUndefined()
  })
})
