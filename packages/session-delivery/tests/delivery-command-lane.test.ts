/**
 * 无标记条目内核契约测试（pi1-disposition-chat-flow D2②/D14⑥ 起源；ADR-0112 首败即停
 * 统一语义 + skill-input-marker-pollution 技能通路并入后为「无标记条目」统一契约）：
 * - 首败即停（ADR-0112）：port.send 失败一次即收口，全条目统一（无 backoff 重试链）——
 *   unmarked 条目从内核移除（无 tombstone）、checked 条目 reject、普通 send() 条目
 *   onSettled('rejected') 逐条上报后移除
 * - failInFlight：断连事件驱动的显式失败终局——in-flight 条目批量转 failed（留守活跃集
 *   等用户处置），queued 条目不触碰
 * - D2② 组批隔离：无标记条目与普通条目同窗挂账 / 同队列积累时无标记条目恒单独成批
 *   （port.send 收到裸文本，不被 BATCH_SEP 拼接为混合 composed——拼接文本使命令解析与
 *   适配器全文身份匹配必然 miss）+ 普通条目合批语义不变（对照）
 * - F1-11：handled 终局路径 checked waiter 受理口径 settle
 *
 * [已不可达用例删除登记] 原「G3 闸②：settle 兜底按命令条目豁免 + 普通条目 60s 兜底」
 * 两用例随 port.send settle 挂死兜底整体退役（ADR-0112 范围纪律：信任边界内不设防，
 * 挂死处置 = 用户重启）而不可达，2026-10-05 投递域清理批次删除。
 *
 * 运行：cd packages/session-delivery && npx vitest run tests/delivery-command-lane.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import type { DeliveryMessage } from '../src/types.js'
import { makeBusyParkPort, makeMockPort, textMsg } from './helpers.js'

function msg(content: string): DeliveryMessage {
  return { payload: { kind: 'text', content } }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('首败即停（ADR-0112 统一语义，backoff 自动重试链退役）', () => {
  it('send() 通路 unmarked 条目：首败从内核移除，不重试（port.send 恰一次）', async () => {
    let calls = 0
    const port = makeMockPort({
      send: () => {
        calls += 1
        return Promise.reject(new Error('port rejected'))
      },
    })
    const handle = createDelivery(port)
    // 非 checked 提交（send()）的 unmarked 条目：unmarked 经 opts 随条目下发
    handle.send(msg('/todos'), { unmarked: true })
    await vi.advanceTimersByTimeAsync(1_000) // 越过原 backoff.ms=100 若干倍（无重试触发点）
    await Promise.resolve()
    // 首败即停：条目已移除（无 tombstone——未进通道无判重语义），无重试
    expect(calls).toBe(1)
    expect(handle.entriesFull().active.some((e) => e.payload.kind === 'text' && e.payload.content === '/todos')).toBe(false)
    expect(handle.entriesFull().tombstones.length).toBe(0)
  })

  it('对照：普通条目同形态首败即停——onSettled rejected 逐条上报后移除（重试决策归消费方）', async () => {
    let calls = 0
    const settled: Array<{ content: string; outcome: string }> = []
    const port = makeMockPort({
      send: () => {
        calls += 1
        return Promise.reject(new Error('transient'))
      },
    })
    const handle = createDelivery(port, {
      onSettled: (m, outcome) => settled.push({ content: m.payload.kind === 'text' ? m.payload.content : '', outcome }),
    })
    handle.send(msg('普通消息'))
    await vi.advanceTimersByTimeAsync(1_000)
    await Promise.resolve()
    // 统一首败即停：恰一次发送 + 失败通知面（onSettled rejected）+ 条目移除（无 tombstone）
    expect(calls).toBe(1)
    expect(settled).toEqual([{ content: '普通消息', outcome: 'rejected' }])
    expect(handle.entriesFull().active.length).toBe(0)
    expect(handle.entriesFull().tombstones.length).toBe(0)
  })

  it('checked 条目（含 unmarked）：首败 reject 即停（入口即拦语义）', async () => {
    const port = makeMockPort({
      send: () => Promise.reject(new Error('port down')),
    })
    const handle = createDelivery(port)
    const checked = handle.sendChecked(msg('/plan'), { id: 'cmd-2', unmarked: true })
    await expect(checked).rejects.toThrow('port down')
    await Promise.resolve()
    expect(handle.entriesFull().active.some((e) => e.id === 'cmd-2')).toBe(false)
    handle.dispose()
  })
})

describe('failInFlight：断连事件驱动的显式失败终局（ADR-0112）', () => {
  it('in-flight 条目转 failed（留守活跃集）+ onSettled rejected；queued 条目不触碰', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const settled: string[] = []
    const handle = createDelivery(port, {
      onSettled: (_m, outcome) => settled.push(outcome),
    })
    // 第一条：受理 → in-flight（sendChecked 受理口径 resolve）
    const p1 = handle.sendChecked(textMsg('msg1'), { id: 'e-1' })
    sendResolve!()
    await p1
    expect(handle.entriesFull().active[0]!.state).toBe('in-flight')
    // 第二条：busy 留守 queued（busy gate 关闸，不出站）
    port.idle = false
    handle.send(textMsg('msg2'), { id: 'e-2' })
    expect(handle.entriesFull().active.find((e) => e.id === 'e-2')!.state).toBe('queued')

    const n = handle.failInFlight('pi connection lost')
    expect(n).toBe(1)
    const full = handle.entriesFull()
    expect(full.active.find((e) => e.id === 'e-1')!.state).toBe('failed')
    expect(full.active.find((e) => e.id === 'e-2')!.state).toBe('queued')
    expect(settled).toEqual(['rejected'])
    handle.dispose()
  })

  it('failed 条目可经 requeue 重投（resync 用户重试通路）', async () => {
    let sendResolve: (() => void) | undefined
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => { sendResolve = resolve }),
    })
    const handle = createDelivery(port)
    const p1 = handle.sendChecked(textMsg('msg1'), { id: 'e-1' })
    sendResolve!()
    await p1
    expect(handle.failInFlight('pi connection lost')).toBe(1)
    // 用户重试：failed → queued → 重投（受理回执到达后转 in-flight）
    expect(handle.requeue(['e-1'])).toBe(1)
    expect(handle.entriesFull().active.find((e) => e.id === 'e-1')!.state).toBe('queued')
    sendResolve!()
    await vi.advanceTimersByTimeAsync(0)
    expect(handle.entriesFull().active.find((e) => e.id === 'e-1')!.state).toBe('in-flight')
    handle.dispose()
  })

  it('幂等：无 in-flight 条目时 failInFlight 返回 0、零回调', () => {
    const settled: string[] = []
    const port = makeMockPort()
    const handle = createDelivery(port, {
      onSettled: (_m, outcome) => settled.push(outcome),
    })
    port.idle = false // busy：条目留守 queued（未受理，不属 failInFlight 触达面）
    handle.send(textMsg('msg1'))
    expect(handle.failInFlight('pi connection lost')).toBe(0)
    expect(settled).toEqual([])
    handle.dispose()
  })
})

describe('D2② 组批隔离：无标记条目不与普通条目拼为混合 composed', () => {
  /** BATCH_SEP 字面量（与 delivery.ts buildBatchPayload 同值镜像，模块私有故本处同值）。 */
  const BATCH_SEP = '\n\n---\n\n'

  function composedOf(call: { msg: DeliveryMessage } | undefined): string {
    const payload = call!.msg.payload
    return payload.kind === 'text' ? payload.content : ''
  }

  it('pump 混合挂账：无标记+普通同窗挂账 → 无标记条目独立成段（port.send 收到裸文本），普通条目随后照常出站', async () => {
    // 每批 send 挂起、逐批放行（advanceTimersByTimeAsync 的微任务 flush 会跑完同步级联，
    // 逐批受控才能逐批断言 composed 形态）
    const resolvers: Array<() => void> = []
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => {
        resolvers.push(resolve)
      }),
    })
    const handle = createDelivery(port)
    const m1 = handle.sendChecked(msg('普通一'), { id: 'm-1' })
    // 在途窗口内连发：无标记 + 普通先后挂账（隔离生效前 pump 会把两者汇为一批拼接出站）
    const c1 = handle.sendChecked(msg('/todos'), { id: 'c-1', unmarked: true })
    const m2 = handle.sendChecked(msg('普通二'), { id: 'm-2' })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sendCalls.length).toBe(1)
    expect(composedOf(port.sendCalls[0])).toBe('普通一')

    resolvers[0]!() // 第一批 settle → pump 组批
    await vi.advanceTimersByTimeAsync(0)
    // 隔离生效：第二批 = 队首无标记条目单独出站（裸文本，无分隔符拼接）
    expect(port.sendCalls.length).toBe(2)
    expect(composedOf(port.sendCalls[1])).toBe('/todos')
    expect(composedOf(port.sendCalls[1])).not.toContain(BATCH_SEP)

    resolvers[1]!()
    await vi.advanceTimersByTimeAsync(0)
    // 无标记批 settle 后剩余普通条目照常出站
    expect(port.sendCalls.length).toBe(3)
    expect(composedOf(port.sendCalls[2])).toBe('普通二')

    resolvers[2]!()
    await Promise.all([m1, c1, m2])
    handle.dispose()
  })

  it('pump 双无标记挂账：无标记批恒单条（两条命令互拼同样使命令解析 miss）', async () => {
    const resolvers: Array<() => void> = []
    const port = makeMockPort({
      send: () => new Promise<void>((resolve) => {
        resolvers.push(resolve)
      }),
    })
    const handle = createDelivery(port)
    const m1 = handle.sendChecked(msg('普通一'), { id: 'm-1' })
    const c1 = handle.sendChecked(msg('/todos'), { id: 'c-1', unmarked: true })
    const c2 = handle.sendChecked(msg('/plan'), { id: 'c-2', unmarked: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sendCalls.length).toBe(1)

    resolvers[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sendCalls.length).toBe(2)
    expect(composedOf(port.sendCalls[1])).toBe('/todos')
    expect(composedOf(port.sendCalls[1])).not.toContain(BATCH_SEP)

    resolvers[1]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(port.sendCalls.length).toBe(3)
    expect(composedOf(port.sendCalls[2])).toBe('/plan')
    expect(composedOf(port.sendCalls[2])).not.toContain(BATCH_SEP)

    resolvers[2]!()
    await Promise.all([m1, c1, c2])
    handle.dispose()
  })

  it('doSend 混合队列：busy park 积累的无标记+普通条目 → 无标记条目单独出站，剩余普通条目合批语义不变（对照）', async () => {
    const bp = makeBusyParkPort()
    bp.setIdle(false) // busy：条目积累（busy park 合批窗口）
    const handle = createDelivery(bp.port)
    handle.send(msg('普通A'), { id: 'a-1' })
    handle.send(msg('/todos'), { id: 'b-1', unmarked: true })
    handle.send(msg('普通C'), { id: 'c-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(bp.port.sendCalls.length).toBe(0)

    bp.setIdle(true)
    bp.fireSettled() // settled 边沿 → flush → doSend 组批
    await vi.advanceTimersByTimeAsync(0)
    // 隔离：第一批 = 队列中的无标记条目单独出站（裸文本）；条目受理后转 in-flight，
    // busy gate 内查在途条目即关闸（设计内行为），第二批等下一边沿
    expect(bp.port.sendCalls.length).toBe(1)
    expect(composedOf(bp.port.sendCalls[0])).toBe('/todos')
    expect(composedOf(bp.port.sendCalls[0])).not.toContain(BATCH_SEP)

    expect(handle.confirmDelivered('b-1')).toBe(true) // 送达回执（message_end 命中模拟）
    bp.fireSettled() // 下一边沿 → 剩余普通条目合批出站（既有合批语义零变化）
    await vi.advanceTimersByTimeAsync(0)
    expect(bp.port.sendCalls.length).toBe(2)
    expect(composedOf(bp.port.sendCalls[1])).toBe(`普通A${BATCH_SEP}普通C`)
    handle.dispose()
  })
})

describe('F1-11：handled 终局路径 checked waiter 受理口径 settle', () => {
  it('port.send 实现内先 confirmDelivered 再 settle（registry deliverOne 同构时序）→ sendChecked promise resolve 且 tombstone 在册', async () => {
    // handled 终局形态（session-delivery-registry deliverOne 同构）：port.send 实现
    // 内部先 confirmDelivered（finalizeEntry 同步摘批 + 写 tombstone），随后 promise
    // 才 settle——onSendOk 的 settleChecked 只 settle 当前批成员（批已不含该条目），
    // 修复前 checked waiter 永不 settle、恒滞留 checkedPending（waiter 泄漏）。
    const handleBox: { current: ReturnType<typeof createDelivery> | undefined } = {
      current: undefined,
    }
    const port = makeMockPort({
      send: async () => {
        handleBox.current!.confirmDelivered('cmd-handled')
        return undefined
      },
    })
    const handle = createDelivery(port)
    handleBox.current = handle
    const checked = handle.sendChecked(msg('/todos'), { id: 'cmd-handled', unmarked: true })
    // 修复前此 await 永挂（vitest 默认超时红）；修复后受理口径随 delivered 终局 resolve
    await checked
    const full = handle.entriesFull()
    expect(full.active.some((e) => e.id === 'cmd-handled')).toBe(false)
    expect(full.tombstones.some((t) => t.id === 'cmd-handled' && t.state === 'delivered')).toBe(true)
    // waiter 已随终局了结（checkedPending 清空）：dispose 不再有挂账可 reject（无
    // 未处理 rejection 即 waiter 已被 resolveWaitersOf 移除的间接锚定）
    handle.dispose()
    await checked
  })
})
