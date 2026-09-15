// src/__tests__/frame.test.ts
//
// 帧协议层测试：LF-only 行分帧（U+2028/U+2029 边界）/ pending 表（超时分级 /
// 迟到响应丢弃 / TTL 清理）/ 早期帧缓冲 / 裸写原语。
//
// 分帧断言移植自 runtime rpc-client-lf-framing.test.ts（D10 构造帧验证范式）；
// pending 语义对齐 rpc-client S6（迟到丢弃）/ L6（超时分级）/ idle-pi-reclamation
// D1（maintenance 豁免判定）。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'

import {
  attachLfOnlyLineReader,
  CMD_TIMEOUT_MS,
  FAST_TIMEOUT_MS,
  SLOW_TIMEOUT_MS,
  TIMED_OUT_ID_TTL_MS,
  createPendingRegistry,
  createEarlyFrameBuffer,
  EARLY_FRAME_BUFFER_MAX,
  tryWriteStdinLine,
  isBrokenPipeError,
} from '../frame.ts'
import type { PiMessage } from '../types.ts'

/** 构造含 U+2028/U+2029 的合法单行 JSON（JSON.stringify 不转义这两个字符，原样入串）。 */
function lineWithSeparators(id: number): string {
  return JSON.stringify({
    type: 'message_update',
    id: String(id),
    payload: { delta: `段落一\u2028行内分隔\u2029段落二 ${id}` },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// LF-only 行分帧
// ─────────────────────────────────────────────────────────────────────────────

describe('attachLfOnlyLineReader', () => {
  it('含 U+2028/U+2029 的单行 JSON 多帧连续：不拆帧，JSON.parse 全部成功', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    let finish: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    attachLfOnlyLineReader(stream, (line) => lines.push(line))
    stream.on('end', () => finish())
    const l1 = lineWithSeparators(1)
    const l2 = lineWithSeparators(2)
    stream.write(l1 + '\n')
    stream.write(l2 + '\n')
    stream.end()
    await done

    expect(lines).toEqual([l1, l2])
    for (const line of lines) {
      const msg = JSON.parse(line) as PiMessage
      expect(msg.payload?.delta).toContain('\u2028')
      expect(msg.payload?.delta).toContain('\u2029')
    }
  })

  it('尾部无换行：流 end 时 flush 半行残留（decoder.end() 兜底交付）', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    let finish: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    attachLfOnlyLineReader(stream, (line) => lines.push(line))
    stream.on('end', () => finish())
    const trailing = lineWithSeparators(9)
    stream.write(lineWithSeparators(8) + '\n')
    stream.write(trailing)
    stream.end()
    await done

    expect(lines).toEqual([lineWithSeparators(8), trailing])
  })

  it('半行到达：多字节 UTF-8 字符跨 chunk 切断仍完整重组（StringDecoder 半字节挂起）', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    let finish: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    attachLfOnlyLineReader(stream, (line) => lines.push(line))
    stream.on('end', () => finish())
    const l1 = lineWithSeparators(1)
    const l2 = lineWithSeparators(2)
    const whole = l1 + '\n' + l2 + '\n'
    // 按字节逐块写入：中文与 U+2028 均为 3 字节 UTF-8，刻意切在中间
    const buf = Buffer.from(whole, 'utf8')
    for (let i = 0; i < buf.length; i += 3) {
      stream.write(buf.subarray(i, Math.min(i + 3, buf.length)))
    }
    stream.end()
    await done

    expect(lines).toEqual([l1, l2])
  })

  it('行尾 \\r 剥离（CRLF 输入对齐 pi 实装行为）', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    let finish: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    attachLfOnlyLineReader(stream, (line) => lines.push(line))
    stream.on('end', () => finish())
    stream.write(JSON.stringify({ type: 'response', success: true }) + '\r\n')
    stream.end()
    await done

    expect(lines).toEqual([JSON.stringify({ type: 'response', success: true })])
  })

  it('返回解绑函数：off 后不再收行', async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    const detach = attachLfOnlyLineReader(stream, (line) => lines.push(line))
    stream.write('a\n')
    detach()
    stream.write('b\n')
    stream.end()
    await new Promise<void>((resolve) => stream.on('end', () => resolve()))
    expect(lines).toEqual(['a'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 超时分级常量（L6）
// ─────────────────────────────────────────────────────────────────────────────

describe('超时分级常量', () => {
  it('FAST=10s / CMD=60s / SLOW=120s / 迟到响应 TTL=5s', () => {
    expect(FAST_TIMEOUT_MS).toBe(10_000)
    expect(CMD_TIMEOUT_MS).toBe(60_000)
    expect(SLOW_TIMEOUT_MS).toBe(120_000)
    expect(TIMED_OUT_ID_TTL_MS).toBe(5_000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// pending 表 + 迟到响应丢弃
// ─────────────────────────────────────────────────────────────────────────────

describe('createPendingRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('response 命中：resolve + 不再命中（一次性）', () => {
    const registry = createPendingRegistry()
    const resolve = vi.fn()
    const reject = vi.fn()
    registry.register('id-1', { resolve, reject }, CMD_TIMEOUT_MS, () => new Error('timeout'))
    const msg: PiMessage = { type: 'response', id: 'id-1', success: true }

    expect(registry.resolveResponse('id-1', msg)).toBe(true)
    expect(resolve).toHaveBeenCalledWith(msg)
    // 二次 resolve（迟到重复帧）不再命中
    expect(registry.resolveResponse('id-1', msg)).toBe(false)
  })

  it('超时：reject(makeTimeoutError) + id 记入 timedOutIds（FAST 档），TTL 后自动清理', () => {
    const registry = createPendingRegistry()
    const resolve = vi.fn()
    const reject = vi.fn()
    const timeoutErr = new Error('RpcTimeout')
    registry.register('id-fast', { resolve, reject }, FAST_TIMEOUT_MS, () => timeoutErr)

    vi.advanceTimersByTime(FAST_TIMEOUT_MS)
    expect(reject).toHaveBeenCalledWith(timeoutErr)
    expect(resolve).not.toHaveBeenCalled()
    // S6 迟到响应丢弃信号
    expect(registry.isTimedOut('id-fast')).toBe(true)

    vi.advanceTimersByTime(TIMED_OUT_ID_TTL_MS)
    expect(registry.isTimedOut('id-fast')).toBe(false)
  })

  it('超时分级：FAST 档在 CMD 档之前触发；同 registry 混档并存', () => {
    const registry = createPendingRegistry()
    const rejects = { fast: vi.fn(), cmd: vi.fn() }
    registry.register('f', { resolve: vi.fn(), reject: rejects.fast }, FAST_TIMEOUT_MS, () => new Error('f'))
    registry.register('c', { resolve: vi.fn(), reject: rejects.cmd }, CMD_TIMEOUT_MS, () => new Error('c'))

    vi.advanceTimersByTime(FAST_TIMEOUT_MS)
    expect(rejects.fast).toHaveBeenCalledTimes(1)
    expect(rejects.cmd).not.toHaveBeenCalled()

    vi.advanceTimersByTime(CMD_TIMEOUT_MS - FAST_TIMEOUT_MS)
    expect(rejects.cmd).toHaveBeenCalledTimes(1)
  })

  it('超时后迟到 response：isTimedOut 命中（消费方丢弃信号），resolveResponse 不命中', () => {
    const registry = createPendingRegistry()
    registry.register('late', { resolve: vi.fn(), reject: vi.fn() }, FAST_TIMEOUT_MS, () => new Error('t'))
    vi.advanceTimersByTime(FAST_TIMEOUT_MS)

    const lateMsg: PiMessage = { type: 'response', id: 'late', success: true }
    expect(registry.isTimedOut('late')).toBe(true)
    expect(registry.resolveResponse('late', lateMsg)).toBe(false)
  })

  it('timeout ≤ 0 = 不限时：不挂墙钟 timer，只经 resolve/rejectAll settle', () => {
    const registry = createPendingRegistry()
    const reject = vi.fn()
    registry.register('unbounded', { resolve: vi.fn(), reject }, 0, () => new Error('t'))
    vi.advanceTimersByTime(SLOW_TIMEOUT_MS * 2)
    expect(reject).not.toHaveBeenCalled()
  })

  it('maintenance 标记：isMaintenanceResponse 仅对命中的 response 帧为 true（D1 双腿闭合）', () => {
    const registry = createPendingRegistry()
    registry.register('m', { resolve: vi.fn(), reject: vi.fn(), maintenance: true }, CMD_TIMEOUT_MS, () => new Error('t'))
    registry.register('n', { resolve: vi.fn(), reject: vi.fn() }, CMD_TIMEOUT_MS, () => new Error('t'))

    expect(registry.isMaintenanceResponse({ type: 'response', id: 'm' })).toBe(true)
    expect(registry.isMaintenanceResponse({ type: 'response', id: 'n' })).toBe(false)
    // 非 response 帧（事件复用 id 形态，如 bash_execution_update）不算 maintenance response
    expect(registry.isMaintenanceResponse({ type: 'bash_execution_update', id: 'm' })).toBe(false)
    expect(registry.isMaintenanceResponse({ type: 'response' })).toBe(false)
  })

  it('cancel：clearTimer + 删除（写 stdin 失败路径，不进 timedOutIds）', () => {
    const registry = createPendingRegistry()
    const reject = vi.fn()
    registry.register('x', { resolve: vi.fn(), reject }, FAST_TIMEOUT_MS, () => new Error('t'))
    registry.cancel('x')
    vi.advanceTimersByTime(FAST_TIMEOUT_MS + TIMED_OUT_ID_TTL_MS)
    expect(reject).not.toHaveBeenCalled()
    expect(registry.isTimedOut('x')).toBe(false)
  })

  it('rejectAll：全部 reject + timedOutIds 清空', () => {
    const registry = createPendingRegistry()
    const rejects = [vi.fn(), vi.fn()]
    registry.register('a', { resolve: vi.fn(), reject: rejects[0] }, CMD_TIMEOUT_MS, () => new Error('t'))
    registry.register('b', { resolve: vi.fn(), reject: rejects[1] }, FAST_TIMEOUT_MS, () => new Error('t'))
    // b 先超时进 timedOutIds
    vi.advanceTimersByTime(FAST_TIMEOUT_MS)
    expect(registry.isTimedOut('b')).toBe(true)

    // b 已被超时 reject（其 timeout error）并从 pending 删除——rejectAll 只覆盖仍 pending 的 a
    expect(rejects[1]).toHaveBeenCalledTimes(1)
    const err = new Error('pi process exited')
    registry.rejectAll(err)
    expect(rejects[0]).toHaveBeenCalledWith(err)
    expect(rejects[1]).toHaveBeenCalledTimes(1) // 不重复 reject
    expect(registry.isTimedOut('b')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 早期帧缓冲
// ─────────────────────────────────────────────────────────────────────────────

describe('createEarlyFrameBuffer', () => {
  it('push/takeAndClose：按序取走 + 一次性关闭', () => {
    const buf = createEarlyFrameBuffer<PiMessage>()
    buf.push({ type: 'e1' })
    buf.push({ type: 'e2' })
    expect(buf.closed).toBe(false)
    const taken = buf.takeAndClose()
    expect(taken.map(m => m.type)).toEqual(['e1', 'e2'])
    expect(buf.closed).toBe(true)
    expect(buf.takeAndClose()).toEqual([])
  })

  it('超上限丢最旧 + onOverflowWarn 恰一次（防帧洪泛刷屏）', () => {
    const onOverflowWarn = vi.fn()
    const buf = createEarlyFrameBuffer<number>({ max: 2, onOverflowWarn })
    buf.push(1)
    buf.push(2)
    buf.push(3)
    buf.push(4)
    expect(onOverflowWarn).toHaveBeenCalledTimes(1)
    expect(onOverflowWarn).toHaveBeenCalledWith(1, 2)
    expect(buf.takeAndClose()).toEqual([3, 4])
  })

  it('缺省上限 = EARLY_FRAME_BUFFER_MAX（256）', () => {
    expect(EARLY_FRAME_BUFFER_MAX).toBe(256)
    const buf = createEarlyFrameBuffer<number>()
    for (let i = 0; i < EARLY_FRAME_BUFFER_MAX + 5; i++) buf.push(i)
    const taken = buf.takeAndClose()
    expect(taken).toHaveLength(EARLY_FRAME_BUFFER_MAX)
    expect(taken[0]).toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 裸写原语（无 pending 的 fire-and-forget 写模式）
// ─────────────────────────────────────────────────────────────────────────────

describe('tryWriteStdinLine', () => {
  it('正常写入：自动补换行 + backpressure 信号透传', () => {
    const write = vi.fn(() => true)
    const stdin = { write, destroyed: false }
    expect(tryWriteStdinLine(stdin as never, '{"type":"prompt"}')).toEqual({ ok: true, backpressure: false })
    expect(write).toHaveBeenCalledWith('{"type":"prompt"}\n')

    const writeBp = vi.fn(() => false)
    expect(tryWriteStdinLine({ write: writeBp, destroyed: false } as never, 'x')).toEqual({ ok: true, backpressure: true })
  })

  it('no-stdin / destroyed：不触发 write，返回结构化跳过信号', () => {
    const write = vi.fn()
    expect(tryWriteStdinLine(null, 'x')).toEqual({ ok: false, reason: 'no-stdin' })
    expect(tryWriteStdinLine(undefined, 'x')).toEqual({ ok: false, reason: 'no-stdin' })
    expect(tryWriteStdinLine({ write, destroyed: true } as never, 'x')).toEqual({ ok: false, reason: 'destroyed' })
    expect(write).not.toHaveBeenCalled()
  })

  it('write 抛错：返回 error 结果（策略归消费方）', () => {
    const err = Object.assign(new Error('broken pipe'), { code: 'EPIPE' })
    const stdin = { write: vi.fn(() => { throw err }), destroyed: false }
    const r = tryWriteStdinLine(stdin as never, 'x')
    expect(r).toEqual({ ok: false, reason: 'error', error: err })
  })

  it('真实 PassThrough：写入可在读端读出', () => {
    const stream = new PassThrough()
    const chunks: string[] = []
    stream.on('data', (c: Buffer) => chunks.push(c.toString()))
    expect(tryWriteStdinLine(stream, 'hello')).toEqual({ ok: true, backpressure: false })
    expect(chunks).toEqual(['hello\n'])
  })
})

describe('isBrokenPipeError', () => {
  it('EPIPE / ERR_STREAM_DESTROYED → true；其他 → false', () => {
    expect(isBrokenPipeError(Object.assign(new Error('x'), { code: 'EPIPE' }))).toBe(true)
    expect(isBrokenPipeError(Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' }))).toBe(true)
    expect(isBrokenPipeError(new Error('plain'))).toBe(false)
    expect(isBrokenPipeError(null)).toBe(false)
    expect(isBrokenPipeError('str')).toBe(false)
  })
})
