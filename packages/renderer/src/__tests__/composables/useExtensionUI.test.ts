/**
 * useExtensionUI per-sessionId 队列隔离单测（slice `companion-band-mount` wave1 bus 版）。
 *
 * 订阅模型改造（IF2）：onUIRequest(WS) 移除 → 模块级 refCount bus 'ui-request' 订阅。
 * 用例覆盖（T1-T10）：
 * - T1/T2: bus 事件入队（askUser=true）与非 askUser 负向分流（C4）
 * - T3: per-sessionId 分区隔离（U1 bus 版）
 * - T4: 按 requestId 精确 respond/cancel（U2 bus 版）
 * - T6: getPendingRequests 保留 RPC 路径（C3，U3/TC4 bus 版）
 * - T7: 同实例切 session 隔离（AC-1/AC-2 bus 版）
 * - T8: filter 第二道闸语义（formFilter 放行；dialog 通道已随 CompanionBand 迁移删除）
 * - T9: 模块级 refCount 注册/注销（项目规则 #2）
 * - T10: requestId dedup 双通路（TC4 bus 版）
 *
 * 运行：npx vitest run src/__tests__/composables/useExtensionUI.test.ts
 * 禁止 node:test / tsx --test。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { effectScope, ref, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { InternalEventBus } from '@taiji/core'

// ── mock extension api domain ──
// onUIRequest 已移除（bus 订阅替代）；getPendingRequests/sendExtensionUIResponse 保留 RPC（C3）。
vi.mock('@taiji/core/transport/api/domains/extension', () => ({
  sendExtensionUIResponse: vi.fn(),
  onNotify: () => () => {},
  // [B9 agentcall LRU 联动] stores/chat 新装配链（agentcall-lru-linkage → workflow store
  // → @/api）把 settings.ts 的 re-export `onExtensions = extensionDomain.onExtensions`
  // 带进本测试模块图——vitest 对 re-export 绑定按具名导入校验，mock 需提供该导出
  //（本测试不消费它，占位 vi.fn 即可）。
  onExtensions: vi.fn(),
  // subscribe 切换 session 时拉取缓存的 pending 请求；测试默认返回空数组
  getPendingRequests: vi.fn().mockResolvedValue([]),
}))

// ── mock getExtensionBus（IF1 惰性单例）──
// 用真实 InternalEventBus 实例（非手写 emitter mock）——验证 emit/on 真实语义。
// importOriginal 展开保留 useExtensionHostBridge 其他导出（initExtensionHostBridge 等）。
let mockBus: InternalEventBus

vi.mock('@/composables/shell/useExtensionHostBridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/composables/shell/useExtensionHostBridge')>()
  return {
    ...original,
    getExtensionBus: () => mockBus,
  }
})

import { useExtensionUI, formFilter, __resetExtensionBusSubscriptionForTesting } from '@/composables/useExtensionUI'
import { sendExtensionUIResponse, getPendingRequests } from '@taiji/core/transport/api/domains/extension'
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

// ── 测试数据构造 helper（DialogRequest 形状，索引签名含 askUser 扩展字段）──
function mkAskUserReq(requestId: string, overrides: Record<string, unknown> = {}) {
  return {
    requestId,
    pluginId: 'p',
    kind: 'select' as const,
    method: 'select',
    title: 't',
    askUser: true,
    askUserQuestions: [{ header: 'q', question: 'q?', options: [] }],
    allowCancel: true,
    ...overrides,
  }
}
function mkDialogReq(requestId: string, method: 'confirm' | 'select' | 'input' = 'confirm') {
  return { requestId, pluginId: 'p', kind: method, method, title: 't' }
}

/** 触发某 session 的 bus ui-request 事件（真实 bus emit） */
function emitBusUIRequest(sid: string, request: unknown): void {
  mockBus.emit({ kind: 'ui-request', sessionId: sid, request } as never)
}

beforeEach(() => {
  // 模块级 refCount 订阅残留重置（防跨测试串扰）+ 新 pinia + 新 bus 实例
  __resetExtensionBusSubscriptionForTesting()
  setActivePinia(createPinia())
  mockBus = new InternalEventBus()
  vi.mocked(sendExtensionUIResponse).mockClear()
  vi.mocked(getPendingRequests).mockResolvedValue([])
})

