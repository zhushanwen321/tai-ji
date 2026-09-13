/**
 * createUseChat factory 行为测试（P3 chat 域 w5）。
 *
 * 锁定 createUseChat(deps) factory 产物的纯行为（不经 renderer 薄包装）：
 * send 流程 / busy 转 steer / ensureStreamSubscription 幂等 / send.rejected handler /
 * message.* 单一入口 / session.* 跨 store 协调 / 错误路径 toast 不 throw /
 * hydrateHistory / loadMoreHistory / disposeSession。
 *
 * 模式（对齐 w4 store.test.ts）：effectScope + createChatStore（真实 store）+ mockDeps
 * （chatApi/sessionStore/toast/compactQueue vi.fn），streamSubscribe mock 捕获 handler
 * 供测试主动 emit 消息（模拟 WS 事件流）。beforeEach resetChatModuleStateForTest() 清
 * 模块级 streamSubscriptions + subscriptionStates（测试隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { textToSegments } from '@xyz-agent/shared'
import type { ServerMessage } from '@xyz-agent/shared'
import { createChatStore } from '../store'
import { getExecutingBash as getExecutingBashForTest } from '../bash-effects'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import type { UseChatDeps } from '../useChat'

/** 构造 ServerMessage（payload 默认带 sessionId，对齐 w4 store.test.ts msg helper） */
function msg(sid: string, type: string, payload: Record<string, unknown> = {}): ServerMessage {
  return { type, payload: { sessionId: sid, ...payload } } as ServerMessage
}

interface Fixture {
  useChat: ReturnType<typeof createUseChat>
  chatApi: {
    send: ReturnType<typeof vi.fn>
    subagentAction: ReturnType<typeof vi.fn>
    steer: ReturnType<typeof vi.fn>
    followUp: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
    compact: ReturnType<typeof vi.fn>
    bash: ReturnType<typeof vi.fn>
    abortBash: ReturnType<typeof vi.fn>
    getHistory: ReturnType<typeof vi.fn>
    streamSubscribe: ReturnType<typeof vi.fn>
  }
  chatStore: ReturnType<typeof createChatStore>
  sessionStore: { applySnapshot: ReturnType<typeof vi.fn>; revive: ReturnType<typeof vi.fn> }
  toast: { error: ReturnType<typeof vi.fn>; warning: ReturnType<typeof vi.fn> }
  writeSegments: ReturnType<typeof vi.fn>
  compactQueue: {
    flush: ReturnType<typeof vi.fn>
    enqueue: ReturnType<typeof vi.fn>
    peek: ReturnType<typeof vi.fn>
    hasPending: ReturnType<typeof vi.fn>
    confirmDelivery: ReturnType<typeof vi.fn>
  }
  /** 主动向 sid 的 streamSubscribe handler 注入一条 ServerMessage（模拟 WS 事件） */
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    bash: vi.fn().mockResolvedValue(undefined),
    abortBash: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 }),
    streamSubscribe: vi.fn((sid: string, h: (m: ServerMessage) => void) => {
      streamHandlers.set(sid, h)
      return () => {
        streamHandlers.delete(sid)
      }
    }),
  }
  const sessionStore = { applySnapshot: vi.fn(), revive: vi.fn() }
  const toast = { error: vi.fn(), warning: vi.fn() }
  // CompactQueueLike mock（session-occupancy D2：rejected 兜底入队 + flush 来源消歧）
  const compactQueue = {
    flush: vi.fn().mockResolvedValue(true),
    enqueue: vi.fn((sid: string, text: string) => ({ id: `q-${sid}-${Date.now()}`, text })),
    peek: vi.fn((_sid: string) => [] as Array<{ id: string; text: string }>),
    // [u5b] CompactQueueLike 全接口 mock（occupancy handler flush 条件的 hasPending +
    // u4a ① 确认出队）——core 用例不发 occupancy 帧，补齐面保接口完整
    hasPending: vi.fn((_sid: string) => false),
    confirmDelivery: vi.fn((_sid: string, _id: string) => false),
  }
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => sessionStore,
    toast,
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    getCompactQueue: () => compactQueue,
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    chatApi,
    chatStore,
    sessionStore,
    toast,
    compactQueue,
    writeSegments: deps.writeSegments as unknown as ReturnType<typeof vi.fn>,
    emit: (sid, m) => {
      streamHandlers.get(sid)?.(m)
    },
    dispose: () => scope.stop(),
  }
}

