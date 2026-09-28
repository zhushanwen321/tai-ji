// @vitest-environment node

/**
 * workflow store 单测 —— state / getters / actions 覆盖（9 组 describe / 38 用例）。
 *
 * 覆盖：
 * - records 初值空数组
 * - loadWorkflows 成功写入该 sid 分区；失败不覆盖现有分区、设 loadError（M1 契约）
 * - loadWorkflows 空结果守卫（连续空 strike 防误删 / RPC 失败重置 strike / oversize 降级保留旧分区）
 * - clearWorkflows 清空 records + 清 agentcall 映射；clearSession per-session 分区释放（ADR-0049）
 * - registerAgentCall / getAgentCallVirtualIdsByMain / clearAgentCallMapping agentcall 清理映射（U7 MUST_FIX 1）
 * - triggerWorkflowReload 信号驱动重拉 + 500ms 延迟重试 + W15 定时器防御性清理（去重 / $dispose）
 * - [W0/D4] 拉取收敛 10 用例：per-session in-flight 合并（并发失效共享一次拉取）+ 可再武装
 *   dirty 补拉（起步竞态 / 终态吞没 / 补拉在途窗口再武装 / 失败分支同样 drain）+ 簿记三点
 *   清理（clearSession / clearWorkflows / $dispose 完成后无幻影补拉——已删 session 的 dirty
 *   不复活）+ 两 sid 并发互不吞（per-session 键粒度）+ clearSession 补齐 reload timer 清理
 *   缺口（已删 session 的 500ms 重试不再触发）
 * - [P3/D6] agentCallElapsedMs 投影消费纯函数（每 ask 已执行时长）
 *
 * [HISTORICAL] overlay 相关用例（selectAgentCall/backFromAgentCall/isViewing/getViewingAgentCallId/
 * getActiveAgentCallVirtualId）已随 U7 overlay 移除删除。agent call 详情现走 drawer SubagentTab
 * （直接 getAgentCallHistory + setMessages + registerAgentCall），不经 store overlay 状态机。
 * [HISTORICAL] 2026-09-16 侧栏任务 tab 退役：sidebar 视图 2 用例（选中 runId / 读取当前
 * workflow / 返回列表三支）随 Agents/Flows tab 删除——同批删除的还有 store 的 per-panel
 * 选中状态与该三支读写函数（生产消费面全在退役面内）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/stores/workflow.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'
import { agentCallVirtualId } from '@taiji/shared'
import type { WorkflowRunRecord } from '@taiji/shared'

// mock sessionApi（loadWorkflows 内部调用）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
}))

// workflow store 经 @/api 门面导入 session（VITE_MOCK=true 下门面指向 mock），
// 需把门面的 session 也指回上面 mock 的 domains 命名空间，保证 store 与断言用的是同一个 vi.fn()。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

import * as sessionApi from '@taiji/core/transport/api/domains/session'

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

/**
 * 测试种数据：applyRecords 已从 store 导出面摘除（生产零直写场景），测试经分区 ref
 * 直写——不可变替换整 Map（与 partition.apply 等价）触发 shallowRef 响应性。
 */
function seedRecords(
  store: ReturnType<typeof useWorkflowStore>,
  sid: string,
  records: WorkflowRunRecord[],
): void {
  store.recordsBySession = new Map(store.recordsBySession).set(sid, records)
}

