/**
 * stores 纯链路域合并产物（round 6 renderer 测试压缩）：三文件同产物，环境默认
 * （happy-dom；sidebar-store 需 localStorage，extension-ui / fileTree-projection 原默认）。
 * 三文件全零 vi.mock（真 Pinia store + 真门面装配链），无 mock 互斥。
 *
 * 并入来源（基名）：
 *  - sidebar-store（折叠态两事实源合成 + 持久化，7 例）
 *  - extension-ui（round5 产物：extension-ui store 全行为集，44 例）
 *  - fileTree-projection（projectVisibleRows 投影等价性/性能量级，20 例）
 *
 * 各文件级 beforeEach（pinia 重置 + sidebar 的 localStorage 清键）已下沉进各自 describe。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/stores/stores-pure-bundle.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, nextTick } from 'vue'
import { useSidebarStore } from '@/stores/sidebar'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import {
  useFileTreeStore,
  projectVisibleRows,
  visibleRowKey,
  type VisibleRow,
  type NodeState,
} from '@/stores/fileTree'
import { nodeMatchesFilter } from '@/composables/logic/file-tree-utils'
import type { FileNode, GitFileStatus, SessionGroup, PiLaunchPreset } from '@taiji/shared'

// ═══════════ 来源节：sidebar-store ═══════════

describe('sidebar store 折叠态持久化（用户意图位）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('taiji:side-collapsed')
  })

  it('无持久化值 → 默认展开', () => {
    expect(useSidebarStore().collapsed).toBe(false)
  })

  it('toggleCollapsed → localStorage 写入新折叠态（watch pre-flush，nextTick 后落盘）', async () => {
    const sidebar = useSidebarStore()
    sidebar.toggleCollapsed()
    await nextTick()
    expect(sidebar.collapsed).toBe(true)
    expect(sidebar.userCollapsed).toBe(true)
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('true')

    sidebar.toggleCollapsed()
    await nextTick()
    expect(sidebar.collapsed).toBe(false)
    expect(sidebar.userCollapsed).toBe(false)
    expect(localStorage.getItem('taiji:side-collapsed')).toBe('false')
  })

  it('刷新（重新创建 store）→ 恢复持久化折叠态', async () => {
    useSidebarStore().toggleCollapsed()
    await nextTick()

    setActivePinia(createPinia())
    expect(useSidebarStore().collapsed).toBe(true)
    expect(useSidebarStore().userCollapsed).toBe(true)
  })

  it('localStorage 写入抛错（隐私模式）→ 不崩、状态照常翻转', async () => {
    const setItem = localStorage.setItem
    localStorage.setItem = () => {
      throw new Error('quota exceeded')
    }
    try {
      const sidebar = useSidebarStore()
      sidebar.toggleCollapsed()
      await nextTick()
      expect(sidebar.collapsed).toBe(true)
    } finally {
      localStorage.setItem = setItem
    }
  })

  it('持久化值损坏（非布尔字面量）→ 静默回落展开态', () => {
    localStorage.setItem('taiji:side-collapsed', '{{{corrupt')
    setActivePinia(createPinia())
    expect(useSidebarStore().collapsed).toBe(false)
  })
})

describe('sidebar store 两事实源合成（userCollapsed || viewportNarrow）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.removeItem('taiji:side-collapsed')
  })

  it('视口强制独立生效：userCollapsed=false + viewportNarrow=true → 折叠；不落盘且刷新后不恢复视口位', async () => {
    const sidebar = useSidebarStore()
    sidebar.viewportNarrow = true
    expect(sidebar.collapsed).toBe(true)
    await nextTick()
    expect(localStorage.getItem('taiji:side-collapsed')).toBe(null)

    // 不落盘 ⇒ 刷新（重建 store）读回无值，视口位与折叠随之复位——视口态是易失的
    setActivePinia(createPinia())
    const fresh = useSidebarStore()
    expect(fresh.viewportNarrow).toBe(false)
    expect(fresh.collapsed).toBe(false)
  })

  it('窄窗强制态下 toggle（含重复点击）→ 意图=展开，仍折叠；意图无变化不写盘；强制解除后弹回', async () => {
    const sidebar = useSidebarStore()
    sidebar.viewportNarrow = true
    sidebar.toggleCollapsed()
    expect(sidebar.userCollapsed).toBe(false)
    expect(sidebar.collapsed).toBe(true)
    // 重复点击：窄窗强制态下按钮可见形态恒为「展开」，每次点击都表达展开意图，意图位不翻转回收起
    // （对「无条件翻转意图位」类错误实现，上一行的单次断言已先红——偶数次点击会恢复奇偶性）
    sidebar.toggleCollapsed()
    await nextTick()

    expect(sidebar.userCollapsed).toBe(false)
    expect(sidebar.collapsed).toBe(true)
    // 意图位无实际变化（false→false）不触发持久化：盘上无值与读侧回落 false 一致
    expect(localStorage.getItem('taiji:side-collapsed')).toBe(null)

    sidebar.viewportNarrow = false
    expect(sidebar.collapsed).toBe(false)
  })
})

// ═══════════ 来源节：extension-ui（round5 产物）═══════════

function makeForm(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-A',
    requestId: 'r1',
    dialogKind: 'select',
    form: true,
    ...overrides,
  }
}

/** 构造测试 ExtensionUIRequest（默认非 ask-user 的简单原语 dialog） */
function makeDialog(overrides: Partial<ExtensionUIRequest> = {}): ExtensionUIRequest {
  return {
    sessionId: 'sess-A',
    requestId: 'r1',
    dialogKind: 'confirm',
    ...overrides,
  }
}

