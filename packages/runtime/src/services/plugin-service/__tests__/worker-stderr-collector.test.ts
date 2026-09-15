/**
 * worker stderr 采集器单测（crash-resilience §3.3 D6-⑤，plugin-host createWorkerStderr）。
 *
 * 锁定：Buffer 累积（多字节字符跨 chunk 边界不截断）/ 超帽丢最旧 + truncated 标注 /
 * take 取走清空（幂等快照语义）。落盘端（writePluginCrashLog + handleWorkerCrash 头块）
 * 由 crash-forensics-logger.test.ts 与 A8 真机场景覆盖。
 */
import { describe, it, expect } from 'vitest'
import { createWorkerStderrCollector, WORKER_STDERR_MAX_BYTES } from '../worker-stderr-collector.js'

describe('createWorkerStderrCollector（D6-⑤ worker stderr 崩溃取证缓冲）', () => {
  it('常态累积：多块 feed 后 take 返回拼接文本，take 后清空（二次 take 为空）', () => {
    const c = createWorkerStderrCollector()
    c.feed(Buffer.from('line one\n', 'utf8'))
    c.feed(Buffer.from('line two\n', 'utf8'))
    const snap = c.take()
    expect(snap.text).toBe('line one\nline two\n')
    expect(snap.truncated).toBe(false)
    const again = c.take()
    expect(again.text).toBe('')
    expect(again.truncated).toBe(false)
  })

  it('多字节字符跨 chunk 边界不截断（Buffer 累积、take 时才解码）', () => {
    const c = createWorkerStderrCollector()
    const text = '崩溃原因：内存耗尽'
    const buf = Buffer.from(text, 'utf8')
    // 按 2 字节一切：每个 UTF-8 多字节字符都被 chunk 边界切断
    for (let i = 0; i < buf.length; i += 2) {
      c.feed(buf.subarray(i, Math.min(i + 2, buf.length)))
    }
    expect(c.take().text).toBe(text)
  })

  it('超帽丢最旧并标注 truncated（对齐 rpc-client stderrChunks 保尾语义）', () => {
    const c = createWorkerStderrCollector(100)
    c.feed(Buffer.from('A'.repeat(60), 'utf8'))
    c.feed(Buffer.from('B'.repeat(60), 'utf8')) // 总 120 > 100 → 丢 A 块
    const snap = c.take()
    expect(snap.text).toBe('B'.repeat(60))
    expect(snap.truncated).toBe(true)
  })

  it('WORKER_STDERR_MAX_BYTES 对齐 pi-crash 的 1MB 上限', () => {
    expect(WORKER_STDERR_MAX_BYTES).toBe(1_000_000)
  })
})
