/**
 * EventAdapter permission 审批 title 判定测试（chat-flow-consistency U9 / S4；常量单源化对拍）。
 *
 * 覆盖（照 plan-review-marker 检测测试形态，全部 mock 零真实 pi）：
 * - title 首行 = PERMISSION_APPROVAL_TITLE 的 select → extension-ui kind + 广播帧双落
 *   permission: true 键（侧栏等待可见性判定键，planReview: true 同构先例）
 * - 多行 title 首行命中 → 仍命中（判定按首行精确匹配，title 可多行——与 pi-permission
 *   approval.ts formatTitle 多行构造对拍）
 * - 普通 select（非 permission title）不带 permission 标记（plain dialog 形态不变）
 * - title 仅含 PERMISSION_APPROVAL_TITLE 子串但首行不等 → 不命中（精确匹配，非子串匹配）
 *
 * 对拍纪律：本测试与 extensions/universal/permission approval.test.ts 引用同一符号
 * PERMISSION_APPROVAL_TITLE（值锁定在 extension-protocol markers.test.ts）——写侧改
 * 文案而读侧未同步时，本测试红灯（修复前是双端手抄，静默失联零报错）。
 *
 * 运行：cd packages/runtime && npx vitest run src/infra/pi/__tests__/event-adapter-permission-title.test.ts
 */
import { describe, it, expect } from 'vitest'

import { translate } from '../event-adapter.js'
import { PERMISSION_APPROVAL_TITLE } from '@zhushanwen/extension-protocol'
import type { PiExtensionUiRequestEvent } from '../pi-protocol.js'
import type { PiTranslatedEvent } from '../../../services/session/types.js'

const SID = 'sess-permission-title-1'

function selectEvent(overrides: Partial<PiExtensionUiRequestEvent> = {}): PiExtensionUiRequestEvent {
  return { type: 'extension_ui_request', method: 'select', id: 'req-1', ...overrides }
}

/** 从 translate 结果取 message kind 事件的 payload（extension.ui_request 广播帧）。 */
function broadcastPayload(events: PiTranslatedEvent[]): Record<string, unknown> | undefined {
  const frame = events.find((e) => e.kind === 'message')
  if (!frame || frame.kind !== 'message') return undefined
  return frame.message.payload as Record<string, unknown>
}

describe('EventAdapter permission 审批 title 判定（常量单源化对拍）', () => {
  it('title 首行 = PERMISSION_APPROVAL_TITLE → extension-ui + 广播帧双落 permission:true', () => {
    const events = translate(
      selectEvent({ title: PERMISSION_APPROVAL_TITLE, options: ['Approve (once)', 'Deny'] }),
      SID,
    )

    expect(events).toHaveLength(2)
    const uiEvent = events[0]
    if (uiEvent.kind !== 'extension-ui') throw new Error(`expected extension-ui kind, got ${String((uiEvent as { kind?: string }).kind)}`)
    expect(uiEvent.method).toBe('select')
    expect(uiEvent.payload['permission']).toBe(true)

    const payload = broadcastPayload(events)
    expect(payload).toBeDefined()
    expect(payload?.['permission']).toBe(true)
    expect(payload?.['sessionId']).toBe(SID)
    expect(payload?.['requestId']).toBe('req-1')
  })

  it('多行 title 首行命中 → 仍落 permission:true（判定按首行，与 formatTitle 多行构造对拍）', () => {
    const multiLineTitle = `${PERMISSION_APPROVAL_TITLE}\nTool: bash\nCommand: rm -rf /tmp\nReason: no allow rule`
    const payload = broadcastPayload(
      translate(selectEvent({ title: multiLineTitle, options: ['Approve (once)', 'Deny'] }), SID),
    )
    expect(payload?.['permission']).toBe(true)
  })

  it('普通 select（非 permission title）不带 permission 标记（plain dialog 形态不变）', () => {
    const payload = broadcastPayload(translate(selectEvent({ title: 'Pick one', options: ['a', 'b'] }), SID))
    expect(payload).toBeDefined()
    expect(payload).not.toHaveProperty('permission')
    expect(payload?.['title']).toBe('Pick one')
  })

  it('title 首行含 PERMISSION_APPROVAL_TITLE 子串但不等 → 不命中（精确匹配，非子串匹配）', () => {
    const payload = broadcastPayload(
      translate(
        selectEvent({ title: `prefix ${PERMISSION_APPROVAL_TITLE}`, options: ['a', 'b'] }),
        SID,
      ),
    )
    expect(payload).not.toHaveProperty('permission')
  })
})