/** 构造 planReview 审批挂起请求（D12：计入 waiting 谓词的第二种判定键，runtime PLAN_REVIEW_MARKER 帧形状） */
function makePlanReview(
  overrides: Partial<ExtensionUIRequest> = {},
): ExtensionUIRequest & { planReview: true } {
  return {
    sessionId: 'sess-B',
    requestId: 'pr-1',
    dialogKind: 'select',
    planReview: true,
    ...overrides,
  }
}

describe('useExtensionUIStore — hasPendingBlockingOverlay', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('session 有表单 pending 返回 true，无返回 false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    store.addRequest('sess-A', makeDialog({ requestId: 'r2', dialogKind: 'confirm' }))

    // r1 带 form 键 → hasPendingBlockingOverlay(sess-A) === true
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
    // sess-B 无任何 pending
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
  })

  it('只有 dialog（无表单）时 hasPendingBlockingOverlay 返回 false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeDialog({ requestId: 'r1', dialogKind: 'input' }))

    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })

  it('未知 session 查询返回 false', () => {
    const store = useExtensionUIStore()
    expect(store.hasPendingBlockingOverlay('never')).toBe(false)
  })
})

describe('useExtensionUIStore — addRequest requestId dedup', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

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
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('respond 后移除单个请求', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    store.addRequest('sess-A', makeDialog({ requestId: 'r2', dialogKind: 'confirm' }))

    store.removeRequest('sess-A', 'r1')

    // 只剩 r2（非 form dialog）
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-A')[0].requestId).toBe('r2')
    // r2 无 form 键 → hasPendingBlockingOverlay 现在 false
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })

  it('移除不存在的 requestId 是 no-op', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1' }))

    expect(() => store.removeRequest('sess-A', 'nonexistent')).not.toThrow()
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
  })

  it('移除后队列空 → hasPendingBlockingOverlay false', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ requestId: 'r1', form: true }))
    store.removeRequest('sess-A', 'r1')

    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })
})

describe('useExtensionUIStore — retainOnly 快照差集剔除（§6.2 采用项④ v6.1 主算法）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keepIds 空集 → 清空分区（空快照路径，僵尸表单剔除）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r2' }))

    // 空快照（[]）→ keepIds 空集：分区中不在快照内的条目全部移除
    store.retainOnly('sess-A', new Set<string>())

    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })

  it('keepIds 部分命中 → 仅保留命中项，其余剔除', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r2' }))
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r3' }))

    store.retainOnly('sess-A', new Set(['r1', 'r3']))

    expect(store.getRequestsBySession('sess-A').map((r) => r.requestId)).toEqual(['r1', 'r3'])
  })

  it('分区不存在 / 无需剔除 → no-op（不抛、不误建分区）', () => {
    const store = useExtensionUIStore()
    expect(() => store.retainOnly('never', new Set<string>())).not.toThrow()
    expect(store.getRequestsBySession('never')).toEqual([])

    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))
    store.retainOnly('sess-A', new Set(['r1']))
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
  })

  it('只动指定分区，不影响其他 session', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))
    store.addRequest('sess-B', makeForm({ sessionId: 'sess-B', requestId: 'r2' }))

    store.retainOnly('sess-A', new Set<string>())

    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.getRequestsBySession('sess-B').map((r) => r.requestId)).toEqual(['r2'])
  })

  it('响应式视图 recordsOf 随剔除更新', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1' }))
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r2' }))
    const records = store.recordsOf('sess-A')
    expect(records.value).toHaveLength(2)

    store.retainOnly('sess-A', new Set(['r2']))

    expect(records.value.map((r) => r.requestId)).toEqual(['r2'])
  })
})

describe('useExtensionUIStore — clearSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

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
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('清空所有 session（runtime 重连清理）', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1', askUser: true }))
    store.addRequest('sess-B', makeDialog({ sessionId: 'sess-B', requestId: 'r2', dialogKind: 'confirm' }))

    store.clearAllPending()

    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
    expect(store.getRequestsBySession('sess-A')).toEqual([])
    expect(store.getRequestsBySession('sess-B')).toEqual([])
  })
})

describe('useExtensionUIStore — recordsOf 响应式视图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

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
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('A/B 互不干扰', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-A', makeForm({ sessionId: 'sess-A', requestId: 'r1', askUser: true }))
    store.addRequest('sess-B', makeDialog({ sessionId: 'sess-B', requestId: 'r2', dialogKind: 'confirm' }))

    // 各分区只含自己的请求
    expect(store.getRequestsBySession('sess-A')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-A')[0].requestId).toBe('r1')
    expect(store.getRequestsBySession('sess-B')).toHaveLength(1)
    expect(store.getRequestsBySession('sess-B')[0].requestId).toBe('r2')

    // 查询也按分区隔离
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(true)
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
  })
})