describe('workflow store', () => {
  it('初始状态：records 分区空', () => {
    const store = useWorkflowStore()
    expect(store.getRecordsBySession('sess-1')).toEqual([])
  })

  it('loadWorkflows 成功写入该 sid 分区', async () => {
    const records = [makeRecord(), makeRecord({ runId: 'wf-test-002' })]
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: records, oversize: false })

    const store = useWorkflowStore()
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(2)
  })

  it('loadWorkflows 失败时不覆盖现有分区', async () => {
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('rpc error'))

    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecord()])
    await store.loadWorkflows('sess-1')

    // M1 契约：失败不覆盖现有分区数据，设 loadError
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.loadErrorOf('sess-1')).toBe('rpc error')
  })

  it('clearWorkflows 清空所有分区 + 清 agentcall 映射', () => {
    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecord()])
    // 登记 agentcall 映射（U7 MUST_FIX 1）
    store.registerAgentCall('sess-1', agentCallVirtualId('ac-1'))
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toContain(agentCallVirtualId('ac-1'))

    store.clearWorkflows()

    expect(store.getRecordsBySession('sess-1')).toEqual([])
    expect(store.getAgentCallVirtualIdsByMain('sess-1')).toEqual([])
  })

  it('RD-3#12: clearWorkflows 补齐 loading/error/strike 三 facet（+ oversize），对齐 clearSession 全清', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = useWorkflowStore()
      seedRecords(store, 'sess-1', [makeRecord({ runId: 'wf-a' })])
      vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false })
      await store.loadWorkflows('sess-1') // strike 1/2：保留分区
      expect(store.getRecordsBySession('sess-1')).toHaveLength(1)

      seedRecords(store, 'sess-2', [makeRecord({ runId: 'wf-b' })])
      vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })
      await store.loadWorkflows('sess-2')
      expect(store.oversizeOf('sess-2')).toBe(true)

      vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('boom'))
      await store.loadWorkflows('sess-3')
      expect(store.loadErrorOf('sess-3')).toBe('boom')

      store.clearWorkflows()

      // 三 facet + oversize 全清（此前仅换 records Map，残留 loading/error/oversize/strike）
      expect(store.getRecordsBySession('sess-1')).toEqual([])
      expect(store.isLoadingOf('sess-1')).toBe(false)
      expect(store.loadErrorOf('sess-3')).toBeNull()
      expect(store.oversizeOf('sess-2')).toBe(false)

      // strike 簿记已清：重新预置后首次空结果从 strike 1 重新计（保留分区）——漏清则残留 1 直接 2/2 误删空
      seedRecords(store, 'sess-1', [makeRecord({ runId: 'wf-keep' })])
      vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false })
      await store.loadWorkflows('sess-1')
      expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty strike 1/2'), 'sess-1')
    } finally {
      warnSpy.mockRestore()
      errorSpy.mockRestore()
    }
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
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false })

    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecord({ runId: 'wf-keep' })])
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
    // 守卫不是错误态：不设 loadError（sid 必须与本用例一致，错 sid 走 ?? null 兜底恒真）
    expect(store.loadErrorOf('sess-1')).toBeNull()
  })

  it('RPC 失败（catch）→ strike 重置，不让连接故障累计出误清分区', async () => {
    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecord({ runId: 'wf-keep' })])

    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false }) // strike 1/2
    await store.loadWorkflows('sess-1')
    vi.mocked(sessionApi.getWorkflows).mockRejectedValue(new Error('network'))
    await store.loadWorkflows('sess-1') // catch → strike 重置
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false }) // 重新 strike 1/2，仍保留
    await store.loadWorkflows('sess-1')

    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-keep')
  })

  it('[RT-4#8] oversize=true：置降级标志 + 保留旧分区（不可用 ≠ 删空，不进 strike 守卫）', async () => {
    const store = useWorkflowStore()
    seedRecords(store, 'sess-1', [makeRecord({ runId: 'wf-keep' })])
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })

    await store.loadWorkflows('sess-1')
    await store.loadWorkflows('sess-1')
    expect(store.oversizeOf('sess-1')).toBe(true)
    expect(store.getRecordsBySession('sess-1')).toHaveLength(1)

    // 恢复正常：标志清除 + 正常覆盖
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecord({ runId: 'wf-new' })], oversize: false })
    await store.loadWorkflows('sess-1')
    expect(store.oversizeOf('sess-1')).toBe(false)
    expect(store.getRecordsBySession('sess-1')[0].runId).toBe('wf-new')

    // clearSession 释放 oversize 分区
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: true })
    await store.loadWorkflows('sess-1')
    store.clearSession('sess-1')
    expect(store.oversizeOf('sess-1')).toBe(false)
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
    seedRecords(store, 'session-1', [makeRecord({ runId: 'wf-a' })])
    seedRecords(store, 'session-2', [makeRecord({ runId: 'wf-b' })])

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
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [], oversize: false })

    // 预置非空分区 → strike 1/2：空结果保留
    seedRecords(store, 'session-1', [makeRecord({ runId: 'wf-keep' })])
    await store.loadWorkflows('session-1')
    expect(store.getRecordsBySession('session-1')).toHaveLength(1)

    // clearSession：分区 + strike 簿记一并清除
    store.clearSession('session-1')
    expect(store.getRecordsBySession('session-1')).toEqual([])

    // 重新预置非空分区 → 第 1 次空结果必须从 strike 1 重新计（保留分区）。
    // 残留计数场景（clearSession 漏删）此步为 strike 2/2 → 分区被清 → 断言红
    seedRecords(store, 'session-1', [makeRecord({ runId: 'wf-keep-2' })])
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
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecord()], oversize: false })
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
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecord()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'done')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('同 sid 连续 running 信号去重：只保留最后一次重试 timer', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecord()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(600)
    // 2 次立即拉取 + 1 次去重后的延迟重试（旧 timer 被 clearTimeout）
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
  })

  it('W15 兜底：store $dispose → 在途重试 timer 被清，不再触发 loadWorkflows', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecord()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 作用域销毁（HMR / store dispose）→ 定时器防御性清理
    store.$dispose()
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('[W0/D4] clearSession 补齐 reload timer 清理缺口：已删 session 的 500ms 重试不再触发', async () => {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [makeRecord()], oversize: false })
    const store = useWorkflowStore()

    store.triggerWorkflowReload('session-1', 'running')
    await vi.advanceTimersByTimeAsync(0)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // 原实现 timer 只在 clearWorkflows/onScopeDispose 清——clearSession 后重试照发（既有缺口）
    store.clearSession('session-1')
    await vi.advanceTimersByTimeAsync(600)
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })
})

