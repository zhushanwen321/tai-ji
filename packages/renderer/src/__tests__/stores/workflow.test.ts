/**
 * workflow store 单测 —— state / getters / actions 覆盖。
 *
 * 覆盖：
 * - records 初值空数组 + workflowCount
 * - loadWorkflows 成功写入 records + 失败清空
 * - clearWorkflows 清空 records + 退出侧边栏视图 2 + 清 agentcall 映射
 * - selectWorkflow / getViewingRunId / getCurrentWorkflow 视图 2（sidebar 内，非 overlay）
 * - backToWorkflowList 退出视图 2
 * - registerAgentCall / getAgentCallVirtualIdsByMain / clearAgentCallMapping agentcall 清理映射（U7 MUST_FIX 1）
 *
 * [HISTORICAL] overlay 相关用例（selectAgentCall/backFromAgentCall/isViewing/getViewingAgentCallId/
 * getActiveAgentCallVirtualId）已随 U7 overlay 移除删除。agent call 详情现走 drawer SubagentTab
 * （直接 getAgentCallHistory + setMessages + registerAgentCall），不经 store overlay 状态机。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/workflow.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import { agentCallVirtualId } from '@xyz-agent/shared'
import type { WorkflowRunRecord } from '@xyz-agent/shared'

// mock sessionApi（loadWorkflows 内部调用）
vi.mock('@xyz-agent/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
}))

// workflow store 经 @/api 门面导入 session（VITE_MOCK=true 下门面指向 mock），
// 需把门面的 session 也指回上面 mock 的 domains 命名空间，保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@xyz-agent/core/transport/api/domains/session')
  return { ...actual, session }
})

import * as sessionApi from '@xyz-agent/core/transport/api/domains/session'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

/** 构造测试 WorkflowRunRecord */
function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
  return {
    runId: 'wf-test-001',
    scriptName: 'test-flow',
    status: 'done',
    reason: 'completed',
    startedAt: '2026-07-10T10:00:00Z',
    completedAt: '2026-07-10T10:30:00Z',
    usedTokens: 50000,
    totalCallCount: 2,
    agentCalls: [
      { id: 0, agent: 'dev-W1', status: 'completed', phase: 'Dev', sessionId: 'sess-001' },
      { id: 1, agent: 'dev-W2', status: 'completed', phase: 'Dev', sessionId: 'sess-002' },
    ],
    stateFilePath: '/data/wf-test-001.jsonl',
    ...overrides,
  }
}

describe('workflow store', () => {
  it('初始状态：records 分区空 + workflowCount=0', () => {
    const store = useWorkflowStore()
    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.workflowCount('sess-1')).toBe(0)
  })

  it('loadWorkflows 成功写入该 sid 分区', async () => {
    const records = [makeRecord(), makeRecord({ runId: 'wf-test-002' })]
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue(records)

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(2)
    expect(store.workflowCount('sess-1')).toBe(2)
  })

  it('loadWorkflows 失败时不覆盖现有分区', async () => {
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('rpc error'))

    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord()])
    await store.loadWorkflows('sess-1')

    // M1 契约：失败不覆盖现有分区数据，设 loadError
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.loadError).toBe('rpc error')
  })

  it('clearWorkflows 清空所有分区 + 退出侧边栏视图 2 + 清 agentcall 映射', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')
    // 登记 agentcall 映射（U7 MUST_FIX 1）
    store.registerAgentCall('sess-1', agentCallVirtualId('ac-1'))
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toContain(agentCallVirtualId('ac-1'))

    store.clearWorkflows()

    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.getViewingRunId('panel-1')).toBeNull()
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toEqual([])
  })

  it('selectWorkflow + getViewingRunId + getCurrentWorkflow 视图 2（sidebar 内，非 overlay）', () => {
    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-001', scriptName: 'my-flow' })])

    store.selectWorkflow('panel-1', 'wf-001')

    expect(store.getViewingRunId('panel-1')).toBe('wf-001')
    expect(store.getCurrentWorkflow('panel-1', 'sess-1')?.scriptName).toBe('my-flow')
  })

  it('backToWorkflowList 退出视图 2', () => {
    const store = useWorkflowStore()
    store.selectWorkflow('panel-1', 'wf-001')
    expect(store.getViewingRunId('panel-1')).toBe('wf-001')

    store.backToWorkflowList('panel-1')

    expect(store.getViewingRunId('panel-1')).toBeNull()
  })
})

