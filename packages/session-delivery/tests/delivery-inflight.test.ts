/**
 * A6-inflight: in-flight 防重 + sendChecked + onSettled + 错误重试（D4）。
 */
import { describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A6-inflight in-flight 防重: 单 handle 至多一个 flush 在途', () => {
  it('send 入队 → flush 中 → 再 settled 边沿不并发 port.send', () => {
    let settledCb: (() => void) | undefined
    let sendCallCount = 0

    const port = makeMockPort({
      send: (msg, intent) => {
        void msg
        void intent
        sendCallCount++
        return undefined
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })

    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)
    expect(sendCallCount).toBe(1)

    settledCb!()
    expect(port.sendCalls).toHaveLength(1)
    expect(sendCallCount).toBe(1)

    handle.dispose()
  })

  it('async port.send 期间 settled 边沿不并发', async () => {
    let sendResolve: (() => void) | undefined
    let settledCb: (() => void) | undefined

    const port = makeMockPort({
      send: (msg, intent) => {
        void msg
        void intent
        return new Promise<void>((resolve) => { sendResolve = resolve })
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => { settledCb = undefined }
      },
    })

    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)

    port.idle = true
    settledCb!()
    expect(port.sendCalls).toHaveLength(1)

    sendResolve!()
    await new Promise((r) => setTimeout(r, 0))

    handle.dispose()
  })

  it('#3 sendChecked 挂起期间 settled 边沿 / flush 不二发（F3 双注入防护）', async () => {
    let sendResolve: (() => void) | undefined
    let settledCb: (() => void) | undefined

    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {}
      },
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(1)

    port.idle = true
    settledCb!() // 挂起期间 settled 边沿
    handle.flush() // 挂起期间外部 flush
    expect(port.sendCalls).toHaveLength(1) // 同一消息只 port.send 一次

    sendResolve!()
    await promise
    expect(port.sendCalls).toHaveLength(1) // resolve 后无补发
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })
})

describe('A6-inflight sendChecked', () => {
  it('resolve=入队且 port.send 受理成功', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).resolves.toBeUndefined()
    expect(port.sendCalls).toHaveLength(1)
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('port.send 抛错 reject', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort({
      send: () => { throw new Error('pi dead') },
    })
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).rejects.toThrow('pi dead')
    expect(handle.depth()).toBe(0)

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('#8 目标 busy（pi 活着）→ 经投递路径受理入队 → resolve（{queued:true} 语义）', async () => {
    // busy 不再是「入内核队列即 resolve」：直投经 streaming 受理入 pi 队列即回
    // （探针 P1 rtt≈1ms），受理本身即可达性确认
    const port = makeMockPort({
      isIdle: () => false,
    })
    const handle = createDelivery(port, { busyPolicy: 'retry-force' })

    await expect(handle.sendChecked(textMsg('hello'))).resolves.toBeUndefined()
    expect(port.sendCalls).toHaveLength(1) // busy 分支也触达 port.send
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('#8 pi 死（port.send 抛错）且 runtime 标志 busy → sendChecked reject（不返回假 queued）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = makeMockPort({
      isIdle: () => false, // 僵尸 busy 标志：目标 pi 已死但 runtime 侧标志未翻转
      send: () => { throw new Error('pi dead') },
    })
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('hello'))).rejects.toThrow('pi dead')
    expect(handle.depth()).toBe(0) // 失败消息不留内核队列（入口即拦）

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('async port.send resolve 后消息从队列移除', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('hello'))
    expect(handle.depth()).toBe(1) // 在途未终态计入诊断深度

    sendResolve!()
    await promise
    expect(handle.depth()).toBe(0)

    handle.dispose()
  })

  it('disposed 后 sendChecked reject', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)
    handle.dispose()

    await expect(handle.sendChecked(textMsg('hello'))).rejects.toThrow(
      'delivery handle disposed',
    )
  })

  it('dispose 时挂起中的 sendChecked reject（不留永久 pending）', async () => {
    const port = makeMockPort({
      send: () => new Promise<void>(() => {}), // 永不 settle
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('hello'))
    handle.dispose()

    await expect(promise).rejects.toThrow('delivery handle disposed')
  })
})

