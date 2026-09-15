/**
 * pending.test.ts — PendingTracker 全 API 契约（F5 失败路径验收 + 原语行为，自 pending-tracker.test.ts 归并）。
 *
 * 背景：PendingTracker 是「三处同构 Map+setTimeout 样板」的提取物，被 plugin-commands-executor、
 * plugin-tool-execution 等多处消费。锁定：命令超时（30s）→ reject + 删 pending Map + 迟到响应
 * 静默丢弃，以及 rejectAll 清 timer / 乱序并发 resolve / 泛型 K 等原语语义。
 *
 * 运行：cd packages/runtime && npx vitest run test/pending.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PendingTracker } from '../src/utils/async/pending-tracker.js'

describe('PendingTracker · F5 命令超时善后', () => {
  let tracker: PendingTracker<string, string>

  beforeEach(() => {
    vi.useFakeTimers()
    tracker = new PendingTracker()
  })

  afterEach(() => {
    // 清理所有 pending 的 timer，避免 unhandled rejection
    vi.runAllTimers()
    vi.useRealTimers()
  })

  it('F5: 超时后 reject + 从 pending Map 删除', async () => {
    const timeoutMs = 30000
    const timeoutError = new Error('Command timeout (30000ms): test-cmd')

    // 注册一个 pending 请求
    const promise = tracker.register('cmd-1', timeoutMs, timeoutError)

    // 验证已注册
    expect(tracker.has('cmd-1')).toBe(true)
    expect(tracker.size).toBe(1)

    // 推进时间到超时
    vi.advanceTimersByTime(timeoutMs)

    // 应 reject
    await expect(promise).rejects.toThrow('Command timeout (30000ms): test-cmd')

    // 应从 pending Map 删除
    expect(tracker.has('cmd-1')).toBe(false)
    expect(tracker.size).toBe(0)
  })

  it('F5: 超时前收到响应 — resolve + 清除 timer', async () => {
    const timeoutMs = 30000
    const timeoutError = new Error('timeout')

    const promise = tracker.register('cmd-2', timeoutMs, timeoutError)

    // 在超时前收到响应
    vi.advanceTimersByTime(1000) // 1s 后
    const resolved = tracker.resolve('cmd-2', 'response-data')
    expect(resolved).toBe(true)

    // 应 resolve
    await expect(promise).resolves.toBe('response-data')

    // 应从 pending Map 删除
    expect(tracker.has('cmd-2')).toBe(false)
    expect(tracker.size).toBe(0)
  })

  it('F5: 迟到响应静默丢弃 — 超时后 resolve 返回 false', async () => {
    const timeoutMs = 30000
    const timeoutError = new Error('timeout')

    const promise = tracker.register('cmd-3', timeoutMs, timeoutError).catch(() => {})

    // 推进时间到超时
    vi.advanceTimersByTime(timeoutMs)

    // 等待 promise settle
    await promise

    // 迟到响应 — 应返回 false（未命中）
    const resolved = tracker.resolve('cmd-3', 'late-response')
    expect(resolved).toBe(false)
  })

  it('F5: 多个请求独立超时 — 互不影响', async () => {
    const timeoutMs = 30000
    const timeoutError = new Error('timeout')

    const promise1 = tracker.register('cmd-a', timeoutMs, timeoutError).catch(() => {})
    const promise2 = tracker.register('cmd-b', timeoutMs, timeoutError).catch(() => {})

    expect(tracker.size).toBe(2)

    // 推进时间到超时
    vi.advanceTimersByTime(timeoutMs)

    // 两个都应 reject
    await promise1
    await promise2

    expect(tracker.size).toBe(0)
  })

  it('F5: rejectAll — 拒绝所有 pending 请求', async () => {
    const timeoutMs = 30000
    const timeoutError = new Error('timeout')

    const promise1 = tracker.register('cmd-x', timeoutMs, timeoutError).catch(() => {})
    const promise2 = tracker.register('cmd-y', timeoutMs, timeoutError).catch(() => {})
    const promise3 = tracker.register('cmd-z', timeoutMs, timeoutError).catch(() => {})

    expect(tracker.size).toBe(3)

    // rejectAll
    tracker.rejectAll(new Error('Process exited'))

    // 所有都应 reject
    await promise1
    await promise2
    await promise3

    expect(tracker.size).toBe(0)
  })

  it('F5: reject 单个请求 — 只拒绝指定的', async () => {
    const timeoutMs = 30000
    const timeoutError = new Error('timeout')

    const promise1 = tracker.register('cmd-1', timeoutMs, timeoutError).catch(() => {})
    const promise2 = tracker.register('cmd-2', timeoutMs, timeoutError)

    // 只 reject cmd-1
    const rejected = tracker.reject('cmd-1', new Error('RPC error'))
    expect(rejected).toBe(true)

    await promise1

    // cmd-2 仍在 pending
    expect(tracker.has('cmd-2')).toBe(true)
    expect(tracker.size).toBe(1)

    // cmd-2 正常 resolve
    tracker.resolve('cmd-2', 'ok')
    await expect(promise2).resolves.toBe('ok')
  })

  it('F5: 不存在的 key — resolve/reject 返回 false', () => {
    const resolved = tracker.resolve('non-existent', 'data')
    expect(resolved).toBe(false)

    const rejected = tracker.reject('non-existent', new Error('err'))
    expect(rejected).toBe(false)
  })

  // ── 原语增量语义（自 pending-tracker.test.ts 归并）──────────────────

  it('resolve() clears the timeout (no late rejection)', async () => {
    const t = new PendingTracker<number, string>()
    const p = t.register(1, 1000, new Error('timeout'))
    t.resolve(1, 'ok')
    vi.advanceTimersByTime(5000) // well past timeout
    await expect(p).resolves.toBe('ok')
  })

  it('rejectAll() clears timeouts (no double-reject after)', async () => {
    const t = new PendingTracker<number, string>()
    const p = t.register(1, 1000, new Error('timeout'))
    t.rejectAll(new Error('disposed'))
    vi.advanceTimersByTime(5000)
    // promise already settled as 'disposed', not the timeout error
    await expect(p).rejects.toThrow('disposed')
    expect(t.size).toBe(0)
  })

  it('handles concurrent out-of-order resolution by key', async () => {
    const t = new PendingTracker<number, string>()
    const promises = [
      t.register(1, 1000, new Error('t')),
      t.register(2, 1000, new Error('t')),
      t.register(3, 1000, new Error('t')),
    ]
    t.resolve(3, 'C')
    t.resolve(1, 'A')
    t.resolve(2, 'B')
    await expect(Promise.all(promises)).resolves.toEqual(['A', 'B', 'C'])
  })

  it('number and string keys both work as generic K', async () => {
    const numT = new PendingTracker<number, string>()
    const strT = new PendingTracker<string, string>()
    const pn = numT.register(1, 100, new Error('t'))
    const ps = strT.register('id-1', 100, new Error('t'))
    numT.resolve(1, 'n')
    strT.resolve('id-1', 's')
    await expect(pn).resolves.toBe('n')
    await expect(ps).resolves.toBe('s')
  })
})