describe('useExtensionUIStore — applyRecords 整体替换', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

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
  })
})

describe('D12 waiting 谓词加 planReview 员（plan 审批挂起 → 侧栏 waiting）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('planReview 挂起计入 hasPendingBlockingOverlay', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-B', makePlanReview())

    // D12：planReview===true 的挂起同计入 waiting 态数据源（多 session 后台审批挂起可见，F15）
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(true)
    // per-session 分区：A 会话不受 B 的挂起影响
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)

    // 出队后回落
    store.removeRequest('sess-B', 'pr-1')
    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(false)
  })

  it('planReview 与 form 两键同位：与 plain dialog 混排时 dialog 不计入 overlay', () => {
    const store = useExtensionUIStore()
    store.addRequest('sess-B', makePlanReview({ requestId: 'pr-1' }))
    store.addRequest('sess-B', makeDialog({ sessionId: 'sess-B', requestId: 'r-dlg' }))

    expect(store.hasPendingBlockingOverlay('sess-B')).toBe(true)
  })

  it('B 会话挂 planReview → 侧栏 waiting 标记（derivedStatus=waiting），焦点 A 不受影响', async () => {
    // 延迟 import + invalidateStatusCache：useSessionDerivations 模块级 computed 缓存会持有
    // 上个用例的旧 store 闭包（照 derive-status-ask-user.test.ts 模式逐用例清理）
    const { useSessionDerivations, invalidateStatusCache } = await import(
      '@/composables/features/chat/useSessionDerivations'
    )
    const { useExtensionUIStore } = await import('@/stores/extension-ui')
    invalidateStatusCache()

    const { derivedStatus } = useSessionDerivations()
    const store = useExtensionUIStore()
    // 未挂起（未 hydrate + 非活跃）→ done（与 ask-user 基线一致）
    expect(derivedStatus('sess-A').value).toBe('done')
    expect(derivedStatus('sess-B').value).toBe('done')

    // S14 形态：B 会话挂起审批，焦点留在 A 会话 → B 侧栏出 waiting 标记，A 不变
    store.addRequest('sess-B', makePlanReview())
    expect(derivedStatus('sess-B').value).toBe('waiting')
    expect(derivedStatus('sess-A').value).toBe('done')

    // 应答出队 → 回落 done
    store.removeRequest('sess-B', 'pr-1')
    expect(derivedStatus('sess-B').value).toBe('done')
  })
})

// ══════════ 来源：session-store-state.test.ts（applySnapshot + markDead/revive） ══════════

function seedSession(): ReturnType<typeof useSessionStore> {
  const store = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's1', label: 'test', cwd: '/repo', status: 'idle', lastActiveAt: 100 },
      { id: 's2', label: 'other', cwd: '/repo', status: 'idle', lastActiveAt: 100 },
    ],
  }
  store.applySnapshot({ groups: [group] })
  return store
}

describe('sessionStore.applySnapshot（单 session 快照合并）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('U11: 更新 label，其余字段不变', () => {
    const store = seedSession()
    store.applySnapshot('s1', { label: '新名' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.label).toBe('新名')
    expect(s1?.status).toBe('idle') // 不变
    expect(s1?.cwd).toBe('/repo') // 其余描述字段不动
  })

  it('U12: 未知 sessionId 不抛错，groups 不变', () => {
    const store = seedSession()
    expect(() => store.applySnapshot('ghost', { label: 'x' })).not.toThrow()
    expect(store.list.length).toBe(2)
    expect(store.list.find((s) => s.id === 's1')?.label).toBe('test')
  })

  it('U13: 只更新 status，label 不变', () => {
    const store = seedSession()
    store.applySnapshot('s1', { status: 'active' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.status).toBe('active')
    expect(s1?.label).toBe('test') // 不变
  })

  it('label 为 undefined 时不更新（保留旧值）', () => {
    const store = seedSession()
    store.applySnapshot('s1', { label: undefined, status: 'done' })
    const s1 = store.list.find((s) => s.id === 's1')
    expect(s1?.status).toBe('done')
    expect(s1?.label).toBe('test') // undefined 跳过，保留旧值
  })

  // ── [W1 会话架构四层分离] 状态字段不再由列表承载（反向锁定；W3 起三字段已不在
  //    SessionSummary 上，写入分支同批删除——本用例锁定无人把它们加回列表条目）────────
  it('W1: 单条快照的状态字段（modelId/thinkingLevel/tokenCount）不写入列表条目', () => {
    const store = seedSession()
    store.applySnapshot('s1', { modelId: 'anthropic/claude-4', thinkingLevel: 'max', tokenCount: 999 })
    const s1 = store.list.find((s) => s.id === 's1')
    // 列表条目只持描述字段；状态字段即使随快照传入也不落列表（W3 起类型上已无这三字段）
    expect(s1).toMatchObject({ id: 's1', label: 'test', status: 'idle' })
    expect(s1).not.toHaveProperty('modelId')
    expect(s1).not.toHaveProperty('thinkingLevel')
    expect(s1).not.toHaveProperty('tokenCount')
  })
})

