/**
 * workflowStore 事件流缓存扩展测试（workflow-visualization U5——D11 生命周期五条逐条）。
 *
 * 覆盖：
 * - loadWorkflowRunEvents 成功写入 runId 分区（ready + events）；在途合并（runEventsInflight
 *   原语承载——C-data-18 组装，force 在途窗口到达同样并入不另起 RPC）
 * - ready 缓存复用（非 force 不重发 RPC）/ force 覆盖重拉（信号触发 / 重试按钮语义）
 * - 错误二分数据形态：record_not_found 结构化回执（errorCode）/ RPC 通道错误（errorMessage）；
 *   error 态非 force 不自动重拉（重试是用户显式动作）
 * - D11① 在途丢弃检查：settle 时活跃锚已切走/已清 → 结果丢弃不写缓存
 * - D11② overlay 关闭不清缓存（重开秒显）；LRU 上界 5（最旧非活跃驱逐、活跃 run 豁免）
 * - D11⑤ clearSession 清该 session 名下 run 缓存 + 活跃锚 + 在途去重簿记；其他 session 分区保留
 * - clearWorkflows 全清
 * - triggerWorkflowReload 活跃 run 联动 force 事件流重拉（§3.1-4 信号接线；非活跃不触发）
 *
 * 运行：cd packages/renderer && npx vitest run src/components/panel/workflow-viz/__tests__/workflow-store-run-events.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkflowStore } from '@/stores/workflow'

// mock sessionApi（store 内部调用；getWorkflowRunEvents = 本扩展的消费面）
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  getWorkflows: vi.fn(),
  getWorkflowRunEvents: vi.fn(),
}))

// workflow store 经 @/api 门面导入 session（VITE_MOCK=true 下门面指向 mock），
// 需把门面的 session 也指回上面 mock 的 domains 命名空间（同 workflow.test.ts 先例）。
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

import * as sessionApi from '@taiji/core/transport/api/domains/session'

const mockGetRunEvents = vi.mocked(sessionApi.getWorkflowRunEvents)

const SID = 's-main'
const RUN_A = 'wf-run-a'
const RUN_B = 'wf-run-b'

/** 事件流 reply 样本（骨架两行形态；截断标注语义归 gantt-segments 测试面） */
function eventsReply(runId: string): { runId: string; events: Array<{ type: string; ts: number }> } {
  return {
    runId,
    events: [
      { type: 'run-created', ts: 1000 },
      { type: 'run-settled', ts: 2000 },
    ],
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mockGetRunEvents.mockResolvedValue(eventsReply(RUN_A))
})

describe('workflowStore 事件流缓存：拉取与缓存复用', () => {
  it('成功拉取写入 runId 分区（ready + events），缓存条目携带归属 session', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    const entry = store.runEventsOf(RUN_A)
    expect(entry?.status).toBe('ready')
    expect(entry?.sessionId).toBe(SID)
    expect(entry?.events).toHaveLength(2)
    expect(mockGetRunEvents).toHaveBeenCalledWith(SID, RUN_A)
  })

  it('ready 缓存复用：非 force 重复调用不重发 RPC（D11② 重开秒显）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
  })

  it('force 覆盖 ready 缓存重拉（workflowUpdate 信号 / 重试按钮语义）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A, { force: true })
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
  })

  it('loading 在途合并：在途期间的重复调用不另起 RPC', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const first = store.loadWorkflowRunEvents(SID, RUN_A)
    const second = store.loadWorkflowRunEvents(SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
    resolveRpc(eventsReply(RUN_A))
    await Promise.all([first, second])
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('force 调用在途窗口内到达：并入在途拉取不另起 RPC（去重由 runEventsInflight 承载，缓存条目三态不兼任）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const first = store.loadWorkflowRunEvents(SID, RUN_A)
    // 信号触发的 force 重拉在首拉在途窗口到达——同 runId 仅首次发起，复用者共享 promise
    const forced = store.loadWorkflowRunEvents(SID, RUN_A, { force: true })
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
    resolveRpc(eventsReply(RUN_A))
    await Promise.all([first, forced])
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('空 sid / runId 守卫：不发起 RPC 不写分区', async () => {
    const store = useWorkflowStore()
    await store.loadWorkflowRunEvents('', RUN_A)
    await store.loadWorkflowRunEvents(SID, '')
    expect(mockGetRunEvents).not.toHaveBeenCalled()
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
  })
})

describe('workflowStore 事件流缓存：错误二分数据形态', () => {
  it('record_not_found 结构化回执 → status error + errorCode（静态指引数据源）', async () => {
    mockGetRunEvents.mockResolvedValue({ runId: RUN_A, code: 'record_not_found', message: '无记录' })
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(store.runEventsOf(RUN_A)).toMatchObject({ status: 'error', errorCode: 'record_not_found' })
  })

  it('RPC 通道错误（reject）→ status error + errorMessage（重试按钮数据源）', async () => {
    mockGetRunEvents.mockRejectedValue(new Error('transport down'))
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(store.runEventsOf(RUN_A)).toMatchObject({ status: 'error', errorMessage: 'transport down' })
    expect(store.runEventsOf(RUN_A)?.errorCode).toBeUndefined()
  })

  it('error 态非 force 不自动重拉（重试 = 用户显式 force）', async () => {
    mockGetRunEvents.mockResolvedValue({ runId: RUN_A, code: 'record_not_found', message: '无记录' })
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
  })
})

describe('workflowStore 事件流缓存：D11① 在途丢弃检查', () => {
  it('settle 时活跃锚已切走（切换 run）→ 结果丢弃、loading 占位撤除（防幻影 loading）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const pending = store.loadWorkflowRunEvents(SID, RUN_A)
    // overlay 切换到 run B
    store.setActiveWorkflowRun(SID, RUN_B)
    resolveRpc(eventsReply(RUN_A))
    await pending
    // 丢弃 = loading 占位一并撤除——残留 loading 会被后续调用的在途合并误判为在途而
    // no-op（重开该 run 永远加载中的幻影 loading）
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
    // 丢弃后重开（活跃锚切回）可正常重新拉取写入
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
  })

  it('settle 时活跃锚已清（overlay 关闭）→ 结果丢弃不写缓存', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    let rejectRpc!: (e: Error) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((_, reject) => (rejectRpc = reject)))
    const pending = store.loadWorkflowRunEvents(SID, RUN_A)
    store.releaseActiveWorkflowRun(SID, RUN_A)
    rejectRpc(new Error('late failure'))
    await pending
    expect(store.runEventsOf(RUN_A)).toBeUndefined() // 丢弃 = 条目不出现（loading 占位撤除）
  })
})

