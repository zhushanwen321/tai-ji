// @vitest-environment node

/**
 * terminal 写域测试合并文件（波 2a 簇 1-10 语义子集）。
 *
 * 节 1 — terminal-write-queue：写队列 + ptyAlive 状态管理（per-terminalId 分键）
 *        + 关闭沿入队检查 + 清理扇出。
 * 节 2 — use-terminal-reconcile-generation：terminal.list 对账的连接世代防护
 *        （greptile PR #30 发现 2）。
 *
 * 合并说明：domains/terminal mock 取超集共享（节 2 工厂含节 1 的 write，
 * 节 1 断言绑定的 terminalApiMock.write 与超集为同一 vi.fn）；节 2 的
 * ws-client 保留式 mock（仅覆写 getCurrentToken）对节 1 链零消费。
 * 两节原本各自的文件级 beforeEach/afterEach 下沉到各自 describe 节内
 * （节 1 的 registerInstance 预注册会破坏节 2 的 hasInstance===false 断言，
 * 必须节内隔离）；节 2 的 const T1 与节 1 同名同值，按节改名 RG_T1。
 * describe/it 名零改动。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/terminal/terminal-write-queue.test.ts --pool=threads
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// ── mock terminalApi（隔离 RPC；超集工厂 = write/spawn/resize/kill/attach/list）──
const terminalApiMock = vi.hoisted(() => ({
  spawn: vi.fn(() => Promise.resolve({})),
  write: vi.fn(() => Promise.resolve()),
  resize: vi.fn(() => Promise.resolve()),
  kill: vi.fn(() => Promise.resolve()),
  attach: vi.fn(() => Promise.resolve()),
  list: vi.fn(() => Promise.resolve([] as Array<{ terminalId: string; alive: boolean }>)),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

// ── 可控 ws-client 世代 token（其余导出保留真实实现；节 2 专用）────────────────
const wsControl = vi.hoisted(() => ({ token: null as string | null }))
vi.mock('@taiji/core/transport/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/transport/ws-client')>()
  return {
    ...actual,
    getCurrentToken: () => wsControl.token,
  }
})

import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { useToast } from '@/composables/useToast'
import { MAX_PENDING_WRITES } from '@taiji/core/domain/drawer'
import {
  __resetTerminalInstanceRegistryForTest,
  registerInstance,
  hasInstance,
} from '@/composables/features/terminal/terminal-instance-registry'
import {
  useTerminal,
  __resetTerminalStateForTest,
  __terminalPartitionCountForTest,
  __terminalSubscriptionCountForTest,
} from '@/composables/features/terminal/useTerminal'

// ══════════ 节 1/2 — 来源: terminal-write-queue.test.ts ══════════

/**
 * 验证写队列 + ptyAlive 状态管理（per-terminalId 分键）+ 关闭沿入队检查 + 清理扇出：
 * - enqueueWrite PTY 未活 → 入队（不立即 write）
 * - enqueueWrite PTY 已活 → 立即 write（命令经编号解析会话段后调 terminalApi.write）
 * - markAlive → flush 队列；markExited → ptyAlive=false
 * - 未注册实例入队被拒（关闭沿检查，不建档）
 * - removeInstance / removeSession（精确前缀）/ clearAll 清理 + dropToastTimers
 */
const T1 = 'term:s1:1'
const T2 = 'term:s1:2'
const T_OTHER = 'term:s2:1'

