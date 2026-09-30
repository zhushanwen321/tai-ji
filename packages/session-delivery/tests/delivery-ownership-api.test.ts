/**
 * u1 所有权 API 全行为（D9③/D5②）：confirmDelivered / requeue / cancel / drain
 * 与判重 tombstone。
 *
 * - confirmDelivered：正规路径 / rebuild 直确认 / 幂等 / tombstone 产生
 * - requeue：多条保相对序至队首（D3 own 处置）/ queued 幂等 / 终态拒绝
 * - cancel：queued 全文快照（D-3 草稿恢复）/ in-flight 收回失败事实优先 delivered /
 *   checked 挂账 reject
 * - drain：全量取回 + 全记 cancelled tombstone + 后续不投递 + 迟到回执安全
 * - tombstone 判重（D5②）：resync 重报已 delivered/cancelled 的 id 不重投；
 *   tombstone 全量保留不设窗口；未显式传 id 的消息不参与幂等（v1 兼容）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('u1-api confirmDelivered', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('返回 true 且 tombstone 携带 lane/settledAt；二次调用幂等 false', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1', lane: 'steer' })
    expect(handle.confirmDelivered('u-1')).toBe(true)
    expect(handle.entriesFull().tombstones).toEqual([
      { id: 'u-1', state: 'delivered', lane: 'steer', settledAt: expect.any(Number) },
    ])
    expect(handle.confirmDelivered('u-1')).toBe(false) // 幂等：已终态
    expect(handle.entriesFull().tombstones).toHaveLength(1)

    handle.dispose()
  })

  it('onSettled("delivered") 仅由本调用驱动（D9⑤），msg 为原始消息引用', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    const msg = textMsg('m1', { dedupeKey: 'k1' })
    handle.send(msg, { id: 'u-1' })
    expect(onSettled).not.toHaveBeenCalled() // 受理不回调

    handle.confirmDelivered('u-1')
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled.mock.calls[0]![0]).toBe(msg)
    expect(onSettled.mock.calls[0]![1]).toBe('delivered')

    handle.dispose()
  })
})

describe('u1-api requeue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('多条保相对序至队首：[B,A] 重排后重投序为 B、A、C（D3 保持原相对序）', () => {
    // busy 起步：A、B 入队排队；settled 边沿合批投出受理
    let idle = false
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => idle,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('A'), { id: 'u-a' })
    handle.send(textMsg('B'), { id: 'u-b' })
    idle = true
    settledCb!() // 合批投出 A+B → 双双受理 in-flight（滞留形态）

    // C 在 A、B 滞留期间入队（busy，等 gate）
    idle = false
    handle.send(textMsg('C'), { id: 'u-c' })

    // 对账回收：clear_queue 全收 → own 集 [B, A] 重排至队首（保 ids 相对序）
    idle = true
    expect(handle.requeue(['u-b', 'u-a'])).toBe(2)

    // 重投：B、A、C 一起成批，composed 顺序 = 队列序 = B、A、C
    expect(port.sendCalls).toHaveLength(2)
    expect(port.sendCalls[1]!.msg.payload.content).toBe('B\n\n---\n\nA\n\n---\n\nC')

    handle.dispose()
  })

  it('queued 条目幂等跳过（已在队列），混合集只重排合法条目', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('A'), { id: 'u-a' }) // queued（busy 留队）
    handle.send(textMsg('B'), { id: 'u-b' }) // queued

    // u-a 在队列（跳过）、u-x 未知（跳过）→ 重排数 0
    expect(handle.requeue(['u-a', 'u-x'])).toBe(0)
    // 队列序不变：A 仍在 B 前
    expect(handle.entriesFull().active.map((e) => e.id)).toEqual(['u-a', 'u-b'])

    handle.dispose()
  })

  it('requeue 后 busy 时经 gate 排队，settled 边沿再投（不绕 gate 强发）', () => {
    let idle = true
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => idle,
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {}
      },
    })
    const handle = createDelivery(port)

    handle.send(textMsg('A'), { id: 'u-a' })
    expect(port.sendCalls).toHaveLength(1) // idle 立即投，受理

    // 对账回收后目标 session busy
    idle = false
    handle.requeue(['u-a'])
    expect(port.sendCalls).toHaveLength(1) // busy gate 拦下，不强发

    idle = true
    settledCb!()
    expect(port.sendCalls).toHaveLength(2) // 边沿驱动重投
    expect(port.sendCalls[1]!.msg.payload.content).toBe('A')

    handle.dispose()
  })

  it('撤销待收回条目拒绝重排：返回数不含它，留守原态且撤销标记不清（dmg-r1-2）', () => {
    let idle = true
    const port = makeMockPort({ isIdle: () => idle })
    const handle = createDelivery(port)

    handle.send(textMsg('A'), { id: 'u-a' }) // idle 立即投 → 受理 in-flight
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    expect(handle.cancel('u-a').kind).toBe('reclaim-requested') // 标记待收回

    // 对账器回收重排：待收回条目被拒（重排会清撤销标记复活消息）
    idle = false
    expect(handle.requeue(['u-a'])).toBe(0)
    expect(handle.entriesFull().active).toMatchObject([{ id: 'u-a', state: 'in-flight' }])

    // 意图留守下撤销仍可兑现：收回确认（再次 cancel）终态
    idle = true
    expect(handle.cancel('u-a').kind).toBe('cancelled')
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toMatchObject([{ id: 'u-a', state: 'cancelled' }])

    handle.dispose()
  })
})

describe('u1-api cancel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancelled 快照含 payload 全文（D-3：草稿恢复依赖全文）', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('full text to restore', { dedupeKey: 'k1' }), { id: 'u-1' })
    const result = handle.cancel('u-1')

    expect(result.kind).toBe('cancelled')
    if (result.kind === 'cancelled') {
      expect(result.entry.payload).toEqual({ kind: 'text', content: 'full text to restore' })
      expect(result.entry.settledAt).toBeTypeOf('number')
    }

    handle.dispose()
  })

  it('in-flight 撤销后文本实际进 transcript：confirmDelivered 事实优先转 delivered', () => {
    const onSettled = vi.fn()
    const port = makeMockPort()
    const handle = createDelivery(port, { onSettled })

    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(handle.cancel('u-1').kind).toBe('reclaim-requested') // 标记待收回

    // 收回失败但 message_end 到达（文本已进 transcript）→ delivered 事实 > cancel 意图
    expect(handle.confirmDelivered('u-1')).toBe(true)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'delivered' })
    expect(onSettled).toHaveBeenCalledWith(expect.anything(), 'delivered')

    handle.dispose()
  })

  it('checked 条目 cancel：挂账 promise reject（不留悬挂）', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('m1'), { id: 'u-1' })
    // 出站在途（queued）即撤：本地移除 + waiter reject
    expect(handle.cancel('u-1').kind).toBe('cancelled')
    await expect(promise).rejects.toThrow('delivery cancelled: u-1')
    expect(handle.entriesFull().active).toHaveLength(0)

    // 迟到的受理回执不炸（条目已不在册）
    sendResolve!()
    await vi.advanceTimersByTimeAsync(0)

    handle.dispose()
  })

  it('出站批次中 cancel 后，迟到受理回执不转移（在册守卫）', async () => {
    const resolvers: (() => void)[] = []
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { resolvers.push(resolve) }),
    })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.send(textMsg('m2'), { id: 'u-2' })
    // u-1 在第 1 批出站在途；撤第 1 条（本地移除），u-2 留队
    expect(handle.cancel('u-1').kind).toBe('cancelled')

    resolvers[0]!() // 第 1 批（u-1）的受理回执迟到到达
    await vi.advanceTimersByTimeAsync(0)
    // 第 1 条已 cancelled 不转移复活；u-2 经 pump 走第 2 批出站在途
    expect(handle.entriesFull().active.map((e) => e.id)).toEqual(['u-2'])
    expect(handle.entriesFull().active[0]!.state).toBe('queued')

    resolvers[1]!() // u-2 受理
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')

    handle.dispose()
  })

  it('出站批次错误重试窗口内 cancel：backoff 到期重试不重发已取消条目（dmg-r1-1）', () => {
    // busy park 两条合批出站 → port.send 首投失败进 backoff 重试窗口 → 窗口内撤 u-1
    // → 重试到期只重发 u-2（修复前：inflightBatch 残留 u-1，composed 原样重发已撤销文本）
    let calls = 0
    let idle = false
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => idle,
      send: () => {
        calls++
        if (calls === 1) throw new Error('transient send failure')
        return undefined
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { backoff: { ms: 100, max: 50 } })

    handle.send(textMsg('m1'), { id: 'u-1' }) // busy 留队
    handle.send(textMsg('m2'), { id: 'u-2' })
    idle = true
    settledCb!() // settled 边沿 flush → 合批 [u-1, u-2] 出站 → 首投失败
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('m1\n\n---\n\nm2')

    // 重试窗口内撤销 u-1（queued 分支本地终结 + 出批）
    expect(handle.cancel('u-1').kind).toBe('cancelled')
    vi.advanceTimersByTime(100) // backoff 到期 → 重试
    expect(port.sendCalls).toHaveLength(2)
    expect(port.sendCalls[1]!.msg.payload.content).toBe('m2') // 已撤销条目不随重试重发
    expect(handle.entriesFull().active.map((e) => e.id)).toEqual(['u-2'])
    expect(handle.entriesFull().tombstones).toMatchObject([{ id: 'u-1', state: 'cancelled' }])

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('出站批次重试窗口内 cancel 唯一条目：backoff 到期按空收口（不重发不挂死）', () => {
    let calls = 0
    let idle = false
    let settledCb: (() => void) | undefined
    const port = makeMockPort({
      isIdle: () => idle,
      send: () => {
        calls++
        if (calls === 1) throw new Error('transient send failure')
        return undefined
      },
      subscribeSettled: (cb) => {
        settledCb = cb
        return () => {
          settledCb = undefined
        }
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { backoff: { ms: 100, max: 50 } })

    handle.send(textMsg('m1'), { id: 'u-1' }) // busy 留队
    idle = true
    settledCb!() // 单条批出站 → 首投失败进重试窗口
    expect(port.sendCalls).toHaveLength(1)

    expect(handle.cancel('u-1').kind).toBe('cancelled')
    vi.advanceTimersByTime(100) // 重试到期：批已空 → 按空收口
    expect(port.sendCalls).toHaveLength(1) // 无第二次 send
    expect(handle.entriesFull().active).toHaveLength(0)

    // 收口后队列不挂死：新消息正常出站
    handle.send(textMsg('m2'), { id: 'u-2' })
    expect(port.sendCalls).toHaveLength(2)
    expect(port.sendCalls[1]!.msg.payload.content).toBe('m2')

    warnSpy.mockRestore()
    handle.dispose()
  })
})

describe('u1-api confirmAccepted（分段受理登记，dmg-r1-4）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('批内 queued 条目受理登记：转 in-flight + 出批 + checked waiter 受理口径 resolve', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('m1'), { id: 'u-1' })
    expect(handle.entriesFull().active[0]!.state).toBe('queued')
    expect(handle.confirmAccepted('u-1')).toBe(true)
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    await expect(promise).resolves.toBeUndefined() // 受理口径 settle（D9⑤）

    // 迟到的批次受理回执：已登记条目不二次转移、不炸
    sendResolve!()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')

    // 送达回执照常驱动 delivered（受理 ≠ 送达，两阶段第二阶段不变）
    expect(handle.confirmDelivered('u-1')).toBe(true)
    expect(handle.entriesFull().tombstones).toMatchObject([{ id: 'u-1', state: 'delivered' }])

    handle.dispose()
  })

  it('非出站批成员（gate 等待中）与未知 id 登记拒绝：不转移不 settle', () => {
    // busy gate 拦下的 queued 条目未触达底层通道，登记即虚报受理（拒）
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' }) // busy：留队等 gate，不在出站批内
    expect(handle.confirmAccepted('u-1')).toBe(false)
    expect(handle.confirmAccepted('u-unknown')).toBe(false)
    expect(handle.entriesFull().active[0]!.state).toBe('queued')

    handle.dispose()
  })
})

describe('u1-api drain', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('混合队列全量取回：queued + in-flight + failed 全返回，条目清空 + 全记 cancelled tombstone', () => {
    // 构造：第 1 次 port.send 成功（A 受理 in-flight）；第 2 次起全败（B+C 批重试耗尽 failed）
    let calls = 0
    let idle = true
    const port = makeMockPort({
      isIdle: () => idle,
      send: () => {
        calls++
        if (calls >= 2) throw new Error('fail after first delivery')
        return undefined
      },
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handle = createDelivery(port, { backoff: { ms: 1, max: 0 } })

    handle.send(textMsg('A'), { id: 'u-a' }) // 立即投 → 受理 in-flight
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')

    idle = false
    handle.send(textMsg('B'), { id: 'u-b' }) // busy 留队
    handle.send(textMsg('C'), { id: 'u-c' })
    idle = true
    handle.flush()
    // B+C 合批投出，第 2 次 port.send 抛错 → 零重试上限 → 双双 failed
    vi.advanceTimersByTime(10)
    expect(handle.entriesFull().active.map((e) => e.state)).toEqual(['in-flight', 'failed', 'failed'])

    const drained = handle.drain()
    expect(drained.map((d) => d.id)).toEqual(['u-a', 'u-b', 'u-c'])
    expect(drained.map((d) => (d.payload.kind === 'text' ? d.payload.content : ''))).toEqual([
      'A',
      'B',
      'C',
    ])
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones.map((t) => t.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ])
    expect(handle.depth()).toBe(0)

    warnSpy.mockRestore()
    handle.dispose()
  })

  it('drain 后无后续投递（port.send 不再被调），同 id 重报被 tombstone 吞', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('A'), { id: 'u-a' })
    handle.send(textMsg('B'), { id: 'u-b' })
    expect(port.sendCalls).toHaveLength(0)

    expect(handle.drain()).toHaveLength(2)
    const callsAfterDrain = port.sendCalls.length

    // drain 后占用方消失（idle 翻转 + settled 边沿）也不投
    ;(port as { idle: boolean }).idle = true
    handle.flush()
    vi.advanceTimersByTime(60_000) // watchdog 也无货可发
    expect(port.sendCalls).toHaveLength(callsAfterDrain)

    // resync 重报同 id：cancelled tombstone 去重
    handle.send(textMsg('A'), { id: 'u-a' })
    expect(port.sendCalls).toHaveLength(callsAfterDrain)
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })

  it('drain 时挂起 checked reject；出站批迟到回执安全吸收', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)

    const promise = handle.sendChecked(textMsg('m1'), { id: 'u-1' })
    const drained = handle.drain()
    expect(drained).toHaveLength(1)
    await expect(promise).rejects.toThrow('delivery drained')

    // 迟到受理：条目已不在册，无转移无炸
    sendResolve!()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones[0]).toMatchObject({ id: 'u-1', state: 'cancelled' })

    handle.dispose()
  })

  it('空 drain 返回空数组（幂等安全）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    expect(handle.drain()).toEqual([])
    expect(handle.drain()).toEqual([]) // 二次 drain 幂等

    handle.dispose()
  })
})

describe('u1-api tombstone 判重（D5②）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resync 重报已 delivered 的 id：吞掉不重投（tombstone 去重）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.confirmDelivered('u-1')
    expect(port.sendCalls).toHaveLength(1)

    // 断连重连后 renderer resync 重报同 clientUuid
    handle.send(textMsg('m1'), { id: 'u-1' })
    expect(port.sendCalls).toHaveLength(1) // 不重投
    expect(handle.entriesFull().active).toHaveLength(0)
    expect(handle.entriesFull().tombstones).toHaveLength(1)

    handle.dispose()
  })

  it('resync 重报活跃集中的 id：吞掉不重复入队（重放风暴去重）', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.send(textMsg('m1'), { id: 'u-1' }) // 同 id 重报（活跃条目在册）
    expect(handle.entriesFull().active).toHaveLength(1)

    handle.dispose()
  })

  it('cancelled tombstone 防复活：cancel 确认帧丢失窗口内 resync 重报不重投', () => {
    const port = makeMockPort({ isIdle: () => false })
    const handle = createDelivery(port)

    handle.send(textMsg('m1'), { id: 'u-1' })
    handle.cancel('u-1')

    handle.send(textMsg('m1'), { id: 'u-1' }) // resync 重报已撤销消息
    expect(port.sendCalls).toHaveLength(0)
    expect(handle.entriesFull().active).toHaveLength(0)

    handle.dispose()
  })

  it('sendChecked 同 id 重报：幂等 resolve（不 reject 不重投）', async () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    await expect(handle.sendChecked(textMsg('m1'), { id: 'u-1' })).resolves.toBeUndefined()
    handle.confirmDelivered('u-1')

    // 二次重报：已见 tombstone → 静默 resolve
    await expect(handle.sendChecked(textMsg('m1'), { id: 'u-1' })).resolves.toBeUndefined()
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })

  it('未显式传 id 的消息不参与幂等判重（v1「无 dedupe 配置不去重」语义保持）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    // 申报 acceptance（受理即落地）：焦点是判重语义，避免首条 in-flight 挂住 gate
    handle.send(textMsg('same'), { receiptAnchor: 'acceptance' })
    handle.send(textMsg('same'), { receiptAnchor: 'acceptance' }) // 同内容、无 id、无 dedupe 配置 → 都投
    expect(port.sendCalls).toHaveLength(2)

    handle.dispose()
  })

  it('tombstone 全量保留不设窗口：>50 条 delivered 后判重锚不丢（D5② 正确性不依赖投影窗口）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port)

    for (let i = 0; i < 60; i++) {
      handle.send(textMsg(`m${i}`), { id: `u-${i}` })
      handle.confirmDelivered(`u-${i}`)
    }

    // 判重表 60 条全量（含最早 10 条——投影窗口只留 50 条完整条目）
    expect(handle.entriesFull().tombstones).toHaveLength(60)
    handle.send(textMsg('m0'), { id: 'u-0' }) // 最早的 id 重报仍被吞
    expect(port.sendCalls).toHaveLength(60)

    handle.dispose()
  })
})
