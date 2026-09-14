/**
 * useChat 单测 —— 流式状态机（CLAUDE.md 规则 #3/#7 防护的「UI 卡思考中」失败模式）。
 *
 * 覆盖：
 * - ensureStreamSubscription 幂等：首次 send 订阅一次，二次不重复订阅
 * - send 守卫：无 active session / 空文本早退；busy 时自动转 steer（B 策略）
 * - 事件驱动派生态 isGenerating：
 *   message.message_start → isGenerating=true（+ clearPendingSend）
 *   message.complete / message.error / message.stream_error → isGenerating=false（finalizeSession）
 *   （stream_error 终态复位是规则 #3 关键分支）
 *
 * mock 策略：vi.hoisted 捕获 streamSubscribe 的 handler，测试向其注入 ServerMessage。
 * 每个测试用唯一 sid 避免 useChat 模块级 streamSubscriptions Map 跨测试干扰。
 *
 * 运行：pnpm --filter @xyz-agent/frontend run test -- src/__tests__/useChat.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, Segment } from '@xyz-agent/shared'
import { textToSegments } from '@xyz-agent/shared'

// vi.hoisted 保证 mock 工厂在模块加载前就绪；holder 捕获 streamSubscribe 注册的 handler
const apiMock = vi.hoisted(() => {
  const holder: { handler: ((msg: ServerMessage) => void) | null } = { handler: null }
  return {
    holder,
    streamSubscribe: vi.fn((_sid: string, handler: (msg: ServerMessage) => void) => {
      holder.handler = handler
      return () => {
        holder.handler = null
      }
    }),
    send: vi.fn(() => Promise.resolve()),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    // useChat subagent 定向消息转发（原 useChat-subagent-directive.test.ts 并入）
    subagentAction: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
    steer: apiMock.steer,
    followUp: apiMock.followUp,
  },
  session: {
    // wave:runtime-patch W2：useChat 现从 @/api import session（writeSegments），
    // useMessageBusSubscription 调 session.subscribe——补 stub 避免 not-a-function
    subscribe: vi.fn().mockResolvedValue({ snapshot: [], stateSnapshot: [], lastSeq: 0 }),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    writeSegments: vi.fn().mockResolvedValue(undefined),
    subagentAction: apiMock.subagentAction,
  },
}))

import { useChatStore } from '@/stores/chat'
import { useChat, resetChatModuleState } from '@/composables/features/chat/useChat'

beforeEach(() => {
  setActivePinia(createPinia())
  resetChatModuleState()
  vi.clearAllMocks()
  apiMock.holder.handler = null
})

/** 向被测 useChat 订阅的 handler 注入一条 ServerMessage */
function emit(msg: ServerMessage): void {
  if (apiMock.holder.handler) apiMock.holder.handler(msg)
}

