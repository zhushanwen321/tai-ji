/**
 * CW wave `session-active-ssot` T3：useSessionDerivations 把 extensionUIStore 的
 * hasPendingAskUser 注入 deriveStatus 的响应式接线（renderer 专属集成段）。
 *
 * deriveStatus 纯函数本体（含 hasAskUserPending 分支/优先级/默认 false）在 core
 * domain/chat/__tests__/derive-status.test.ts 已复刻全 9 态矩阵——原 describe#1 的
 * 5 个纯函数用例（搬迁残留）已删，回归职责归 core。
 *
 * ask-user 走 extension.ui_request 通道，不产生 toolCall running：agent 阻塞等待用户
 * 输入期间，即使后续有流式文本也不应脱离 waiting——本文件锁 store 注入 → 派生值
 * 响应式迁移的用户可见链路。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/derive-status-ask-user.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

describe('T3: useSessionDerivations 注入 extensionUIStore.hasPendingAskUser（集成）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有 ask-user pending → derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    // 延迟 import：invalidateStatusCache 需在每次 pinia 重置后清理模块级缓存，
    // 避免 computed 持有上个用例的旧 store 闭包（对齐 session-active-state.test.ts 模式）
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    const { useExtensionUIStore } = await import('@/stores/extension-ui')
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const extensionUIStore = useExtensionUIStore()
    const sessionId = 's-int'

    // 初始无 pending → 未 hydrate + 非活跃 → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // push 一个 ask-user 请求（askUser=true）
    extensionUIStore.addRequest(sessionId, {
      sessionId,
      requestId: 'r1',
      method: 'select',
      askUser: true,
    })
    // 响应式：computed 应重算为 waiting
    expect(derivedStatus(sessionId).value).toBe('waiting')

    // respond（removeRequest）后回落 done
    extensionUIStore.removeRequest(sessionId, 'r1')
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})
