/**
 * down 方向写路径单点单测（R3-N1）：write 回执 → 入队 → drain 的分界。
 *
 * 真管道无法构造「write 返回 true 之后再收到 drain」以及精确的 write 回执序列，这里用
 * 最小 fake stdin 直测 SubagentControlServer 的私有写路径（测试经结构断言访问，不改
 * 生产可见面）。契约：帧一旦交给 Node（含 write 返回 false 的那一帧，数据已被受理）
 * 就绝不入队；drain 只重写真正入队的帧——每帧恰好投递一次。
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, afterEach } from 'vitest'
import { SubagentControlServer } from '../../../infra/subagent-control/control-server.js'
import { makeServer, makeTmpDir, rmTmpDir } from './test-helpers.js'

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

/** writeDown 消费的 ChannelCtx 最小投影（其余字段本路径不触达）。 */
function makeCtx(stdin: FakeStdin): {
  rec: { channelId: string; child: { stdin: FakeStdin } }
  conn: { downQueueBytes: number; destroyed: boolean }
  pendingDown: Array<{ line: string; bytes: number }>
  pendingDownBytes: number
  downAwaitingDrain: boolean
} {
  return {
    rec: { channelId: 'ch-test', child: { stdin } },
    conn: { downQueueBytes: 0, destroyed: false },
    pendingDown: [],
    pendingDownBytes: 0,
    downAwaitingDrain: false,
  }
}

type DownWriteInternals = {
  writeDown(ctx: unknown, line: string): void
  flushPendingDown(ctx: unknown): void
}

const tmpDirs: string[] = []
const servers: SubagentControlServer[] = []

async function makeInternals(): Promise<DownWriteInternals> {
  const dataDir = await makeTmpDir('ctl-down-')
  tmpDirs.push(dataDir)
  const server = makeServer(dataDir)
  servers.push(server)
  return server as unknown as DownWriteInternals
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.destroy()
  await Promise.all(tmpDirs.splice(0).map((d) => rmTmpDir(d)))
})

describe('down 写路径（R3-N1 每帧恰好投递一次）', () => {
  it('write 返回 true：只写一次，其后 drain 不重写', async () => {
    const internals = await makeInternals()
    const stdin = makeFakeStdin([true])
    const ctx = makeCtx(stdin)
    internals.writeDown(ctx, 'line-true')
    expect(stdin.writes).toEqual(['line-true\n'])
    expect(ctx.pendingDown).toEqual([])
    expect(ctx.downAwaitingDrain).toBe(false)
    // 健康写从未产生背压，drain 事件即使到达也没有可重写的帧
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['line-true\n'])
    expect(ctx.conn.downQueueBytes).toBe(0)
  })

  it('write 返回 false：已受理帧不入队；drain 只重写背压期入队帧且各恰好一次', async () => {
    const internals = await makeInternals()
    // 回执序列：first=false（已受理、不入队）；second=false（入队帧冲刷时再次背压）；
    // third=true（队列清空）
    const stdin = makeFakeStdin([false, false, true])
    const ctx = makeCtx(stdin)

    internals.writeDown(ctx, 'first')
    expect(stdin.writes).toEqual(['first\n'])
    expect(ctx.pendingDown).toEqual([])
    expect(ctx.downAwaitingDrain).toBe(true)

    // 背压期：只入队、不写（保持 FIFO，也绝不再写 first）
    internals.writeDown(ctx, 'second')
    internals.writeDown(ctx, 'third')
    expect(stdin.writes).toEqual(['first\n'])
    expect(ctx.pendingDown.map((entry) => entry.line)).toEqual(['second', 'third'])
    expect(ctx.conn.downQueueBytes).toBe(Buffer.byteLength('second\n') + Buffer.byteLength('third\n'))
    // 同一背压期只挂一个 drain 监听（旧实现每帧一个 → >10 帧触发 MaxListenersExceededWarning）
    expect(stdin.listenerCount('drain')).toBe(1)

    // 第一次 drain：second 写出（false 已被受理）→ 出队并重新等 drain；third 留队
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['first\n', 'second\n'])
    expect(ctx.pendingDown.map((entry) => entry.line)).toEqual(['third'])
    expect(ctx.downAwaitingDrain).toBe(true)
    expect(stdin.listenerCount('drain')).toBe(1)

    // 第二次 drain：third 写出（true）→ 队列清空、聚合计数归零
    stdin.emit('drain')
    expect(stdin.writes).toEqual(['first\n', 'second\n', 'third\n'])
    expect(ctx.pendingDown).toEqual([])
    expect(ctx.conn.downQueueBytes).toBe(0)
    expect(ctx.downAwaitingDrain).toBe(false)
    expect(stdin.listenerCount('drain')).toBe(0)
  })
})