describe('useChat 流式状态机', () => {
  it('首次 send 订阅流式事件恰好一次', async () => {
    const { send } = useChat()
    await send('s-subscribe', textToSegments('hello'))
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(apiMock.send).toHaveBeenCalledTimes(1)
  })

  it('同 session 二次 send 不重复订阅（ensureStreamSubscription 幂等）', async () => {
    const { send } = useChat()
    await send('s-idempotent', textToSegments('one'))
    // 第一轮流式周期结束（message_start 清 dispatching + 设 isStreaming，complete 清 isStreaming），
    // 否则 isActive guard 会拦截第二次 send（dispatching 残留）
    emit({ type: 'message.message_start', payload: { sessionId: 's-idempotent', messageId: 'a1' } })
    emit({ type: 'message.complete', payload: { sessionId: 's-idempotent' } })
    await send('s-idempotent', textToSegments('two'))
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(apiMock.send).toHaveBeenCalledTimes(2)
  })

  it('message.message_start → isGenerating=true', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-start', textToSegments('hi'))
    expect(chat.isGenerating('s-start')).toBe(false)
    emit({ type: 'message.message_start', payload: { sessionId: 's-start', messageId: 'a1' } })
    expect(chat.isGenerating('s-start')).toBe(true)
  })

  it('message.complete → isGenerating=false', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-complete', textToSegments('hi'))
    emit({ type: 'message.message_start', payload: { sessionId: 's-complete', messageId: 'a1' } })
    expect(chat.isGenerating('s-complete')).toBe(true)
    emit({ type: 'message.complete', payload: { sessionId: 's-complete' } })
    expect(chat.isGenerating('s-complete')).toBe(false)
  })

  it('message.error → isGenerating=false（规则 #3 终态复位）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-error', textToSegments('hi'))
    emit({ type: 'message.message_start', payload: { sessionId: 's-error', messageId: 'a1' } })
    expect(chat.isGenerating('s-error')).toBe(true)
    emit({ type: 'message.error', payload: { sessionId: 's-error', message: 'boom' } })
    expect(chat.isGenerating('s-error')).toBe(false)
  })

  it('message.stream_error → isGenerating=false（stream_error 终态复位关键分支）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-stream-err', textToSegments('hi'))
    emit({ type: 'message.message_start', payload: { sessionId: 's-stream-err', messageId: 'a1' } })
    expect(chat.isGenerating('s-stream-err')).toBe(true)
    // 若 pi 发了 message_update{error} 后不再发 agent_end，必须在此复位
    emit({ type: 'message.stream_error', payload: { sessionId: 's-stream-err', content: 'err' } })
    expect(chat.isGenerating('s-stream-err')).toBe(false)
  })

  it('send 守卫：空文本/纯空白时早退', async () => {
    const { send } = useChat()
    await send('s-empty', textToSegments('   '))
    await send('s-empty', textToSegments(''))
    expect(apiMock.streamSubscribe).not.toHaveBeenCalled()
    expect(apiMock.send).not.toHaveBeenCalled()
  })

  it('send busy 时转 steer（B 策略：不打断当前回合，不重复 send）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-busy', textToSegments('first'))
    emit({ type: 'message.message_start', payload: { sessionId: 's-busy', messageId: 'a1' } })
    expect(chat.isGenerating('s-busy')).toBe(true)
    await send('s-busy', textToSegments('second'))
    // B 策略：busy 时 send 自动转 steer（不重复 send）
    expect(apiMock.send).toHaveBeenCalledTimes(1)
    expect(apiMock.steer).toHaveBeenCalledTimes(1)
  })
})

