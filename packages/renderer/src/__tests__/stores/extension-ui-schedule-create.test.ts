/**
 * extension-ui store getter 扩义单测（schedule-create-confirm-modal U6）。
 *
 * hasPendingBlockingOverlay 谓词扩义为「有 pending 富交互 overlay 请求」（askUser ∨ scheduleCreate），
 * hasPendingDialog 对称判据修正（两类 overlay 都不归 dialog）。本文件锁定：
 * - getter 扩义对 schedule-create 请求的查询结果（消费方 ①deriveStatus waiting 的数据源）
 * - hasPendingDialog 不把 scheduleCreate 误归 dialog 类（双 getter 恒不双真）
 * - ask-user 既有查询行为零变更（V7 回归面：老形状请求结果不变）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/extension-ui-schedule-create.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 构造 schedule 创建确认富交互请求（runtime event-adapter 第 4 marker 分支的帧形状） */
function makeScheduleCreate(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-A',
    requestId: 'r1',
    method: 'select',
    scheduleCreate: true,
    scheduleDraft: {
      kind: 'recurring',
      schedule: '0 9 * * *',
      prompt: '总结昨天的工作进展',
      models: ['m-1'],
      currentModel: 'm-1',
    },
    ...overrides,
  }
}

function makeAskUser(requestId: string): ExtensionUIRequest {
  return { sessionId: 'sess-A', requestId, method: 'select', askUser: true }
}

function makeDialog(requestId: string): ExtensionUIRequest {
  return { sessionId: 'sess-A', requestId, method: 'confirm' }
}

describe('getter 扩义：hasPendingBlockingOverlay 覆盖 scheduleCreate（有 pending 阻塞 overlay）', () => {
  it('只有 scheduleCreate 请求 → hasPendingBlockingOverlay true（waiting/豁免消费方的数据源）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeScheduleCreate({ requestId: 'r1' }))

    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
  })

  it('respond 后回落 false（响应式由不可变 Map 替换保证）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeScheduleCreate({ requestId: 'r1' }))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)

    store.removeRequest('sess-A', 'r1')
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })

  it('askUser 与 scheduleCreate 双请求并存 → 恒 true；逐个移除后才 false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeAskUser('r1'))
    store.addRequest('sess-A', makeScheduleCreate({ requestId: 'r2' }))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)

    store.removeRequest('sess-A', 'r1')
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)  // scheduleCreate 仍在等

    store.removeRequest('sess-A', 'r2')
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })

  it('V7 回归：无 scheduleCreate 字段的老形状请求查询行为不变（askUser=true→true / dialog→false）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeAskUser('r1'))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)

    store.clearSession('sess-A')
    store.addRequest('sess-A', makeDialog('r2'))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })
})

describe('hasPendingDialog 对称判据：scheduleCreate 不归 dialog 类', () => {
  it('只有 scheduleCreate 请求 → hasPendingDialog false（与 hasPendingBlockingOverlay 不双真）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeScheduleCreate({ requestId: 'r1' }))

    expect(store.hasPendingDialog('sess-A')).toBe(false)
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
  })

  it('askUser 请求同样不归 dialog（既有对称语义保持）；普通 dialog 归 dialog', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeAskUser('r1'))
    expect(store.hasPendingDialog('sess-A')).toBe(false)

    store.addRequest('sess-A', makeDialog('r2'))
    expect(store.hasPendingDialog('sess-A')).toBe(true)
  })
})