describe('A6-inflight port.send 错误重试（D4：失败不丢消息）', () => {
  it('#2 前两次抛错第三次成功 → 最终 delivered（消息不出队直到成功）', async () => {
    vi.useFakeTimers()
    let calls = 0
    const settled: string[] = []
    const port = makeMockPort({
      send: () => {
        calls++
        if (calls < 3) throw new Error('transient')
        return undefined
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      backoff: { ms: 100, max: 50 },
      onSettled: (_m, outcome) => settled.push(outcome),
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(1) // 首试抛错
    expect(settled).toEqual([]) // 未终态：重试中
    expect(handle.depth()).toBe(1) // 在途重试中计入深度

    vi.advanceTimersByTime(100)
    expect(port.sendCalls).toHaveLength(2) // 重试 1 又抛错
    expect(settled).toEqual([])

    vi.advanceTimersByTime(100)
    expect(port.sendCalls).toHaveLength(3) // 重试 2 成功
    expect(settled).toEqual(['delivered'])
    expect(handle.depth()).toBe(0)

    warnSpy.mockRestore()
    handle.dispose()
    vi.useRealTimers()
  })

  it('#2 连续抛错达 backoff 上限 → settle rejected + onSettled 上报', () => {
    vi.useFakeTimers()
    const settled: string[] = []
    const port = makeMockPort({
      send: () => { throw new Error('pi stuck') },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      backoff: { ms: 100, max: 3 },
      onSettled: (_m, outcome) => settled.push(outcome),
    })

    handle.send(textMsg('hello'))
    expect(settled).toEqual([])

    // 尝试 1(t0) + 重试 t100/t200/t300 → 第 4 次失败后 attempts=4 > max=3 → rejected
    vi.advanceTimersByTime(300)
    expect(port.sendCalls).toHaveLength(4)
    expect(settled).toEqual(['rejected'])
    expect(handle.depth()).toBe(0) // 终态 rejected，不无限积压

    warnSpy.mockRestore()
    handle.dispose()
    vi.useRealTimers()
  })

  it('#2 async port.send reject 同样走重试（Promise 拒绝等价抛错）', async () => {
    vi.useFakeTimers()
    let calls = 0
    const settled: string[] = []
    const port = makeMockPort({
      send: () => {
        calls++
        if (calls === 1) return Promise.reject(new Error('rpc reset'))
        return Promise.resolve()
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      backoff: { ms: 100, max: 50 },
      onSettled: (_m, outcome) => settled.push(outcome),
    })

    handle.send(textMsg('hello'))
    await vi.advanceTimersByTimeAsync(100)
    expect(port.sendCalls).toHaveLength(2)
    expect(settled).toEqual(['delivered'])

    warnSpy.mockRestore()
    handle.dispose()
    vi.useRealTimers()
  })

  it('#2 park 策略下错误也不无限重试之外排队：达上限同样 rejected', () => {
    // busyPolicy 'park' 管 busy gate；port.send 错误重试是独立恢复路径，同样有上限
    vi.useFakeTimers()
    const settled: string[] = []
    const port = makeMockPort({
      send: () => { throw new Error('boom') },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      busyPolicy: 'park',
      backoff: { ms: 50, max: 1 },
      onSettled: (_m, outcome) => settled.push(outcome),
    })

    handle.send(textMsg('hello'))
    vi.advanceTimersByTime(50)
    expect(port.sendCalls).toHaveLength(2)
    expect(settled).toEqual(['rejected'])

    warnSpy.mockRestore()
    handle.dispose()
    vi.useRealTimers()
  })
})

describe('A6-inflight onSettled 终态信号', () => {
  it('port.send 成功后回调 delivered', () => {
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort()
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))

    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('delivered')
    expect(settledCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('port.send 抛错且零重试上限（max:0）→ 回调 rejected', () => {
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => { throw new Error('fail') },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      backoff: { ms: 0, max: 0 }, // 零重试：首败即终态
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))

    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('rejected')

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('async port.send resolve 后回调 delivered', async () => {
    let sendResolve: (() => void) | undefined
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))
    expect(settledCalls).toHaveLength(0)

    sendResolve!()
    await new Promise((r) => setTimeout(r, 0))
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('delivered')

    handle.dispose()
  })

  it('async port.send reject 且零重试上限（max:0）→ 回调 rejected', async () => {
    let sendReject: ((err: Error) => void) | undefined
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => new Promise<void>((_, reject) => { sendReject = reject }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      backoff: { ms: 0, max: 0 }, // 零重试：首败即终态
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))
    expect(settledCalls).toHaveLength(0)

    sendReject!(new Error('fail'))
    await new Promise((r) => setTimeout(r, 0))
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('rejected')

    warnSpy.mockRestore()
    handle.dispose()
  })
})
