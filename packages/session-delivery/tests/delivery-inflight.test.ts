/**
 * A6-inflight: in-flight 防重 + sendChecked + onSettled + 首败即停（ADR-0122，
 * 原 D4 错误重试链已退役——重试决策归消费方）。
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

    const handle = createDelivery(port)

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

    const handle = createDelivery(port)

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
    const handle = createDelivery(port)

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

describe('A6-inflight port.send 首败即停（ADR-0122：失败不静默、不重试）', () => {
  it('#2 同步抛错 → 首败即 rejected + 条目移除（无重试）', () => {
    const settled: string[] = []
    const port = makeMockPort({
      send: () => { throw new Error('transient') },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      onSettled: (_m, outcome) => settled.push(outcome),
    })

    handle.send(textMsg('hello'))
    expect(port.sendCalls).toHaveLength(1) // 恰一次投递
    expect(settled).toEqual(['rejected']) // 失败显式上报
    expect(handle.entriesFull().active).toHaveLength(0) // 条目移除，不留守
    expect(handle.entriesFull().tombstones).toHaveLength(0) // 未受理无判重语义

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('#2 async port.send reject 同形态：首败即 rejected（Promise 拒绝等价抛错）', async () => {
    const settled: string[] = []
    const port = makeMockPort({
      send: () => Promise.reject(new Error('rpc reset')),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      onSettled: (_m, outcome) => settled.push(outcome),
    })

    handle.send(textMsg('hello'))
    await new Promise((r) => setTimeout(r, 0)) // Promise reject（宏任务）结算
    expect(port.sendCalls).toHaveLength(1)
    expect(settled).toEqual(['rejected'])
    expect(handle.entriesFull().active).toHaveLength(0)

    warnSpy.mockRestore()
    handle.dispose()
  })
})

describe('A6-inflight onSettled 终态信号', () => {
  it('port.send 成功后条目 in-flight；confirmDelivered 驱动 delivered 回调（D9⑤ 送达口径）', () => {
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort()
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))
    // 受理 ≠ 送达：受理成功不回调
    expect(settledCalls).toHaveLength(0)

    const id = handle.entriesFull().active[0]!.id
    handle.confirmDelivered(id)
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('delivered')
    expect(settledCalls[0]!.msg.payload.content).toBe('hello')

    handle.dispose()
  })

  it('port.send 抛错 → 回调 rejected（首败即停，ADR-0122）', () => {
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => { throw new Error('fail') },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
      onSettled: (msg, outcome) => settledCalls.push({ msg, outcome }),
    })

    handle.send(textMsg('hello'))

    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('rejected')

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('async port.send resolve 后条目 in-flight；confirmDelivered 驱动 delivered 回调（D9⑤）', async () => {
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
    expect(settledCalls).toHaveLength(0) // 受理 ≠ 送达

    const id = handle.entriesFull().active[0]!.id
    handle.confirmDelivered(id)
    expect(settledCalls).toHaveLength(1)
    expect(settledCalls[0]!.outcome).toBe('delivered')

    handle.dispose()
  })

  it('async port.send reject → 回调 rejected（首败即停，ADR-0122）', async () => {
    let sendReject: ((err: Error) => void) | undefined
    const settledCalls: { msg: DeliveryMessage; outcome: string }[] = []
    const port = makeMockPort({
      send: () => new Promise<void>((_, reject) => { sendReject = reject }),
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, {
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