describe('terminal-write-queue store（多实例）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    terminalApiMock.write.mockClear()
    useToast().toasts.value = []
    __resetTerminalInstanceRegistryForTest()
    // 已建档（关注册成员资格）——入队检查放行；测试按需再注册
    registerInstance(T1, true)
    registerInstance(T2, true)
    registerInstance(T_OTHER, true)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('WQ-1: enqueueWrite PTY 未活 → 入队（不立即 write）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'npm test')
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    expect(store.isPtyAlive(T1)).toBe(false)
    expect(store.pendingCountOf(T1)).toBe(1)
  })

  it('WQ-2: enqueueWrite PTY 已活 → 立即 write（编号解析会话段）', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive(T1) // 先标记存活
    terminalApiMock.write.mockClear()
    store.enqueueWrite(T1, 'echo done')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', T1, 'echo done')
  })

  it('WQ-3: markAlive flush 待写队列（按入队顺序）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'cmd1')
    store.enqueueWrite(T1, 'cmd2')
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    store.markAlive(T1)
    expect(terminalApiMock.write).toHaveBeenCalledTimes(2)
    expect(terminalApiMock.write).toHaveBeenNthCalledWith(1, 's1', T1, 'cmd1')
    expect(terminalApiMock.write).toHaveBeenNthCalledWith(2, 's1', T1, 'cmd2')
  })

  it('WQ-4: markAlive 后再 enqueueWrite 立即 write（队列已空）', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive(T1)
    terminalApiMock.write.mockClear()
    store.enqueueWrite(T1, 'late-cmd')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', T1, 'late-cmd')
  })

  it('WQ-5: markExited 置 ptyAlive=false（后续 enqueueWrite 入队）', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive(T1)
    expect(store.isPtyAlive(T1)).toBe(true)
    store.markExited(T1)
    expect(store.isPtyAlive(T1)).toBe(false)
    terminalApiMock.write.mockClear()
    store.enqueueWrite(T1, 'after-exit')
    expect(terminalApiMock.write).not.toHaveBeenCalled()
  })

  it('WQ-6: 多实例隔离（同会话两实例 / 跨会话独立队列）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'cmd-t1')
    store.enqueueWrite(T2, 'cmd-t2')
    store.enqueueWrite(T_OTHER, 'cmd-other')
    store.markAlive(T1)
    expect(terminalApiMock.write).toHaveBeenCalledTimes(1)
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', T1, 'cmd-t1')
    terminalApiMock.write.mockClear()
    store.markAlive(T_OTHER)
    expect(terminalApiMock.write).toHaveBeenCalledWith('s2', T_OTHER, 'cmd-other')
  })

  it('WQ-7: removeInstance 清理实例态（返回滞留数）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'pending')
    expect(store.removeInstance(T1)).toBe(1)
    expect(store.isPtyAlive(T1)).toBe(false)
    expect(store.pendingCountOf(T1)).toBe(0)
  })

  // ── 关闭沿入队检查（注册成员资格，与存活镜像解耦）───────────────────────

  it('MI-1: 未注册实例入队被拒（不建档、不 write）+「输入可能丢失」提示一次', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite('term:s1:9', 'to-closed')
    expect(store.pendingCountOf('term:s1:9')).toBe(0)
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    // 丢弃必显形（设计 §5 u2）：复用「输入可能丢失」提示通道，含实例显示名
    const warnings = useToast().toasts.value.filter((x) => x.type === 'warning')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.message).toContain('终端 9')
  })

  it('MI-2: 已注册未 alive → 入 pendingWrites，markAlive 后正常 flush（检查与镜像解耦）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'before-alive')
    expect(store.pendingCountOf(T1)).toBe(1)
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    store.markAlive(T1)
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', T1, 'before-alive')
  })

  it('MI-3: removeSession 精确前缀清该会话全部实例态（含他会话不受影响）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'a1')
    store.enqueueWrite(T2, 'a2')
    store.enqueueWrite(T_OTHER, 'b1')
    expect(store.removeSession('s1')).toBe(2)
    expect(store.pendingCountOf(T1)).toBe(0)
    expect(store.pendingCountOf(T2)).toBe(0)
    expect(store.pendingCountOf(T_OTHER)).toBe(1)
  })

  it('MI-4: clearAll 清空全部实例态（世代变更重置）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite(T1, 'a1')
    store.enqueueWrite(T_OTHER, 'b1')
    expect(store.clearAll()).toBe(2)
    expect(store.pendingCountOf(T1)).toBe(0)
    expect(store.pendingCountOf(T_OTHER)).toBe(0)
  })

  // ── RD-3#5：write 失败 catch + drop 计数显形（M2 renderer 端） ─────────

  it('RD3-5-R1: write RPC 失败 catch → warn + error toast（不再裸奔成 unhandledrejection）', async () => {
    terminalApiMock.write.mockRejectedValueOnce(new Error('ws closed'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useTerminalWriteQueueStore()
    store.markAlive(T1)
    store.enqueueWrite(T1, 'boom')
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled(), { interval: 1 })
    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]!.type).toBe('error')
    expect(toasts.value[0]!.message).toContain('ws closed')
  })

  it('RD3-5-R2: 队列满 drop-oldest → 聚合 toast（1s 窗口合并为一条，显示累计数）', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useTerminalWriteQueueStore()
    for (let i = 0; i < MAX_PENDING_WRITES + 3; i++) {
      store.enqueueWrite(T1, `cmd-${i}`)
    }
    expect(warnSpy).toHaveBeenCalledTimes(3)
    expect(useToast().toasts.value).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]!.type).toBe('warning')
    expect(toasts.value[0]!.message).toContain('3')
  })

  it('RD3-5-R3: removeInstance 清理未触发的聚合 toast timer', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useTerminalWriteQueueStore()
    for (let i = 0; i < MAX_PENDING_WRITES + 1; i++) {
      store.enqueueWrite(T1, `cmd-${i}`)
    }
    store.removeInstance(T1)
    vi.advanceTimersByTime(5000)
    expect(useToast().toasts.value).toHaveLength(0)
  })

  it('RD3-5-R4: removeSession 按精确前缀清理聚合 toast timer（他会话 timer 保留）', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = useTerminalWriteQueueStore()
    for (let i = 0; i < MAX_PENDING_WRITES + 1; i++) store.enqueueWrite(T1, `cmd-${i}`)
    for (let i = 0; i < MAX_PENDING_WRITES + 1; i++) store.enqueueWrite(T_OTHER, `other-${i}`)
    store.removeSession('s1')
    vi.advanceTimersByTime(1000)
    // 仅 s2 的聚合 toast 触发（s1 timer 已随 removeSession 清理）
    const { toasts } = useToast()
    expect(toasts.value).toHaveLength(1)
    expect(toasts.value[0]!.message).toContain('1')
  })
})