function seedIdleStore(): ReturnType<typeof useSessionStore> {
  const store = useSessionStore()
  const group: SessionGroup = {
    cwd: '/repo',
    sessions: [
      { id: 's1', label: 'idle-session', cwd: '/repo', status: 'idle', lastActiveAt: 100 },
      { id: 's2', label: 'active-session', cwd: '/repo', status: 'active', lastActiveAt: 200 },
    ],
  }
  store.applySnapshot({ groups: [group] })
  return store
}

describe('sessionStore.markDead', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('idle session 标记为 dead', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')
  })

  it('active session 标记为 dead（流式中进程崩溃的场景）', () => {
    const store = seedIdleStore()
    store.markDead('s2')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('dead')
  })

  it('未知 sessionId 为 no-op（不抛错，列表不变）', () => {
    const store = seedIdleStore()
    expect(() => store.markDead('ghost')).not.toThrow()
    expect(store.list.length).toBe(2)
    expect(store.list.every((s) => s.status !== 'dead')).toBe(true)
  })

  it('只改目标 session，其余 session 状态不变', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('active')
  })
})

describe('sessionStore.revive', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('dead session 重置为 idle', () => {
    const store = seedIdleStore()
    store.markDead('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('dead')

    store.revive('s1')
    expect(store.list.find((s) => s.id === 's1')?.status).toBe('idle')
  })

  it('非 dead 态不受 revive 影响（防止误改 active）', () => {
    const store = seedIdleStore()
    // s2 是 active，revive 应 no-op
    store.revive('s2')
    expect(store.list.find((s) => s.id === 's2')?.status).toBe('active')
  })

  it('未知 sessionId 为 no-op', () => {
    const store = seedIdleStore()
    expect(() => store.revive('ghost')).not.toThrow()
    expect(store.list.length).toBe(2)
  })
})

// ══════════ 来源：preset-store.test.ts（preset 纯状态容器） ══════════

describe('preset store 初值', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('初值：presets=[]、defaultPresetId=""', () => {
    const store = usePresetStore()
    expect(store.presets).toEqual([])
    expect(store.defaultPresetId).toBe('')
  })
})

describe('preset store setPresets（TC-3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('setPresets([a,b]) → store.presets === [a,b]', () => {
    const store = usePresetStore()
    const presets: PiLaunchPreset[] = [
      { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
      { id: 'builtin:readonly', name: '只读模式', builtin: true, order: 2, toolMode: 'allowlist', allowedTools: ['read'], extensionMode: 'all' },
    ]
    store.setPresets(presets)
    expect(store.presets).toEqual(presets)
    expect(store.presets).toHaveLength(2)
  })
})

describe('preset store setDefaultPresetId（TC-3）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('setDefaultPresetId("builtin:full") → store.defaultPresetId === "builtin:full"', () => {
    const store = usePresetStore()
    store.setDefaultPresetId('builtin:full')
    expect(store.defaultPresetId).toBe('builtin:full')
  })

  it('重复 setDefaultPresetId 覆盖（纯写入幂等覆盖）', () => {
    const store = usePresetStore()
    store.setDefaultPresetId('builtin:full')
    store.setDefaultPresetId('builtin:readonly')
    expect(store.defaultPresetId).toBe('builtin:readonly')
  })
})

// ══════════ 来源：extension-ui-schedule-create.test.ts（form 键判定 legacy scheduler
//             表单；makeForm/makeDialog 与主体同名异签名，按节重命名为
//             makeSchedForm/makeSchedDialog，用例名与断言零改动） ══════════

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

/** 构造表单请求（form 帧形状；原名 makeForm，与主体 helper 同名异签名故按节重命名） */
function makeSchedForm(requestId: string): ExtensionUIRequest {
  return { sessionId: 'sess-A', requestId, dialogKind: 'select', form: true }
}

/** 构造 dialog 请求（原名 makeDialog，同上重命名） */
function makeSchedDialog(requestId: string): ExtensionUIRequest {
  return { sessionId: 'sess-A', requestId, dialogKind: 'confirm' }
}

describe('form 键判定：hasPendingBlockingOverlay 覆盖 legacy scheduler 表单（有 pending 阻塞 overlay）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

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
    store.addRequest('sess-A', makeSchedForm('r1'))
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
    store.addRequest('sess-A', makeSchedDialog('r2'))
    expect(store.hasPendingBlockingOverlay('sess-A')).toBe(false)
  })
})

// ═══════════ 来源节：fileTree-projection ═══════════

