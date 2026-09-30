// @vitest-environment node

/**
 * useSessionDerivations × extensionUIStore.hasPendingBlockingOverlay 联动测试。
 *
 * deriveStatus 纯函数本体（含 hasFormOverlayPending 分支/优先级/默认 false）在 core
 * domain/chat/__tests__/derive-status.test.ts 已复刻全 9 态矩阵，回归职责归 core；
 * 本文件锁 renderer 侧 store 注入 → 派生值响应式迁移的用户可见链路，覆盖两个形状：
 * - 通用富交互表单（extension.ui_request 通道，form 键判定，ui-presentation-protocol D5）：
 *   agent 阻塞等待用户输入期间，即使后续有流式文本也不应脱离 waiting。
 * - scheduler 表单（schedule-create-confirm-modal U6 消费方 ①）：legacy scheduleCreate 帧
 *   归一附加 form 键后，deriveStatus 经同一 getter 自动联动。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/derive-status.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

describe('T3: useSessionDerivations 注入 extensionUIStore.hasPendingBlockingOverlay（集成）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有表单 pending → derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    // 延迟 import：invalidateStatusCache 需在每次 pinia 重置后清理模块级缓存，
    // 避免 computed 持有上个用例的旧 store 闭包（对齐 session-active-state.test.ts 模式；
    // 下同——本文件两个 describe 共用此模式）
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

    // push 一个表单请求（form=true，legacy askUser 帧归一后形状）
    extensionUIStore.addRequest(sessionId, {
      sessionId,
      requestId: 'r1',
      method: 'select',
      form: true,
    })
    // 响应式：computed 应重算为 waiting
    expect(derivedStatus(sessionId).value).toBe('waiting')

    // respond（removeRequest）后回落 done
    extensionUIStore.removeRequest(sessionId, 'r1')
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})

describe('scheduler 表单 pending → derivedStatus waiting（form 键判定联动）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有 scheduler 表单 pending（legacy 帧归一 form 键）→ derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    const { useExtensionUIStore } = await import('@/stores/extension-ui')
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const extensionUIStore = useExtensionUIStore()
    const sessionId = 's-sc'

    // 初始无 pending → 未 hydrate + 非活跃 → done
    expect(derivedStatus(sessionId).value).toBe('done')

    // push 一个 scheduler 表单请求（legacy scheduleCreate 帧归一后形状：原键保留 + form 附加）
    extensionUIStore.addRequest(sessionId, {
      sessionId,
      requestId: 'r-sc',
      method: 'select',
      form: true,
      scheduleCreate: true,
      scheduleDraft: { kind: 'recurring', schedule: '0 9 * * *', prompt: 'p', models: [] },
    })
    // 响应式：computed 应重算为 waiting
    expect(derivedStatus(sessionId).value).toBe('waiting')

    // respond（removeRequest）后回落 done
    extensionUIStore.removeRequest(sessionId, 'r-sc')
    expect(derivedStatus(sessionId).value).toBe('done')
  })
})
