// @vitest-environment node

/**
 * terminal-write-queue store 测试（Phase 5 联动 2 / 多实例 u2）。
 *
 * 验证写队列 + ptyAlive 状态管理（per-terminalId 分键）+ 关闭沿入队守卫 + 清理扇出：
 * - enqueueWrite PTY 未活 → 入队（不立即 write）
 * - enqueueWrite PTY 已活 → 立即 write（命令经编号解析会话段后调 terminalApi.write）
 * - markAlive → flush 队列；markExited → ptyAlive=false
 * - 未注册实例入队被拒（关闭沿守卫，不建档）
 * - removeInstance / removeSession（精确前缀）/ clearAll 清理 + dropToastTimers
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/terminal-write-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const terminalApiMock = vi.hoisted(() => ({
  write: vi.fn(() => Promise.resolve()),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'
import { useToast } from '@/composables/useToast'
import { MAX_PENDING_WRITES } from '@taiji/core/domain/drawer'
import {
  __resetTerminalInstanceRegistryForTest,
  registerInstance,
} from '@/composables/features/terminal/terminal-instance-registry'

const T1 = 'term:s1:1'
const T2 = 'term:s1:2'
const T_OTHER = 'term:s2:1'

beforeEach(() => {
  setActivePinia(createPinia())
  terminalApiMock.write.mockClear()
  useToast().toasts.value = []
  __resetTerminalInstanceRegistryForTest()
  // 已建档（关注册成员资格）——入队守卫放行；测试按需再注册
  registerInstance(T1, true)
  registerInstance(T2, true)
  registerInstance(T_OTHER, true)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('terminal-write-queue store（多实例）', () => {
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

  // ── 关闭沿入队守卫（注册成员资格，与存活镜像解耦）───────────────────────

  it('MI-1: 未注册实例入队被拒（不建档、不 write）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite('term:s1:9', 'to-closed')
    expect(store.pendingCountOf('term:s1:9')).toBe(0)
    expect(terminalApiMock.write).not.toHaveBeenCalled()
  })

  it('MI-2: 已注册未 alive → 入 pendingWrites，markAlive 后正常 flush（守卫与镜像解耦）', () => {
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
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())
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