describe('workflowStore 事件流缓存：D11② LRU 与关闭不清', () => {
  it('overlay 关闭（活跃锚清）后缓存保留——重开秒显', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    store.releaseActiveWorkflowRun(SID, RUN_A)
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('releaseActiveWorkflowRun 条件释放：锚已切走时不误清新 run 的锚', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    store.setActiveWorkflowRun(SID, RUN_B) // 切换（新面板登记）
    store.releaseActiveWorkflowRun(SID, RUN_A) // 旧面板晚到的卸载清理
    // 锚未被误清：后续 loadWorkflowRunEvents 丢弃检查仍以 RUN_B 为活跃
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const pending = store.loadWorkflowRunEvents(SID, RUN_B)
    resolveRpc(eventsReply(RUN_B))
    await pending
    expect(store.runEventsOf(RUN_B)?.status).toBe('ready') // 锚在 → 结果未被丢弃
  })

  it('LRU 上界 5：写入第 6 个 run 驱逐最旧非活跃者', async () => {
    const store = useWorkflowStore()
    // 模拟真实打开路径：逐个切换活跃 run 后拉取（非活跃 run 的拉取结果被 D11① 丢弃，
    // 不入缓存——LRU 填充只发生在「曾打开」的 run 上）
    const runIds = ['wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5', 'wf-6']
    for (const runId of runIds) {
      mockGetRunEvents.mockResolvedValue(eventsReply(runId))
      store.setActiveWorkflowRun(SID, runId)
      await store.loadWorkflowRunEvents(SID, runId)
    }
    // 6 个 run 全 ready → 超界，最旧（wf-1）被驱逐
    expect(store.runEventsOf('wf-1')).toBeUndefined()
    expect(store.runEventsOf('wf-2')?.status).toBe('ready')
    expect(store.runEventsOf('wf-6')?.status).toBe('ready')
  })

  it('LRU 驱逐豁免活跃 run（正在显示的 run 不被驱逐）', async () => {
    const store = useWorkflowStore()
    // 填满 5 个（逐个切换活跃锚）
    for (const runId of ['wf-1', 'wf-2', 'wf-3', 'wf-4', 'wf-5']) {
      mockGetRunEvents.mockResolvedValue(eventsReply(runId))
      store.setActiveWorkflowRun(SID, runId)
      await store.loadWorkflowRunEvents(SID, runId)
    }
    // 活跃锚切回最早写入的 wf-1，再写入 wf-6 → 驱逐跳过 wf-1、淘汰次旧 wf-2
    store.setActiveWorkflowRun(SID, 'wf-1')
    mockGetRunEvents.mockResolvedValue(eventsReply('wf-6'))
    await store.loadWorkflowRunEvents(SID, 'wf-6')
    expect(store.runEventsOf('wf-1')?.status).toBe('ready')
    expect(store.runEventsOf('wf-2')).toBeUndefined()
  })
})