describe('useChat pendingSend 合并态（空窗期）', () => {
  it('send 置 pendingSend → isActive 立即为 true（不等 message_start）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    // send 的 api.send 是异步的，但我们用 await 等它 resolve
    await send('s-dispatch', textToSegments('hello'))
    // send resolve 后到 message_start 之前，pendingSend 应保持（空窗期 isActive=true）
    expect(chat.pendingSend.has('s-dispatch')).toBe(true)
    expect(chat.isActive('s-dispatch')).toBe(true)
    expect(chat.isGenerating('s-dispatch')).toBe(false) // message_start 未到
  })

  it('message_start 到达 → 清 pendingSend + 设 isGenerating（空窗期无缝切换）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-switch', textToSegments('hi'))
    expect(chat.pendingSend.has('s-switch')).toBe(true)
    emit({ type: 'message.message_start', payload: { sessionId: 's-switch', messageId: 'a1' } })
    expect(chat.pendingSend.has('s-switch')).toBe(false)
    expect(chat.isGenerating('s-switch')).toBe(true)
    expect(chat.isActive('s-switch')).toBe(true) // 合并态仍 true
  })

  it('终态（complete）清 pendingSend（兜底，message_start 未到的异常路径）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-terminal', textToSegments('hi'))
    expect(chat.pendingSend.has('s-terminal')).toBe(true)
    // 模拟 pi 未发 message_start 直接 complete（异常但需兜底）
    emit({ type: 'message.complete', payload: { sessionId: 's-terminal' } })
    expect(chat.pendingSend.has('s-terminal')).toBe(false)
    expect(chat.isActive('s-terminal')).toBe(false)
  })

  it('send 失败清 pendingSend（catch 路径）', async () => {
    const chat = useChatStore()
    apiMock.send.mockRejectedValueOnce(new Error('network'))
    const { send } = useChat()
    // [W2] send 失败不再 throw（与 steer/followUp/abort 对齐：clearPendingSend + toast，不 throw）
    await expect(send('s-fail', textToSegments('hi'))).resolves.toBeUndefined()
    expect(chat.pendingSend.has('s-fail')).toBe(false)
    expect(chat.isActive('s-fail')).toBe(false)
  })

  it('steer 在空窗期可用（isActive guard 而非 isGenerating）', async () => {
    const chat = useChatStore()
    const { send, steer } = useChat()
    await send('s-steer', textToSegments('first')) // 置 pendingSend，isActive=true 但 isGenerating=false
    expect(chat.isGenerating('s-steer')).toBe(false)
    await steer('s-steer', textToSegments('补充'))
    expect(apiMock.steer).toHaveBeenCalledTimes(1)
  })

  it('steer 非活跃时早退（不发送）', async () => {
    const { steer } = useChat()
    await steer('s-idle', textToSegments('补充'))
    expect(apiMock.steer).not.toHaveBeenCalled()
  })

  it('steer/followUp 调 pushPending 入 buffer（m1：pending 不进 messages）', async () => {
    const chat = useChatStore()
    const { send, steer, followUp } = useChat()
    await send('s-pending', textToSegments('first'))
    await steer('s-pending', textToSegments('steer 内容'))
    await followUp('s-pending', textToSegments('followup 内容'))
    // send 的 user 入流；steer/followUp 进 pendingBuffer（m1 解耦：pending 不进 messages）
    const buf = chat.pendingBuffer.get('s-pending') ?? []
    expect(buf).toHaveLength(2)
    expect(buf[0].sendMode).toBe('steer')
    expect(buf[0].text).toBe('steer 内容')
    expect(buf[1].sendMode).toBe('follow-up')
    expect(buf[1].text).toBe('followup 内容')
    // messages 只有 send 的 user（steer/followUp 未投递不入流）
    const users = chat.getMessages('s-pending').filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
  })

  it('abort 乐观清 pendingSend（W4：失败路径不残留）', async () => {
    const chat = useChatStore()
    const { send, abort } = useChat()
    await send('s-abort', textToSegments('first'))
    expect(chat.pendingSend.has('s-abort')).toBe(true)
    // abort 即使 RPC 失败也清 pendingSend（乐观清理 + catch 兜底）
    apiMock.abort.mockRejectedValueOnce(new Error('session not found'))
    await abort('s-abort') // 不抛（catch 吞掉）
    expect(chat.pendingSend.has('s-abort')).toBe(false)
    expect(chat.isActive('s-abort')).toBe(false)
  })

  it('pendingSend 30s 超时兜底：message_start 永不到 → 强制清（W3）', () => {
    vi.useFakeTimers()
    const chat = useChatStore()
    chat.addPendingSend('s-timeout')
    expect(chat.pendingSend.has('s-timeout')).toBe(true)
    // 29s 未超时，仍挂着
    vi.advanceTimersByTime(29_000)
    expect(chat.pendingSend.has('s-timeout')).toBe(true)
    // 30s 触发超时回调，finalizeSession('timeout') 强制清
    vi.advanceTimersByTime(1_000)
    expect(chat.pendingSend.has('s-timeout')).toBe(false)
    expect(chat.isActive('s-timeout')).toBe(false)
    vi.useRealTimers()
  })

  it('streaming 超时兜底：message.complete 永不到 → armStreamingTimer 强制收口（W3 扩展）', () => {
    vi.useFakeTimers()
    const chat = useChatStore()
    // 创建 streaming entity + arm 超时 timer（取代 setStreaming 二合一）
    chat.applyMessageEvent('s-stream-timeout', { type: 'message.message_start', payload: { sessionId: 's-stream-timeout', messageId: 'a1' } })
    chat.testInternals.armStreamingTimer('s-stream-timeout')
    expect(chat.isGenerating('s-stream-timeout')).toBe(true)
    // 阈值 DEFAULT_STREAMING_IDLE_TIMEOUT_MS=30min idle（1_800_000ms）：30min-1s 零帧未超时，仍 streaming
    vi.advanceTimersByTime(1_799_000)
    expect(chat.isGenerating('s-stream-timeout')).toBe(true)
    // 推进到 30min+1s 触发超时回调，finalizeSession('timeout') 强制收口
    vi.advanceTimersByTime(2_000)
    expect(chat.isGenerating('s-stream-timeout')).toBe(false)
    vi.useRealTimers()
  })

  it('finalizeAllStreaming 强制收口所有 streaming session（runtime 崩溃时 useConnection 调）', () => {
    const chat = useChatStore()
    // 创建 streaming entity（isActive=true via isGenerating）
    chat.applyMessageEvent('s-crash', { type: 'message.message_start', payload: { sessionId: 's-crash', messageId: 'a1' } })
    expect(chat.isActive('s-crash')).toBe(true)
    expect(chat.isGenerating('s-crash')).toBe(true)
    // runtime 崩溃：finalizeAllStreaming 收口（useConnection restart/disconnect 时调）
    chat.finalizeAllStreaming('restart')
    expect(chat.isGenerating('s-crash')).toBe(false)
    expect(chat.isActive('s-crash')).toBe(false)
  })

  it('正常流转清除 pendingSend 超时 timer（message_start 到达 → pendingSend timer 不再触发）', () => {
    vi.useFakeTimers()
    const chat = useChatStore()
    chat.addPendingSend('s-normal')
    expect(chat.pendingSend.has('s-normal')).toBe(true)
    // message_start 到达 → 创建 streaming entity + clearPendingSend（清 pendingSend + 其 timer）
    chat.applyMessageEvent('s-normal', { type: 'message.message_start', payload: { sessionId: 's-normal', messageId: 'a1' } })
    expect(chat.pendingSend.has('s-normal')).toBe(false)
    // 推进超过 30s，pendingSend 超时回调不应再触发（timer 已被 clearPendingSend 清除）
    vi.advanceTimersByTime(31_000)
    expect(chat.pendingSend.has('s-normal')).toBe(false)
    // streaming entity 仍存在（未被 pendingSend timer 误清）
    expect(chat.isGenerating('s-normal')).toBe(true)
    vi.useRealTimers()
  })

  it('steer API 失败回滚 pending + toast 提示（W1：不留孤儿气泡，不 unhandled reject）', async () => {
    const chat = useChatStore()
    const { send, steer } = useChat()
    await send('s-rollback', textToSegments('first'))
    apiMock.steer.mockRejectedValueOnce(new Error('ws disconnected'))
    // 不抛（错误已消化：pending 回滚 + toast 提示），避免 unhandled rejection
    // [D2] steer 返回值契约：RPC 失败 return false（成功 true）
    await expect(steer('s-rollback', textToSegments('补充'))).resolves.toBe(false)
    const msgs = chat.getMessages('s-rollback')
    // pending 已被回滚移除，无孤儿
    expect(msgs.some((m) => m.status === 'pending')).toBe(false)
  })

  it('followUp API 失败回滚 pending + toast 提示（W1）', async () => {
    const chat = useChatStore()
    const { send, followUp } = useChat()
    await send('s-fu-rollback', textToSegments('first'))
    apiMock.followUp.mockRejectedValueOnce(new Error('ws disconnected'))
    await expect(followUp('s-fu-rollback', textToSegments('下轮'))).resolves.toBeUndefined()
    const msgs = chat.getMessages('s-fu-rollback')
    expect(msgs.some((m) => m.status === 'pending')).toBe(false)
  })
})