const TREE: FileNode[] = [
  {
    path: 'src',
    name: 'src',
    type: 'dir',
    children: [
      { path: 'src/a.ts', name: 'a.ts', type: 'file' },
      {
        path: 'src/utils',
        name: 'utils',
        type: 'dir',
        children: [
          { path: 'src/utils/b.ts', name: 'b.ts', type: 'file' },
          { path: 'src/utils/ignored.log', name: 'ignored.log', type: 'file', ignored: true },
        ],
      },
      { path: 'src/empty', name: 'empty', type: 'dir', children: [] },
      {
        path: 'src/ignored-dir',
        name: 'ignored-dir',
        type: 'dir',
        ignored: true,
        children: [{ path: 'src/ignored-dir/x.ts', name: 'x.ts', type: 'file' }],
      },
    ],
  },
  { path: 'README.md', name: 'README.md', type: 'file' },
  {
    path: 'node_modules',
    name: 'node_modules',
    type: 'dir',
    ignored: true,
    children: [{ path: 'node_modules/pkg', name: 'pkg', type: 'dir', children: [] }],
  },
]

/** 行简写（等价性比较用）：kind = 节点类型或 hint 类型 */
interface RowBrief {  // oe-exempt:20261027:test:
  path: string
  depth: number
  kind: string
}

/** reference：逐行复刻旧递归渲染（FileView.visibleNodes 顶层裁 + FileTreeRow 递归）语义
 * （[2026-10-15] showIgnored 维度随开关退役移除——ignored 节点全量显示） */
function legacyVisibleRows(
  nodes: FileNode[],
  expanded: Set<string>,
  q: string,
  nodeStates: Map<string, NodeState>,
): RowBrief[] {
  const out: RowBrief[] = []
  function walk(list: FileNode[], depth: number): void {
    for (const node of list) {
      out.push({ path: node.path, depth, kind: node.type })
      if (node.type === 'dir' && expanded.has(node.path)) {
        const status = nodeStates.get(node.path)?.status ?? 'unloaded'
        if (status === 'loading') {
          out.push({ path: node.path, depth: depth + 1, kind: 'loading' })
          continue
        }
        if (status === 'error') {
          out.push({ path: node.path, depth: depth + 1, kind: 'error' })
          continue
        }
        if (node.children) {
          const vc = node.children
          if (vc.length === 0) {
            out.push({ path: node.path, depth: depth + 1, kind: 'empty' })
            continue
          }
          walk(vc, depth + 1)
        }
      }
    }
  }
  let top = nodes
  if (q) top = top.filter((n) => nodeMatchesFilter(n, q.toLowerCase())) // 旧 FileView 先 trim().toLowerCase()
  walk(top, 0)
  return out
}

/** projectVisibleRows 参数序列单源（per-session getter 传参；getNodeState 可注入 spy）。 */
function projectArgs(store: ReturnType<typeof useFileTreeStore>, sid: string, getNodeState?: (s: string, path: string) => unknown) {
  return [
    (s: string) => store.getTree(s),
    (s: string) => store.getExpanded(s),
    (s: string) => store.getGitOverlay(s),
    store.filterText,
    sid,
    getNodeState ?? ((s: string, path: string) => store.getNodeState(s, path)),
  ] as const
}

/** 用 store 状态驱动派生视图（与 FileView computed 相同的调用形态：per-session getter 传参） */
function project(store: ReturnType<typeof useFileTreeStore>, sid = 's1'): VisibleRow[] {
  return projectVisibleRows(...projectArgs(store, sid))
}

function briefs(rows: VisibleRow[]): RowBrief[] {
  return rows.map((r) => ({ path: r.path, depth: r.depth, kind: r.hint ?? r.type }))
}

/** 预置树 + 各种展开组合 */
function setupTree(store: ReturnType<typeof useFileTreeStore>, expandedPaths: string[]): void {
  store.setTree('s1', TREE)
  for (const p of expandedPaths) store.addExpanded('s1', p)
}

describe('projectVisibleRows 等价性（旧递归渲染节点集合，顺序 + 缩进深度）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  const expandedCombos: string[][] = [
    [],
    ['src'],
    ['src', 'src/utils'],
    ['src/utils'], // 父未展开、子展开（rehydrate 边缘态）
    ['src', 'src/empty'],
    ['src', 'src/ignored-dir'],
    ['node_modules'],
    ['src', 'src/utils', 'node_modules', 'src/empty', 'nonexistent'], // 含已删路径（graceful）
  ]
  const filters = ['', 'b', 'README', 'utils', 'zzz_no_match']
  const nodeStateCombos: Array<Map<string, NodeState>> = [
    new Map(),
    new Map([['src', { status: 'loading' }]]),
    new Map([['src', { status: 'error' }]]),
    new Map([['src/utils', { status: 'loading' }]]),
    new Map([['src', { status: 'invalidated' }]]), // invalidated 展开 → 仍渲旧 children（旧 v-else 分支）
    new Map([['src', { status: 'loading' }], ['src/utils', { status: 'error' }]]),
  ]

  for (const expanded of expandedCombos) {
    for (const q of filters) {
      for (const states of nodeStateCombos) {
        it(`等价：expanded=[${expanded.join(',') || '-'}] q='${q}' states=[${[...states.keys()].join(',') || '-'}]`, () => {
          const store = useFileTreeStore()
          setupTree(store, expanded)
          store.setFilter(q)
          for (const [path, state] of states) {
            store.setNodeState('s1', path, state)
          }

          const rows = project(store)
          expect(briefs(rows)).toEqual(
            legacyVisibleRows(TREE, new Set(expanded), q, states),
          )
        })
      }
    }
  }
})