describe('workflowStore 事件流缓存：生命周期清理', () => {
  async function seedTwoSessions(store: ReturnType<typeof useWorkflowStore>): Promise<void> {
    mockGetRunEvents.mockResolvedValue(eventsReply(RUN_A))
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    mockGetRunEvents.mockResolvedValue(eventsReply(RUN_B))
    store.setActiveWorkflowRun('s-other', RUN_B)
    await store.loadWorkflowRunEvents('s-other', RUN_B)
  }

  it('D11⑤ clearSession：清该 session 名下 run 缓存与活跃锚，其他 session 分区保留', async () => {
    const store = useWorkflowStore()
    await seedTwoSessions(store)
    store.setActiveWorkflowRun(SID, RUN_A) // 活跃锚回到 s-main 名下
    store.clearSession(SID)
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
    expect(store.runEventsOf(RUN_B)?.status).toBe('ready') // 其他 session 保留
    expect(store.runEventsOf(RUN_B)?.sessionId).toBe('s-other')
  })

  it('clearSession 清活跃锚（归属该 session 时）', async () => {
    const store = useWorkflowStore()
    await seedTwoSessions(store)
    // 活跃锚指 RUN_B（s-other），清 s-main 不动锚；清 s-other 才动
    store.setActiveWorkflowRun('s-other', RUN_B)
    store.clearSession(SID)
    expect(store.runEventsOf(RUN_B)).toBeDefined()
    store.clearSession('s-other')
    expect(store.runEventsOf(RUN_B)).toBeUndefined()
  })

  it('clearSession 在途窗口释放去重簿记：后续同 runId 调用重新发起 RPC（不并入注定丢弃的在途拉取）', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    let resolveRpc!: (v: unknown) => void
    mockGetRunEvents.mockReturnValueOnce(new Promise((resolve) => (resolveRpc = resolve)))
    const stale = store.loadWorkflowRunEvents(SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)

    // session 删除时首拉仍在途：分区 + 活跃锚 + 在途簿记一并释放
    store.clearSession(SID)
    // 重开该 run（分区重建后的重挂载形态）：新调用发起独立 RPC——若在途簿记未释放，
    // 会静默并入已删除分区的陈旧在途（结果无 loading 占位可显示的空窗）
    store.setActiveWorkflowRun(SID, RUN_A)
    const fresh = store.loadWorkflowRunEvents(SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(2)
    await fresh
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')

    // 陈旧在途 settle：活跃锚已重指本 run（非丢弃路径），写回同源数据无害
    resolveRpc(eventsReply(RUN_A))
    await stale
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })

  it('clearWorkflows：事件流缓存 + LRU 序 + 活跃锚全清', async () => {
    const store = useWorkflowStore()
    await seedTwoSessions(store)
    store.clearWorkflows()
    expect(store.runEventsOf(RUN_A)).toBeUndefined()
    expect(store.runEventsOf(RUN_B)).toBeUndefined()
    // 清空后重新拉取可正常写入（无残留 LRU 序干扰）
    mockGetRunEvents.mockResolvedValue(eventsReply(RUN_A))
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(store.runEventsOf(RUN_A)?.status).toBe('ready')
  })
})

describe('workflowStore：triggerWorkflowReload 活跃 run 事件流联动（§3.1-4 信号接线）', () => {
  it('活跃 run 命中信号 session → force 重拉事件流', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
    mockGetWorkflowsResolved()
    store.triggerWorkflowReload(SID, 'running')
    await vi.waitFor(() => expect(mockGetRunEvents).toHaveBeenCalledTimes(2))
    expect(mockGetRunEvents).toHaveBeenLastCalledWith(SID, RUN_A)
  })

  it('信号 session 与活跃 run 不归属 → 不触发事件流拉取', async () => {
    const store = useWorkflowStore()
    store.setActiveWorkflowRun(SID, RUN_A)
    await store.loadWorkflowRunEvents(SID, RUN_A)
    mockGetWorkflowsResolved()
    store.triggerWorkflowReload('s-other', 'running')
    // 等待微任务排空确认无新增调用
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockGetRunEvents).toHaveBeenCalledTimes(1)
  })

  /** getWorkflows mock（triggerWorkflowReload 内 loadWorkflows 的伴随调用）默认 resolve 空列表 */
  function mockGetWorkflowsResolved(): void {
    vi.mocked(sessionApi.getWorkflows).mockResolvedValue({ workflows: [] })
  }
})
