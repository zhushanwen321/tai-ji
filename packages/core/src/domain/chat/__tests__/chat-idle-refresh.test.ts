/**
 * chat idle-refresh 语义单测（[idle-refresh] docs/design/timeout-streaming-ui-idle.md §5.1 D1 / §5.7 D7 / §6）。
 *
 * 锁定 streaming timer 从「固定总时长墙钟」到「纯活动刷新 idle 无进展检测」的语义变更：
 * - 活动帧（text_delta / auto_retry_start 等）经 applyMessageEvent 刷新计时（D1：入口单点挂载）
 * - stream_warn 排除刷新（D7：它是「无活动」断言帧，刷新 = 给挂死流续命）
 * - finalize 后迟到帧 no-op 不复活 timer（§9 P-H 构造性语义）
 * - 阈值读当前值挂点：DEFAULT_STREAMING_IDLE_TIMEOUT_MS（1800s）+ setStreamingIdleTimeoutMs
 *   （非法值 clamp 进 60–3600s 合法域 + warn；进行中 timer 不受影响，新挂载生效）
 * - subagent.stream_delta 桥接端到端（core 侧链路）：routeInbound FALLBACK →
 *   onSubagentStreamDelta 回调 → resolveSubagentParentSessionId 双形态解析 →
 *   store.refreshStreamingTimer 刷新父 session（renderer 装配层接线以「模拟装配」注入，
 *   装配文件本身不在本单元领地）
 *
 * 运行：cd packages/core && npx vitest run src/domain/chat/__tests__/chat-idle-refresh.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createChatStore, DEFAULT_STREAMING_IDLE_TIMEOUT_MS, STREAMING_IDLE_TIMEOUT_MIN_MS, STREAMING_IDLE_TIMEOUT_MAX_MS } from '../store'
import type { ChatStoreInstance } from '../store'
import { configureRouteInbound } from '../../../coordination/route-inbound'
import type { InboundEffects, TransportPorts } from '../../../coordination/route-inbound'
import { resetSubscriptionStates } from '../../../coordination/subscription-state'
import { resolveSubagentParentSessionId } from '@taiji/shared'
import type { ServerMessage } from '@taiji/shared'

/** 默认 idle 阈值：30min（1800s，§5.1 阈值取值论证单一权威口径）。 */
const IDLE_MS = 1_800_000

function makeStore(): { store: ChatStoreInstance; dispose: () => void } {
  const scope = effectScope(true)
  const store = scope.run(() => createChatStore())!
  return { store, dispose: () => scope.stop() }
}

/** 模拟 renderer 装配层桥接（useMessageEffects 等价实现）：解析父 sid → refreshStreamingTimer。 */
function makeBridgeEffects(store: ChatStoreInstance, onDelta?: (frame: ServerMessage) => void): InboundEffects {
  return {
    onSubagentStreamDelta: (frame) => {
      onDelta?.(frame)
      const sid = (frame.payload as { sessionId?: string }).sessionId
      if (typeof sid !== 'string' || !sid) return
      store.refreshStreamingTimer(resolveSubagentParentSessionId(sid))
    },
  }
}

function makePorts(): TransportPorts {
  return {
    pending: {
      resolve: vi.fn(),
      reject: vi.fn(),
      rejectAll: vi.fn(),
      has: vi.fn().mockReturnValue(false),
      resolveEnvelope: vi.fn(),
    },
    events: {
      dispatchSession: vi.fn(),
      dispatchGlobal: vi.fn(),
      dispatchCrossSession: vi.fn(),
    },
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0, gap: false }),
  }
}

describe('idle 语义 — 常量单一权威（§5.3 D3）', () => {
  it('DEFAULT_STREAMING_IDLE_TIMEOUT_MS = 1_800_000（30min），合法域 60–3600s', () => {
    // 经包出口消费（与 renderer re-export 同源），锁定「默认 + clamp 域」单一权威口径
    expect(DEFAULT_STREAMING_IDLE_TIMEOUT_MS).toBe(1_800_000)
    expect(STREAMING_IDLE_TIMEOUT_MIN_MS).toBe(60_000)
    expect(STREAMING_IDLE_TIMEOUT_MAX_MS).toBe(3_600_000)
  })
})