describe('useChat compact 状态机（#6）', () => {
  it('compact 调 chatApi.compact 且建立会话级订阅（消费 compacting/compacted）', async () => {
    const { compact } = useChat()
    await compact('c-sub')
    // compact(sessionId, customInstructions?) → chatApi.compact(sid, undefined)（未传自定义指令）
    expect(apiMock.compact).toHaveBeenCalledWith('c-sub', undefined)
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
  })

  it('session.compacting + occupancy{compacting:true} → isCompacting=true；occupancy{false} 帧 → false（u5b 投影驱动）', async () => {
    const chat = useChatStore()
    const { compact } = useChat()
    await compact('c-flow')
    // [u5b] membership 由 occupancy 投影派生（interpreter 同一挂点先发 session.compacting
    // 再发 occupancy——帧序镜像 runtime 实发）；session.compacting 只承载 reason 文案源。
    emit({ type: 'session.compacting', payload: { sessionId: 'c-flow', status: 'compacting', reason: 'manual' } })
    expect(chat.getCompactingReason('c-flow')).toBe('manual')
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-flow', turn: 'idle', compacting: true, bash: false } })
    expect(chat.isCompacting('c-flow')).toBe(true)
    // compaction_end 三路复位（含失败）→ occupancy compacting=false 帧 → 投影复位
    emit({ type: 'session.compacted', payload: { sessionId: 'c-flow', status: 'compacted' } })
    emit({ type: 'session.occupancy', payload: { sessionId: 'c-flow', turn: 'idle', compacting: false, bash: false } })
    expect(chat.isCompacting('c-flow')).toBe(false)
    expect(chat.getCompactingReason('c-flow')).toBeUndefined()
  })

  it('compact 失败（pending reject）→ toast 错误提示，不抛出（不卡 UI，M8 toast 方案）', async () => {
    const chat = useChatStore()
    apiMock.compact.mockRejectedValueOnce(new Error('Session not found'))
    const { compact } = useChat()
    await expect(compact('c-err')).resolves.toBeUndefined()
    // M8: compact 错误走 toast 而非 appendSystemNotice，不再插入 system 消息
    const msgs = chat.getMessages('c-err')
    expect(msgs).toEqual([])
  })
})

