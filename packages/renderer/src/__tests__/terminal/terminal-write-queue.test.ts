/**
 * terminal-write-queue store 测试（Phase 5 V5.1）。
 *
 * 验证联动 2 的写队列 + ptyAlive 状态管理：
 * - enqueueWrite PTY 未活 → 入队（不立即 write）
 * - enqueueWrite PTY 已活 → 立即 write
 * - markAlive → flush 队列
 * - markExited → ptyAlive=false
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/terminal/terminal-write-queue.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const terminalApiMock = vi.hoisted(() => ({
  write: vi.fn(() => Promise.resolve()),
}))
vi.mock('@taiji/core/transport/api/domains/terminal', () => ({
  terminalApi: terminalApiMock,
}))

import { useTerminalWriteQueueStore } from '@/stores/terminal-write-queue'

beforeEach(() => {
  setActivePinia(createPinia())
  terminalApiMock.write.mockClear()
})

describe('terminal-write-queue store（Phase 5 联动 2）', () => {
  it('WQ-1: enqueueWrite PTY 未活 → 入队（不立即 write）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite('s1', 'npm test')
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    expect(store.isPtyAlive('s1')).toBe(false)
  })

  it('WQ-2: enqueueWrite PTY 已活 → 立即 write', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive('s1') // 先标记存活
    terminalApiMock.write.mockClear()
    store.enqueueWrite('s1', 'echo done')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', 'echo done')
  })

  it('WQ-3: markAlive flush 待写队列（按入队顺序）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite('s1', 'cmd1')
    store.enqueueWrite('s1', 'cmd2')
    expect(terminalApiMock.write).not.toHaveBeenCalled()
    store.markAlive('s1')
    expect(terminalApiMock.write).toHaveBeenCalledTimes(2)
    expect(terminalApiMock.write).toHaveBeenNthCalledWith(1, 's1', 'cmd1')
    expect(terminalApiMock.write).toHaveBeenNthCalledWith(2, 's1', 'cmd2')
  })

  it('WQ-4: markAlive 后再 enqueueWrite 立即 write（队列已空）', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive('s1')
    terminalApiMock.write.mockClear()
    store.enqueueWrite('s1', 'late-cmd')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', 'late-cmd')
  })

  it('WQ-5: markExited 置 ptyAlive=false（后续 enqueueWrite 入队）', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive('s1')
    expect(store.isPtyAlive('s1')).toBe(true)
    store.markExited('s1')
    expect(store.isPtyAlive('s1')).toBe(false)
    terminalApiMock.write.mockClear()
    store.enqueueWrite('s1', 'after-exit')
    expect(terminalApiMock.write).not.toHaveBeenCalled() // 入队，不立即 write
  })

  it('WQ-6: 多 session 隔离（s1/s2 独立队列）', () => {
    const store = useTerminalWriteQueueStore()
    store.enqueueWrite('s1', 'cmd-s1')
    store.enqueueWrite('s2', 'cmd-s2')
    store.markAlive('s1')
    // s1 flush 了，s2 还在队列（未 alive）
    expect(terminalApiMock.write).toHaveBeenCalledTimes(1)
    expect(terminalApiMock.write).toHaveBeenCalledWith('s1', 'cmd-s1')
    terminalApiMock.write.mockClear()
    store.markAlive('s2')
    expect(terminalApiMock.write).toHaveBeenCalledWith('s2', 'cmd-s2')
  })

  it('WQ-7: removeSession 清理状态', () => {
    const store = useTerminalWriteQueueStore()
    store.markAlive('s1')
    store.removeSession('s1')
    expect(store.isPtyAlive('s1')).toBe(false)
  })
})