describe('createUseChat factory 行为', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('clearQueueState 转发 core store（session-dead G1：forceQuit 后清 pi 快照，R3 S-3 补测）', () => {
    const f = makeFixture()
    f.chatStore.applyMessageEvent('sq-1', msg('sq-1', 'message.queue_update', { steering: ['pending-steer'] }))
    expect(f.chatStore.getQueueState('sq-1')).toBeDefined()

    f.useChat.clearQueueState('sq-1')

    expect(f.chatStore.getQueueState('sq-1')).toBeUndefined()
    // 其他 session 不受影响（转发是定向清除，非全量重置）
    f.chatStore.applyMessageEvent('sq-2', msg('sq-2', 'message.queue_update', { followUp: ['x'] }))
    f.useChat.clearQueueState('sq-1')
    expect(f.chatStore.getQueueState('sq-2')).toBeDefined()
    f.dispose()
  })

  it('send 流程：appendUser + chatApi.send 调用', async () => {
    const f = makeFixture()
    await f.useChat.send('s1', textToSegments('hello'))
    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    // appendUser 写入 messages 分区（user message 存在）
    expect(f.chatStore.getMessages('s1').length).toBeGreaterThan(0)
    f.dispose()
  })

  it('busy 转 steer：isActive 时 send 委托 steer', async () => {
    const f = makeFixture()
    await f.useChat.send('s2', textToSegments('hi'))
    // 触发 streaming → isActive=true
    f.emit('s2', msg('s2', 'message.message_start', { messageId: 'a1' }))
    expect(f.chatStore.isActive('s2')).toBe(true)
    await f.useChat.send('s2', textToSegments('more'))
    expect(f.chatApi.steer).toHaveBeenCalledTimes(1)
    // 第二次是 steer（非 send）
    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('ensureStreamSubscription 幂等：同 session 二次 send streamSubscribe 只订阅一次', async () => {
    const f = makeFixture()
    await f.useChat.send('s3', textToSegments('one'))
    // 完成首轮（清 streaming/dispatching，否则 isActive guard 拦截）
    f.emit('s3', msg('s3', 'message.message_start', { messageId: 'a1' }))
    f.emit('s3', msg('s3', 'message.complete', { stopReason: 'end_turn' }))
    await f.useChat.send('s3', textToSegments('two'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(f.chatApi.send).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('send.rejected handler：clearPendingSend + toast.error', async () => {
    // [session-occupancy D2] send await 完成后未决记录已收口（WS FIFO 下 rejected 帧必然先于
    // reply 处理，await 后到达属迟到帧/非直发来源）→ fallback 分支：保持既有反馈（清占位 +
    // toast），不回滚不入队。直发时序的完整行为见下方「send.rejected 兜底与回滚」describe。
    const f = makeFixture()
    await f.useChat.send('s4', textToSegments('hi'))
    f.emit('s4', msg('s4', 'send.rejected', { reason: 'busy', message: '被拒' }))
    expect(f.toast.error).toHaveBeenCalledWith('被拒')
    f.dispose()
  })

  it('message.* 单一入口：message_start → isGenerating=true', async () => {
    const f = makeFixture()
    await f.useChat.send('s5', textToSegments('hi'))
    expect(f.chatStore.isGenerating('s5')).toBe(false)
    f.emit('s5', msg('s5', 'message.message_start', { messageId: 'm1' }))
    expect(f.chatStore.isGenerating('s5')).toBe(true)
    f.dispose()
  })

  it('session.renamed → sessionStore.applySnapshot(label)', async () => {
    const f = makeFixture()
    await f.useChat.send('s6', textToSegments('hi'))
    f.emit('s6', msg('s6', 'session.renamed', { name: '新名' }))
    expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s6', { label: '新名' })
    f.dispose()
  })

  it('session.renamed 空 name 跳过（guard）', async () => {
    const f = makeFixture()
    await f.useChat.send('s6b', textToSegments('hi'))
    f.emit('s6b', msg('s6b', 'session.renamed', { name: '' }))
    expect(f.sessionStore.applySnapshot).not.toHaveBeenCalled()
    f.dispose()
  })

  it('session.state_changed → sessionStore.applySnapshot(modelId/thinkingLevel)', async () => {
    const f = makeFixture()
    await f.useChat.send('s7', textToSegments('hi'))
    f.emit('s7', msg('s7', 'session.state_changed', { modelId: 'gpt-4', thinkingLevel: 'high' }))
    expect(f.sessionStore.applySnapshot).toHaveBeenCalledWith('s7', {
      modelId: 'gpt-4',
      thinkingLevel: 'high',
    })
    f.dispose()
  })

  it('steer API 失败：toast.error + abortPending（不 throw）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8', textToSegments('hi'))
    f.emit('s8', msg('s8', 'message.message_start', { messageId: 'a1' }))
    f.chatApi.steer.mockRejectedValueOnce(new Error('WS断'))
    // busy → steer，steer 内部 catch
    await f.useChat.send('s8', textToSegments('more'))
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('[D2] steer 返回值契约：失败 return false，成功 return true，早退 return true', async () => {
    const f = makeFixture()
    await f.useChat.send('s8d2', textToSegments('hi'))
    f.emit('s8d2', msg('s8d2', 'message.message_start', { messageId: 'a1' }))
    // 失败：RPC reject → false
    f.chatApi.steer.mockRejectedValueOnce(new Error('WS断'))
    await expect(f.useChat.steer('s8d2', textToSegments('补充'))).resolves.toBe(false)
    // 成功：RPC resolve → true
    await expect(f.useChat.steer('s8d2', textToSegments('再补'))).resolves.toBe(true)
    // 早退：空 segments → true（无投递动作非失败）
    await expect(f.useChat.steer('s8d2', [])).resolves.toBe(true)
    f.dispose()
  })

  it('首尾空白保真：steer 原文（含空白）直达 chatApi.steer（Gate B 观测①回归）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8w', textToSegments('hi'))
    f.emit('s8w', msg('s8w', 'message.message_start', { messageId: 'a1' }))
    // busy → steer；提交文本带首尾空白，发往 pi 的 promptText 必须原文保真
    // （segmentsToPrompt 曾 trim，pi 落盘 ≠ 提交原文破坏显示对账）
    await f.useChat.send('s8w', textToSegments('  注意  '))
    expect(f.chatApi.steer).toHaveBeenCalledWith('s8w', '  注意  ')
    f.dispose()
  })

  it('纯空白文本不发送：steer 空挡拦截（保真修复后空白拦截归调用方）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8b', textToSegments('hi'))
    f.emit('s8b', msg('s8b', 'message.message_start', { messageId: 'a1' }))
    await f.useChat.send('s8b', textToSegments('   '))
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    f.dispose()
  })

  it('abort API 失败：toast.error（乐观 clearPendingSend，不 throw）', async () => {
    const f = makeFixture()
    f.chatApi.abort.mockRejectedValueOnce(new Error('pi死'))
    await f.useChat.abort('s9')
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('hydrateHistory：注入历史 + truncated 窗口标志', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: true, loadedTurns: 20, totalTurnsEstimate: 20 })
    await f.useChat.hydrateHistory('s10')
    expect(f.useChat.hasMoreHistory('s10')).toBe(true)
    // 幂等：二次 hydrate 不重复请求
    const callsBefore = f.chatApi.getHistory.mock.calls.length
    await f.useChat.hydrateHistory('s10')
    expect(f.chatApi.getHistory.mock.calls.length).toBe(callsBefore)
    f.dispose()
  })

  it('[u6] loadMoreHistory：游标翻页（cursor = 分区最旧消息身份）页响应收敛 truncated=false', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [{ id: 'm1', role: 'user', content: 'q', status: 'complete', timestamp: 1 }], truncated: true, loadedTurns: 20, totalTurnsEstimate: 20 })
    await f.useChat.hydrateHistory('s11')
    expect(f.useChat.hasMoreHistory('s11')).toBe(true)
    // 游标翻页走 getHistory（带 cursor = 分区最旧消息 m1 的 id）；空页（翻页到头）收敛
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: false, loadedTurns: 0, totalTurnsEstimate: 0 })
    await f.useChat.loadMoreHistory('s11')
    expect(f.chatApi.getHistory).toHaveBeenLastCalledWith('s11', { cursor: 'm1' })
    expect(f.useChat.hasMoreHistory('s11')).toBe(false)
    f.dispose()
  })

  it('[u6] loadMoreHistory：页响应仍 truncated=true → 顶部条入口保持', async () => {
    const f = makeFixture()
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    await f.useChat.hydrateHistory('s11b')
    // 窗口契约字段写入 store 窗口状态（u4b 透传）
    expect(f.chatStore.getHistoryWindow('s11b')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    // [u6] 游标翻页页响应仍截断（锚前有更早历史）
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: true, loadedTurns: 20, totalTurnsEstimate: 40 })
    await f.useChat.loadMoreHistory('s11b')
    expect(f.useChat.hasMoreHistory('s11b')).toBe(true)
    f.dispose()
  })

  it('disposeSession：取消订阅，再 send 重新订阅', async () => {
    const f = makeFixture()
    await f.useChat.send('s12', textToSegments('hi'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    f.useChat.disposeSession('s12')
    await f.useChat.send('s12', textToSegments('again'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('compact：ensureStreamSubscription + chatApi.compact 调用', async () => {
    const f = makeFixture()
    await f.useChat.compact('s13')
    expect(f.chatApi.compact).toHaveBeenCalledTimes(1)
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('compact transport/busy 级失败（compaction_end 未到达）：toast 兜底（MF-1）', async () => {
    const f = makeFixture()
    // transport/busy 级失败：RPC 未达 pi / dispatcher busy 预检拒绝 → compaction_end 不发 →
    // interpreter 不参与 → 零用户反馈（违反 AGENTS.md 规则 #3）
    f.chatApi.compact.mockRejectedValueOnce(new Error('RPC 超时'))
    await f.useChat.compact('s15')
    // manualCompactionState 仍 false（compaction_end 未到达）→ catch toast 兜底
    expect(f.toast.error).toHaveBeenCalledTimes(1)
    expect(f.toast.error).toHaveBeenCalledWith(
      expect.stringContaining('composable.compactFailed')
    )
    f.dispose()
  })

  it('compact compaction 级失败（compaction_end 先于 RPC reject 到达）：catch 不 toast（MF-1）', async () => {
    const f = makeFixture()
    // 模拟 pi 时序：compact() 失败时先 emit compaction_end 后 throw（agent-session.js catch 块）
    // compaction_end 经 stdout 先于 RPC error reply 到达 → session.compacted handler 先 set
    // manualCompactionState=true → catch 见 ended=true → 不 toast（interpreter 已进对话流提示）
    f.chatApi.compact.mockImplementationOnce(() => {
      f.emit('s16', msg('s16', 'session.compacted', { error: '上下文压缩失败' }))
      return Promise.reject(new Error('上下文压缩失败'))
    })
    await f.useChat.compact('s16')
    // compaction 级失败：interpreter 经 compaction_end{errorMessage} → message.error 进对话流（确定可见）
    // catch 不 toast（避免与 interpreter 双提示）
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('abortBash API 失败：toast.error（markStreamingBashError 兼底，不 throw）', async () => {
    const f = makeFixture()
    f.chatApi.abortBash.mockRejectedValueOnce(new Error('pi死'))
    // abortBash 失败 → markStreamingBashError（无 streaming bash 时 no-op）+ toast.error
    await f.useChat.abortBash('s14')
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  // ── D-2 token 合帧接线（W12）：经 streamSubscribe 回调 → coalescer → store 全链路 ──

  it('D-2 接线：同窗口 N 条 text_delta 只进一次 applyMessageEvent，内容有序拼接', async () => {
    const f = makeFixture()
    await f.useChat.send('s20', textToSegments('hi'))
    f.emit('s20', msg('s20', 'message.message_start', { messageId: 'a1' }))
    const applySpy = vi.spyOn(f.chatStore, 'applyMessageEvent')
    f.emit('s20', msg('s20', 'message.text_delta', { delta: 'He', contentIndex: 0 }))
    f.emit('s20', msg('s20', 'message.text_delta', { delta: 'll', contentIndex: 0 }))
    f.emit('s20', msg('s20', 'message.text_delta', { delta: 'o', contentIndex: 0 }))
    expect(applySpy).not.toHaveBeenCalled() // microtask 前全部缓冲中
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(applySpy).toHaveBeenCalledTimes(1) // N 条 → 1 次合成提交
    const last = f.chatStore.getMessages('s20').at(-1)
    expect(last?.content).toBe('Hello')
    // contentIndex 透传：text contentBlock 带 contentIndex（R-18）
    expect(last?.contentBlocks?.some((b) => b.type === 'text' && b.contentIndex === 0)).toBe(true)
    f.dispose()
  })

  it('D-2 接线：message.complete 到达时同步 flush（先 delta 后终态，不等 microtask）', () => {
    const f = makeFixture()
    void f.useChat.send('s21', textToSegments('hi'))
    f.emit('s21', msg('s21', 'message.message_start', { messageId: 'a1' }))
    f.emit('s21', msg('s21', 'message.text_delta', { delta: 'par' }))
    f.emit('s21', msg('s21', 'message.text_delta', { delta: 'tial' }))
    // complete 不带 content（权威覆盖关闭）→ content 只能来自 flush 落地的 delta 累积。
    // 若 flush 未先于 complete 执行，sealed 守卫（isLastAssistantStreaming）会丢弃 delta，content 为空。
    f.emit('s21', msg('s21', 'message.complete', { stopReason: 'end_turn' }))
    const last = f.chatStore.getMessages('s21').at(-1)
    expect(last?.content).toBe('partial') // flush 先行证据：delta 累积值已落地
    expect(last?.status).not.toBe('streaming') // complete 同步收口
    expect(f.chatStore.isGenerating('s21')).toBe(false)
    f.dispose()
  })

  it('D-2 接线：complete 后迟到 delta（同窗口 2 条）被 sealed 守卫丢弃，content 不串改（P8 门槛）', async () => {
    const f = makeFixture()
    await f.useChat.send('s22', textToSegments('hi'))
    f.emit('s22', msg('s22', 'message.message_start', { messageId: 'a1' }))
    f.emit('s22', msg('s22', 'message.text_delta', { delta: 'final' }))
    // complete 同步 flush 前置 delta 并收口（上一用例锁定的时序），实体进入终态
    f.emit('s22', msg('s22', 'message.complete', { stopReason: 'end_turn' }))
    const sealed = f.chatStore.getMessages('s22').at(-1)
    expect(sealed?.status).toBe('complete')
    expect(sealed?.content).toBe('final')

    // 迟到 delta：同 microtask 窗口 2 条 → flush 时合成为 1 条 'late-x' dispatch，
    // 但 isLastAssistantStreaming sealed 守卫为 false（终态后无 streaming assistant）→
    // 丢弃，已 complete 的 content 不被串改（07 文档 §3.4 P8 ⛔ 门槛）。
    const applySpy = vi.spyOn(f.chatStore, 'applyMessageEvent')
    f.emit('s22', msg('s22', 'message.text_delta', { delta: 'late' }))
    f.emit('s22', msg('s22', 'message.text_delta', { delta: '-x' }))
    expect(applySpy).not.toHaveBeenCalled() // microtask 前缓冲中
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    // 合成 delta 确实被 dispatch（1 次）——被丢弃是 sealed 守卫的行为，不是缓冲丢失
    expect(applySpy).toHaveBeenCalledTimes(1)
    const dispatched = applySpy.mock.calls[0][1] as ServerMessage
    expect((dispatched.payload as Record<string, unknown>).delta).toBe('late-x')
    const after = f.chatStore.getMessages('s22').at(-1)
    expect(after?.content).toBe('final') // sealed：content 不变
    expect(after?.status).toBe('complete')
    f.dispose()
  })
})

// ── `@` 定向发送分流（U2b，composer-symbol-system §3.3.4/§3.3.7）──────────────────────

describe('send 定向分流（含 subagent 段）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  it('subagentId 非空 → subagentAction(message) 被调且 text 序列化含 file/session 段；send 不被调', async () => {
    const f = makeFixture()
    await f.useChat.send('d1', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'session', sessionId: 'sess-9', label: '设计讨论' },
      { type: 'file', path: '/a.ts', lineRange: [1, 5] },
      { type: 'text', text: '展开讲讲' },
    ])
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    expect(f.chatApi.subagentAction).toHaveBeenCalledWith('d1', 'message', {
      subagentId: 'rec-1',
      // 定向文本 = 其余段序列化：session → #sessionId、file → path:L 范围、subagent 段空串不进。
      // 前导空格 = subagent(chip)→text 边界补格，segmentsToPrompt 不 trim（保真）随行发出
      text: ' #sess-9 /a.ts:L1-L5 展开讲讲',
    })
    // 不走主 agent 通道（§3.3.8 命题 1：无主 agent turn）
    expect(f.chatApi.send).not.toHaveBeenCalled()
    f.dispose()
  })

  it('subagentId 非空：不 appendUser（无 user 气泡，live ≡ reload——pi 只落 custom entry）', async () => {
    const f = makeFixture()
    await f.useChat.send('d1b', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '汇报进度' },
    ])
    const messages = f.chatStore.getMessages('d1b')
    expect(messages.some((m) => m.role === 'user')).toBe(false)
    // 定向气泡由 subagent.directive 广播驱动（见下一 describe），send 路径自身不插
    expect(messages.length).toBe(0)
    f.dispose()
  })

  it('subagentId 空串（新建占位 chip）→ subagentAction(start)，slug 自动生成 chat- 前缀，占位 slug 被覆盖', async () => {
    const f = makeFixture()
    await f.useChat.send('d2', [
      // U2a 新建项：subagentId 空串 + slug 为 i18n 占位文案（不可作 id）
      { type: 'subagent', subagentId: '', slug: '新任务' },
      { type: 'text', text: '帮我修 bug' },
    ])
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    const [sid, action, params] = f.chatApi.subagentAction.mock.calls[0] as unknown as [
      string, string, { slug?: string; task?: string },
    ]
    expect(sid).toBe('d2')
    expect(action).toBe('start')
    expect(params.slug).toMatch(/^chat-/) // 自动 slug 生成规则
    expect(params.slug).not.toBe('新任务') // 占位 slug 不可作 id，被覆盖
    // 前导空格 = subagent(chip)→text 边界补格（segmentsToPrompt 不 trim，原文保真）
    expect(params.task).toBe(' 帮我修 bug')
    expect(f.chatApi.send).not.toHaveBeenCalled()
    f.dispose()
  })

  it('纯 chip 无文本 → 空文本挡：不调 subagentAction，toast 可读错误（不静默）', async () => {
    const f = makeFixture()
    await f.useChat.send('d3', [{ type: 'subagent', subagentId: 'rec-1', slug: 'build-api' }])
    expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
    expect(f.chatApi.send).not.toHaveBeenCalled()
    expect(f.toast.error).toHaveBeenCalledWith('composable.subagentDirectiveEmpty')
    f.dispose()
  })

  it('RPC 失败 → toast 错误可见（不 throw、不静默丢失）', async () => {
    const f = makeFixture()
    f.chatApi.subagentAction.mockRejectedValueOnce(new Error('subagent 已结束'))
    await expect(
      f.useChat.send('d4', [
        { type: 'subagent', subagentId: 'rec-x', slug: 'closed-one' },
        { type: 'text', text: '继续' },
      ]),
    ).resolves.toBeUndefined()
    expect(f.toast.error).toHaveBeenCalledWith(
      'composable.subagentDirectiveFailed:{"msg":"subagent 已结束"}',
    )
    f.dispose()
  })

  it('定向发送仍 ensureStreamSubscription（消费 subagent.directive 广播的前提）', async () => {
    const f = makeFixture()
    await f.useChat.send('d5', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'hi' },
    ])
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('主 agent busy 时定向消息不转 steer（与主 agent turn 正交）', async () => {
    const f = makeFixture()
    await f.useChat.send('d6', textToSegments('首发'))
    f.emit('d6', msg('d6', 'message.message_start', { messageId: 'a1' }))
    expect(f.chatStore.isActive('d6')).toBe(true)
    await f.useChat.send('d6', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'busy 时追问' },
    ])
    expect(f.chatApi.steer).not.toHaveBeenCalled()
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('session 段（无 subagent 段）照常走 message.send，#sessionId 序列化进 prompt（U1 验证）', async () => {
    const f = makeFixture()
    await f.useChat.send('d7', [
      { type: 'session', sessionId: 'sess-1', label: '旧会话' },
      { type: 'text', text: '看看这个' },
    ])
    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    // send 参数：prompt = 序列化文本 + clientUuid 标记（非纯文本消息 needsBackfill 拼标记，
    // 标记被 pi extension input hook 剥离，这里只断言用户可见正文部分）
    const [calledSid, calledPrompt] = f.chatApi.send.mock.calls[0] as unknown as [string, string]
    expect(calledSid).toBe('d7')
    expect(calledPrompt.startsWith('#sess-1 看看这个')).toBe(true)
    expect(calledPrompt).toMatch(/<!--xyz:msg:u-[0-9a-fA-F-]{36}-->$/)
    expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
    f.dispose()
  })
})

// ── [steer-bubble u2 / docs/design/steer-followup-user-bubble-display.md D2 维护点 2]
//    send inflight 挂钩：乐观 +1 / catch 回滚 −1 / 挂钩位置约定（busy 转 steer 不挂）──

describe('send inflight 挂钩（steer-bubble u2 / D2 维护点 2）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  /** message_end(user) 帧（payload.entry 为 event-adapter 重构形态——send 乐观插入的确认帧） */
  function userEnd(sid: string, text: string): ServerMessage {
    return {
      type: 'message.message_end',
      payload: {
        sessionId: sid,
        entry: {
          type: 'message',
          parentId: null,
          timestamp: new Date(0).toISOString(),
          message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
        },
      },
    } as ServerMessage
  }

  it('send 乐观插入 → inflight +1；pi 投递确认 message_end(user) 到达 → 抵消归零', async () => {
    const f = makeFixture()
    await f.useChat.send('s30', textToSegments('hi'))
    // 乐观插入即「已显示」——待 message_end(user) 确认（不落入腿 2 includes 兜底，
    // 防与队列未投递同文本碰撞误命中）
    expect(f.chatStore.getInflight('s30')).toBe(1)

    f.emit('s30', userEnd('s30', 'hi'))
    expect(f.chatStore.getInflight('s30')).toBe(0)
    f.dispose()
  })

  it('send RPC 失败 → catch 回滚 −1（pi 侧无消息、message_end 永不到来，配额不悬空）', async () => {
    const f = makeFixture()
    f.chatApi.send.mockRejectedValueOnce(new Error('WS断'))

    await f.useChat.send('s31', textToSegments('hi'))

    // +1 后回滚 −1 → 0：不回滚则配额永久悬空、下一次 F1 投递的 message_end 被错抵
    expect(f.chatStore.getInflight('s31')).toBe(0)
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('busy 转 steer 分支不挂钩（走 pushPending 暂存，投递时腿 1/腿 2 消费各自计数）', async () => {
    const f = makeFixture()
    await f.useChat.send('s32', textToSegments('hi')) // 首发 send：+1
    f.emit('s32', msg('s32', 'message.message_start', { messageId: 'a1' })) // busy
    expect(f.chatStore.isActive('s32')).toBe(true)

    await f.useChat.send('s32', textToSegments('more')) // B 策略转 steer

    // 只有首发的 +1；steer 的 pushPending 不动 inflight（其确认走腿 1 消费 +m 链路）
    expect(f.chatStore.getInflight('s32')).toBe(1)
    expect(f.chatApi.steer).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('editAndResend 不挂钩（其 message_end 走 includes 不命中跳过，无需配额）', async () => {
    const f = makeFixture()
    // 建 1 条可编辑的 user 消息（首条 user 消息 id）
    await f.useChat.send('s33', textToSegments('old'))
    const userMsgId = f.chatStore.getMessages('s33').find((m) => m.role === 'user')!.id

    await f.useChat.editAndResend('s33', userMsgId, textToSegments('edited'))

    // 挂钩在 send 调用点不在 appendUser 内：编辑重发路径零计数（误挂会在此 +1，
    // 其 message_end 到达时错抵真正的 inflight 配额）
    expect(f.chatStore.getInflight('s33')).toBe(1) // 仅首发 send 的 +1
    f.dispose()
  })
})

// ── [session-occupancy-send-closure D2 / u3-p1-renderer + u5b P3 全 reason] send.rejected 兜底与回滚 ──
// 乐观气泡回滚 + inflight 回滚全 reason 生效；u5b 起三种 reason 统一静默入队（flush 触发源
// 切 session.occupancy 全 idle，busy/processing 的拒绝入队等 idle 即投递，无「等不到触发源」
// 滞留——D2 被否 ③ 的前置条件已解除）；clientUuid 命中队列条目（flush 来源）只回滚不入队。
// 时序模拟：WS FIFO 保证 rejected 广播先于 RPC reply——send 的 promise 同步段完成后
// （记录已写、订阅已建）即 emit，再 await send 收口。

describe('send.rejected 兜底与回滚（session-occupancy D2 P1）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  /** 直发 + 注入 rejected（真实时序：广播先于 reply，emit 在 send await 收口前） */
  async function sendThenReject(
    f: Fixture,
    sid: string,
    text: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const p = f.useChat.send(sid, textToSegments(text))
    f.emit(sid, msg(sid, 'send.rejected', payload))
    await p
  }

  it('验收① compacting 拒绝：乐观气泡回滚 + inflight 回滚 + 入队恰一次，无 toast', async () => {
    const f = makeFixture()
    await sendThenReject(f, 'r1', '继续重构 auth 模块', { reason: 'compacting', message: 'Agent 正在处理' })

    // 气泡回滚：appendUser 的乐观 user 气泡被移除（对话流无错误气泡也无残留气泡）
    expect(f.chatStore.getMessages('r1').length).toBe(0)
    // inflight 回滚：send 乐观 +1 被 rejected 回滚 −1，无悬空
    expect(f.chatStore.getInflight('r1')).toBe(0)
    // 入队恰一次：兜底 enqueue 调用一次，原文入队（flush 重放直发原文）
    expect(f.compactQueue.enqueue).toHaveBeenCalledTimes(1)
    expect(f.compactQueue.enqueue).toHaveBeenCalledWith('r1', '继续重构 auth 模块', [{ type: 'text', text: '继续重构 auth 模块' }], '继续重构 auth 模块')
    // 静默入队取代 toast（D2 接管表）
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('验收② busy 拒绝：回滚生效 + 静默入队（P3 全 reason，无 toast 无对话流气泡）', async () => {
    const f = makeFixture()
    await sendThenReject(f, 'r2', 'hi', { reason: 'busy', message: 'Agent 正在处理' })

    expect(f.chatStore.getMessages('r2').length).toBe(0)
    expect(f.chatStore.getInflight('r2')).toBe(0)
    // P3 全 reason：busy（bash 忙等）拒绝同样静默入队——occupancy 回 idle（bash 结束）时
    // useChat occupancy handler 触发 flush 投递，不再有「等不到触发源」的滞留。
    expect(f.compactQueue.enqueue).toHaveBeenCalledTimes(1)
    expect(f.compactQueue.enqueue).toHaveBeenCalledWith('r2', 'hi', [{ type: 'text', text: 'hi' }], 'hi')
    // toast-only 分支退役（静默入队取代）
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('验收② processing 拒绝（settling 窗口）：回滚生效 + 静默入队（P3 全 reason）', async () => {
    const f = makeFixture()
    await sendThenReject(f, 'r2b', 'hi', { reason: 'processing', message: 'Agent 正在处理' })

    expect(f.chatStore.getMessages('r2b').length).toBe(0)
    expect(f.chatStore.getInflight('r2b')).toBe(0)
    expect(f.compactQueue.enqueue).toHaveBeenCalledTimes(1)
    expect(f.compactQueue.enqueue).toHaveBeenCalledWith('r2b', 'hi', [{ type: 'text', text: 'hi' }], 'hi')
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('验收③ clientUuid 命中队列已有条目（flush 来源）：只做回滚不做入队', async () => {
    const f = makeFixture()
    const p = f.useChat.send('r3', textToSegments('hi'))
    // appendUser 的气泡 id = clientUuid（u-<uuid>）；构造该 uuid 已在队列条目中的形态
    //（u4b 起 flush 提交携带条目 id，rejected 回带命中）——即使与未决直发记录同 uuid，
    // 也只回滚不入队（重入队会双条目双投递）。
    const userMsgId = f.chatStore.getMessages('r3').find((m) => m.role === 'user')!.id
    f.compactQueue.peek.mockReturnValue([{ id: userMsgId, text: 'hi' }])
    f.emit('r3', msg('r3', 'send.rejected', { reason: 'compacting', message: 'Agent 正在处理', clientUuid: userMsgId }))
    await p

    // 回滚生效（气泡移除 + inflight 归零）……
    expect(f.chatStore.getMessages('r3').length).toBe(0)
    expect(f.chatStore.getInflight('r3')).toBe(0)
    // ……但不重入队（条目已在队列，flush 的 S1 订阅已处理失败保留）
    expect(f.compactQueue.enqueue).not.toHaveBeenCalled()
    f.dispose()
  })

  it('验收③b flush 重放来源（clientUuid 命中队列条目）：不重入队且静默（A1，D2 接管表 toast 删除）', async () => {
    const f = makeFixture()
    // 先完成一次 send（ack 后未决记录收口），再注入 flush 形态的 rejected
    await f.useChat.send('r3b', textToSegments('old'))
    f.compactQueue.peek.mockReturnValue([{ id: 'q-flush-entry', text: 'queued text' }])
    f.emit('r3b', msg('r3b', 'send.rejected', { reason: 'compacting', message: 'Agent 正在处理', clientUuid: 'q-flush-entry' }))

    // 队列条目不翻倍（重入队 = 双条目双投递）
    expect(f.compactQueue.enqueue).not.toHaveBeenCalled()
    // [A1] flush 来源静默：busy 类拒绝留队后由下一次 occupancy idle 帧自动重投（自愈路径），
    // 不 toast——原「保持既有 toast 反馈」违背 D2 接管表（toast「Agent 正在处理」删除），
    // 且与 flush 侧 queueFlushFailed 构成双 toast，一并消除。
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('验收④ 正常发送路径：clientUuid 经 RPC options 透传且等于乐观气泡 id', async () => {
    const f = makeFixture()
    await f.useChat.send('r4', textToSegments('hello'))

    expect(f.chatApi.send).toHaveBeenCalledTimes(1)
    const [calledSid, calledText, options] = f.chatApi.send.mock.calls[0] as unknown as [
      string, string, { clientUuid?: string },
    ]
    expect(calledSid).toBe('r4')
    expect(calledText).toBe('hello') // 纯文本消息无标记，promptText 原样
    const userMsgId = f.chatStore.getMessages('r4').find((m) => m.role === 'user')!.id
    expect(options.clientUuid).toBe(userMsgId) // 透传值 = appendUser 生成的气泡 id（u-<uuid>）
    expect(userMsgId).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    f.dispose()
  })

  it('非纯文本消息：clientUuid 透传 RPC options，prompt 内标记并存（两通路正交）', async () => {
    const f = makeFixture()
    await f.useChat.send('r5', [
      { type: 'file', path: '/tmp/a.ts' },
      { type: 'text', text: '看看' },
    ])

    const [calledSid, calledText, options] = f.chatApi.send.mock.calls[0] as unknown as [
      string, string, { clientUuid?: string },
    ]
    expect(calledSid).toBe('r5')
    expect(calledText).toMatch(/<!--xyz:msg:u-[0-9a-fA-F-]{36}-->$/) // prompt 标记通路不变
    expect(options.clientUuid).toMatch(/^u-[0-9a-fA-F-]{36}$/) // RPC 参数通路新增
    f.dispose()
  })

  it('[D4-d] text+slash 段组合 = 纯文本：不写 sidecar、prompt 无标记（needsBackfill 谓词单点扩展）', async () => {
    // 命令 chip（slash 段）无 badge 还原需求——chat 流显示归位后纯文本即可，谓词
    // （useChat needsBackfill）把 slash 计入纯文本，sidecar 写入与 custom entry 标记
    // 两条通道同时关闭（谓词单点门控，两侧自然同步）。
    const f = makeFixture()
    await f.useChat.send('r5b', [
      { type: 'text', text: '任务描述' },
      { type: 'slash', name: 'compact' },
    ])

    expect(f.writeSegments).not.toHaveBeenCalled() // sidecar 通道关闭
    const [calledSid, calledText] = f.chatApi.send.mock.calls[0] as unknown as [string, string]
    expect(calledSid).toBe('r5b')
    expect(calledText).toBe('/compact 任务描述') // 归位产物，无 <!--xyz:msg:--> 标记
    f.dispose()
  })

  it('RPC ack 后迟到 rejected：记录已收口，不重复回滚不入队（防御）；非队列来源保持 toast 反馈', async () => {
    const f = makeFixture()
    await f.useChat.send('r6', textToSegments('hi'))
    // ack 后乐观气泡属正常在途（message_end(user) 确认）——迟到 rejected 帧不得误删
    const msgsBefore = f.chatStore.getMessages('r6').length
    f.emit('r6', msg('r6', 'send.rejected', { reason: 'compacting', message: 'Agent 正在处理' }))

    expect(f.chatStore.getMessages('r6').length).toBe(msgsBefore)
    expect(f.chatStore.getInflight('r6')).toBe(1)
    expect(f.compactQueue.enqueue).not.toHaveBeenCalled()
    // [A1] 非队列来源的无记录迟到帧（真正孤儿帧）toast 保留——静默收窄只覆盖 flush
    // 来源（clientUuid 命中队列条目）与本编排器直发（未决记录命中）两类。
    expect(f.toast.error).toHaveBeenCalledWith('Agent 正在处理')
    f.dispose()
  })

  it('验收⑤ editAndResend 被拒（竞态窗口）：乐观气泡回滚 + 不动 inflight + 入队自愈（A2）', async () => {
    const f = makeFixture()
    // 预置一条已完成的 user 消息作为编辑目标
    await f.useChat.send('r7', textToSegments('original'))
    f.emit('r7', msg('r7', 'message.message_start', { messageId: 'a1' }))
    f.emit('r7', msg('r7', 'message.complete', { stopReason: 'end_turn' }))
    const targetId = f.chatStore.getMessages('r7').find((m) => m.role === 'user')!.id
    const inflightBefore = f.chatStore.getInflight('r7')

    // 编辑重发（idle 态）——rejected 帧在 await 收口前注入（WS FIFO 时序）
    const p = f.useChat.editAndResend('r7', targetId, textToSegments('edited'))
    const editedId = f.chatStore.getMessages('r7').find((m) => m.role === 'user')!.id
    f.emit('r7', msg('r7', 'send.rejected', { reason: 'compacting', message: 'Agent 正在处理', clientUuid: editedId }))
    await p

    // 气泡回滚：原消息已被截断（编辑语义）、编辑重发的乐观气泡被移除不残留
    //（修复前残留 → 重开 session 消失，live ≠ reload）
    expect(f.chatStore.getMessages('r7').filter((m) => m.role === 'user')).toHaveLength(0)
    // inflight 不动：editAndResend 不挂配额（holdsInflight=false），handler 不 decrement
    //（多扣会错抵后续 send/flush 占位——计数漂移）
    expect(f.chatStore.getInflight('r7')).toBe(inflightBefore)
    // 入队自愈（与 send 对齐）：编辑后原文入队等 occupancy idle 重投，内容不丢
    expect(f.compactQueue.enqueue).toHaveBeenCalledTimes(1)
    expect(f.compactQueue.enqueue).toHaveBeenCalledWith('r7', 'edited', [{ type: 'text', text: 'edited' }], 'edited')
    // 静默（D2 接管表：toast「Agent 正在处理」删除）
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })
})

// ── [簇 A1] 帧序修复：入队晚于 idle 帧的 flush 触发 + 拒绝循环 timer 重投 ─────────────
// [HISTORICAL] 帧序复现（session-dead 修复前的 runtime 行为）：handlePromptFailure 对 pi 的
// processing 拒绝也先广播 occupancy idle（复位帧）后广播 send.rejected（WS FIFO 有序）
// → idle 帧处理时队列尚空不 flush；其后 agent_settled 同值 idle 被幂等写去重不再来帧。
// 修复 = rejected 入队后读当前投影已全 idle 立即 flush；flush 再拒（resolve false）由
// per-session timer 以 1s 有界节奏重投（当时是唯一保证可达的重投脉冲）。
// [session-dead 2026-09-10] runtime #8 分型后 processing 拒绝不再发 idle 复位帧（改写 generating），
// 本 describe 的帧序用例仍作为「D1 帧序 + timer 兜底」路径的回归锚点保留。

describe('簇 A1：busy 拒绝入队后的 flush 触发与拒绝循环重投', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('A1-MF: settling idle 帧先到（队列空不 flush）→ rejected 入队后已全 idle → 立即 flush（帧序修复锚点）', async () => {
    const f = makeFixture()
    const p = f.useChat.send('a1m', textToSegments('<xyz-skill name="review"/>帮我审查'))
    // [HISTORICAL] runtime 帧序复现（订阅已建立）：handlePromptFailure 先发复位 idle 帧——此刻队列尚空
    //（hasPending false），occupancy handler 的 flush 条件不满足（改造前消息自此滞留）
    f.compactQueue.hasPending.mockReturnValue(false)
    f.emit('a1m', msg('a1m', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    expect(f.compactQueue.flush).not.toHaveBeenCalled()

    // skill-marker 消息 busy（settling 窗口 processing）拒绝 → 兜底入队
    f.compactQueue.hasPending.mockReturnValue(true) // enqueue 后队列非空
    f.emit('a1m', msg('a1m', 'send.rejected', { reason: 'processing', message: 'Agent 正在处理' }))
    await p

    expect(f.compactQueue.enqueue).toHaveBeenCalledWith(
      'a1m',
      '<xyz-skill name="review"/>帮我审查',
      [{ type: 'text', text: '<xyz-skill name="review"/>帮我审查' }],
      '<xyz-skill name="review"/>帮我审查',
    )
    // [A1] 入队晚于 idle 帧：投影已全 idle → 立即 flush 补投（改造前此处 flush 恒 0 次，
    // 消息滞留到下一个无关 occupancy 转移）
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('A1-BUSY: 入队时投影仍忙（bash 维度）→ 不立即 flush，等后续 idle 帧照常触发', async () => {
    const f = makeFixture()
    const p = f.useChat.send('a1b', textToSegments('hi'))
    // 订阅建立后 bash 开始（occupancy bash=true 投影写入）
    f.emit('a1b', msg('a1b', 'session.occupancy', { turn: 'idle', compacting: false, bash: true }))
    f.compactQueue.hasPending.mockReturnValue(true)
    f.emit('a1b', msg('a1b', 'send.rejected', { reason: 'busy', message: 'Agent 正在处理' }))
    await p

    // bash 忙：入队侧不触发（bash 结束的 idle 帧是投递时机）——防 busy 态 RPC 空打
    expect(f.compactQueue.flush).not.toHaveBeenCalled()
    f.dispose()
  })

  it('A1-RETRY: 立即 flush 再遭 S1 拒绝（resolve false）→ 1s timer 重投直到成功（拒绝循环不死循环）', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    f.compactQueue.hasPending.mockReturnValue(true)
    // 第 1 次 flush（rejected 入队后立即触发）：pi 仍 settling → S1 再拒（条目留队 resolve
    // false）；第 2 次（timer 重投）：pi 已 idle → 提交成功
    f.compactQueue.flush
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const p = f.useChat.send('a1r', textToSegments('hi'))
    f.emit('a1r', msg('a1r', 'send.rejected', { reason: 'processing', message: 'Agent 正在处理' }))
    await p
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)

    // timer 重投脉冲：1s 有界节奏（不产生 RPC 热循环），成功后不再 re-arm
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(2) // 成功即止，无循环
    f.dispose()
  })

  it('A1-IDEMPOTENT: 连续两次失败 flush 只有一个 pending timer（幂等）；fire 时队列已清空则不重投', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush.mockResolvedValue(false) // 持续拒绝

    const p = f.useChat.send('a1i', textToSegments('hi'))
    f.emit('a1i', msg('a1i', 'send.rejected', { reason: 'processing', message: 'Agent 正在处理' }))
    await p
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1) // 入队后立即 flush（失败，arm timer）

    // 第二触发源（bash 结束 idle 帧）flush 再失败 → 已有 pending timer，不重复排
    f.emit('a1i', msg('a1i', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(2)

    // timer fire 时用户已撤销（队列空）→ hasPending false 早退，不空转 flush
    f.compactQueue.hasPending.mockReturnValue(false)
    const callsBefore = f.compactQueue.flush.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush.mock.calls.length).toBe(callsBefore)
    f.dispose()
  })

  it('A1-DISPOSE: disposeSession 清重投 timer——session 销毁后 timer 不再开火', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush.mockResolvedValue(false)

    const p = f.useChat.send('a1d', textToSegments('hi'))
    f.emit('a1d', msg('a1d', 'send.rejected', { reason: 'processing', message: 'Agent 正在处理' }))
    await p
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)

    f.useChat.disposeSession('a1d')
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1) // timer 已清，无幽灵重投
    f.dispose()
  })

  it('A1-TRANSPORT: flush RPC reject（传输级真错误）→ toast 上抛路径保留，不 arm timer', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush.mockRejectedValueOnce(new Error('WS disconnected'))
      .mockResolvedValue(true)

    const p = f.useChat.send('a1t', textToSegments('hi'))
    f.emit('a1t', msg('a1t', 'send.rejected', { reason: 'processing', message: 'Agent 正在处理' }))
    await p

    // 传输级错误 toast「发送失败: {原因}」（§3.5 错误规格表语义），气泡保持 pending 队列保留；
    // 恢复后由重连快照回放 idle 帧触发，不走 timer（断连期间 timer 重投只会再撞墙）
    expect(f.toast.error).toHaveBeenCalledWith('composable.sendFailed:{"msg":"WS disconnected"}')
    const callsBefore = f.compactQueue.flush.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.compactQueue.flush.mock.calls.length).toBe(callsBefore)
    f.dispose()
  })

  // ── [session-dead 第三环] 连续 flush 失败熔断（N=5）+ 一次可操作提示 ─────────────────
  // 事故形态：busy 拒绝 → 静默入队 → 入队后已 idle 立即 flush → 再拒 → arm 1s timer →
  // 无限循环（runtime 日志：90s 内 82 次，1 秒 1 次，用户零感知）。

  /** 事故形态起手：用户直发被 busy 拒 → 静默入队 → 入队后投影已全 idle 立即 flush（第 1 次）。
   *  返回 flush mock（默认已被调用 1 次）。 */
  async function primeAccidentLoop(sid: string, f: Fixture): Promise<void> {
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush.mockResolvedValue(false) // 持续 busy 拒绝（条目留队）
    const p = f.useChat.send(sid, textToSegments('hi'))
    f.emit(sid, msg(sid, 'send.rejected', { reason: 'busy', message: 'Agent 正在处理' }))
    await p
    await vi.advanceTimersByTimeAsync(0)
  }

  /**
   * 熔断提示计数过滤：[GUI 快修④] send.rejected 自愈入队起 toast warning
   * （sendAutoRequeued，每次直发被拒恰一条）——与熔断提示 deferFlushStalled 分道断言，
   * 防两条 warning 语义互相污染计数。
   */
  function stalledWarnings(f: Fixture): Array<[string]> {
    return f.toast.warning.mock.calls.filter((c) => c[0] === 'composable.deferFlushStalled') as Array<[string]>
  }

  it('A1-CIRCUIT: 连续 5 次 busy 拒绝 → 熔断 timer 重投（无 pending timer）+ 恰一次可操作提示', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    await primeAccidentLoop('a1cb', f)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1) // 入队后立即 flush（第 1 次失败 → 计 1 → arm）
    expect(vi.getTimerCount()).toBe(1)

    // timer 自驱动重投：第 2..5 次（恰第 5 次达阈值）
    for (const expected of [2, 3, 4, 5]) {
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.compactQueue.flush).toHaveBeenCalledTimes(expected)
    }

    // ① 不再排新 timer（deferFlushRetryTimers 无该 sid = fake timer 池为空）
    expect(vi.getTimerCount()).toBe(0)
    // 其后 10s 无第 6 次投递（熔断生效，不再是 1 秒 1 次的拒绝风暴）
    await vi.advanceTimersByTimeAsync(10000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(5)

    // ② 用户可见提示恰一次：文案非空 + 走可操作指引 i18n key。
    //    真实文案（zh-CN「pi 仍在处理，消息可能已卡住…可在侧栏右键强制退出该会话后重新发送」/
    //    en-US 对应）在 renderer 侧 use-chat-compacted-flush.test.ts TC11c 用真实 i18n 断言（本fixture 的 t 直出 key）。
    const stalled = stalledWarnings(f)
    expect(stalled).toHaveLength(1)
    const copy = stalled[0]![0]
    expect(copy).toBe('composable.deferFlushStalled')
    expect(copy.length).toBeGreaterThan(0)
    f.dispose()
  })

  it('[GUI 快修④] send.rejected 自愈入队：一次性 toast warning 提示已自动重试（每次被拒直发恰一条）', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush.mockResolvedValue(false)

    const p = f.useChat.send('a1q', textToSegments('hi'))
    f.emit('a1q', msg('a1q', 'send.rejected', { reason: 'busy', message: 'Agent 正在处理' }))
    await p

    // 自愈入队行为保留（既有产品行为）+ 恰一条 sendAutoRequeued 提示
    expect(f.compactQueue.enqueue).toHaveBeenCalled()
    expect(f.toast.warning).toHaveBeenCalledWith('composable.sendAutoRequeued')
    const requeued = f.toast.warning.mock.calls.filter((c) => c[0] === 'composable.sendAutoRequeued')
    expect(requeued).toHaveLength(1)

    // 后续 timer 重投的拒绝不重复提示（flush 失败留队走熔断通道，无 sendAutoRequeued）
    await vi.advanceTimersByTimeAsync(3000)
    expect(f.toast.warning.mock.calls.filter((c) => c[0] === 'composable.sendAutoRequeued')).toHaveLength(1)
    f.dispose()
  })

  it('A1-CIRCUIT-EDGE: 第 4 次失败（阈值-1）仍 re-arm，第 5 次才熔断', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    await primeAccidentLoop('a1ce', f)

    for (const expected of [1, 2, 3, 4]) {
      if (expected > 1) await vi.advanceTimersByTimeAsync(1000)
      expect(f.compactQueue.flush).toHaveBeenCalledTimes(expected)
      expect(vi.getTimerCount()).toBe(1) // 阈值-1 不得提前熔断
      expect(stalledWarnings(f)).toHaveLength(0) // 未达阈值不提示
    }
    // 第 5 次：熔断 + 提示一次
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)
    expect(stalledWarnings(f)).toHaveLength(1)
    f.dispose()
  })

  it('A1-CIRCUIT-RESET: flush 成功清零计数 → 之后新的失败序列重新累计（不「成功后永久停」）', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true) // 第 4 次成功：清零
      .mockResolvedValue(false)

    const p = f.useChat.send('a1cr', textToSegments('hi'))
    f.emit('a1cr', msg('a1cr', 'send.rejected', { reason: 'busy', message: 'Agent 正在处理' }))
    await p
    await vi.advanceTimersByTimeAsync(0)

    // 第 1..3 次失败（计数 3）→ 第 4 次成功（清零 + 不 re-arm）
    for (const expected of [1, 2, 3, 4]) {
      if (expected > 1) await vi.advanceTimersByTimeAsync(1000)
      expect(f.compactQueue.flush).toHaveBeenCalledTimes(expected)
    }
    expect(vi.getTimerCount()).toBe(0) // 成功不 re-arm
    expect(stalledWarnings(f)).toHaveLength(0)

    // 新的失败序列从头累计：第 5 次失败 → 计 1 → arm（若成功后未清零，此处早已静音不再 arm）
    f.emit('a1cr', msg('a1cr', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(1)

    // 新序列累计到 5 次（总第 9 次）才再次熔断 + 提示（计数不跨成功累计）
    for (const expected of [6, 7, 8, 9]) {
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.compactQueue.flush).toHaveBeenCalledTimes(expected)
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(stalledWarnings(f)).toHaveLength(1)
    f.dispose()
  })

  it('A1-CIRCUIT-FRAME: 熔断只停 timer 通路——occupancy idle 帧到达仍照常投递（不永久封死）', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    await primeAccidentLoop('a1cf', f)
    // 推到阈值（第 2..5 次）
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(5)
    expect(vi.getTimerCount()).toBe(0)

    // 卡死解除：occupancy 帧驱动的投递路径不受熔断影响——帧到达即投递（条目不丢）
    f.compactQueue.flush.mockResolvedValue(true)
    f.emit('a1cf', msg('a1cf', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(6)
    expect(stalledWarnings(f)).toHaveLength(1) // 不重复提示

    // 投递成功已清零 → 再次失败重新从 1 累计（timer 通路自动恢复，无需人工干预）
    f.compactQueue.flush.mockResolvedValue(false)
    f.emit('a1cf', msg('a1cf', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(7)
    expect(vi.getTimerCount()).toBe(1)
    f.dispose()
  })

  it('A1-CIRCUIT-RESET-SEND: 熔断后用户重新发送（新条目入队）→ 计数清零，重投机制恢复可用', async () => {
    vi.useFakeTimers()
    const f = makeFixture()
    await primeAccidentLoop('a1rs', f)
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(5)
    expect(stalledWarnings(f)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0) // 已熔断

    // 用户重新发送：直发被拒 → 重入队（计数清零）→ 入队后投影已全 idle 立即 flush（第 6 次，失败 → 计 1）
    const p2 = f.useChat.send('a1rs', textToSegments('second'))
    f.emit('a1rs', msg('a1rs', 'send.rejected', { reason: 'busy', message: 'Agent 正在处理' }))
    await p2
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(1) // ← 计数已清零（否则 6 >= 阈值直接静音，不 arm）

    // 重投恢复可用：1s 后第 7 次（历史计数不永久误伤后续正常发送）
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(7)
    expect(stalledWarnings(f)).toHaveLength(1) // 新序列未达阈值，不重复提示
    f.dispose()
  })
})

// ── subagent.directive live 广播消费（U2b，§3.3.3a live 链路）──────────────────────

describe('subagent.directive 广播消费', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
  })

  /** 构造 subagent.directive ServerMessage（payload 对齐 ServerMessageMap 契约） */
  function directiveMsg(sid: string, subagentId: string, slug: string, text: string): ServerMessage {
    return {
      type: 'subagent.directive',
      payload: { sessionId: sid, subagentId, slug, direction: 'user', text },
    } as ServerMessage
  }

  it('payload.sessionId 匹配订阅 sid → 聊天流插入定向消息（reload 形态逐字段一致）', async () => {
    const f = makeFixture()
    await f.useChat.send('e1', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: '汇报进度' },
    ])
    f.emit('e1', directiveMsg('e1', 'rec-1', 'build-api', '汇报进度'))
    const inserted = f.chatStore.getMessages('e1').at(-1)
    // U2c 契约：role system + customType + content + details + display:true（live ≡ reload）
    expect(inserted).toMatchObject({
      role: 'system',
      customType: 'subagent-directive',
      content: '汇报进度',
      details: { subagentId: 'rec-1', slug: 'build-api', direction: 'user' },
      display: true,
      status: 'complete',
    })
    expect(inserted?.id).toMatch(/^cm-/) // customStart 先例：客户端生成 id
    f.dispose()
  })

  it('payload.sessionId 不匹配订阅 sid → 丢弃（ADR-0049 per-session 隔离，架构约定 7）', async () => {
    const f = makeFixture()
    await f.useChat.send('e2', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'hi' },
    ])
    const before = f.chatStore.getMessages('e2').length
    // 伪造异 session 广播到达 e2 的 handler（防御层校验 payload.sessionId === 订阅 sid）
    f.emit('e2', directiveMsg('other-session', 'rec-1', 'build-api', '串台消息'))
    expect(f.chatStore.getMessages('e2').length).toBe(before)
    expect(f.chatStore.getMessages('e2').some((m) => m.content === '串台消息')).toBe(false)
    f.dispose()
  })

  it('未订阅的 session 收不到广播（per-sid 通道路由，无 handler 可触发）', async () => {
    const f = makeFixture()
    // e3 从未 send（未 ensureStreamSubscription）→ streamHandlers 无条目，emit 天然 no-op
    f.emit('e3', directiveMsg('e3', 'rec-1', 'build-api', '未订阅'))
    expect(f.chatStore.getMessages('e3').length).toBe(0)
    f.dispose()
  })
})

