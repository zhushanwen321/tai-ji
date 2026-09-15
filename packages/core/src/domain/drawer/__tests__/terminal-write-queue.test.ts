/**
 * terminal 写队列状态机单测（TC2）。
 *
 * 覆盖（对应原 renderer terminal-write-queue.test.ts 的 WQ-1~WQ-7 全量行为）：
 * - WQ-1 enqueueWrite PTY 未活 → 入队（不立即 write）
 * - WQ-2 enqueueWrite PTY 已活 → 立即 write
 * - WQ-3 markAlive flush 待写队列（按入队顺序）
 * - WQ-4 markAlive 后再 enqueueWrite 立即 write（队列已空）
 * - WQ-5 markExited 置 ptyAlive=false（后续 enqueueWrite 入队）
 * - WQ-6 多 session 隔离（s1/s2 独立队列）
 * - WQ-7 removeSession 清理状态
 *
 * 运行：cd packages/core && npx vitest run src/domain/drawer/__tests__/terminal-write-queue.test.ts
 * 测试框架 vitest（禁止 node:test / tsx --test）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTerminalWriteQueue, MAX_PENDING_WRITES } from '../terminal-write-queue'
import type { TerminalWriteFn } from '../terminal-write-queue'

describe('terminal-write-queue 状态机（WQ 联动 2）', () => {
  let writeFn: ReturnType<typeof vi.fn<TerminalWriteFn>>

  beforeEach(() => {
    writeFn = vi.fn<TerminalWriteFn>()
  })

  it('WQ-1: enqueueWrite PTY 未活 → 入队（不立即 write）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite('s1', 'npm test')
    expect(writeFn).not.toHaveBeenCalled()
    expect(queue.isPtyAlive('s1')).toBe(false)
  })

  it('WQ-2: enqueueWrite PTY 已活 → 立即 write', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive('s1') // 先标记存活
    writeFn.mockClear()
    queue.enqueueWrite('s1', 'echo done')
    expect(writeFn).toHaveBeenCalledWith('s1', 'echo done')
  })

  it('WQ-3: markAlive flush 待写队列（按入队顺序）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite('s1', 'cmd1')
    queue.enqueueWrite('s1', 'cmd2')
    expect(writeFn).not.toHaveBeenCalled()
    queue.markAlive('s1')
    expect(writeFn).toHaveBeenCalledTimes(2)
    expect(writeFn).toHaveBeenNthCalledWith(1, 's1', 'cmd1')
    expect(writeFn).toHaveBeenNthCalledWith(2, 's1', 'cmd2')
  })

  it('WQ-4: markAlive 后再 enqueueWrite 立即 write（队列已空）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive('s1')
    writeFn.mockClear()
    queue.enqueueWrite('s1', 'late-cmd')
    expect(writeFn).toHaveBeenCalledWith('s1', 'late-cmd')
  })

  it('WQ-5: markExited 置 ptyAlive=false（后续 enqueueWrite 入队）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive('s1')
    expect(queue.isPtyAlive('s1')).toBe(true)
    queue.markExited('s1')
    expect(queue.isPtyAlive('s1')).toBe(false)
    writeFn.mockClear()
    queue.enqueueWrite('s1', 'after-exit')
    expect(writeFn).not.toHaveBeenCalled() // 入队，不立即 write
  })

  it('WQ-6: 多 session 隔离（s1/s2 独立队列）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.enqueueWrite('s1', 'cmd-s1')
    queue.enqueueWrite('s2', 'cmd-s2')
    queue.markAlive('s1')
    // s1 flush 了，s2 还在队列（未 alive）
    expect(writeFn).toHaveBeenCalledTimes(1)
    expect(writeFn).toHaveBeenCalledWith('s1', 'cmd-s1')
    writeFn.mockClear()
    queue.markAlive('s2')
    expect(writeFn).toHaveBeenCalledWith('s2', 'cmd-s2')
  })

  it('WQ-7: removeSession 清理状态', () => {
    const queue = createTerminalWriteQueue(writeFn)
    queue.markAlive('s1')
    queue.removeSession('s1')
    expect(queue.isPtyAlive('s1')).toBe(false)
  })

  it('WQ-8: pendingWrites 容量上限（超限丢弃最旧，保留最新，flush 顺序保持）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    for (let i = 0; i < MAX_PENDING_WRITES + 25; i++) {
      queue.enqueueWrite('s1', `cmd-${i}`)
    }
    expect(writeFn).not.toHaveBeenCalled() // 全部入队，未 flush
    queue.markAlive('s1')
    // 只 flush 最近 MAX_PENDING_WRITES 条（最旧 25 条被丢弃），保留 FIFO 顺序
    expect(writeFn).toHaveBeenCalledTimes(MAX_PENDING_WRITES)
    expect(writeFn).toHaveBeenNthCalledWith(1, 's1', 'cmd-25')
    expect(writeFn).toHaveBeenNthCalledWith(MAX_PENDING_WRITES, 's1', `cmd-${MAX_PENDING_WRITES + 24}`)
  })

  it('WQ-9: 队列在容量上限内不丢命令（边界：恰好 MAX_PENDING_WRITES 条全保留）', () => {
    const queue = createTerminalWriteQueue(writeFn)
    for (let i = 0; i < MAX_PENDING_WRITES; i++) {
      queue.enqueueWrite('s1', `cmd-${i}`)
    }
    queue.markAlive('s1')
    expect(writeFn).toHaveBeenCalledTimes(MAX_PENDING_WRITES)
    expect(writeFn).toHaveBeenNthCalledWith(1, 's1', 'cmd-0')
    expect(writeFn).toHaveBeenNthCalledWith(MAX_PENDING_WRITES, 's1', `cmd-${MAX_PENDING_WRITES - 1}`)
  })

  it('工厂 per-instance 隔离：两个实例互不影响', () => {
    const queueA = createTerminalWriteQueue(writeFn)
    const queueB = createTerminalWriteQueue(writeFn)
    queueA.markAlive('s1')
    expect(queueB.isPtyAlive('s1')).toBe(false) // B 实例独立状态
  })
})
