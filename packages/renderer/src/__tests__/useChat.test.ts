/**
 * useChat 单测 —— 流式状态机（AGENTS.md 规则 #3/#7 防护的「UI 卡思考中」失败模式）。
 *
 * 覆盖：
 * - ensureStreamSubscription 幂等：首次 send 订阅一次，二次不重复订阅
 * - send 守卫：空文本早退；占用期照常统一提交（[u3c/D1] B 策略本地转 steer 已退役——
 *   lane 判定收归 runtime 内核，renderer 只提交不判定）
 * - 事件驱动派生态 isGenerating：
 *   message.message_start → isGenerating=true（+ clearPendingSend）
 *   message.complete / message.error / message.stream_error → isGenerating=false（finalizeSession）
 *   （stream_error 终态复位是规则 #3 关键分支）
 *
 * mock 策略：vi.hoisted 捕获 streamSubscribe 的 handler，测试向其注入 ServerMessage。
 * 每个测试用唯一 sid 避免 useChat 模块级 streamSubscriptions Map 跨测试干扰。
 *
 * [u3c] 发送链统一走 chatApi.submitDelivery（delivery.submit，core 编排）；旧 chatApi.send
 * 仅存续至 u5 协议退役（renderer 已无活调用方）。
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/useChat.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ServerMessage, Segment } from '@taiji/shared'
import { textToSegments } from '@taiji/shared'

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
    // [u3c/D1] 统一提交入口（core submitSegments → delivery.submit）
    submitDelivery: vi.fn(() =>
      Promise.resolve({ clientUuid: 'u-mock', state: 'in-flight' as const, lane: 'direct' as const }),
    ),
    getHistory: vi.fn(() => Promise.resolve([])),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    // useChat subagent 定向消息转发（原 useChat-subagent-directive.test.ts 并入）
    subagentAction: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  chat: {
    streamSubscribe: apiMock.streamSubscribe,
    send: apiMock.send,
    submitDelivery: apiMock.submitDelivery,
    getHistory: apiMock.getHistory,
    abort: apiMock.abort,
    compact: apiMock.compact,
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
    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(1)
  })

  it('同 session 二次 send 不重复订阅（ensureStreamSubscription 幂等）', async () => {
    const { send } = useChat()
    await send('s-idempotent', textToSegments('one'))
    // 第一轮流式周期结束（message_start 清 dispatching + 设 isStreaming，complete 清 isStreaming）
    emit({ type: 'message.message_start', payload: { sessionId: 's-idempotent', messageId: 'a1' } })
    emit({ type: 'message.complete', payload: { sessionId: 's-idempotent' } })
    await send('s-idempotent', textToSegments('two'))
    expect(apiMock.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(2)
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
    expect(apiMock.submitDelivery).not.toHaveBeenCalled()
  })

  it('[u3c/D1] 占用期 send 照常统一提交（B 策略本地转 steer 已退役，lane 判定在内核）', async () => {
    const chat = useChatStore()
    const { send } = useChat()
    await send('s-busy', textToSegments('first'))
    emit({ type: 'message.message_start', payload: { sessionId: 's-busy', messageId: 'a1' } })
    expect(chat.isGenerating('s-busy')).toBe(true)
    await send('s-busy', textToSegments('second'))
    // 两次都经统一提交（内核判 lane：queued/steer 由内核承接），renderer 不再本地转 steer
    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(2)
  })
})

describe('useChat pendingSend 合并态（空窗期）', () => {
  // fake timers 统一恢复：放用例尾部会在断言失败时跳过恢复 → 向后续用例泄漏 fake timers
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

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

  it('send 失败零乐观残留（受理回执前不上屏——无气泡无占位，失败信号走 toast/false 契约）', async () => {
    const chat = useChatStore()
    apiMock.submitDelivery.mockRejectedValueOnce(new Error('network'))
    const { send } = useChat()
    // [W2] send 失败不再 throw（toast + false，不 throw）；
    // [R2-A5] send 契约 Promise<boolean>——失败返回 false，dispatch 侧按 false 恢复草稿。
    // [ADR-0112 受理回执后上屏] 失败时气泡/占位从未置位（无回滚面，结构性零残留）。
    await expect(send('s-fail', textToSegments('hi'))).resolves.toBe(false)
    expect(chat.getMessages('s-fail')).toHaveLength(0)
    expect(chat.pendingSend.has('s-fail')).toBe(false)
    expect(chat.isActive('s-fail')).toBe(false)
  })

  // [审计候选 8] useChat.steer 已随 message.steer 协议腿退役删除——其统一提交 / 非活跃早退 /
  // 乐观气泡用例随被测符号移除；followUp 通路契约由下方用例承接。

  it('[u3c/D1] followUp 统一提交并生成自己的乐观气泡（空窗期）', async () => {
    const chat = useChatStore()
    const { send, followUp } = useChat()
    await send('s-pending', textToSegments('first'))
    await followUp('s-pending', textToSegments('followup 内容'))
    // 两条各自经统一提交（内核判 lane）；每条都有乐观气泡入流。[B1 退役] 前身「pendingBuffer
    // 不暂存」哨兵已删：分区本尊随计数腿删除，无暂存由缺字段结构性保证。
    expect(apiMock.submitDelivery).toHaveBeenCalledTimes(2)
    const users = chat.getMessages('s-pending').filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
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

  // [ADR-0112] 原「pendingSend 30s 超时兜底（W3）」用例随 30s 空窗 timer 退役删除：
  // pendingSend 收口全事件驱动（message_start / finalizeSession 各 reason / deliveryHandled /
  // delivery morph / occupancy idle 帧 / 断连 finalizeAllStreaming），无墙钟兜底可推演。
  // 「message_start 永不到」的现实成因（pi 死亡）由断连链收口——finalizeAllStreaming 用例覆盖。

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

  // [ADR-0112] 原「正常流转清除 pendingSend 超时 timer」用例随 timer 退役删除：
  // message_start 到达清 pendingSend 的语义由「message_start 到达 → 清 pendingSend +
  // 设 isGenerating」用例覆盖，无 timer 残留断言面。

  it('[u3c/D1] followUp 提交失败零乐观残留（受理回执前不上屏）+ toast 提示', async () => {
    const chat = useChatStore()
    const { send, followUp } = useChat()
    await send('s-fu-rollback', textToSegments('first'))
    const before = chat.getMessages('s-fu-rollback').length
    apiMock.submitDelivery.mockRejectedValueOnce(new Error('ws disconnected'))
    await expect(followUp('s-fu-rollback', textToSegments('下轮'))).resolves.toBe(false)
    // 失败时新气泡从未上屏（无回滚面，分区长度不变——结构性零残留）
    expect(chat.getMessages('s-fu-rollback')).toHaveLength(before)
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
    await expect(compact('c-err')).resolves.toBe(false)
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
