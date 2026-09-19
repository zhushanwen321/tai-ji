/**
 * EventAdapter PLAN_REVIEW_MARKER 检测路由测试（plan 模式重设计 D5，u1-rpc 领地补配项）。
 *
 * 覆盖（照 ask-user 检测测试形态，全部 mock 零真实 pi）：
 * - title=PLAN_REVIEW_MARKER 的 select 事件 → 成对产出 extension-ui kind + extension.ui_request
 *   广播帧，payload 含 planReview: true 标记（与 askUser: true 同构分流）+ planReviewDocs 透传
 * - 普通 select（无 marker）不带 planReview 标记（plain dialog 分支形态不变）
 * - marker 命中但 payload 非法（非 JSON）→ 降级普通 select（payload 无 planReview，
 *   与 ask-user 检测失败降级同构边界）
 * - 既有 marker 路由无回归：ASK_USER_MARKER 富交互分流照常（askUser: true）；
 *   SUBAGENT_INFLIGHT_MARKER 唯一不广播例外照常（translate 守卫分支零产出）
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-plan-review-marker.test.ts
 */
import { describe, it, expect } from 'vitest'

import { translate } from '../event-adapter.js'
import { ASK_USER_MARKER, PLAN_REVIEW_MARKER, SUBAGENT_INFLIGHT_MARKER } from '@zhushanwen/extension-protocol'
import type { PiExtensionUiRequestEvent } from '../pi-protocol.js'
import type { PiTranslatedEvent } from '../../../services/session/types.js'

const SID = 'sess-plan-review-1'

function selectEvent(overrides: Partial<PiExtensionUiRequestEvent> = {}): PiExtensionUiRequestEvent {
  return { type: 'extension_ui_request', method: 'select', id: 'req-1', ...overrides }
}

/** 从 translate 结果取 message kind 事件的 payload（extension.ui_request 广播帧）。 */
function broadcastPayload(events: PiTranslatedEvent[]): Record<string, unknown> | undefined {
  const frame = events.find((e) => e.kind === 'message')
  if (!frame || frame.kind !== 'message') return undefined
  return frame.message.payload as Record<string, unknown>
}

describe('EventAdapter PLAN_REVIEW_MARKER 检测路由（D5）', () => {
  it('title=PLAN_REVIEW_MARKER + docs payload → 广播 extension.ui_request 含 planReview:true + planReviewDocs 透传', () => {
    const docs = [{ fileName: 'design.md', absPath: '/repo/.taiji-harness/slug/design.md', sourceSkill: 'tech-design', version: 1 }]
    const events = translate(
      selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ docs })] }),
      SID,
    )

    // 成对产出：extension-ui kind（interpreter 挂起跟踪）+ message kind（前端广播帧）
    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.method).toBe('select')
    expect(uiEvent.requestId).toBe('req-1')
    expect(uiEvent.sessionId).toBe(SID)
    expect(uiEvent.payload['planReview']).toBe(true)
    expect(uiEvent.payload['planReviewDocs']).toEqual(docs)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['planReview']).toBe(true)
    expect(payload?.['planReviewDocs']).toEqual(docs)
    expect(payload?.['sessionId']).toBe(SID)
    expect(payload?.['requestId']).toBe('req-1')
  })

  it('普通 select（无 marker）不带 planReview 标记（plain dialog 分支形态不变）', () => {
    const events = translate(selectEvent({ title: 'Pick one', options: ['a', 'b'] }), SID)
    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['planReview']).toBeUndefined()
    expect(payload?.['askUser']).toBeUndefined()
    // plain dialog 形态：title/options 原样透传
    expect(payload?.['title']).toBe('Pick one')
    expect(payload?.['options']).toEqual(['a', 'b'])
  })

  it('marker 命中但 payload 非法（非 JSON）→ 降级普通 select，payload 无 planReview', () => {
    const events = translate(selectEvent({ title: PLAN_REVIEW_MARKER, options: ['not-json'] }), SID)
    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['planReview']).toBeUndefined()
    // 降级 = plain dialog 形态（title 透传原样，前端 C4 未识别 marker title 是检测失败的
    // 边界场景——与 ask-user 检测失败降级同构）
    expect(payload?.['title']).toBe(PLAN_REVIEW_MARKER)
  })

  it('docs 缺失（合法 JSON 但无 docs 字段）→ 降级普通 select', () => {
    const events = translate(selectEvent({ title: PLAN_REVIEW_MARKER, options: [JSON.stringify({ other: 1 })] }), SID)
    const payload = broadcastPayload(events)
    expect(payload?.['planReview']).toBeUndefined()
  })
})

describe('EventAdapter 既有 marker 路由无回归（plan-review 加员后）', () => {
  it('ASK_USER_MARKER 富交互分流照常（askUser:true + questions 透传）', () => {
    const questions = [{ question: '选择方案?', options: ['A', 'B'] }]
    const events = translate(
      selectEvent({ title: ASK_USER_MARKER, options: [JSON.stringify({ questions, allowCancel: true })] }),
      SID,
    )
    const payload = broadcastPayload(events)
    expect(payload?.['askUser']).toBe(true)
    expect(payload?.['askUserQuestions']).toEqual(questions)
    expect(payload?.['planReview']).toBeUndefined()
  })

  it('SUBAGENT_INFLIGHT_MARKER 唯一不广播例外照常（translate 守卫分支零产出）', () => {
    const events = translate(
      selectEvent({ title: SUBAGENT_INFLIGHT_MARKER, options: [JSON.stringify({ report: {} })] }),
      SID,
    )
    expect(events).toHaveLength(0)
  })
})
