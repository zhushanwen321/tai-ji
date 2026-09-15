/**
 * Chat store streaming idle 语义回归测试（[idle-refresh] docs/design/timeout-streaming-ui-idle.md）。
 *
 * 语义演变：原 W6「10min 固定墙钟」（600_000ms，任何活动帧
 * 都不刷新计时）改为「纯活动刷新的 idle 无进展检测」（§5.1 D1）——
 *   - 常量更名 DEFAULT_STREAMING_IDLE_TIMEOUT_MS = 1_800_000（30min，默认 1800s 单一权威）
 *   - 到期 = 「阈值时长内零帧」：活动帧（text_delta 等）经 applyMessageEvent 刷新计时
 *   - stream_warn 排除刷新（§5.7 D7：它是「无活动」断言帧，刷新 = 给挂死流续命）
 *   - finalize 后迟到帧 no-op 不复活 timer（§9 P-H 构造性语义）
 *
 * 运行：npx vitest run src/__tests__/chat-streaming-timeout.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as chatModule from '@/stores/chat'
import { useChatStore } from '@/stores/chat'

const IDLE_MS = 1_800_000

describe('chat store streaming idle 语义（30min 零帧收口 + 活动刷新）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })
  afterEach(() => vi.useRealTimers())

  it('DEFAULT_STREAMING_IDLE_TIMEOUT_MS 常量值为 1_800_000（30min），旧墙钟常量名不再存在', () => {
    const timeout = (chatModule as unknown as Record<string, unknown>).DEFAULT_STREAMING_IDLE_TIMEOUT_MS
    expect(timeout).toBe(1_800_000)
  })

  it('零帧 30min 到期 finalize（error 态）——挂死流有出路', () => {
    const store = useChatStore()
    const sid = 's-idle-zero-frame'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a1' },
    })
    expect(store.isGenerating(sid)).toBe(true)

    vi.advanceTimersByTime(IDLE_MS)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('error')
  })

  it('阈值前零帧不误触发', () => {
    const store = useChatStore()
    const sid = 's-idle-before'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a2' },
    })
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(store.isGenerating(sid)).toBe(true)
  })

  it('活动帧刷新：周期性 delta 累计远超旧 10min 墙钟仍 streaming（活跃流不误判，G1）', () => {
    const store = useChatStore()
    const sid = 's-idle-active'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a3' },
    })
    // 3 轮「推 28min → delta」：累计 84min >> 旧 10min 墙钟，全程 streaming
    for (let round = 0; round < 3; round++) {
      vi.advanceTimersByTime(28 * 60 * 1000)
      store.applyMessageEvent(sid, {
        type: 'message.text_delta',
        payload: { sessionId: sid, delta: `chunk-${round}` },
      })
      expect(store.isGenerating(sid)).toBe(true)
    }
    // 活动停止后零帧满阈值 → 收口
    vi.advanceTimersByTime(IDLE_MS)
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('stream_warn 不刷新（D7）：warn 后零帧仍在原阈值窗口内收口', () => {
    const store = useChatStore()
    const sid = 's-idle-warn'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a4' },
    })
    vi.advanceTimersByTime(1_000_000)
    store.applyMessageEvent(sid, {
      type: 'message.stream_warn',
      payload: { sessionId: sid, content: '长时间无响应' },
    })
    // warn 不重置计时：自 message_start 起满 30min 即收口（若被 warn 刷新，此处仍 streaming）
    vi.advanceTimersByTime(800_000)
    expect(store.isGenerating(sid)).toBe(false)
  })

  it('finalize 后迟到 delta no-op 不复活 timer（P-H）：无二次收口', () => {
    const store = useChatStore()
    const sid = 's-idle-late'
    store.applyMessageEvent(sid, {
      type: 'message.message_start',
      payload: { sessionId: sid, messageId: 'a5' },
    })
    vi.advanceTimersByTime(IDLE_MS)
    expect(store.isGenerating(sid)).toBe(false)
    expect(store.getMessages(sid)[0].status).toBe('error')
    // 迟到活动帧：refresh 构造性 no-op（timer 已随 finalize 清除）
    store.applyMessageEvent(sid, {
      type: 'message.text_delta',
      payload: { sessionId: sid, delta: 'late' },
    })
    // 长时间推进：无复活 timer，无新增消息，终态不变
    vi.advanceTimersByTime(IDLE_MS * 2)
    expect(store.getMessages(sid)).toHaveLength(1)
    expect(store.getMessages(sid)[0].status).toBe('error')
  })
})