// ── ①b toast 抑制（timeout-slow-flow-wallclock D2/r4 极性修正）────────────────
//
// 极性（§7 useChat 行为权威表述）：executingBash 是「命令执行中」瞬时态（bashStart 置 /
// bashResult·markBashError 清），「已收合成终态」= getExecutingBash 查询为空（取反）——
// 为空 → 抑制 bashFailed toast（气泡终态是权威呈现面）；非空（命令仍在执行 = env backstop
// 先到形态）→ 不抑制（toast 是唯一提示）。
describe('sendBash ①b toast 抑制（D2 极性：空→抑制 / 非空→不抑制）', () => {
  it('终态帧先于 error envelope 到达（executingBash 为空）→ 抑制 bashFailed toast，气泡终态是权威面', async () => {
    const f = makeFixture()
    // bash RPC 挂起：手动控制 reject 时机（模拟 runtime 先广播合成终态帧、后回 error envelope）
    let rejectBash: (e: unknown) => void = () => {}
    f.chatApi.bash.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectBash = reject }),
    )
    const sending = f.useChat.sendBash('b1', 'sleep 3700', false)
    // bashStart 到达：executingBash 置位
    f.emit('b1', msg('b1', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
    // 合成终态帧到达（dispatcher catch 的诚实文案帧）：executingBash 清空
    f.emit('b1', msg('b1', 'message.bashResult', {
      command: 'sleep 3700', output: '命令执行超过 1 小时，已停止等待……', exitCode: null,
      cancelled: false, truncated: false, excludeFromContext: false, timestamp: 1724000000001,
    }))
    expect(getExecutingBashForTest('b1')).toBeUndefined()
    // error envelope（blocked → 'Bash execution failed'）此时刻达
    rejectBash(new Error('Bash execution failed'))
    await sending
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })

  it('终态帧未到达（executingBash 非空 = env backstop 先到形态）→ 不抑制，toast 是唯一提示', async () => {
    const f = makeFixture()
    let rejectBash: (e: unknown) => void = () => {}
    f.chatApi.bash.mockImplementation(
      () => new Promise((_resolve, reject) => { rejectBash = reject }),
    )
    const sending = f.useChat.sendBash('b2', 'sleep 3700', false)
    // bashStart 到达（命令确实在 runtime 执行中），bashResult 未到（runtime 3600s 未到点）
    f.emit('b2', msg('b2', 'message.bashStart', { command: 'sleep 3700', excludeFromContext: false, timestamp: 1724000000000 }))
    expect(getExecutingBashForTest('b2')).toBeDefined()
    // renderer backstop（3660s 或中间态 65s）先 reject
    rejectBash(new Error('request timeout after 3660000ms'))
    await sending
    expect(f.toast.error).toHaveBeenCalledTimes(1)
    expect(f.toast.error).toHaveBeenCalledWith(expect.stringContaining('request timeout after 3660000ms'))
    f.dispose()
  })

  it('命令从未到达 runtime（executingBash 从未置位）→ 抑制 toast（无终态可呈现，行为归 deviations 登记）', async () => {
    const f = makeFixture()
    f.chatApi.bash.mockRejectedValue(new Error('transport unavailable (ws not open)'))
    await f.useChat.sendBash('b3', 'echo hi', false)
    expect(f.toast.error).not.toHaveBeenCalled()
    f.dispose()
  })
})