describe('useExtensionUI T1/T2 bus 事件入队与 C4 分流', () => {
  it('T1: bus ui-request 事件（askUser=true）入 store，字段完整（legacy 帧归一附加 form 键）', () => {
    const { currentFormRequest } = useExtensionUI(ref('sessionA'))

    emitBusUIRequest('sessionA', mkAskUserReq('r1'))

    expect(currentFormRequest.value?.requestId).toBe('r1')
    expect(currentFormRequest.value?.sessionId).toBe('sessionA')
    expect(currentFormRequest.value?.method).toBe('select')
    // legacy 键保留（D7 归一是附加不是替换）+ form 键附加（判定面统一）
    expect(currentFormRequest.value?.askUser).toBe(true)
    expect(currentFormRequest.value?.form).toBe(true)
    expect(currentFormRequest.value?.allowCancel).toBe(true)
    expect(currentFormRequest.value?.title).toBe('t')
    expect(typeof currentFormRequest.value?.receivedAt).toBe('number')

    // store 分区为事件 sid
    const records = useExtensionUIStore().getRequestsBySession('sessionA')
    expect(records).toHaveLength(1)
    expect(records[0].requestId).toBe('r1')
  })

  it('T2: 无标记 dialog 请求不入 store（C4 分流）', () => {
    const { currentFormRequest } = useExtensionUI(ref('sessionA'))

    emitBusUIRequest('sessionA', mkDialogReq('r2', 'confirm'))

    expect(currentFormRequest.value).toBeUndefined()
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
  })

  it('T2b: 事件 sessionId 缺失 → 跳过入队（C2）', () => {
    const { currentFormRequest } = useExtensionUI(ref('sessionA'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // 无 sessionId 的 ui-request 事件
    mockBus.emit({ kind: 'ui-request', request: mkAskUserReq('r-nosid') } as never)

    expect(currentFormRequest.value).toBeUndefined()
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('useExtensionUI T3 per-session 队列隔离', () => {
  it('sessionA 与 sessionB 的 ask-user 互不串扰', () => {
    const { currentFormRequest: aAsk } = useExtensionUI(ref('sessionA'))
    const { currentFormRequest: bAsk } = useExtensionUI(ref('sessionB'))

    emitBusUIRequest('sessionA', mkAskUserReq('r-a1'))
    emitBusUIRequest('sessionB', mkAskUserReq('r-b1'))

    expect(aAsk.value?.requestId).toBe('r-a1')
    expect(bAsk.value?.requestId).toBe('r-b1')
    expect(aAsk.value?.requestId).not.toBe('r-b1')
    expect(bAsk.value?.requestId).not.toBe('r-a1')
  })
})

describe('useExtensionUI T4 按 requestId 精确 respond/cancel', () => {
  it('队列含多个表单请求，respond 指定 requestId → 仅该请求出队 + 响应参数正确', () => {
    const { respond, currentFormRequest } = useExtensionUI(ref('sessionA'))
    emitBusUIRequest('sessionA', mkAskUserReq('r-ask'))
    emitBusUIRequest('sessionA', mkAskUserReq('r-ask2'))

    respond('r-ask2', true)

    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-ask2', 'select', true)
    expect(currentFormRequest.value?.requestId).toBe('r-ask')

    // respond 队首后队列空
    respond('r-ask', false)
    expect(currentFormRequest.value).toBeUndefined()
  })

  it('cancel 传入 requestId 等价于 respond(null)', () => {
    const { cancel } = useExtensionUI(ref('sessionA'))
    emitBusUIRequest('sessionA', mkAskUserReq('r-x'))

    cancel('r-x')
    expect(sendExtensionUIResponse).toHaveBeenCalledWith('sessionA', 'r-x', 'select', null)
  })
})

describe('useExtensionUI T6 C3 保留 RPC 路径', () => {
  it('T6: getPendingRequests 拉取结果入 store（RPC 保留）', async () => {
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkAskUserReq('r1'),
      mkAskUserReq('r2'),
    ] as never)
    const { currentFormRequest } = useExtensionUI(ref('sessionA'))

    // 等待拉取 Promise resolve（初始 subscribe 即触发一次 getPendingRequests）
    await nextTick()
    await nextTick()

    expect(getPendingRequests).toHaveBeenCalled()
    expect(currentFormRequest.value?.requestId).toBe('r1')
    expect(useExtensionUIStore().getRequestsBySession('sessionA')).toHaveLength(2)
  })
})

describe('useExtensionUI T7 同实例切 session 隔离（AC-1/AC-2 bus 版）', () => {
  it('AC-1: 同一实例 sessionId 从 A 切到 B 后 currentFormRequest 变 undefined', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid))

    emitBusUIRequest('sessionA', mkAskUserReq('r-a1'))
    expect(result.currentFormRequest.value?.requestId).toBe('r-a1')

    sid.value = 'sessionB'
    await nextTick()

    expect(result.currentFormRequest.value).toBeUndefined()
    dispose()
  })

  it('AC-2: 切回 A 后 pending 表单请求恢复显示（Map 分区保留）', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid))

    emitBusUIRequest('sessionA', mkAskUserReq('r-a1'))
    sid.value = 'sessionB'
    await nextTick()
    expect(result.currentFormRequest.value).toBeUndefined()

    sid.value = 'sessionA'
    await nextTick()
    expect(result.currentFormRequest.value?.requestId).toBe('r-a1')

    dispose()
  })

  it('T7b: 切走后旧 sid 迟到事件写旧分区（M1 事件 sid 语义），不污染新分区', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid))

    sid.value = 'sessionB'
    await nextTick()

    // 旧 sid 迟到事件（退订异步，或 runtime 重放）——事件 sid 仍是 A
    emitBusUIRequest('sessionA', mkAskUserReq('r-late-a'))

    // B 分区不被污染；切回 A 能看到迟到事件
    expect(result.currentFormRequest.value).toBeUndefined()
    sid.value = 'sessionA'
    await nextTick()
    expect(result.currentFormRequest.value?.requestId).toBe('r-late-a')

    dispose()
  })
})

