/**
 * extension-host-dialog C4 过滤排除 scheduleCreate 单测（schedule-create-confirm-modal U6）。
 *
 * ui-request bus 是双消费方架构：askUser / scheduleCreate 富交互类由 useExtensionUI 独占
 * （Panel inline overlay），dialog 类由 CompanionBand 独占（本适配层投递）。零重叠契约：
 * scheduleCreate 请求必须从 CompanionBand 侧排除——否则同一请求被转成空壳 select dialog
 * 入队（用户误点 = respond null = 误触取消）并与 overlay 双 UI 并存。
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

describe('C4 过滤：富交互 overlay 类（askUser / scheduleCreate）不投递 CompanionBand', () => {
  it('scheduleCreate 请求不投递（防双消费空壳 dialog）', () => {
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

  it('askUser 请求不投递（既有 C4 行为零变更）；普通 select 照常投递', () => {
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
