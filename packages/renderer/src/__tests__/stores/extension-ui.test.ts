/**
 * extension-ui store 单测 —— TC1：ask-user/dialog pending 的 session 级 SSOT。
 *
 * 覆盖：
 * - hasPendingBlockingOverlay / hasPendingDialog 查询（核心：derivedStatus 入口）
 * - addRequest requestId dedup（迁移自 useExtensionUI push 去重）
 * - removeRequest（respond/cancel/timeout 出队）
 * - clearSession（deleteSession 分区释放）
 * - clearAllPending（runtime 重连全局清理）
 * - recordsOf 响应式视图（组件订阅自动更新）
 * - per-sessionId 分区隔离（A/B 互不干扰）
 *
 * store 只 import 类型，无 API 依赖，故无需 mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/extension-ui.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExtensionUIStore } from '@/stores/extension-ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'

beforeEach(() => {
  setActivePinia(createPinia())
})

/** 构造测试 ExtensionUIRequest（默认统一表单请求——form 键，D5 收敛判定键） */
function makeForm(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-A',
    requestId: 'r1',
    method: 'select',
    form: true,
    ...overrides,
  }
}

/** 构造测试 ExtensionUIRequest（默认非 ask-user 的简单原语 dialog） */
function makeDialog(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-A',
    requestId: 'r1',
    method: 'confirm',
    ...overrides,
  }
}

describe('useExtensionUIStore — hasPendingBlockingOverlay / hasPendingDialog', () => {
  it('session 有表单 pending 返回 true，无返回 false；hasPendingDialog 查非 form', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    store.addRequest('sess-A', makeDialog({ requestId: 'r2', method: 'confirm' }))

    // r1 带 form 键 → hasPendingBlockingOverlay(sess-A) === true
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
    // sess-B 无任何 pending
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
    // r2 无 form 键 → hasPendingDialog(sess-A) === true
    expect(store.hasPendingDialog('sess-A')).toBe(true)
    // sess-B 无 dialog
    expect(store.hasPendingDialog('sess-B')).toBe(false)
  })

  it('只有 dialog（无表单）时 hasPendingBlockingOverlay 返回 false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeDialog({ requestId: 'r1', method: 'input' }))

    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
    expect(store.hasPendingDialog('sess-A')).toBe(true)
  })

  it('未知 session 查询返回 false', () => {
    const store = useExtensionUIStore()
    expect(store.hasPendingBlockingOverlay('never')).toBe(false)
    expect(store.hasPendingDialog('never')).toBe(false)
  })
})

describe('useExtensionUIStore — addRequest requestId dedup', () => {
  it('同 requestId 不重复追加', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    // 重复同 requestId（即便字段略不同也按 requestId 唯一化，迁移自 useExtensionUI push 去重）
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true, title: 'dup' }))

    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-A')[0].requestId).toBe('r1')
  })

  it('不同 requestId 正常追加', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1' }))
    store.addRequest('sess-A', makeForm({ requestId: 'r2' }))

    expect(store.getRequestsBySession('sess-A')).toHaveLength(2)
  })
})

describe('useExtensionUIStore — removeRequest', () => {
  it('respond 后移除单个请求', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    store.addRequest('sess-A', makeDialog({ requestId: 'r2', method: 'confirm' }))

    store.removeRequest('sess-A', 'r1')

    // 只剩 r2（非 form dialog）
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-A')[0].requestId).toBe('r2')
    // r2 无 form 键 → hasPendingBlockingOverlay 现在 false
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
    expect(store.hasPendingDialog('sess-A')).toBe(true)
  })

  it('移除不存在的 requestId 是 no-op', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1' }))

    expect(() => store.removeRequest('sess-A', 'nonexistent')).not.toThrow()
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
  })

  it('移除后队列空 → hasPendingBlockingOverlay / hasPendingDialog 均 false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    store.removeRequest('sess-A', 'r1')

    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
    expect(store.hasPendingDialog('sess-A')).toBe(false)
  })
})

describe('useExtensionUIStore — clearSession', () => {
  it('deleteSession 清分区，不影响其他 session', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))
    store.addRequest('sess-B', makeForm({ sessionId: 'sess-B', requestId: 'r2' }))

    store.clearSession('sess-A')

    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
    // sess-B 不受影响
    expect(store.getRequestsBySession('sess-B')).toHaveLength(1)
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(true)
  })

  it('清除不存在的 session 是 no-op', () => {
    const store = useExtensionUIStore()
    expect(() => store.clearSession('never')).not.toThrow()
  })
})

describe('useExtensionUIStore — clearAllPending', () => {
  it('清空所有 session（runtime 重连清理）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1', askUser: true }))
    store.addRequest('sess-B', makeDialog({ sessionId: 'sess-B', requestId: 'r2', method: 'confirm' }))

    store.clearAllPending()

    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.getRequestsBySession('sess-B')).toEqual([])
  })
})

describe('useExtensionUIStore — recordsOf 响应式视图', () => {
  it('addRequest 后响应式视图自动更新', () => {
    const store = useExtensionUIStore()
    const records = store.recordsOf('sess-A')

    // 初始空
    expect(records.value).toHaveLength(0)

    store.addRequest('sess-A', makeForm({ requestId: 'r1' }))

    // 响应式触发：computed 重算
    expect(records.value).toHaveLength(1)
    expect(records.value[0].requestId).toBe('r1')
  })

  it('removeRequest 后响应式视图自动更新', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1' }))
    store.addRequest('sess-A', makeForm({ requestId: 'r2' }))
    const records = store.recordsOf('sess-A')
    expect(records.value).toHaveLength(2)

    store.removeRequest('sess-A', 'r1')

    expect(records.value).toHaveLength(1)
    expect(records.value[0].requestId).toBe('r2')
  })

  it('不同 session 的 recordsOf 互不干扰', () => {
    const store = useExtensionUIStore()
    const recordsA = store.recordsOf('sess-A')
    const recordsB = store.recordsOf('sess-B')

    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))

    expect(recordsA.value).toHaveLength(1)
    expect(recordsB.value).toHaveLength(0)
  })
})

describe('useExtensionUIStore — per-sessionId 分区隔离', () => {
  it('A/B 互不干扰', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1', askUser: true }))
    store.addRequest('sess-B', makeDialog({ sessionId: 'sess-B', requestId: 'r2', method: 'confirm' }))

    // 各分区只含自己的请求
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-A')[0].requestId).toBe('r1')
    expect(store.getRequestsBySession('sess-B')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-B')[0].requestId).toBe('r2')

    // 查询也按分区隔离
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
    expect(store.hasPendingDialog('sess-A')).toBe(false)
    expect(store.hasPendingDialog('sess-B')).toBe(true)
  })
})

describe('useExtensionUIStore — applyRecords 整体替换', () => {
  it('整体替换该分区（不可变写触发响应式）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1' }))
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)

    // applyRecords 整体替换（runtime 推送全量列表场景）
    store.applyRecords('sess-A', [
      makeForm({ requestId: 'r3' }),
      makeDialog({ requestId: 'r4' }),
    ])

    expect(store.getRequestsBySession('sess-A')).toHaveLength(2)
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
    expect(store.hasPendingDialog('sess-A')).toBe(true)
  })
})