// ── 空结果守卫接线冒烟（R7 归一）：strike 机制全部行为（阈值计数 / 非空打断重置 /
// reset 清零 / 分区空放行 / warn 文案结构）直测锁定在
// __tests__/lib/partitioned-session-records.test.ts（守卫工厂单源，S4 A1；不 import store，无环）。
// 此处只证明守卫经本 store 接线真实可达：strike 放行路径 + catch 重置路径；
// clearSession 联动见下方 clearSession describe 的簿记用例。
// 背景（sidebar-sync-plan P1 + R1 business-logic S3）：runtime getWorkflows 读盘失败时
// catch 降级返回 []，连续 2 次空才判真实删空覆盖分区，瞬时读失败不得清掉分区历史。

describe('workflow store — loadWorkflows 空结果守卫（接线冒烟）', () => {
  let warnSpy: MockInstance

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('连续第 2 次 RPC 空 → 判真实删空，清分区（strike 1/2 保留 → 2/2 放行全程经 store 可达 + 接线 tag）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])

    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-keep' })])
    await store.loadWorkflows('sess-1') // strike 1/2：保留
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    // 接线参数：warn 前缀含 store 传入的 logTag + fetchLabel（文案结构归共享直测）
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[workflow-store] getWorkflows returned empty list'),
      'sess-1',
    )
    await store.loadWorkflows('sess-1') // strike 2/2：真实删空判定，放行覆盖
    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('clearing partition'),
      'sess-1',
    )
    // 守卫不是错误态：不设 loadError
    expect(store.loadError).toBeNull()
  })

  it('RPC 失败（catch）→ strike 重置，不让连接故障累计出误清分区', async () => {
    const store = useWorkflowStore()
    store.applyRecords('sess-1', [makeRecord({ runId: 'wf-keep' })])

    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([]) // strike 1/2
    await store.loadWorkflows('sess-1')
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('network'))
    await store.loadWorkflows('sess-1') // catch → strike 重置
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([]) // 重新 strike 1/2，仍保留
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-keep')
  })
})

// ── U7 MUST_FIX 1: agentcall 清理映射（deleteSession 清 agentcall 虚拟 key 唯一通路）──

describe('U7 MUST_FIX 1: agentcall 虚拟 key 清理映射', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('registerAgentCall 登记 virtualId，getAgentCallVirtualIdsByMain 反查', () => {
    const store = useWorkflowStore()
    const vid = agentCallVirtualId('ac-sess-1')

    store.registerAgentCall('main-1', vid)

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([vid])
  })

  it('同一 mainSession 多个 agentcall virtualId 都登记', () => {
    const store = useWorkflowStore()
    const vid1 = agentCallVirtualId('ac-1')
    const vid2 = agentCallVirtualId('ac-2')

    store.registerAgentCall('main-1', vid1)
    store.registerAgentCall('main-1', vid2)

    expect(store.getAgentCallVirtualIdsByMain('main-1').sort()).toEqual([vid1, vid2].sort())
  })

  it('不同 mainSession 独立分区，互不干扰', () => {
    const store = useWorkflowStore()
    store.registerAgentCall('main-1', agentCallVirtualId('ac-1'))
    store.registerAgentCall('main-2', agentCallVirtualId('ac-2'))

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([agentCallVirtualId('ac-1')])
    expect(store.getAgentCallVirtualIdsByMain('main-2')).toEqual([agentCallVirtualId('ac-2')])
  })

  it('clearAgentCallMapping 清指定 mainSession 的映射（deleteSession 路径）', () => {
    const store = useWorkflowStore()
    store.registerAgentCall('main-1', agentCallVirtualId('ac-1'))
    store.registerAgentCall('main-2', agentCallVirtualId('ac-2'))

    store.clearAgentCallMapping('main-1')

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([])
    // main-2 不受影响
    expect(store.getAgentCallVirtualIdsByMain('main-2')).toHaveLength(1)
  })

  it('registerAgentCall 幂等：同 virtualId 重复登记不重复', () => {
    const store = useWorkflowStore()
    const vid = agentCallVirtualId('ac-1')

    store.registerAgentCall('main-1', vid)
    store.registerAgentCall('main-1', vid)

    expect(store.getAgentCallVirtualIdsByMain('main-1')).toEqual([vid])
  })

  it('未登记的 mainSession 反查返回空数组（deleteSession 安全 no-op）', () => {
    const store = useWorkflowStore()
    expect(store.getAgentCallVirtualIdsByMain('never')).toEqual([])
    // 清不存在的映射不抛错
    expect(() => store.clearAgentCallMapping('never')).not.toThrow()
  })
})