describe('useExtensionUI T8 filter 第二道闸语义', () => {
  it('formFilter 实例放行表单类请求（dialog 不再经 store）', () => {
    const sid = ref<string | null>('shared')
    const { result: formPanel } = runWithScope(() => useExtensionUI(sid, formFilter))

    emitBusUIRequest('shared', mkAskUserReq('r-ask'))

    // formFilter 放行（legacy askUser 帧归一附加 form 后命中 form 键）
    expect(formPanel.currentFormRequest.value?.requestId).toBe('r-ask')

    // store 只有一条（formFilter 实例写入）
    expect(useExtensionUIStore().getRequestsBySession('shared')).toHaveLength(1)
  })
})

describe('useExtensionUI T9 模块级 refCount 注册/注销（项目规则 #2）', () => {
  it('多实例订阅共享单次 bus.on；全部 dispose 后不再分发', () => {
    const onSpy = vi.spyOn(mockBus, 'on')
    const sid = ref<string | null>('shared')
    const insts = [1, 2, 3].map(() => runWithScope(() => useExtensionUI(sid)))

    // 3 实例订阅 → bus.on 只被调 1 次（refCount 首个注册）
    expect(onSpy).toHaveBeenCalledTimes(1)
    expect(onSpy.mock.calls[0][0]).toBe('ui-request')

    // 分发仍工作（3 实例都收到 → store 去重后 1 条）
    emitBusUIRequest('shared', mkAskUserReq('r1'))
    expect(useExtensionUIStore().getRequestsBySession('shared')).toHaveLength(1)
    expect(insts[0].result.currentFormRequest.value?.requestId).toBe('r1')
    expect(insts[2].result.currentFormRequest.value?.requestId).toBe('r1')

    // dispose 2 个 → 第 3 个实例仍收（r2 入队，respond r1 后晋升）
    insts[0].dispose()
    insts[1].dispose()
    emitBusUIRequest('shared', mkAskUserReq('r2'))
    expect(insts[2].result.currentFormRequest.value?.requestId).toBe('r1')
    insts[2].result.respond('r1', true)
    expect(insts[2].result.currentFormRequest.value?.requestId).toBe('r2')

    // 全部 dispose → 不再分发（bus 无 handler，emit 无副作用）
    insts[2].dispose()
    emitBusUIRequest('shared', mkAskUserReq('r3'))
    // r1 已被中途 respond 出队，store 保持 ['r2']——r3 未入队
    expect(useExtensionUIStore().getRequestsBySession('shared').map((r) => r.requestId)).toEqual(['r2'])
  })
})

describe('useExtensionUI T10 requestId dedup 双通路（bus 帧 + 拉取）', () => {
  it('bus 实时帧先入队，切回拉取同 requestId 不重复入队', async () => {
    const sid = ref<string | null>('sessionA')
    const { result, dispose } = runWithScope(() => useExtensionUI(sid, formFilter))

    // 1. bus 实时帧入 r1
    emitBusUIRequest('sessionA', mkAskUserReq('r1'))
    expect(result.currentFormRequest.value?.requestId).toBe('r1')

    // 2. 切到 B（拉取空）
    sid.value = 'sessionB'
    await nextTick()

    // 3. 切回 A：拉取返回 [r1, r2]，r1 已在队（去重后只入 r2）
    vi.mocked(getPendingRequests).mockResolvedValue([
      mkAskUserReq('r1'),
      mkAskUserReq('r2'),
    ] as never)
    sid.value = 'sessionA'
    await nextTick()
    await nextTick()
    await nextTick()

    // 4. 去重断言：respond(r1) 后晋升 r2（若有重复 r1，currentFormRequest 仍命中第二个 r1）
    result.respond('r1', true)
    expect(result.currentFormRequest.value?.requestId).toBe('r2')

    // 5. respond(r1) 只发送一次
    const r1Calls = vi.mocked(sendExtensionUIResponse).mock.calls.filter((c) => c[1] === 'r1')
    expect(r1Calls).toHaveLength(1)

    dispose()
  })
})
