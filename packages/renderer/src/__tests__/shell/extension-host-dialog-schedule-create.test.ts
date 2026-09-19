/**
 * extension-host-dialog C4 过滤排除表单类单测（ui-presentation-protocol u4 版，原名
 * schedule-create 排除面职责扩展为统一表单排除面）。
 *
 * ui-request bus 是双消费方架构：表单类（form 键 + 窗口期 legacy askUser / scheduleCreate
 * 原始帧键——本侧消费 bus 原始帧，归一只发生在 useExtensionUI handler 内）由
 * useExtensionUI 独占（Panel inline FormOverlay），dialog 类由 CompanionBand 独占（本
 * 适配层投递）。零重叠契约：表单类请求必须从 CompanionBand 侧排除——否则同一请求被
 * 转成空壳 select dialog 入队（用户误点 = respond null = 误触取消）并与 overlay 双 UI 并存。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/shell/extension-host-dialog-schedule-create.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { InternalEventBus } from '@taiji/core'
import { createDialogRequestSource, __resetDialogRequestIdSessionsForTest } from '@/composables/shell/extension-host-dialog'
import type { DialogRequest } from '@taiji/ui/extension-host'

function emitBusUIRequest(bus: InternalEventBus, sid: string, request: Record<string, unknown>): void {
  bus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

beforeEach(() => {
  __resetDialogRequestIdSessionsForTest()
})

describe('C4 过滤：统一表单类（form ∨ legacy askUser/scheduleCreate）不投递 CompanionBand', () => {
  it('form 帧不投递（新 marker 帧；防双消费空壳 dialog）', () => {
    const bus = new InternalEventBus()
    const delivered: DialogRequest[] = []
    const source = createDialogRequestSource(bus)
    const unsub = source.onUiRequest((req) => delivered.push(req))

    emitBusUIRequest(bus, 's1', {
      requestId: 'r-form',
      pluginId: '',
      kind: 'select',
      method: 'select',
      form: true,
      formQuestions: [{ type: 'choice', question: 'q?', options: [{ label: 'a' }] }],
    })

    expect(delivered).toHaveLength(0)
    unsub()
  })

  it('legacy scheduleCreate 帧不投递（窗口键集合原始帧键排除）', () => {
    const bus = new InternalEventBus()
    const delivered: DialogRequest[] = []
    const source = createDialogRequestSource(bus)
    const unsub = source.onUiRequest((req) => delivered.push(req))

    emitBusUIRequest(bus, 's1', {
      requestId: 'r-sc',
      pluginId: '',
      kind: 'select',
      method: 'select',
      scheduleCreate: true,
      scheduleDraft: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', models: [] },
    })

    expect(delivered).toHaveLength(0)
    unsub()
  })

  it('legacy askUser 帧不投递（既有 C4 行为零变更）；普通 select 照常投递', () => {
    const bus = new InternalEventBus()
    const delivered: DialogRequest[] = []
    const source = createDialogRequestSource(bus)
    const unsub = source.onUiRequest((req) => delivered.push(req))

    emitBusUIRequest(bus, 's1', {
      requestId: 'r-ask', pluginId: '', kind: 'select', method: 'select',
      askUser: true, askUserQuestions: [{ question: 'q?', options: [] }],
    })
    expect(delivered).toHaveLength(0)

    emitBusUIRequest(bus, 's1', {
      requestId: 'r-plain', pluginId: '', kind: 'select', method: 'select',
      title: '选择', options: ['a', 'b'],
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].requestId).toBe('r-plain')
    expect(delivered[0].method).toBe('select')
    unsub()
  })
})