// ── [W0/D4] 拉取收敛：per-session in-flight 合并 + 可再武装 dirty 补拉 ──
// 设计锚点 workflow-step-visibility-data-source D4：renderer 信号一次性不可重放，
// 只合并不补拉会丢更新（起步竞态 / 终态吞没两个真实交织）；封顶版 dirty（只补一次）
// 会在补拉在途窗口复刻终态吞没，dirty 必须可再武装。RPC 用手动放行的 deferred 队列
// 精确控制在途窗口；队列空时同步抛错——幻影补拉经 loadError 可观测（非挂起等超时）。

describe('workflow store — [W0/D4] 拉取收敛（in-flight 合并 + dirty 补拉）', () => {
  interface WorkflowsResult {
    workflows: WorkflowRunRecord[]
    oversize: boolean
  }
  interface DeferredRpc {
    promise: Promise<WorkflowsResult>
    resolve: (v: WorkflowsResult) => void
    reject: (e: unknown) => void
  }

  const rpcQueue: DeferredRpc[] = []

  /** 入队一次受控 RPC（手动 resolve/reject 控制放行时序）；出队按调用序（FIFO） */
  function enqueueRpc(): DeferredRpc {
    let resolve!: (v: WorkflowsResult) => void
    let reject!: (e: unknown) => void
    const promise = new Promise<WorkflowsResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const deferred: DeferredRpc = { promise, resolve, reject }
    rpcQueue.push(deferred)
    return deferred
  }

  /** 排空微任务链（resolve 后 drain/补拉起 RPC 都在微任务里，断言调用计数前先排空） */

  beforeEach(() => {
    rpcQueue.length = 0
    vi.mocked(sessionApi.getWorkflows).mockImplementation(() => {
      const next = rpcQueue.shift()
      if (!next) throw new Error('unexpected extra getWorkflows RPC (rpcQueue empty)')
      return next.promise
    })
  })

  /** 排空微任务链（resolve 后 drain/补拉起 RPC 都在微任务里，断言调用计数前先排空） */
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
  }

  it('并发失效共享一次拉取：在途期间的新调用不另起 RPC、返回同一 promise；合并的 dirty 收敛为一次补拉', async () => {
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    // 在途窗口内两次新调用（并发失效）：共享在途拉取，不另起 RPC（pinia 对 async action
    // 的返回值包一层 then，promise 对象身份断言不可用——以「不另起 RPC + 双方都收敛到
    // 补拉后终态」为可观测契约）
    const second = store.loadWorkflows('s1')
    const third = store.loadWorkflows('s1')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(store.isLoadingOf('s1')).toBe(true)

    // 在途完成 → 两次合并信号收敛为一次补拉（3 信号 ≤ 2 次 RPC；无收敛则 3 次）
    d1.resolve({ workflows: [], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    d2.resolve({ workflows: [makeRecord()], oversize: false })
    await Promise.all([first, second, third])
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    expect(store.getRecordsBySession('s1')).toHaveLength(1)
  })

  it('起步竞态：run-created 拉取在途期间 record 落盘 → 空结果不滞留（补拉拾起新落盘数据）', async () => {
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const store = useWorkflowStore()
    // 第一次拉取（run-created 信号）在途——此刻返回空（record 尚未落盘）
    const created = store.loadWorkflows('s1')
    // record 落盘 → 新信号在途窗口内到达（合并置 dirty）
    const settled = store.loadWorkflows('s1')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)

    // stale 空结果完成 → dirty 补拉拾起已落盘的 record（无补拉则「run 在、0 步骤」空壳滞留）
    d1.resolve({ workflows: [], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    d2.resolve({ workflows: [makeRecord({ runId: 'wf-blind' })], oversize: false })
    await Promise.all([created, settled])
    expect(store.getRecordsBySession('s1')[0]?.runId).toBe('wf-blind')
  })

  it('终态吞没：最后终态信号合并进 stale 在途拉取 → 补拉送达终态（步骤不永久 running）', async () => {
    const staleRecord = makeRecord({
      runId: 'wf-term',
      status: 'running',
      agentCalls: [{ id: 0, agent: 'reviewer-1', status: 'running', phase: 'Review', sessionId: 'acs-1' }],
    })
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    // 最后一条终态信号在 stale 拉取在途窗口到达（合并进 stale 拉取——无 dirty 补拉则永久丢失）
    const terminal = store.loadWorkflows('s1')

    d1.resolve({ workflows: [staleRecord], oversize: false })
    d2.resolve({
      workflows: [
        makeRecord({
          runId: 'wf-term',
          status: 'done',
          reason: 'completed',
          agentCalls: [{ id: 0, agent: 'reviewer-1', status: 'completed', phase: 'Review', sessionId: 'acs-1' }],
        }),
      ],
      oversize: false,
    })
    await Promise.all([first, terminal])
    const final = store.getRecordsBySession('s1')[0]
    expect(final?.status).toBe('done')
    expect(final?.agentCalls[0]?.status).toBe('completed')
  })

  it('补拉在途窗口到达终态信号：dirty 可再武装（补拉的补拉），最终状态正确', async () => {
    const d1 = enqueueRpc()
    const d2 = enqueueRpc()
    const d3 = enqueueRpc()
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    // 信号 A：stale 在途窗口内到达 → dirty
    store.loadWorkflows('s1')
    d1.resolve({ workflows: [makeRecord({ runId: 'wf-r' })], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2) // 补拉 B 已起（在途）

    // 信号 C：补拉 B 在途窗口内到达 → 再置 dirty（可再武装语义的验证点；封顶版此处丢信号）
    store.loadWorkflows('s1')
    d2.resolve({ workflows: [makeRecord({ runId: 'wf-r', status: 'running' })], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3) // B 完成后 drain 判 dirty → 补拉 C
    d3.resolve({ workflows: [makeRecord({ runId: 'wf-r', status: 'done', reason: 'completed' })], oversize: false })
    await first
    expect(store.getRecordsBySession('s1')[0]?.status).toBe('done')
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
  })

  it('失败分支同样 drain：在途拉取失败不阻断 dirty 补拉（后续信号驱动的补拉照常送达）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const d1 = enqueueRpc()
      const d2 = enqueueRpc()
      const store = useWorkflowStore()
      const first = store.loadWorkflows('s1')
      const retry = store.loadWorkflows('s1') // 在途窗口内新信号 → dirty

      d1.reject(new Error('rpc down'))
      await flushMicrotasks()
      expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2) // 失败后 dirty 补拉照常起
      d2.resolve({ workflows: [makeRecord({ runId: 'wf-after-fail' })], oversize: false })
      await Promise.all([first, retry])
      expect(store.getRecordsBySession('s1')[0]?.runId).toBe('wf-after-fail')
      expect(store.loadErrorOf('s1')).toBeNull() // 补拉成功清错误
    } finally {
      errorSpy.mockRestore()
    }
  })
})

// ── [W0/D4] 三点簿记清理（clearWorkflows / clearSession / $dispose）无幻影补拉 ──

describe('workflow store — [W0/D4] 拉取收敛簿记三点清理（已删 session 的 dirty 不复活）', () => {
  interface WorkflowsResult {
    workflows: WorkflowRunRecord[]
    oversize: boolean
  }
  interface DeferredRpc {
    promise: Promise<WorkflowsResult>
    resolve: (v: WorkflowsResult) => void
  }

  /** 按 sid 路由的 RPC 队列（多 sid 并发用例的出队按会话键匹配，不受调用序干扰） */
  const rpcQueues = new Map<string, DeferredRpc[]>()

  function enqueueRpc(sid: string): DeferredRpc {
    let resolve!: (v: WorkflowsResult) => void
    const promise = new Promise<WorkflowsResult>((res) => {
      resolve = res
    })
    const deferred: DeferredRpc = { promise, resolve }
    const queue = rpcQueues.get(sid) ?? []
    queue.push(deferred)
    rpcQueues.set(sid, queue)
    return deferred
  }

  beforeEach(() => {
    rpcQueues.clear()
    vi.mocked(sessionApi.getWorkflows).mockImplementation((sid: string) => {
      const next = rpcQueues.get(sid)?.shift()
      if (!next) throw new Error(`unexpected extra getWorkflows RPC for ${sid} (rpcQueue empty)`)
      return next.promise
    })
  })

  /** 排空微任务链（同前述 describe：断言调用计数前先排空 resolve 后的微任务） */
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0))
  }

  it('clearSession：在途 + dirty 随分区释放，完成后无补拉（已删 session 的 dirty 不复活）', async () => {
    const d1 = enqueueRpc('s1')
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    store.loadWorkflows('s1') // 在途窗口内信号 → dirty 置位
    store.clearSession('s1')

    d1.resolve({ workflows: [makeRecord()], oversize: false })
    await first
    // 无补拉：RPC 恒 1 次；幻影补拉会打到空队列（同步抛错 → loadError 分区可观测）
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(store.loadErrorOf('s1')).toBeNull()
    expect(store.isLoadingOf('s1')).toBe(false)
  })

  it('clearWorkflows：全表簿记清理，在途完成无补拉', async () => {
    const d1 = enqueueRpc('s1')
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    store.loadWorkflows('s1')
    store.clearWorkflows()

    d1.resolve({ workflows: [makeRecord()], oversize: false })
    await first
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
    expect(store.loadErrorOf('s1')).toBeNull()
  })

  it('onScopeDispose（$dispose）：簿记清理，在途完成无补拉（HMR / store dispose）', async () => {
    const d1 = enqueueRpc('s1')
    const store = useWorkflowStore()
    const first = store.loadWorkflows('s1')
    store.loadWorkflows('s1')
    store.$dispose()

    d1.resolve({ workflows: [makeRecord()], oversize: false })
    await first
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(1)
  })

  it('per-session 键粒度：两 sid 并发拉取互不吞——各自在途、dirty 不跨 session 触发补拉', async () => {
    const dA1 = enqueueRpc('sa')
    const dA2 = enqueueRpc('sa')
    const dB1 = enqueueRpc('sb')
    const store = useWorkflowStore()
    const loadA = store.loadWorkflows('sa')
    const loadB = store.loadWorkflows('sb')
    // 全局单例键会在此合并成一次 RPC（sb 吞进 sa 的在途）——per-session 键各自在途
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(2)
    expect(sessionApi.getWorkflows).toHaveBeenNthCalledWith(1, 'sa')
    expect(sessionApi.getWorkflows).toHaveBeenNthCalledWith(2, 'sb')

    // sa 在途窗口内信号 → 仅 sa 置 dirty
    store.loadWorkflows('sa')
    // sa 完成 → 仅 sa 补拉（第 3 次 RPC）；sb 无 dirty → resolve 后无补拉
    dA1.resolve({ workflows: [makeRecord({ runId: 'wf-a1' })], oversize: false })
    await flushMicrotasks()
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
    dA2.resolve({ workflows: [makeRecord({ runId: 'wf-a2' })], oversize: false })
    dB1.resolve({ workflows: [makeRecord({ runId: 'wf-b1' })], oversize: false })
    await Promise.all([loadA, loadB])
    expect(sessionApi.getWorkflows).toHaveBeenCalledTimes(3)
    expect(store.getRecordsBySession('sa')[0]?.runId).toBe('wf-a2')
    expect(store.getRecordsBySession('sb')[0]?.runId).toBe('wf-b1')
  })
})

