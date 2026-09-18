/**
 * useExtensionUI schedule-create 通道分流单测（schedule-create-confirm-modal U6）。
 *
 * 锁定（bus 真实 emit 语义，范式同 useExtensionUI.test.ts）：
 * - C4 分流扩展：bus ui-request 中 scheduleCreate 类入 store（Panel inline 渲染数据源），
 *   无标记普通 select 仍不入（CompanionBand 独占 dialog，零重叠）
 * - toExtensionUIRequest 白名单搬运字段保真：scheduleCreate/scheduleDraft 经
 *   DialogRequest 索引签名 → store 记录不剥离（漏补 = 静默剥离）
 * - currentAskUserRequest（语义 = 队列第一个富交互 overlay 请求）双 overlay 排序：
 *   askUser 与 scheduleCreate 并存时先到先渲染、后到排队（P-INLINE 派生层互斥）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/useExtensionUI-schedule-create.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'

// ── mock extension api domain（WS/RPC 路径保留桩，范式同 useExtensionUI.test.ts）──
const uiTimeoutHandlers = new Map<string, Array<(requestId: string) => void>>()

vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  onUITimeout: (sid: string, handler: (requestId: string) => void) => {
    const arr = uiTimeoutHandlers.get(sid) ?? []
    arr.push(handler)
    uiTimeoutHandlers.set(sid, arr)
    return () => {
      const cur = uiTimeoutHandlers.get(sid)
      if (!cur) return
      const idx = cur.indexOf(handler)
      if (idx !== -1) cur.splice(idx, 1)
      if (cur.length === 0) uiTimeoutHandlers.delete(sid)
    }
  },
  sendExtensionUIResponse: vi.fn(),
  onNotify: () => () => {},
  onExtensions: vi.fn(),
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

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
  overlayFilter,
  scheduleCreateFilter,
  __resetExtensionBusSubscriptionForTesting,
} from '@/composables/useExtensionUI'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ScheduleDraft } from '@zhushanwen/extension-protocol'

const draft: ScheduleDraft = {
  kind: 'recurring',
  schedule: '0 9 * * *',
  prompt: '总结昨天的工作进展',
  models: ['m-1', 'm-2'],
  currentModel: 'm-1',
}

function mkScheduleCreateReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    method: 'select',
    scheduleCreate: true,
    scheduleDraft: draft,
  }
}
function mkAskUserReq(requestId: string): Record<string, unknown> {
  return {
    requestId,
    pluginId: '',
    kind: 'select',
    method: 'select',
    askUser: true,
    askUserQuestions: [{ question: 'q?', options: [{ label: 'a' }] }],
  }
}
function mkPlainSelectReq(requestId: string): Record<string, unknown> {
  return { requestId, pluginId: '', kind: 'select', method: 'select', title: '选择', options: ['a', 'b'] }
}

function emitBusUIRequest(sid: string, request: unknown): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

/** 在独立 effectScope 内运行（useExtensionUI 注册 watch/onScopeDispose 的生命周期要求） */
function runWithScope<T>(fn: () => T): { result: T; dispose: () => void } {
  const scope = effectScope()
  let result!: T
  scope.run(() => {
    result = fn()
  })
  return { result, dispose: () => scope.stop() }
}

beforeEach(() => {
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  uiTimeoutHandlers.clear()
})

describe('C4 分流：scheduleCreate 类入 store，普通 select 不入', () => {
  it('scheduleCreate 请求入 store 分区（overlayFilter 放行）', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA'), overlayFilter))

    emitBusUIRequest('sessionA', mkScheduleCreateReq('r1'))

    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records).toHaveLength(1)
    expect(records[0].requestId).toBe('r1')
    dispose()
  })

  it('无标记普通 select 不入 store（CompanionBand 独占，零重叠）', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA'), overlayFilter))

    emitBusUIRequest('sessionA', mkPlainSelectReq('r2'))

    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    dispose()
  })

  it('scheduleCreateFilter 与 askUser 类谓词互斥（单标记请求各自只被自己的过滤器命中）', () => {
    const scReq = { scheduleCreate: true } as never
    const askReq = { askUser: true } as never
    expect(scheduleCreateFilter(scReq)).toBe(true)
    expect(scheduleCreateFilter(askReq)).toBe(false)
  })
})

describe('toExtensionUIRequest 白名单搬运字段保真', () => {
  it('scheduleCreate/scheduleDraft 经 bus → store 记录不剥离、值保真', () => {
    const { dispose } = runWithScope(() => useExtensionUI(ref('sessionA'), overlayFilter))

    emitBusUIRequest('sessionA', mkScheduleCreateReq('r1'))

    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records[0].scheduleCreate).toBe(true)
    expect(records[0].scheduleDraft).toEqual(draft)
    expect(records[0].method).toBe('select')
    dispose()
  })
})

describe('双 overlay 互斥派生（P-INLINE 派生层）：先到先渲染，后到排队', () => {
  it('askUser 与 scheduleCreate 并存 → currentOverlay 是先到的；respond 后接管', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA'), overlayFilter))

    emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))

    // 队列串行：find 返回第一个（先到先渲染），不会双 overlay 同时派生
    expect(result.currentAskUserRequest.value?.requestId).toBe('r-ask')
    expect(result.currentAskUserRequest.value?.askUser).toBe(true)

    result.respond('r-ask', 'answer')
    expect(result.currentAskUserRequest.value?.requestId).toBe('r-sc')
    expect(result.currentAskUserRequest.value?.scheduleCreate).toBe(true)
    dispose()
  })

  it('反序到达：scheduleCreate 先到 → 先渲染 scheduleCreate，askUser 排队', () => {
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA'), overlayFilter))

    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))
    emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))

    expect(result.currentAskUserRequest.value?.requestId).toBe('r-sc')
    expect(result.currentAskUserRequest.value?.scheduleCreate).toBe(true)
    dispose()
  })

  it('scheduleCreate 请求 respond 走 sendExtensionUIResponse（select 通道回传 FormResult JSON）', async () => {
    const { sendExtensionUIResponse } = await import('@taiji/core/transport/api/domains/extension')
    const { result, dispose } = runWithScope(() => useExtensionUI(ref('sessionA'), overlayFilter))

    emitBusUIRequest('sessionA', mkScheduleCreateReq('r-sc'))
    const formResult = JSON.stringify({ action: 'create', kind: 'recurring', schedule: '0 9 * * *', prompt: 'p' })
    result.respond('r-sc', formResult)

    expect(vi.mocked(sendExtensionUIResponse)).toHaveBeenCalledWith('sessionA', 'r-sc', 'select', formResult)
    // respond 后出队
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    dispose()
  })
})