describe('projectVisibleRows 字段映射（徽章/角标/行数从分桶派生视图）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('childCount = 目录可见直接子项数（ignored 全量计入），文件行恒 0', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src']) // 展开 src → src/empty 行进入派生视图

    const rows = project(store)
    const src = rows.find((r) => r.path === 'src')!
    const empty = rows.find((r) => r.path === 'src/empty')!
    const readme = rows.find((r) => r.path === 'README.md')!
    // src 直接子项 a.ts/utils/empty/ignored-dir 全量计入（ignored 不过滤）→ 4
    expect(src.childCount).toBe(4)
    expect(empty.childCount).toBe(0) // 空目录 = 0（demo .fbadge：是目录即恒渲染，0 也显）
    expect(readme.childCount).toBe(0) // 文件行不映射子项数
  })

  it('未加载 children 的目录 childCount 恒 0（懒加载诚实值）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'lazy', name: 'lazy', type: 'dir' }])
    expect(project(store).find((r) => r.path === 'lazy')!.childCount).toBe(0)
  })

  it('gitStatus 整对象 + lineStats 映射（tracked → add/del；untracked+size → size；无标注 → undefined）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [
      { path: 'm.ts', name: 'm.ts', type: 'file' },
      { path: 'u.log', name: 'u.log', type: 'file', size: 30 },
      { path: 'clean.ts', name: 'clean.ts', type: 'file' },
    ])
    store.setGitOverlay('s1', [
      { path: 'm.ts', xyCode: ' M', status: 'modified', additions: 12, deletions: 3 },
      { path: 'u.log', xyCode: '??', status: 'untracked' },
    ])
    const rows = project(store)
    const m = rows.find((r) => r.path === 'm.ts')!
    expect(m.gitStatus?.status).toBe('modified')
    expect(m.lineStats).toEqual({ add: 12, del: 3 })
    const u = rows.find((r) => r.path === 'u.log')!
    expect(u.gitStatus?.status).toBe('untracked')
    expect(u.lineStats).toEqual({ size: 30 })
    const clean = rows.find((r) => r.path === 'clean.ts')!
    expect(clean.gitStatus).toBeUndefined()
    expect(clean.lineStats).toBeUndefined()
  })

  it('expanded/ignored/type/depth 派生视图正确（含 hint 行 depth = 目录 depth+1）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/utils'])
    const rows = project(store)
    const src = rows.find((r) => r.path === 'src')!
    expect(src.expanded).toBe(true)
    expect(src.depth).toBe(0)
    const utils = rows.find((r) => r.path === 'src/utils')!
    expect(utils.expanded).toBe(true)
    expect(utils.depth).toBe(1)
    const ignoredDir = rows.find((r) => r.path === 'src/ignored-dir')!
    expect(ignoredDir.ignored).toBe(true)
  })

  it('hint 行：loading/error/empty 三类占位（nodeStates 驱动，depth 为目录 depth+1）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/utils', 'src/empty'])
    store.setNodeState('s1', 'src/utils', { status: 'loading' })
    const rows = project(store)

    const loading = rows.find((r) => r.hint === 'loading')!
    expect(loading.path).toBe('src/utils')
    expect(loading.depth).toBe(2) // src(0) → utils(1) → hint(2)
    expect(loading.type).toBe('dir')

    // src/empty：loaded（默认 unloaded → 无 children 判定？——empty 目录有 children=[] 但需 loaded）
    store.setNodeState('s1', 'src/empty', { status: 'loaded' })
    const rows2 = project(store)
    const empty = rows2.find((r) => r.hint === 'empty')!
    expect(empty.path).toBe('src/empty')
    expect(empty.depth).toBe(2)
  })

  it('hint 行 key 与节点行不冲突（visibleRowKey：hint 加前缀）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/empty'])
    store.setNodeState('s1', 'src/empty', { status: 'loaded' })
    const rows = project(store)
    const keys = rows.map((r) => visibleRowKey(r))
    expect(new Set(keys).size).toBe(keys.length) // 无重复 key（目录行 'src/empty' vs hint 行同 path）
  })

  it('[W28 审查 Fix-1] error hint 行 expanded=true（目录已展开才渲染 hint；点击 = 折叠非重试）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src'])
    store.setNodeState('s1', 'src', { status: 'error', reason: 'timeout' })
    const rows = project(store)

    const errorHint = rows.find((r) => r.hint === 'error')!
    // 旧递归语义：error hint 只在已展开目录渲染，点击 = 折叠父目录。
    // expanded 恒 true → FileView.onToggleRow 走 collapseNode（expanded:false 会走
    // expandNode → error 态重新发请求，变重试——行为回归）
    expect(errorHint.expanded).toBe(true)
    // 目录行自身展开态不受 hint 影响
    const srcRow = rows.find((r) => r.path === 'src' && !r.hint)!
    expect(srcRow.expanded).toBe(true)
  })
})