// ── [P3/D6] progress 投影消费纯函数（drawer/tray 共用推导单点）──

import { agentCallElapsedMs } from '@/stores/workflow'
import type { WorkflowAgentCall } from '@taiji/shared'

const NOW = 1_000_000_000_000

describe('workflow store — [P3/D6] agentCallElapsedMs（每 ask 已执行时长槽）', () => {
  const startedIso = new Date(NOW - 30_000).toISOString()

  function callWith(overrides: Partial<WorkflowAgentCall>): WorkflowAgentCall {
    return { id: 0, agent: 'dev', status: 'running', startedAt: startedIso, ...overrides }
  }

  it('running + 可解析 startedAt → now - startedAt；负差钳 0', () => {
    expect(agentCallElapsedMs(callWith({}), NOW)).toBe(30_000)
    expect(agentCallElapsedMs(callWith({ startedAt: new Date(NOW + 5000).toISOString() }), NOW)).toBe(0)
  })

  it('非 running / 缺 startedAt / 坏时间串 → null（槽省略——旧快照缺省渲染路径）', () => {
    expect(agentCallElapsedMs(callWith({ status: 'done' }), NOW)).toBeNull()
    expect(agentCallElapsedMs(callWith({ startedAt: undefined }), NOW)).toBeNull()
    expect(agentCallElapsedMs(callWith({ startedAt: 'garbage' }), NOW)).toBeNull()
  })
})
