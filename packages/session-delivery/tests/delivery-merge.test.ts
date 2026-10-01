/**
 * A5-merge: mergeHoldActive 谓词语义 + 合批格式 + 非合批 timer 纪律（busy 停车形态）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDelivery } from '../src/delivery.js'
import { makeMockPort, textMsg } from './helpers.js'

describe('A5-merge mergeHoldActive 谓词', () => {
  it('谓词 true 走合批窗口', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)

    vi.useRealTimers()
    handle.dispose()
  })

  it('谓词 false/缺省立即投', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => false,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })

  it('[锁] isIdle=true + mergeHoldActive=true 时仍走合批（禁止 isIdle 参与立即投判定）', () => {
    vi.useFakeTimers()
    const port = makeMockPort()
    port.idle = true
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(0)

    vi.advanceTimersByTime(5000)
    expect(port.sendCalls).toHaveLength(1)

    vi.useRealTimers()
    handle.dispose()
  })

  it('缺省 mergeHoldActive（undefined）+ mergeWindowMs > 0 时立即投', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
    })

    handle.send(textMsg('msg1'))
    expect(port.sendCalls).toHaveLength(1)

    handle.dispose()
  })
})

describe('A5-merge 合批拼接格式', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('多条 text 以 "\\n\\n---\\n\\n" join（text 无 details 出口，不包装 batch）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('msg1'))
    handle.send(textMsg('msg2'))
    handle.send(textMsg('msg3'))

    vi.advanceTimersByTime(5000)

    expect(port.sendCalls).toHaveLength(1)
    const sent = port.sendCalls[0]!.msg
    expect(sent.payload.content).toBe('msg1\n\n---\n\nmsg2\n\n---\n\nmsg3')

    handle.dispose()
  })

  it('#6 custom 合批 items 装载各消息 details（record 顶层字段直达 bg-notify-render）', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send({
      payload: {
        kind: 'custom',
        customType: 'subagent-bg-notify',
        content: 'n1',
        display: true,
        details: { agent: 'a1', status: 'done' },
      },
    })
    handle.send({
      payload: {
        kind: 'custom',
        customType: 'subagent-bg-notify',
        content: 'n2',
        display: true,
        details: { agent: 'a2', status: 'running' },
      },
    })

    vi.advanceTimersByTime(5000)

    expect(port.sendCalls).toHaveLength(1)
    const sent = port.sendCalls[0]!.msg.payload
    expect(sent.kind).toBe('custom')
    expect(sent.content).toBe('n1\n\n---\n\nn2')
    // items 元素 = 消息的 details（record 本体），不再是把 record 藏在
    // payload.details 下的嵌套结构
    expect(sent.details).toEqual({
      batch: true,
      items: [
        { agent: 'a1', status: 'done' },
        { agent: 'a2', status: 'running' },
      ],
    })

    handle.dispose()
  })

  it('#6 custom 无 details 的消息在 items 中装载 payload 本身', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send({
      payload: { kind: 'custom', customType: 't', content: 'with', display: true, details: { k: 1 } },
    })
    handle.send({
      payload: { kind: 'custom', customType: 't', content: 'without', display: true },
    })

    vi.advanceTimersByTime(5000)

    const sent = port.sendCalls[0]!.msg.payload
    expect(sent.details).toEqual({
      batch: true,
      items: [{ k: 1 }, { kind: 'custom', customType: 't', content: 'without', display: true }],
    })

    handle.dispose()
  })

  it('单条消息不包装 batch', () => {
    const port = makeMockPort()
    const handle = createDelivery(port, {
      mergeWindowMs: 5000,
      mergeHoldActive: () => true,
    })

    handle.send(textMsg('solo'))

    vi.advanceTimersByTime(5000)

    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('solo')

    handle.dispose()
  })
})

describe('A5-merge 非合批 timer 纪律（busy 停车形态）', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('非合批 send 只清残留合批 timer，不重设（无孤儿 flush timer 被武装）', () => {
    // busy 停车形态：subscribeSettled 订阅成立但回调从不触发 + busy 滞留 →
    // 消息滞留 queue，唯一出站通道是真正的外部触发（idle + flush）。
    // watchdogMs 拉出观察窗外，隔离「idle 后 watchdog 兜底 flush」对孤儿 timer
    // 观测的干扰。
    const port = makeMockPort({ subscribeSettled: () => () => {} })
    port.idle = false
    const handle = createDelivery(port, {
      mergeWindowMs: 60_000,
      mergeHoldActive: () => true,
      watchdogMs: 3_600_000,
    })

    // 1. 合批 send 武装窗口 timer A；2. 非合批 send 清 A 且不得重设 B
    handle.send(textMsg('m1'), { merge: true })
    handle.send(textMsg('m2'), { merge: false })
    // 有订阅装配 + busy：不启动退避强发，消息滞留 queue
    vi.advanceTimersByTime(100)
    expect(port.sendCalls).toHaveLength(0)

    // 3. 转空闲后推进整个 mergeWindow：若非合批路径重设了 timer，孤儿 timer 到期
    //    flush 会把滞留消息冲出（旧缺陷）；只清不设 → 消息仍等真正的外部触发
    port.idle = true
    vi.advanceTimersByTime(61_000)
    expect(port.sendCalls).toHaveLength(0)

    // 对照：外部 flush 仍可正常触发投递（消息可达，非卡死）
    handle.flush()
    vi.advanceTimersByTime(0)
    expect(port.sendCalls).toHaveLength(1)
    expect(port.sendCalls[0]!.msg.payload.content).toBe('m1\n\n---\n\nm2')

    handle.dispose()
  })
})

describe('depth 诊断', () => {
  it('反映当前队列深度', () => {
    const port = makeMockPort()
    port.idle = false
    const handle = createDelivery(port)

    expect(handle.depth()).toBe(0)
    handle.send(textMsg('m1'))
    expect(handle.depth()).toBe(1)
    handle.send(textMsg('m2'))
    expect(handle.depth()).toBe(2)

    handle.dispose()
    expect(handle.depth()).toBe(0)
  })
})