// ── clearSession per-session 分区释放 + W15 定时器防御性清理（fake timers）──

describe('workflow store — clearSession（per-session 分区释放，ADR-0049 AC-8）', () => {
  it('清除指定 sid 分区，不影响其他 sid', () => {
    const store = useWorkflowStore()
    store.applyRecords('session-1', [makeRecord({ runId: 'wf-a' })])
    store.applyRecords('session-2', [makeRecord({ runId: 'wf-b' })])

    store.clearSession('session-1')

    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(store.getRecordsBySession('session-2')).toHaveLength(1)
  })

  it('清除不存在的 sid 分区是 no-op（不抛错）', () => {
    const store = useWorkflowStore()
    expect(() => store.clearSession('never')).not.toThrow()
  })

  it('strike 簿记随分区清除：clearSession 后重新预置分区，strike 从 0 重新计（不残留旧计数）', async () => {
    // R3 test-coverage S1 强化 + R7 接线冒烟：reset 语义（清零后重新计数）归共享直测
    // （partitioned-session-records.test.ts），此处锁 clearSession 接线确实调了 reset——
    // 若 clearSession 漏调 strikeGuard.reset，残留计数 1 会让下一次空结果直接
    // strike 2/2 误判删空 → 分区保留断言红。
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useWorkflowStore()
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([])

    // 预置非空分区 → strike 1/2：空结果保留
    store.applyRecords('session-1', [makeRecord({ runId: 'wf-keep' })])
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)

    // clearSession：分区 + strike 簿记一并清除
    store.clearSession('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])

    // 重新预置非空分区 → 第 1 次空结果必须从 strike 1 重新计（保留分区）。
    // 残留计数场景（clearSession 漏删）此步为 strike 2/2 → 分区被清 → 断言红
    store.applyRecords('session-1', [makeRecord({ runId: 'wf-keep-2' })])
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)
    expect(store.getRecordsBySession('session-1')[0].runId).toBe('wf-keep-2')
    // warn 明示 strike 1/2（从 0 重新计数的直接证据，而非残留的 2/2）
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty strike 1/2'), 'session-1')

    // 再 1 次空 → strike 2/2 判真实删空放行（重新计数的完整语义闭环）
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('clearing partition'), 'session-1')
    warnSpy.mockRestore()
  })
})

describe('workflow store — triggerWorkflowReload / W15 定时器防御性清理', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('running 信号：立即拉一次 + 500ms 延迟重试一次（workflow-state-link 延迟 flush 兜底）', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    // 立即拉取（微任务 flush）
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 延迟重试在 RUNNING_RETRY_MS=500 后触发
    await vi.advanceTimersByTimeAsync(500)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    expect(sessionApi.getWorkflows).toHaveBeenNthCalledWith(2, 'session-1')
  })

  it('非 running 信号：只立即拉一次，不安排延迟重试', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'done')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('同 sid 连续 running 信号去重：只保留最后一次重试 timer', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    // 2 次立即拉取 + 1 次去重后的延迟重试（旧 timer 被 clearTimeout）
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
  })

  it('W15 兜底：store $dispose → 在途重试 timer 被清，不再触发 loadWorkflows', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue([makeRecord()])
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 作用域销毁（HMR / store dispose）→ 定时器防御性清理
    store.$dispose()
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })
})