// ══════════ 节 2/2 — 来源: use-terminal-reconcile-generation.test.ts ══════════

/**
 * 场景：list 请求在途期间 auth token 变化（runtime 重启换 token = 连接世代变更），
 * 旧世代落定的清单响应必须被丢弃——不进实例注册表、按失败路径返回（不自动新建）。
 * 当前接线下断连时 use-connection 的 pendingApi.rejectAll 已把在途请求 reject 走失败路径，
 * 本防护是纵深第二层：传输层行为变化（旧响应不再被 reject 直达注册表）时兜住
 * 「旧清单响应复活幽灵终端」，与 resetTerminalDomain 的世代重置语义配套。
 */
const RG_T1 = 'term:s1:1'

describe('terminal.list 对账的连接世代防护（greptile PR #30 发现 2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    __resetTerminalStateForTest()
    wsControl.token = null
    for (const key of Object.keys(terminalApiMock) as (keyof typeof terminalApiMock)[]) {
      terminalApiMock[key].mockClear()
    }
    terminalApiMock.list.mockResolvedValue([])
  })

  it('请求在途期间世代变更 → 落定的旧世代清单响应被丢弃，注册表/分区/订阅零污染', async () => {
    terminalApiMock.list.mockImplementation(async () => {
      // 模拟 list RPC 在途期间 runtime 重启（auth token 更换 = 连接世代变更）
      wsControl.token = 'token-B'
      return [{ terminalId: RG_T1, alive: true }]
    })
    const terminal = useTerminal(ref('s1'))
    const result = await terminal.reconcileInstances()

    // 失败路径语义：不自动新建、保留既有条目（响应整体丢弃，不按清单增删注册表）
    expect(result).toEqual({ ok: false, count: -1 })
    expect(hasInstance(RG_T1)).toBe(false)
    expect(terminal.instances.value).toEqual([])
    expect(__terminalPartitionCountForTest()).toBe(0)
    expect(__terminalSubscriptionCountForTest()).toBe(0)
  })

  it('同世代（token 未变）响应照常建档（防护不吞正常清单）', async () => {
    terminalApiMock.list.mockResolvedValue([{ terminalId: RG_T1, alive: true }])
    const terminal = useTerminal(ref('s1'))
    const result = await terminal.reconcileInstances()

    expect(result).toEqual({ ok: true, count: 1 })
    expect(hasInstance(RG_T1)).toBe(true)
    expect(terminal.instances.value.map((i) => i.terminalId)).toEqual([RG_T1])
  })
})