// ── [D1] defer flush 重投 timer 占用短路（adversarial-review-fixes u3）────────────
//
// 原缺陷：armDeferFlushRetry 的 1s timer fire 时不查占用投影——turn 合法长跑（小时级
// bash）期每秒空转发一次注定被拒的 send RPC。修复后 fire 回调读 occupancy 投影：仍忙
// → 不重排不 flush（帧驱动优先——occupancy 回 idle 帧触发现有 handler）；投影缺失
//（getOccupancy 无记录回落全 idle 缺省）→ 保守走原重试路径防死锁。
//
// 驱动链：emit send.rejected（busy，无 clientUuid）→ 兜底入队 → 入队时投影全 idle
//（缺省）→ flushDeferQueueAfterIdle → flush resolve false → arm 1s timer。
describe('defer flush 重投 timer 占用短路（D1）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 驱动一次「直发被拒 → 入队 → flush 失败 → 1s timer 已排」的前置链。
   *  时序对齐 sendThenReject 范式（WS FIFO：rejected 广播先于 RPC reply）——send 同步段
   *  建立 pendingDirectSends 记录后 emit，rejected handler 据此入队 + 缺省 idle 即 flush。 */
  async function armRetryTimer(f: ReturnType<typeof makeFixture>, sid: string): Promise<void> {
    f.compactQueue.hasPending.mockReturnValue(true)
    f.compactQueue.flush.mockResolvedValue(false)
    const p = f.useChat.send(sid, textToSegments('排队消息'))
    f.emit(sid, msg(sid, 'send.rejected', { reason: 'busy', message: 'Agent is busy' }))
    await p
    // 入队后投影缺省全 idle → 立即 flush（resolve false）→ then 内 arm timer（microtask）
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)
    // rejecte handler 已 clearPendingSend（连带清 pendingSendTimer）→ 仅剩重投 timer 1 个
    expect(vi.getTimerCount()).toBe(1)
  }

  it('占用态 fire：不调 flush、不重排 timer（小时级 bash 期无每秒空转 RPC）', async () => {
    const f = makeFixture()
    await armRetryTimer(f, 'd1a')
    // 置忙（bash 占用）：timer fire 时投影非全 idle
    f.chatStore.setOccupancy('d1a', { turn: 'idle', compacting: false, bash: true })
    await vi.advanceTimersByTimeAsync(60_000)
    // 1 分钟过去：flush 仍只被调 1 次（arm 前那次）、timer 已自删不重排
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    f.dispose()
  })

  it('短路后 occupancy 回 idle 帧 → 帧驱动触发 flush（timer 只兜 idle 帧丢失）', async () => {
    const f = makeFixture()
    await armRetryTimer(f, 'd1b')
    f.chatStore.setOccupancy('d1b', { turn: 'idle', compacting: false, bash: true })
    await vi.advanceTimersByTimeAsync(1000) // fire → 占用短路（无重排）
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)
    // occupancy 回 idle 帧到达（bash 结束）：handleSessionOccupancy 判定全 idle + hasPending → flush
    f.emit('d1b', msg('d1b', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('投影缺失（无 occupancy 记录）：fire 保守走原重试路径（flush + 失败再 re-arm）', async () => {
    const f = makeFixture()
    await armRetryTimer(f, 'd1c')
    // 不写任何 occupancy（快照缺失 = getOccupancy 缺省全 idle）→ fire 走 flush，false 后再 re-arm
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1) // re-arm（1s 有界重试，消息不丢优先）
    f.dispose()
  })

  it('turn 维度占用（settling）同样短路；队列为空时 fire no-op', async () => {
    const f = makeFixture()
    await armRetryTimer(f, 'd1d')
    f.chatStore.setOccupancy('d1d', { turn: 'settling', compacting: false, bash: false })
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)
    // 队列清空后（hasPending=false）：即便投影 idle，fire 早退不 flush
    f.compactQueue.hasPending.mockReturnValue(false)
    f.emit('d1d', msg('d1d', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.compactQueue.flush).toHaveBeenCalledTimes(1)
    f.dispose()
  })
})

