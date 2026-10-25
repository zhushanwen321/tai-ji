// @vitest-environment node

/**
 * extension-ui store permission 判定键单测（chat-flow-consistency U9 / 特殊流程 S4）。
 *
 * 验收条款「非焦点会话权限等待侧栏 waiting（单测：判定键扩后 deriveStatus 联动）」的
 * store 层承载：hasPendingBlockingOverlay 是 deriveStatus waiting 状态点的唯一输入位
 * （useSessionDerivations），本文件锁定判定键扩展后 permission 帧（runtime event-adapter
 * 对 title 首行「[pi-permission] Approval required」select 附加 permission: true）命中
 * waiting 判定；既有 form / planReview 键行为不回归。
 *
 * 运行：cd packages/renderer && npx vitest run src/stores/__tests__/extension-ui-permission.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExtensionUIStore } from '@/stores/extension-ui'

/** permission 审批请求形状（runtime event-adapter translatePlainDialogRequest 附加键后的
 *  extension.ui_request 广播 payload；CompanionBand 直连消费同款形状）。 */
function mkPermissionReq(requestId: string): Record<string, unknown> {
  return {
    sessionId: 's1',
    requestId,
    dialogKind: 'select',
    title: '[pi-permission] Approval required\nTool: bash\nCommand: echo hi',
    permission: true,
  }
}

/** 普通 select（无 permission 键——第三方扩展 / permission 扩展被禁用形态，行为回落现状）。 */
function mkPlainSelectReq(requestId: string): Record<string, unknown> {
  return { sessionId: 's1', requestId, dialogKind: 'select', title: 'Pick one', options: ['a', 'b'] }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('extension-ui store — hasPendingBlockingOverlay permission 键（U9/S4）', () => {
  it('permission 键命中 waiting 判定（未水合会话缺口的修复面：无消息分区也能经 store 命中）', () => {
    const store = useExtensionUIStore()
    expect(store.hasPendingBlockingOverlay('s1')).toBe(false)
    store.applyRecords('s1', [mkPermissionReq('req-1') as never])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
  })

  it('respond 移除后判定回落 false（等待消退联动）', () => {
    const store = useExtensionUIStore()
    store.applyRecords('s1', [mkPermissionReq('req-1') as never])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
    store.removeRequest('s1', 'req-1')
    expect(store.hasPendingBlockingOverlay('s1')).toBe(false)
  })

  it('既有键不回归：form / planReview 仍命中；普通 select 与 false 值不命中', () => {
    const store = useExtensionUIStore()
    store.applyRecords('s1', [
      { sessionId: 's1', requestId: 'r-form', dialogKind: 'select', form: true } as never,
    ])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
    store.clearSession('s1')
    store.applyRecords('s1', [
      { sessionId: 's1', requestId: 'r-plan', dialogKind: 'select', planReview: true } as never,
    ])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(true)
    store.clearSession('s1')
    store.applyRecords('s1', [
      mkPlainSelectReq('r-plain') as never,
      { sessionId: 's1', requestId: 'r-false', dialogKind: 'select', permission: false } as never,
    ])
    expect(store.hasPendingBlockingOverlay('s1')).toBe(false)
  })

  it('per-session 分区隔离（ADR-0049）：s1 的 permission 挂起不影响 s2 判定', () => {
    const store = useExtensionUIStore()
    store.applyRecords('s1', [mkPermissionReq('req-1') as never])
    expect(store.hasPendingBlockingOverlay('s2')).toBe(false)
  })
})
