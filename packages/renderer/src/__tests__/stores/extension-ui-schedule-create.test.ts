// @vitest-environment node

/**
 * extension-ui store getter form 键判定单测（ui-presentation-protocol u4；原名
 * schedule-create 扩义面职责随 D5 收敛改写）。
 *
 * hasPendingBlockingOverlay 判定键收敛为 form（新 form 帧原生携带 / legacy askUser /
 * scheduleCreate 帧经 useExtensionUI 归一层附加——store 记录入队前必经归一）。本文件锁定：
 * - getter 对 legacy scheduler 表单请求（归一后 form + scheduleCreate 双键）的查询结果
 *   （消费方 ①deriveStatus waiting 的数据源）
 * - 裸 legacy 形状（无 form 键、未经归一）不命中 overlay 判定（判定侧收敛语义）
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

/** 构造 legacy scheduler 表单请求（归一后形状：scheduleCreate/scheduleDraft 原键 + form 附加） */
function makeScheduleCreate(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-A',
    requestId: 'r1',
    dialogKind: 'select',
    form: true,
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

/** 构造表单请求（form 帧形状） */
function makeForm(requestId: string): ExtensionUIRequest {
  return { sessionId: 'sess-A', requestId, dialogKind: 'select', form: true }
}

function makeDialog(requestId: string): ExtensionUIRequest {
  return { sessionId: 'sess-A', requestId, dialogKind: 'confirm' }
}

describe('form 键判定：hasPendingBlockingOverlay 覆盖 legacy scheduler 表单（有 pending 阻塞 overlay）', () => {
  it('只有 legacy scheduler 表单请求 → hasPendingBlockingOverlay true（waiting/豁免消费方的数据源）', () => {
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

  it('form 帧与 legacy scheduler 表单双请求并存 → 恒 true；逐个移除后才 false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm('r1'))
    store.addRequest('sess-A', makeScheduleCreate({ requestId: 'r2' }))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)

    store.removeRequest('sess-A', 'r1')
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)  // scheduler 表单仍在等

    store.removeRequest('sess-A', 'r2')
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })

  it('判定侧收敛语义：裸 legacy 形状（无 form 键、未经归一）不命中 overlay 判定', () => {
    // store 判定键只认 form——无 form 键的形状只在归一层之前存在
    //（useExtensionUI 双挂点保证入 store 前必经归一，此处裸形状 = 归一层回归的探针）
    const store = useExtensionUIStore()
    store.addRequest('sess-A', { sessionId: 'sess-A', requestId: 'r1', dialogKind: 'select', scheduleCreate: true })
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)

    store.clearSession('sess-A')
    store.addRequest('sess-A', makeDialog('r2'))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })
})