// ── 原 useChat-subagent-directive.test.ts 并入（同 SUT useChat.send、同 mock 骨架）──
// U2b chatApiPort.subagentAction 懒转发：send 携带 subagent 段时经端口调
// session.subagentAction（sid, action, params），不走主 agent send 通道。
describe('useChat subagent 定向消息转发（@ chip）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetChatModuleState()
    vi.clearAllMocks()
    apiMock.holder.handler = null
  })

  it('send 含 subagent 段（subagentId 非空）→ 调 session.subagentAction(message)，不走主 agent send', async () => {
    const { send } = useChat()
    const segments: Segment[] = [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '展开讲讲' },
    ]
    await send('s-directive', segments)

    expect(apiMock.subagentAction).toHaveBeenCalledTimes(1)
    expect(apiMock.subagentAction).toHaveBeenCalledWith('s-directive', 'message', {
      subagentId: 'rec-1',
      // 前导空格 = subagent(chip)→text 边界补格（segmentsToText，chip 产出空串后
      // 补格残留）——8f93d7feb 已裁决该形态「保真随行发出」并同步其测试期望，此处对齐。
      text: ' 展开讲讲',
    })
    // 无主 agent turn（§3.3.8：不经 message.send 通道）
    expect(apiMock.send).not.toHaveBeenCalled()
  })

  it('subagentId 空串（新建占位 chip）→ subagentAction(start)，slug 自动生成', async () => {
    const { send } = useChat()
    const segments: Segment[] = [
      { type: 'subagent', subagentId: '', slug: '新任务' },
      { type: 'text', text: '帮我修 bug' },
    ]
    await send('s-start-action', segments)

    expect(apiMock.subagentAction).toHaveBeenCalledWith('s-start-action', 'start', {
      slug: expect.stringMatching(/^chat-/),
      // 同上：chip→text 边界补格的前导空格，保真透传（8f93d7feb 口径）
      task: ' 帮我修 bug',
    })
    expect(apiMock.send).not.toHaveBeenCalled()
  })
})
