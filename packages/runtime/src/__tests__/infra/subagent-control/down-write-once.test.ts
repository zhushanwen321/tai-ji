/**
 * down 方向写路径单点单测（R3-N1）：write 回执 → 入队 → drain 的分界。
 *
 * 真管道无法构造「write 返回 true 之后再收到 drain」以及精确的 write 回执序列，这里用
 * 最小 fake stdin 直测 ChannelDownQueue 的写路径。契约：帧一旦交给 Node（含 write 返回
 * false 的那一帧，数据已被受理）就绝不入队；drain 只重写真正入队的帧——每帧恰好投递
 * 一次。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { ChannelDownQueue } from '../../../infra/subagent-control/down-queue.js'

type FakeStdin = EventEmitter & {
  destroyed: boolean
  writes: string[]
  write(chunk: string): boolean
}

/** write 回执按 results 序列返回（耗尽后恒 true）；记录每次写入的完整行。 */
function makeFakeStdin(results: boolean[]): FakeStdin {
  const stdin = new EventEmitter() as FakeStdin
  let index = 0
  stdin.destroyed = false
  stdin.writes = []
  stdin.write = (chunk: string): boolean => {
    stdin.writes.push(chunk)
    const result = results[Math.min(index, results.length - 1)] ?? true
    index += 1
    return result
  }
  return stdin
}

function makeQueue(stdin: FakeStdin): {
  queue: ChannelDownQueue
  state: { connectionBytes: number; overflows: number }
} {
  const state = { connectionBytes: 0, overflows: 0 }
  const queue = new ChannelDownQueue({
    channelId: 'ch-test',
    getStdin: () => stdin,
    channelMaxBytes: 1024,
    channelMaxFrames: 16,
    getConnectionBytes: () => state.connectionBytes,
    setConnectionBytes: (bytes) => { state.connectionBytes = bytes },
    connectionMaxBytes: 4096,
    onOverflow: () => { state.overflows += 1 },
  })
  return { queue, state }
}

describe('down 写路径（R3-N1 每帧恰好投递一次）', () => {
  it('write 返回 true：只写一次，其后 drain 不重写', () => {
    const stdin = makeFakeStdin([true])
    const { queue, state } = makeQueue(stdin)
    queue.push('line-true')
    expect(stdin.writes).toEqual(['line-true\n'])
    // 健康写从未产生背压，drain 事件即使到达也没有可重写的帧
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['line-true\n'])
    expect(state.connectionBytes).toBe(0)
    expect(state.overflows).toBe(0)
  })

  it('write 返回 false：已受理帧不入队；drain 只重写背压期入队帧且各恰好一次', () => {
    // 回执序列：first=false（已受理、不入队）；second=false（入队帧冲刷时再次背压）；
    // third=true（队列清空）
    const stdin = makeFakeStdin([false, false, true])
    const { queue, state } = makeQueue(stdin)

    queue.push('first')
    expect(stdin.writes).toEqual(['first\n'])

    // 背压期：只入队、不写（保持 FIFO，也绝不再写 first）
    queue.push('second')
    queue.push('third')
    expect(stdin.writes).toEqual(['first\n'])
    expect(state.connectionBytes).toBe(Buffer.byteLength('second\n') + Buffer.byteLength('third\n'))
    // 同一背压期只挂一个 drain 监听（旧实现每帧一个 → >10 帧触发 MaxListenersExceededWarning）
    expect(stdin.listenerCount('drain')).toBe(1)

    // 第一次 drain：second 写出（false 已被受理）→ 出队并重新等 drain；third 留队
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['first\n', 'second\n'])
    expect(state.connectionBytes).toBe(Buffer.byteLength('third\n'))
    expect(stdin.listenerCount('drain')).toBe(1)

    // 第二次 drain：third 写出（true）→ 队列清空、聚合计数归零
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['first\n', 'second\n', 'third\n'])
    expect(state.connectionBytes).toBe(0)
    expect(stdin.listenerCount('drain')).toBe(0)
  })

  it('背压期队列越界 → onOverflow 显式失败（不静默丢帧）', () => {
    const stdin = makeFakeStdin([false])
    const { queue, state } = makeQueue(stdin)
    queue.push('x'.repeat(2048)) // 首帧 write=false（已受理，不入队）
    expect(state.connectionBytes).toBe(0)
    queue.push('x'.repeat(2048)) // 入队即超 per-channel 上限
    expect(state.overflows).toBe(1)
    expect(state.connectionBytes).toBe(0)
  })
})
