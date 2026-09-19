/**
 * useSessionDerivations × schedule-create waiting 联动测试（schedule-create-confirm-modal U6，
 * 消费方 ①；对照 derive-status-ask-user.test.ts）。
 *
 * extensionUIStore.hasPendingBlockingOverlay 判定键收敛为 form（ui-presentation-protocol D5；
 * legacy scheduler 帧归一附加 form）后，deriveStatus 经同一 getter 自动联动：scheduler
 * 确认等待同样使 session 状态点进入 waiting（agent block 等用户确认，非空闲）。
 * 锁 store 注入 → 派生值响应式迁移的用户可见链路。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/derive-status-schedule-create.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

describe('scheduler 表单 pending → derivedStatus waiting（form 键判定联动）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('extensionUIStore 有 scheduler 表单 pending（legacy 帧归一 form 键）→ derivedStatus 响应式 = waiting；respond 后回落 done', async () => {
    // 延迟 import：invalidateStatusCache 需在每次 pinia 重置后清理模块级缓存
    //（对齐 derive-status-ask-user.test.ts 模式）
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