describe('projectVisibleRows 纯函数幂等（同树同过滤同展开 → 同输出）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('相同入参两次调用 → 深等输出（零副作用）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src', 'src/utils'])
    store.setFilter('utils')
    const a = project(store)
    const b = project(store)
    expect(a).toEqual(b)
    // 输出为独立数组（非共享引用——调用方改行不影响下次派生视图）
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
  })
})

describe('projectVisibleRows 性能量级（万级节点，替代旧 per-row 12 computed）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function buildBigTree(fileCount: number): FileNode[] {
    return [
      {
        path: 'big',
        name: 'big',
        type: 'dir',
        children: [
          ...Array.from({ length: fileCount }, (_, i) => ({
            path: `big/f${i}.ts`,
            name: `f${i}.ts`,
            type: 'file' as const,
          })),
          {
            path: 'big/nested',
            name: 'nested',
            type: 'dir',
            children: Array.from({ length: fileCount }, (_, i) => ({
              path: `big/nested/g${i}.ts`,
              name: `g${i}.ts`,
              type: 'file' as const,
            })),
          },
        ],
      },
    ]
  }

  /** 计数版 Map：overlay.get 调用次数（行级 O(1) 的线性性证据，替代墙钟断言） */
  class CountingGetMap<V> extends Map<string, V> {
    getCalls = 0
    override get(key: string): V | undefined {
      this.getCalls += 1
      return super.get(key)
    }
  }

  it('万级可见行单次派生视图全量产出（10002 行），overlay.get/getNodeState 调用次数线性上界（替代墙钟）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', buildBigTree(10000))
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    store.setGitOverlay('s1', [
      { path: 'big/f1.ts', xyCode: ' M', status: 'modified' },
      { path: 'big/nested/g2.ts', xyCode: '??', status: 'untracked' },
    ])

    // 操作计数（不做墙钟断言——CI 慢机墙钟不可靠）：
    // - getNodeState 只按已展开目录数调用（loading/error hint 判定），非 per-row
    // - overlay.get 每行至多 2 次（gitStatus 派生视图 + lineStats），总次数 ≤ 2×行数（线性上界）
    const countingOverlay = new CountingGetMap(store.getGitOverlay('s1'))
    const nodeStateSpy = vi.fn((s: string, p: string) => store.getNodeState(s, p))
    const rows = projectVisibleRows(
      (s) => store.getTree(s),
      (s) => store.getExpanded(s),
      (s) => (s === 's1' ? countingOverlay : store.getGitOverlay(s)),
      store.filterText,
      's1',
      nodeStateSpy,
    )

    expect(rows).toHaveLength(10002) // big + 10000 files + nested 行（nested 未展开仅目录行）
    // 只对已展开目录调用（1 个：'big'），不做 10002 次 per-row 状态读取
    expect(nodeStateSpy).toHaveBeenCalledTimes(1)
    // 行级 O(1)：2×行数 上界证明无 per-row 派生/前缀扫描（每行 gitStatus + lineStats 各一次）
    expect(countingOverlay.getCalls).toBeLessThanOrEqual(rows.length * 2)
  })

  it('getNodeState 只按需调用（展开目录数），不做 per-row 派生（替代旧每行 12 computed 的调用方式）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', buildBigTree(10000))
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.setNodeState('s1', 'big/nested', { status: 'loaded' })
    store.addExpanded('s1', 'big')
    store.addExpanded('s1', 'big/nested')

    const spy = vi.fn((s: string, p: string) => store.getNodeState(s, p))
    const rows = projectVisibleRows(...projectArgs(store, 's1', spy))
    expect(rows).toHaveLength(20002) // big + 10000 files + nested + 10000 files，全部展开
    // 只对 2 个已展开目录调用（loading/error hint 判定），不做 20002 次 per-row 状态读取
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('过滤态派生视图：匹配判定一次 O(节点数)，派生视图只含命中祖先链（旧递归语义）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', buildBigTree(10000))
    store.setNodeState('s1', 'big', { status: 'loaded' })
    store.setFilter('g5000') // 仅 big/nested/g5000.ts 命中

    // 未展开 → 顶层 big 祖先链保留（1 行，其余顶层节点被裁）
    expect(project(store).map((r) => r.path)).toEqual(['big'])

    // 展开 big（nested 未展开）→ 旧递归语义：顶层命中 → 整棵子树按展开态渲染（不裁中间层）
    store.addExpanded('s1', 'big')
    const rows = project(store)
    expect(rows).toHaveLength(10002) // big + 10000 files + nested

    // 展开 nested → 命中链全部可见（g0..g9999 与命中兄弟全部渲染——旧语义）
    store.addExpanded('s1', 'big/nested')
    const rows2 = project(store)
    expect(rows2).toHaveLength(20002) // 1 + 10000 + 1 + 10000

    // 无匹配 → 空派生视图
    store.setFilter('zzz_no_match')
    expect(project(store)).toHaveLength(0)
  })
})

