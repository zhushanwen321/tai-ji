/**
 * terminal 写队列状态机单测（TC2 / 多实例 u2）。
 *
 * 覆盖（对应原 renderer terminal-write-queue.test.ts 的 WQ-1~WQ-7 + 多实例新增）：
 * - WQ-1 enqueueWrite PTY 未活 → 入队（不立即 write）
 * - WQ-2 enqueueWrite PTY 已活 → 立即 write
 * - WQ-3 markAlive flush 待写队列（按入队顺序）
 * - WQ-4 markAlive 后再 enqueueWrite 立即 write（队列已空）
 * - WQ-5 markExited 置 ptyAlive=false（后续 enqueueWrite 入队）
 * - WQ-6 多实例隔离（同会话两实例 / 跨会话两实例独立队列）
 * - WQ-7 removeInstance 清理实例态并返回丢弃的滞留命令数
 * - WQ-8/9 pendingWrites 容量上限
 * - MI-* 关闭沿入队守卫（注册成员资格，与存活镜像解耦）/ 精确前缀扇出 / 世代重置 / 幽灵拒收
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/terminal-write-queue.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTerminalWriteQueue, MAX_PENDING_WRITES } from '../terminal-write-queue'
import type { TerminalWriteFn } from '../terminal-write-queue'

describe('terminal-write-queue 状态机（多实例）', () => {
  let writeFn: ReturnType<typeof vi.fn<TerminalWriteFn>>
  const T1 = 'term:s1:1'
  const T2 = 'term:s1:2'
  const T_OTHER = 'term:s2:1'

  beforeEach(() => {
    writeFn = vi.fn<TerminalWriteFn>()
  })

  it('WQ-1: enqueueWrite PTY 未活 → 入队（不立即 write）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite(T1, 'npm test')
    expect(writeFn).not.toHaveBeenCalled()
    expect(queue.isPtyAlive(T1)).toBe(false)
  })

  it('WQ-2: enqueueWrite PTY 已活 → 立即 write', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive(T1) // 先标记存活
    writeFn.mockClear()
    queue.enqueueWrite(T1, 'echo done')
    expect(writeFn).toHaveBeenCalledWith(T1, 'echo done')
  })

  it('WQ-3: markAlive flush 待写队列（按入队顺序）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite(T1, 'cmd1')
    queue.enqueueWrite(T1, 'cmd2')
    expect(writeFn).not.toHaveBeenCalled()
    queue.markAlive(T1)
    expect(writeFn).toHaveBeenCalledTimes(2)
    expect(writeFn).toHaveBeenNthCalledWith(1, T1, 'cmd1')
    expect(writeFn).toHaveBeenNthCalledWith(2, T1, 'cmd2')
  })

  it('WQ-4: markAlive 后再 enqueueWrite 立即 write（队列已空）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive(T1)
    writeFn.mockClear()
    queue.enqueueWrite(T1, 'late-cmd')
    expect(writeFn).toHaveBeenCalledWith(T1, 'late-cmd')
  })

  it('WQ-5: markExited 置 ptyAlive=false（后续 enqueueWrite 入队）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive(T1)
    expect(queue.isPtyAlive(T1)).toBe(true)
    queue.markExited(T1)
    expect(queue.isPtyAlive(T1)).toBe(false)
    writeFn.mockClear()
    queue.enqueueWrite(T1, 'after-exit')
    expect(writeFn).not.toHaveBeenCalled() // 入队，不立即 write
  })

  it('WQ-6: 多实例隔离（同会话两实例 / 跨会话两实例独立队列）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite(T1, 'cmd-t1')
    queue.enqueueWrite(T2, 'cmd-t2')
    queue.enqueueWrite(T_OTHER, 'cmd-other')
    queue.markAlive(T1)
    // 仅 T1 flush，其余两个实例仍在各自队列（未 alive）
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith(T1, 'cmd-t1')
    writeFn.mockClear()
    queue.markAlive(T2)
    expect(writeFn).toHaveBeenCalledWith(T2, 'cmd-t2')
    expect(writeFn).toHaveBeenCalledTimes(1)
  })

  it('WQ-7: removeInstance 清理实例态并返回被丢弃的滞留命令数', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive(T1)
    queue.enqueueWrite(T1, 'a')
    queue.markExited(T1)
    queue.enqueueWrite(T1, 'b')
    queue.enqueueWrite(T1, 'c')
    expect(queue.pendingCountOf(T1)).toBe(2)
    expect(queue.removeInstance(T1)).toBe(2)
    expect(queue.isPtyAlive(T1)).toBe(false)
    expect(queue.pendingCountOf(T1)).toBe(0)
    // 未建档实例移除返回 0（幂等）
    expect(queue.removeInstance('term:s1:9')).toBe(0)
  })

  it('WQ-8: pendingWrites 容量上限（超限丢弃最旧，保留最新，flush 顺序保持）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    for (let i = 0; i < MAX_PENDING_WRITES + 25; i++) {
      queue.enqueueWrite(T1, `cmd-${i}`)
    }
    expect(writeFn).not.toHaveBeenCalled() // 全部入队，未 flush
    queue.markAlive(T1)
    expect(writeFn).toHaveBeenCalledTimes(MAX_PENDING_WRITES)
    expect(writeFn).toHaveBeenNthCalledWith(1, T1, 'cmd-25')
    expect(writeFn).toHaveBeenNthCalledWith(MAX_PENDING_WRITES, T1, `cmd-${MAX_PENDING_WRITES + 24}`)
  })

  it('WQ-9: 队列在容量上限内不丢命令（边界：恰好 MAX_PENDING_WRITES 条全保留）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    for (let i = 0; i < MAX_PENDING_WRITES; i++) {
      queue.enqueueWrite(T1, `cmd-${i}`)
    }
    queue.markAlive(T1)
    expect(writeFn).toHaveBeenCalledTimes(MAX_PENDING_WRITES)
    expect(writeFn).toHaveBeenNthCalledWith(1, T1, 'cmd-0')
    expect(writeFn).toHaveBeenNthCalledWith(MAX_PENDING_WRITES, T1, `cmd-${MAX_PENDING_WRITES - 1}`)
  })

  // ── 多实例：关闭沿入队守卫 / 扇出 / 世代重置 ─────────────────────────────

  it('MI-1: 关闭沿入队守卫——注册表否定时拒绝入队且不建档（无幽灵实例态）', () => {
    const isRegistered = vi.fn((terminalId: string) => terminalId === T1)
    const queue = createTerminalWriteQueue(writeFn, { isRegistered })
    queue.enqueueWrite(T2, 'closed-instance')
    // 守卫被征询（判据 = 注册成员资格），且未建档：pendingCountOf / isPtyAlive 均回落默认（不产生幽灵条目）
    expect(isRegistered).toHaveBeenCalledWith(T2)
    expect(queue.pendingCountOf(T2)).toBe(0)
    expect(queue.isPtyAlive(T2)).toBe(false)
    expect(writeFn).not.toHaveBeenCalled()
    // 「输入可能丢失」提示腿在 renderer store 兼容层（core 零 UI 依赖）——见
    // packages/renderer/src/__tests__/terminal/terminal-write-queue.test.ts MI-1。
  })

  it('MI-2: 守卫判据与存活镜像解耦——已建档未 alive 仍入 pendingWrites，markAlive 后 flush', () => {
    const isRegistered = vi.fn(() => true)
    const queue = createTerminalWriteQueue(writeFn, { isRegistered })
    queue.enqueueWrite(T1, 'cmd-before-alive')
    expect(queue.isPtyAlive(T1)).toBe(false)
    expect(queue.pendingCountOf(T1)).toBe(1)
    expect(writeFn).not.toHaveBeenCalled()
    queue.markAlive(T1)
    expect(writeFn).toHaveBeenCalledWith(T1, 'cmd-before-alive')
  })

  it('MI-3: removeSession 按精确前缀扇出该会话全部实例键；含冒号 sid 形态不误匹配', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite(T1, 'a1')
    queue.enqueueWrite(T2, 'a2')
    queue.enqueueWrite(T_OTHER, 'b1')
    // 恶意/异常键：sid 含冒号形态（P7 负例），`term:a:` 前缀不得吞掉
    queue.enqueueWrite('term:a:1:1', 'weird')
    const dropped = queue.removeSession('s1')
    expect(dropped).toBe(2)
    expect(queue.pendingCountOf(T1)).toBe(0)
    expect(queue.pendingCountOf(T2)).toBe(0)
    // 他会话与含冒号 sid 键不受影响
    expect(queue.pendingCountOf(T_OTHER)).toBe(1)
    expect(queue.pendingCountOf('term:a:1:1')).toBe(1)
    // sid 'a' 的前缀扇出不误纳 `term:a:1:1`
    expect(queue.removeSession('a')).toBe(0)
    expect(queue.pendingCountOf('term:a:1:1')).toBe(1)
  })

  it('MI-4: clearAll 清空全部实例态并返回滞留命令总数（世代变更重置）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite(T1, 'a1')
    queue.enqueueWrite(T1, 'a2')
    queue.enqueueWrite(T_OTHER, 'b1')
    expect(queue.clearAll()).toBe(3)
    expect(queue.pendingCountOf(T1)).toBe(0)
    expect(queue.pendingCountOf(T_OTHER)).toBe(0)
    // 清空后同形键重新入队是干净的（不串旧世代命令）
    queue.enqueueWrite(T1, 'fresh')
    expect(queue.pendingCountOf(T1)).toBe(1)
  })

  // ── RD-3#5：drop-oldest 计数显形 ──────────────────────────────────────

  it('RD3-5-D1: 队列满 drop-oldest 累计计数 + onDrop 回调（携带 per-instance 累计值）', () => {
    const onDrop = vi.fn()
    const queue = createTerminalWriteQueue(writeFn, { onDrop })
    for (let i = 0; i < MAX_PENDING_WRITES + 3; i++) {
      queue.enqueueWrite(T1, `cmd-${i}`)
    }
    expect(onDrop).toHaveBeenCalledTimes(3)
    expect(onDrop).toHaveBeenNthCalledWith(1, T1, 1)
    expect(onDrop).toHaveBeenNthCalledWith(3, T1, 3)
    expect(queue.droppedCountOf(T1)).toBe(3)
    expect(queue.droppedCountOf('term:s1:9')).toBe(0)
  })

  it('RD3-5-D2: removeInstance 清零计数；上限内不触发 onDrop', () => {
    const onDrop = vi.fn()
    const queue = createTerminalWriteQueue(writeFn, { onDrop })
    for (let i = 0; i < MAX_PENDING_WRITES; i++) {
      queue.enqueueWrite(T1, `cmd-${i}`)
    }
    expect(onDrop).not.toHaveBeenCalled()
    queue.removeInstance(T1)
    expect(queue.droppedCountOf(T1)).toBe(0)
  })

  it('工厂 per-instance 隔离：两个实例互不影响', () => {
    const queueA = createTerminalWriteQueue(writeFn)
    const queueB = createTerminalWriteQueue(writeFn)
    queueA.markAlive(T1)
    expect(queueB.isPtyAlive(T1)).toBe(false) // B 实例独立状态
  })
})
