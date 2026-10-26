// @vitest-environment node
/**
 * stores 单文件多源合并（round5-d 分区 4 簇 4-11 的 node 环境子集）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——本簇 4 个 node 环境文件共同装载
 * vue / shared / extension-protocol / zh-CN locale / core chat domain 等重模块，
 * 单文件共享一份装载；拆文件会让每个文件各付一次全树装载（每份秒级 CPU）。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动；四文件全零 vi.mock）：
 *  - extension-ui.test.ts（extension-ui store pending SSOT，主体）
 *  - session-store-state.test.ts（applySnapshot + markDead/revive）
 *  - preset-store.test.ts（preset 纯状态容器）
 *  - extension-ui-schedule-create.test.ts（form 键判定 legacy scheduler 表单）
 *
 * 冲突处理（试点模式）：
 *  - 四文件顶层 beforeEach（全部同为 setActivePinia(createPinia()) 幂等重置）
 *    合并为文件级公共 hook 一份
 *  - extension-ui-schedule-create 的 makeForm/makeDialog 与主体同名异签名
 *    （前者 string 参数、后者 overrides 对象参数），按节重命名局部副本为
 *    makeSchedForm/makeSchedDialog（仅函数名，用例名与断言零改动）
 *
 * 环境注：同簇的 chat-occupancy-phase.test.ts 与 sidebar-store.test.ts 为
 * happy-dom（默认）环境，与 node 异类，不并入（保持原文件原样）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/extension-ui.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useExtensionUIStore } from '@/stores/extension-ui'
import { useSessionStore } from '@/stores/session'
import { usePresetStore } from '@/stores/preset'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import type { SessionGroup, PiLaunchPreset } from '@taiji/shared'

// 公共 hook（四源文件顶层 beforeEach 的幂等并集，全同构）
beforeEach(() => {
  setActivePinia(createPinia())
})

// ══════════ 主体：原 extension-ui.test.ts 全部 ══════════

/** 构造测试 ExtensionUIRequest（默认统一表单请求——form 键，D5 收敛判定键） */
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
    store.addRequest('sess-B', makeDialog({ sessionId: 'sess-B', requestId: 'r2', dialogKind: 'confirm' }))

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
  it('初值：presets=[]、defaultPresetId=""', () => {
    const store = usePresetStore()
    expect(store.presets).toEqual([])
    expect(store.defaultPresetId).toBe('')
  })
})

describe('preset store setPresets（TC-3）', () => {
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
