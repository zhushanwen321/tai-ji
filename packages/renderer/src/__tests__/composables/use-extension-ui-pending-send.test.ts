/**
 * useExtensionUI respond 分型锚点 + invalidated 清除单测（form-hang-fix D1 / 探针 P-fh5）。
 *
 * 覆盖四形态（设计 §3.3 D1 采用项 1/2）：
 * - ① cancel 型（result=null，Esc / 取消按钮 / cancel() 同链）respond 送达后
 *     clearPendingSend(sid) 被调——pendingSend 假忙窗口收口
 * - ② 提交型（result 非 null string）不清——pendingSend 桥接 respond→message_start
 *     由其正常清除（现状语义保留）；另含 boolean 守卫格（false 非 null 亦不清，
 *     防判据误写为 falsy 判定）
 * - ③ delivered=false（WS 断连）不清——现状保留路径，锚点只挂送达成功后
 * - ④ requests-invalidated 广播到达：按帧 sid removeRequest + clearPendingSend
 *     （runtime 非 respond 终结：reclaimed / plan-aborted / turn-aborted /
 *     session-destroyed 四类触发源，均无后续 turn 预期）
 *
 * mock 形态照抄 useExtensionUI.test.ts（真实 InternalEventBus + extension domain mock）；
 * chatStore 经 vi.mock('@/stores/chat') 注入 spy（本文件只验证因果调用，不例化真实
 * chat store——真实链路时序由真机探针 P-fh1/P-fh2/P-fh3 承接）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/use-extension-ui-pending-send.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'

// ── mock chatStore（clearPendingSend 因果断言面；vi.hoisted 解决工厂提升引用）──
const chatStoreMocks = vi.hoisted(() => ({
  clearPendingSend: vi.fn(),
}))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ clearPendingSend: chatStoreMocks.clearPendingSend }),
}))

// ── mock extension api domain（照 useExtensionUI.test.ts）──
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  // 返 true = 送达；断连场景用例单独 mockReturnValueOnce(false)
  sendExtensionUIResponse: vi.fn((): boolean => true),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

// ── mock getExtensionBus：真实 InternalEventBus 实例 ──
let mockBus: InternalEventBus

vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return {
    ...original,
    getExtensionBus: () => mockBus,
  }
})

import {
  useExtensionUI,
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import { sendExtensionUIResponse } from '@taiji/core/transport/api/domains/extension'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** 在独立 effectScope 内运行，模拟单 Panel 实例的完整生命周期 */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

/** 统一表单请求（runtime marker 分支产出的 view-ready 帧形状，form 键原生携带） */
function mkFormReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: 'p',
    kind: 'select',
    method: 'select',
    title: 't',
    form: true,
    formQuestions: [{ type: 'text', header: 'q', question: 'q?' }],
    allowCancel: true,
  }
}

function emitBusUIRequest(sid: string, request: unknown): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

function emitBusRequestsInvalidated(sid: string, requestIds: string[], reason: string): void {
  mockBus.emit({ kind: 'requests-invalidated', sessionId: sid, requestIds, reason } as never)
}

beforeEach(() => {
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  vi.mocked(sendExtensionUIResponse).mockClear()
  chatStoreMocks.clearPendingSend.mockClear()
})

describe('① cancel 型（result=null）respond 送达后收口 pendingSend（D1 采用项 1）', () => {
  it('respond(requestId, null) 送达 → removeRequest + clearPendingSend(sid)', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkFormReq('r-cancel'))
    expect(result.currentFormRequest.value?.requestId).toBe('r-cancel')

    result.respond('r-cancel', null)

    // 送达 + 出队（现状行为不回归）
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-cancel', 'select', null)
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
    // cancel 型清除锚点：按请求归属 sid 收口假忙窗口
    expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
    expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
    dispose()
  })

  it('cancel() 便捷函数（Esc / 取消按钮同链）等价触发清除', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkFormReq('r-esc'))
    result.cancel('r-esc')

    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-esc', 'select', null)
    expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
    expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
    dispose()
  })
})

describe('② 提交型（result≠null）不清——pendingSend 桥接 message_start（现状语义保留）', () => {
  it('respond(requestId, 表单 answers JSON string) 送达 → 不调 clearPendingSend', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkFormReq('r-submit'))
    const answers = JSON.stringify({ title: '任务' })

    result.respond('r-submit', answers)

    // 送达 + 出队照常（respond 主路径不回归），仅清除锚点分型跳过
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-submit', 'select', answers)
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
    expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
    dispose()
  })

  it('boolean 守卫格：respond(requestId, false) 非 null 同样不清（判据严格 === null，非 falsy）', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkFormReq('r-bool'))
    result.respond('r-bool', false)

    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-bool', 'select', false)
    expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
    dispose()
  })
})

describe('③ delivered=false（WS 断连）不清——锚点只挂送达成功后（现状保留路径）', () => {
  it('send 返 false → removeRequest 与 clearPendingSend 均不调，请求保留', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkFormReq('r-drop'))
    vi.mocked(sendExtensionUIResponse).mockReturnValueOnce(false)

    result.cancel('r-drop')

    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-drop', 'select', null)
    // 断连期请求保留（FormOverlay 不消失，现状行为）+ pendingSend 不收口
    //（表单仍占输入面，假忙窗口不暴露——设计 §3.1 失败路径语义）
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(1)
    expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
    dispose()
  })
})

describe('④ requests-invalidated 广播按帧 sid 清（D1 采用项 2 / 探针 P-fh5）', () => {
  it('invalidated 帧 → 该 sid 请求移除 + clearPendingSend(帧 sid)', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA')))

    emitBusUIRequest('sessionA', mkFormReq('r-inv'))
    expect(result.currentFormRequest.value?.requestId).toBe('r-inv')

    emitBusRequestsInvalidated('sessionA', ['r-inv'], 'reclaimed')

    // 表单移除（P2-2 既有行为）+ pendingSend 收口（D1 新增锚点）
    expect(result.currentFormRequest.value).toBeUndefined()
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toEqual([])
    expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledTimes(1)
    expect(chatStoreMocks.clearPendingSend).toHaveBeenCalledWith('sessionA')
    dispose()
  })

  it('帧 sid 缺失 → 不清（跳过，与 removeRequest 同一守卫）', () => {
    runWithScope(() => useExtensionUI(ref('sessionA')))

    // 事件契约 sessionId 可选；缺失帧整体跳过（无 sid 可清）
    mockBus.emit({ kind: 'requests-invalidated', requestIds: ['r-nosid'], reason: 'reclaimed' } as never)

    expect(chatStoreMocks.clearPendingSend).not.toHaveBeenCalled()
  })
})