describe('恢复窗口过渡态的 message_start 收口 gate（crash-resilience T4 回流修复）', () => {
  // 缺陷背景（Gate B A7 真机）：恢复窗口（respawnPending）内用户发消息 → runtime 惰性恢复
  // join 先于 D7 自动恢复 timer 完成 → timer fire「already active/restoring — skip」→
  // session.restored 帧永不发布 → 前端过渡态只能等 30s 超时回落 dead 终态页（而 session
  // 实际已活）。收口信号 = 恢复窗口内该 session 的 message_start 到达（新 pi 已在处理）。

  it('respawnPending 内 message_start 到达 → 过渡态收口 + T4 条入流 + sessionStore.revive', async () => {
    const f = makeFixture()
    await f.useChat.send('s-join', textToSegments('hello during recovery'))
    f.chatStore.markRespawnPending('s-join')

    f.emit('s-join', msg('s-join', 'message.message_start', { messageId: 'a-join' }))

    // 过渡态收口（同步于 enqueue 前——流式帧处理前 T4 条已在流内，先于 assistant 气泡）
    expect(f.chatStore.isRespawnPending('s-join')).toBe(false)
    expect(f.sessionStore.revive).toHaveBeenCalledWith('s-join')
    const notice = f.chatStore
      .getMessages('s-join')
      .find((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored')
    expect(notice).toBeDefined()
    // fallbackText 经 deps.t（fixture 返回 key 本身）
    expect(notice!.content).toBe('panel.message.respawnRestored')
    f.dispose()
  })

  it('非恢复窗口 message_start → gate no-op（无 T4 条、revive 不调）', async () => {
    const f = makeFixture()
    await f.useChat.send('s-normal', textToSegments('hi'))
    f.emit('s-normal', msg('s-normal', 'message.message_start', { messageId: 'a1' }))
    expect(f.sessionStore.revive).not.toHaveBeenCalled()
    expect(
      f.chatStore
        .getMessages('s-normal')
        .some((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored'),
    ).toBe(false)
    f.dispose()
  })

  it('restored 帧先行收口后 message_start 到达 → 二次收口 no-op（不插双条）', async () => {
    const f = makeFixture()
    await f.useChat.send('s-race', textToSegments('hi'))
    f.chatStore.markRespawnPending('s-race')
    // 模拟 restored 帧先到（renderer useMessageEffects.handleSessionRestored 的收口三件套）
    f.chatStore.clearRespawnPending('s-race')
    f.chatStore.appendRespawnNotice('s-race', 'restored', 'panel.message.respawnRestored')

    f.emit('s-race', msg('s-race', 'message.message_start', { messageId: 'a1' }))

    expect(f.sessionStore.revive).not.toHaveBeenCalled()
    expect(
      f.chatStore
        .getMessages('s-race')
        .filter((m) => m.role === 'system' && (m.details as { variant?: string } | undefined)?.variant === 'restored'),
    ).toHaveLength(1)
    f.dispose()
  })
})
