/**
 * RFC 8628 设备码轮询器单测（mock poll + vi fake timers）。
 *
 * 覆盖：pending 继续轮询 / slow_down 服务器 interval 优先、无 interval 时 +5s /
 * complete 返回 value / failed 返回 reason / 绝对超时（expiresInSeconds）/
 * abort 中断（运行中 + 调用前已 abort）/ waitBeforeFirstPoll 先等一轮 / attempt 递增。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runDeviceCodeFlow, type DevicePollResult } from '../device-code-flow.js'

const CANCEL_MESSAGE = 'Login cancelled'

function controller(): AbortController {
  return new AbortController()
}

describe('runDeviceCodeFlow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('pending 持续轮询直到 complete，返回 value', async () => {
    const results: DevicePollResult[] = [
      { status: 'pending' },
      { status: 'pending' },
      { status: 'complete', value: { token: 'abc' } },
    ]
    const poll = vi.fn(async () => results.shift() as DevicePollResult)
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal })

    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(5000)

    await expect(p).resolves.toEqual({ ok: true, value: { token: 'abc' } })
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('poll 收到递增的 attempt 序号', async () => {
    const poll = vi.fn(async (_attempt: number) => ({ status: 'pending' } as DevicePollResult))
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal })

    // 30s 超时 / 5s 间隔 → 共 6 次 poll（0..5），最后一次 sleep 后到达 deadline
    await vi.advanceTimersByTimeAsync(30_000)

    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' })
    expect(poll.mock.calls.map((c) => c[0])).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('slow_down 带 intervalSeconds 时直接采用服务器值', async () => {
    const results: DevicePollResult[] = [
      { status: 'slow_down', intervalSeconds: 2 },
      { status: 'complete', value: 'done' },
    ]
    const poll = vi.fn(async () => results.shift() as DevicePollResult)
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal })

    // 默认 interval 5s：slow_down 后应变为 2s，advance 2s 即触发第二次 poll
    await vi.advanceTimersByTimeAsync(2000)

    await expect(p).resolves.toEqual({ ok: true, value: 'done' })
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('slow_down 无 intervalSeconds 时按 RFC 8628 §3.5 增加 5s', async () => {
    const results: DevicePollResult[] = [
      { status: 'slow_down' },
      { status: 'complete', value: 'done' },
    ]
    const poll = vi.fn(async () => results.shift() as DevicePollResult)
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal })

    // 5s + 5s = 10s：advance 5s 后仍未到第二次 poll
    await vi.advanceTimersByTimeAsync(5000)
    expect(poll).toHaveBeenCalledTimes(1)

    // 再 advance 5s 触发第二次
    await vi.advanceTimersByTimeAsync(5000)
    await expect(p).resolves.toEqual({ ok: true, value: 'done' })
    expect(poll).toHaveBeenCalledTimes(2)
  })

  it('自定义 slowDownIncrementMs 生效', async () => {
    const results: DevicePollResult[] = [
      { status: 'slow_down' },
      { status: 'complete', value: 'done' },
    ]
    const poll = vi.fn(async () => results.shift() as DevicePollResult)
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal, slowDownIncrementMs: 1000 })

    // 5s + 1s = 6s
    await vi.advanceTimersByTimeAsync(6000)
    await expect(p).resolves.toEqual({ ok: true, value: 'done' })
  })

  it('poll 返回 failed 时直接返回 reason failed', async () => {
    const poll = vi.fn(async () => ({ status: 'failed', message: 'device not approved' } as DevicePollResult))
    const signal = controller().signal
    const result = await runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal })

    expect(result).toEqual({ ok: false, reason: 'failed', message: 'device not approved' })
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('超过 expiresInSeconds 绝对超时返回 reason timeout', async () => {
    const poll = vi.fn(async () => ({ status: 'pending' } as DevicePollResult))
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 1, signal })

    // 第一次 poll 立即执行，之后 sleep min(5s, remaining)，advance 1s 到 deadline
    await vi.advanceTimersByTimeAsync(1000)

    await expect(p).resolves.toEqual({ ok: false, reason: 'timeout' })
  })

  it('运行中 abort 返回 reason aborted', async () => {
    const poll = vi.fn(async () => ({ status: 'pending' } as DevicePollResult))
    const ac = controller()
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal: ac.signal })

    // flush 第一次 poll + 注册 sleep
    await vi.advanceTimersByTimeAsync(0)
    expect(poll).toHaveBeenCalledTimes(1)

    ac.abort()
    await expect(p).resolves.toEqual({ ok: false, reason: 'aborted', message: CANCEL_MESSAGE })
  })

  it('调用前已 abort 则立即返回 aborted 且不发起 poll', async () => {
    const ac = controller()
    ac.abort()
    const poll = vi.fn(async () => ({ status: 'pending' } as DevicePollResult))
    const result = await runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal: ac.signal })

    expect(result).toEqual({ ok: false, reason: 'aborted', message: CANCEL_MESSAGE })
    expect(poll).not.toHaveBeenCalled()
  })

  it('waitBeforeFirstPoll 先等一个 interval 再首次 poll', async () => {
    const poll = vi.fn(async () => ({ status: 'complete', value: 1 } as DevicePollResult))
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal, waitBeforeFirstPoll: true })

    await vi.advanceTimersByTimeAsync(4999)
    expect(poll).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(p).resolves.toEqual({ ok: true, value: 1 })
    expect(poll).toHaveBeenCalledTimes(1)
  })

  it('minIntervalMs 下限生效（服务器 interval 小于下限时被抬升）', async () => {
    const results: DevicePollResult[] = [
      { status: 'slow_down', intervalSeconds: 0.2 },
      { status: 'complete', value: 'done' },
    ]
    const poll = vi.fn(async () => results.shift() as DevicePollResult)
    const signal = controller().signal
    const p = runDeviceCodeFlow({ poll, expiresInSeconds: 30, signal })

    // 服务器 interval 0.2s < minIntervalMs 1s → 抬升到 1s
    await vi.advanceTimersByTimeAsync(1000)
    await expect(p).resolves.toEqual({ ok: true, value: 'done' })
  })
})