describe('idle 语义 — applyMessageEvent 活动刷新（D1）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }
  const sid = 's-idle'

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
    sut.store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })
    expect(sut.store.isGenerating(sid)).toBe(true)
  })
  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  it('零帧 30min 到期 finalize（error 态）——挂死流有出路（G2 半边）', () => {
    vi.advanceTimersByTime(IDLE_MS)
    expect(sut.store.isGenerating(sid)).toBe(false)
    const after = sut.store.getMessages(sid)
    expect(after[0].status).toBe('error')
  })

  it('阈值前零帧不误触发', () => {
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(sut.store.isGenerating(sid)).toBe(true)
  })

  it('活动帧刷新：周期性 delta 累计远超旧 10min 墙钟仍 streaming（G1 构造性成立）', () => {
    // 3 轮「推 1700s（< 阈值）→ delta 刷新」：累计 5100s（85min）>> 旧 600s 墙钟
    for (let round = 0; round < 3; round++) {
      vi.advanceTimersByTime(1_700_000)
      sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: `chunk-${round}` } })
      expect(sut.store.isGenerating(sid)).toBe(true)
    }
    // 停止活动，零帧满阈值后收口
    vi.advanceTimersByTime(IDLE_MS)
    expect(sut.store.isGenerating(sid)).toBe(false)
  })

  it('auto_retry_start 参与刷新（D7：重试是受 maxRetries 约束的有界活动）', () => {
    vi.advanceTimersByTime(IDLE_MS - 1)
    sut.store.applyMessageEvent(sid, { type: 'message.auto_retry_start', payload: { sessionId: sid, attempt: 1, maxAttempts: 3 } })
    vi.advanceTimersByTime(IDLE_MS - 1)
    expect(sut.store.isGenerating(sid)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(sut.store.isGenerating(sid)).toBe(false)
  })

  it('stream_warn 不刷新（D7）：warn 后零帧仍在原阈值窗口内收口（S5 反向验证）', () => {
    vi.advanceTimersByTime(1_000_000)
    sut.store.applyMessageEvent(sid, { type: 'message.stream_warn', payload: { sessionId: sid, content: '长时间无响应' } })
    // 自 message_start 起累计 30min（warn 若刷新计时，此处不会收口）
    vi.advanceTimersByTime(800_000)
    expect(sut.store.isGenerating(sid)).toBe(false)
  })

  it('finalize 后迟到 delta no-op 不复活 timer（P-H）：无二次收口', () => {
    vi.advanceTimersByTime(IDLE_MS)
    expect(sut.store.isGenerating(sid)).toBe(false)
    const finalizeErr = sut.store.getMessages(sid)[0].status
    expect(finalizeErr).toBe('error')
    // 迟到活动帧：refresh 构造性 no-op（timer Map 已无 sid），sealed guard 丢弃内容更新
    sut.store.applyMessageEvent(sid, { type: 'message.text_delta', payload: { sessionId: sid, delta: 'late' } })
    expect(vi.getTimerCount()).toBe(0)
    // 长时间推进：不再有 timer 触发第二次 finalize
    vi.advanceTimersByTime(IDLE_MS * 2)
    expect(sut.store.getMessages(sid)).toHaveLength(1)
    expect(sut.store.getMessages(sid)[0].status).toBe('error')
  })
})