describe('visibleRowKey 稳定性', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('节点行 key = path；hint 行 key 带类型前缀（跨派生视图稳定）', () => {
    expect(visibleRowKey({ path: 'a.ts', type: 'file', depth: 0 } as VisibleRow)).toBe('a.ts')
    expect(
      visibleRowKey({ path: 'src', type: 'dir', depth: 1, hint: 'loading' } as VisibleRow),
    ).toBe('hint:loading:src')
  })

  it('[W28 审查 Fix-3] 旧前缀形状的真实路径与 hint 行 key 不撞（hint: 分隔，Windows 禁冒号）', () => {
    // 真实文件路径以旧前缀 '__loading__' 开头（POSIX 合法文件名）vs loading hint 行——新格式隔离
    const realFile = visibleRowKey({ path: '__loading__src', type: 'file', depth: 0 } as VisibleRow)
    const loadingHint = visibleRowKey({ path: 'src', type: 'dir', depth: 1, hint: 'loading' } as VisibleRow)
    expect(realFile).toBe('__loading__src') // 节点行 key 恒为原 path，不带前缀
    expect(loadingHint).toBe('hint:loading:src')
    expect(realFile).not.toBe(loadingHint)

    // 三类 hint 前缀互斥：同 path 不同 hint 类型 key 各异
    const hintKeys = ['loading', 'error', 'empty'].map((h) =>
      visibleRowKey({ path: 'src', type: 'dir', depth: 1, hint: h as VisibleRow['hint'] } as VisibleRow),
    )
    expect(new Set(hintKeys).size).toBe(3)
  })
})

describe('projectVisibleRows 与 store 组合行为（懒加载/目录协议不破坏）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('未加载 children 的展开目录不产出子行（懒加载语义，ADR-0026 不变）', () => {
    const store = useFileTreeStore()
    // 顶层 dir 无 children（unloaded）
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.addExpanded('s1', 'src')
    const rows = project(store)
    expect(briefs(rows)).toEqual([{ path: 'src', depth: 0, kind: 'dir' }])
  })

  it('展开态拉取 children 后（setNodeState loaded + merge）→ 新行进入可见列表', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'loaded' }, [
      { path: 'src/a.ts', name: 'a.ts', type: 'file' },
    ])
    const rows = project(store)
    expect(briefs(rows)).toEqual([
      { path: 'src', depth: 0, kind: 'dir' },
      { path: 'src/a.ts', depth: 1, kind: 'file' },
    ])
  })

  it('clearSession 后派生视图空（分桶清理）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src'])
    expect(project(store)).not.toHaveLength(0)
    store.clearSession('s1')
    expect(project(store)).toHaveLength(0)
  })
})

describe('[W28 审查 Fix-2] E7-a 细粒度 getter 分桶（异 sid 更新不触发本 sid 派生视图重算）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('异 sid overlay 更新不重算本 sid 派生视图；同 sid 更新重算（split mode 多面板隔离）', () => {
    const store = useFileTreeStore()
    setupTree(store, ['src'])
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: 'A ', status: 'added' },
    ])

    // 模拟 FileView 的派生视图 computed（getter 传参形态）
    let recomputes = 0
    const rows = computed(() => {
      recomputes += 1
      return project(store, 's1')
    })
    void rows.value // 首次求值
    expect(recomputes).toBe(1)

    // 异 sid overlay 回写（split mode 另一面板的 git.status）→ 本 sid 派生视图缓存命中不重算
    store.setGitOverlay('s2', [{ path: 'other.ts', xyCode: ' M', status: 'modified' }])
    expect(rows.value).toBe(rows.value) // 同一数组引用（未 dirty）
    expect(recomputes).toBe(1)

    // 同 sid overlay 更新 → 重算一次（setGitOverlay keyed set 触发本 sid 分桶）
    store.setGitOverlay('s1', [
      { path: 'src/a.ts', xyCode: ' M', status: 'modified' },
      { path: 'src/utils/b.ts', xyCode: 'A ', status: 'added' },
      { path: 'src/empty/x.ts', xyCode: ' M', status: 'modified' },
    ])
    expect(rows.value).toBe(rows.value)
    expect(recomputes).toBe(2)
  })
})

describe('[W28 审查 Fix-7] 金标准用例（手写期望行序列，不经 reference 生成）', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('invalidated 展开目录仍渲染旧 children（hint 判定不吞 children）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [
      {
        path: 'src',
        name: 'src',
        type: 'dir',
        children: [{ path: 'src/a.ts', name: 'a.ts', type: 'file' }],
      },
    ])
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'invalidated' })
    // invalidated 不是 loading/error → 落到 children 分支，渲旧缓存子行（下次展开重发请求）
    expect(briefs(project(store))).toEqual([
      { path: 'src', depth: 0, kind: 'dir' },
      { path: 'src/a.ts', depth: 1, kind: 'file' },
    ])
  })

  it('loaded 但无 children 的展开目录：不产子行也不产 hint（懒加载盲区：加载完成但未 merge children）', () => {
    const store = useFileTreeStore()
    store.setTree('s1', [{ path: 'src', name: 'src', type: 'dir' }])
    store.addExpanded('s1', 'src')
    store.setNodeState('s1', 'src', { status: 'loaded' })
    expect(briefs(project(store))).toEqual([{ path: 'src', depth: 0, kind: 'dir' }])
  })
})
