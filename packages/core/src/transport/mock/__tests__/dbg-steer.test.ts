/**
 * mock chat queue_update payload 契约单测 —— W8 契约必填字段（pendingMessageCount =
 * steering + followUp 条数和，对齐 event-adapter 翻译口径）在 steer 入队/drain 两态下的守恒。
 * 注：原文件名为调试遗留（dbg-steer），内容已固化为正式契约用例；如需更名可安全 rename。
 * 时序：setMockTiming 压至 1ms/步（drain 全链 ~ms 级，经历顺序不变），afterAll 还原默认。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chat, __clearTimers, setMockTiming, resetMockTiming } from '../index'
import type { ServerMessageUnion } from '@taiji/shared'

interface QueuePayload {
  steering?: string[]
  followUp?: string[]
  pendingMessageCount: number
}

beforeAll(() => {
  setMockTiming({ ack: 1, startGap: 1, chunk: 1, done: 1, steerDrain: 1 })
})

afterAll(() => {
  resetMockTiming()
})

describe('mock chat queue_update payload 契约', () => {
  it('steer 入队/drain：pendingMessageCount 与两队列条数和守恒', async () => {
    const frames: ServerMessageUnion[] = []
    const un = chat.streamSubscribe('s-qc', (m) => frames.push(m))
    await chat.steer('s-qc', '契约检查')
    // drain（压缩时序 ~ms）+ assistant 补发 turn 完成后收口（15s deadline 为防御上界）
    const deadline = Date.now() + 15_000
    while (!frames.some((m) => m.type === 'message.complete')) {
      if (Date.now() > deadline) throw new Error('timeout waiting drain assistant turn')
      await new Promise((r) => setTimeout(r, 50))
    }
    un()
    __clearTimers()
    const queueFrames = frames
      .filter((m) => m.type === 'message.queue_update')
      .map((m) => m.payload as QueuePayload)
    expect(queueFrames.length).toBeGreaterThanOrEqual(2)
    for (const q of queueFrames) {
      expect(q.pendingMessageCount).toBe((q.steering?.length ?? 0) + (q.followUp?.length ?? 0))
    }
    expect(queueFrames.some((q) => (q.steering?.length ?? 0) === 1)).toBe(true)
    expect(queueFrames.some((q) => q.pendingMessageCount === 0)).toBe(true)
  })
})