describe('idle 语义 — setStreamingIdleTimeoutMs 配置挂点（§6 store 行）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }
  const sid = 's-config'

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    sut = makeStore()
  })
  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  it('新值对新挂载生效（新 turn 生效语义）', () => {
    sut.store.setStreamingIdleTimeoutMs(120_000)
    sut.store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })
    vi.advanceTimersByTime(120_000)
    expect(sut.store.isGenerating(sid)).toBe(false)
  })

  it('进行中 timer 不受更新影响（保存后新 turn 生效，进行中 turn 不变）', () => {
    sut.store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })
    sut.store.setStreamingIdleTimeoutMs(60_000)
    // 推进超过新值但未到默认值：进行中 timer 仍按挂载时的旧阈值
    vi.advanceTimersByTime(120_000)
    expect(sut.store.isGenerating(sid)).toBe(true)
    vi.advanceTimersByTime(IDLE_MS - 120_000)
    expect(sut.store.isGenerating(sid)).toBe(false)
  })

  it('低于下界 clamp 至 60s + warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sut.store.setStreamingIdleTimeoutMs(1_000)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    sut.store.applyMessageEvent(sid, { type: 'message.message_start', payload: { sessionId: sid, messageId: 'a1' } })
    vi.advanceTimersByTime(60_000)
    expect(sut.store.isGenerating(sid)).toBe(false)
    warnSpy.mockRestore()
  })

  it('高于上界 clamp 至 3600s + warn（warn 文案带实际生效值，可操作）', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sut.store.setStreamingIdleTimeoutMs(86_400_000)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('3600000'))
    warnSpy.mockRestore()
  })

  it('合法域内值不触发 warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sut.store.setStreamingIdleTimeoutMs(600_000)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('idle 语义 — subagent.stream_delta 桥接端到端（core 链路，§5.1 D1 桥接）', () => {
  let sut: { store: ChatStoreInstance; dispose: () => void }
  const mainSid = 's-parent'
  let dispatcher: (msg: ServerMessage) => void

  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    resetSubscriptionStates()
    sut = makeStore()
    dispatcher = configureRouteInbound(makePorts(), makeBridgeEffects(sut.store))
    sut.store.applyMessageEvent(mainSid, { type: 'message.message_start', payload: { sessionId: mainSid, messageId: 'a1' } })
    expect(sut.store.isGenerating(mainSid)).toBe(true)
  })
  afterEach(() => {
    sut.dispose()
    vi.useRealTimers()
  })

  it('tee 通道虚拟 id 帧（subagent:<main>:<sub>）刷新父 session timer', () => {
    // 编排期父 session 零 message.* 帧，子代理 stream_delta 旁路到达
    vi.advanceTimersByTime(1_700_000)
    dispatcher({ type: 'subagent.stream_delta', payload: { sessionId: `subagent:${mainSid}:bg-1`, recordId: 'bg-1', lines: ['partial'] } } as ServerMessage)
    // 再推 1700s（累计 3400s >> 旧 600s 墙钟）：桥接刷新生效则父气泡仍 streaming
    vi.advanceTimersByTime(1_700_000)
    expect(sut.store.isGenerating(mainSid)).toBe(true)
    // 桥接停止后零帧满阈值 → 收口
    vi.advanceTimersByTime(IDLE_MS)
    expect(sut.store.isGenerating(mainSid)).toBe(false)
  })

  it('旧 widget 通道主 sid 帧（payload.sessionId = 主 sid）原样刷新', () => {
    vi.advanceTimersByTime(1_700_000)
    dispatcher({ type: 'subagent.stream_delta', payload: { sessionId: mainSid, recordId: 'bg-1', lines: ['partial'] } } as ServerMessage)
    vi.advanceTimersByTime(1_700_000)
    expect(sut.store.isGenerating(mainSid)).toBe(true)
  })

  it('回调透传原始 frame（payload 形状协议 SSOT：sessionId/recordId/lines）', () => {
    let captured: ServerMessage | undefined
    const spyDispatcher = configureRouteInbound(makePorts(), makeBridgeEffects(sut.store, (frame) => { captured = frame }))
    const frame = { type: 'subagent.stream_delta', payload: { sessionId: `subagent:${mainSid}:bg-1`, recordId: 'bg-1', lines: undefined } } as ServerMessage
    spyDispatcher(frame)
    expect(captured).toBe(frame)
  })
})
