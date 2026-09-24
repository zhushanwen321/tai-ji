/**
 * createUseChat factory 行为测试（P3 chat 域 w5 → 投递所有权内核 u3b 改造）。
 *
 * 锁定 createUseChat(deps) factory 产物的纯行为（不经 renderer 薄包装）：
 * 统一 submit（乐观气泡 + delivery.submit）/ session.delivery 帧消费与气泡 morph /
 * 送达回执入流 / ensureStreamSubscription 幂等 / message.* 单一入口 / session.* 跨 store
 * 协调 / 错误路径 toast 不 throw / loadMoreHistory / disposeSession。
 *
 * 历史注入的生产通路 = session 域 reconcile（use-session 点击切入统一入口，经
 * historyWindowFromReply 归一后写 store.hydrate/reconcileHistory）——原 useChat.hydrateHistory
 * 死导出已删（b05 候选 4），hydrate 相关用例改走 store.hydrate 验收路径。
 *
 * [u3b 退役] defer flush/S1 拒绝检测/1s 重投 timer/5 次熔断/handleSendRejected/pendingDirectSends
 * /steer pendingBuffer 计数腿相关 describe 已删除（设计 §3.1 删除面），由「统一 submit +
 * delivery 帧 morph + 回执入流」describe 承接，git 可追溯。
 *
 * 模式（对齐 w4 store.test.ts）：effectScope + createChatStore（真实 store）+ mockDeps
 * （chatApi/sessionStore/toast vi.fn），streamSubscribe mock 捕获 handler
 * 供测试主动 emit 消息（模拟 WS 事件流）。beforeEach resetChatModuleStateForTest() 清
 * 模块级 streamSubscriptions + subscriptionStates + 内核投影（测试隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { effectScope, nextTick, toRaw } from 'vue'
import { segmentsToText, textToSegments } from '@taiji/shared'
import type { Segment, ServerMessage } from '@taiji/shared'
import { createChatStore } from '../store'
import { getExecutingBash as getExecutingBashForTest } from '../bash-effects'
import { createUseChat, resetChatModuleStateForTest } from '../useChat'
import { provideDevMode, __resetDevModeForTesting } from '../../../platform/dev-mode'
import type { UseChatDeps } from '../useChat'
import { getDeliveryProjection, replaceDeliveryProjection, resetDeliveryProjectionForTest } from '../effects/user-delivery'
import { historyWindowFromReply } from '../truncated-window'
import { msg, userEndFrame } from './helpers/fixtures'

interface Fixture {
  useChat: ReturnType<typeof createUseChat>
  chatApi: {
    submitDelivery: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
    subagentAction: ReturnType<typeof vi.fn>
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
  /** 主动向 sid 的 streamSubscribe handler 注入一条 ServerMessage（模拟 WS 事件） */
  emit: (sid: string, m: ServerMessage) => void
  dispose: () => void
}

function makeFixture(): Fixture {
  const scope = effectScope(true)
  const streamHandlers = new Map<string, (m: ServerMessage) => void>()
  const chatStore = scope.run(() => createChatStore())!
  const chatApi = {
    // [投递所有权内核 u3b] 统一提交通道（默认 reply = direct/in-flight 受理确认）
    submitDelivery: vi.fn().mockResolvedValue({ clientUuid: 'u-x', state: 'in-flight', lane: 'direct' }),
    // [u5a 注记] send 为 ChatApiPort 存量成员（协议 message.send 是设计显式保留项），core
    // 发送链已不再调用——mock 保留供「零调用」断言；steer/followUp 成员随 u5a 删除。
    send: vi.fn().mockResolvedValue(undefined),
    subagentAction: vi.fn().mockResolvedValue(undefined),
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
  const deps: UseChatDeps = {
    chatApi,
    writeSegments: vi.fn().mockResolvedValue(undefined),
    getChatStore: () => chatStore,
    getSessionStore: () => sessionStore,
    toast,
    t: (k: string, p?: Record<string, unknown>) => (p ? `${k}:${JSON.stringify(p)}` : k),
  }
  const useChat = createUseChat(deps)
  return {
    useChat,
    chatApi,
    chatStore,
    sessionStore,
    toast,
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

  // [u5a 退役] 前身「clearQueueState 转发 core store」用例已删：转发面随 store 侧（queueStates
  // 分区 + clearQueueState 方法）一并删除，无转发可测——pi 槽位回收由 delivery.drain 承担。

  it('send 流程：统一 submit——appendUser 乐观气泡 + submitDelivery（content + clientUuid = 气泡 id）', async () => {
    const f = makeFixture()
    // [R2-A5 失败信号] 成功路径返回 true（Promise<boolean> 契约）
    await expect(f.useChat.send('s1', textToSegments('hello'))).resolves.toBe(true)
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1)
    const [calledSid, calledContent, calledUuid] = f.chatApi.submitDelivery.mock.calls[0] as unknown as [
      string, string, string,
    ]
    expect(calledSid).toBe('s1')
    expect(calledContent).toBe('hello')
    // clientUuid = appendUser 生成的乐观气泡 id（u-<uuid>）——内核条目 id / 帧回执 / morph 身份锚
    const userMsg = f.chatStore.getMessages('s1').find((m) => m.role === 'user')!
    expect(calledUuid).toBe(userMsg.id)
    expect(calledUuid).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    f.dispose()
  })

  it('busy 期发送不转车道（B 策略退役）：统一 submit 照常提交，由内核判定 lane', async () => {
    const f = makeFixture()
    await f.useChat.send('s2', textToSegments('hi'))
    f.emit('s2', msg('s2', 'message.message_start', { messageId: 'a1' }))
    expect(f.chatStore.isActive('s2')).toBe(true)
    await f.useChat.send('s2', textToSegments('more'))
    // 两次都走统一 submit；chatApi.send 零调用（车道判定在 runtime 内核）。
    // [u5a] 前身同时断言 chatApi.steer 零调用——该成员已随 u5a 删除，断言随之移除。
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(2)
    expect(f.chatApi.send).not.toHaveBeenCalled()
    f.dispose()
  })

  it('ensureStreamSubscription 幂等：同 session 二次 send streamSubscribe 只订阅一次', async () => {
    const f = makeFixture()
    await f.useChat.send('s3', textToSegments('one'))
    // 完成首轮（清 streaming/dispatching）
    f.emit('s3', msg('s3', 'message.message_start', { messageId: 'a1' }))
    f.emit('s3', msg('s3', 'message.complete', { stopReason: 'end_turn' }))
    await f.useChat.send('s3', textToSegments('two'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(2)
    f.dispose()
  })

  it('RET: send.rejected 帧零消费（内核排队取代拒绝——无回滚无 toast 无入队）', async () => {
    const f = makeFixture()
    await f.useChat.send('s4', textToSegments('hi'))
    const msgsBefore = f.chatStore.getMessages('s4').length
    f.emit('s4', msg('s4', 'send.rejected', { reason: 'busy', message: '被拒' }))
    // 前身 handler：回滚气泡/入队/toast——整体退役，帧静默终止
    expect(f.chatStore.getMessages('s4').length).toBe(msgsBefore)
    expect(f.toast.error).not.toHaveBeenCalled()
    expect(f.toast.warning).not.toHaveBeenCalled()
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

  it('steer（统一 submit 化）：RPC 失败 → toast + return false（乐观副作用回滚）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8', textToSegments('hi'))
    f.emit('s8', msg('s8', 'message.message_start', { messageId: 'a1' }))
    f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('WS断'))
    await expect(f.useChat.steer('s8', textToSegments('补充'))).resolves.toBe(false)
    // 失败回滚：乐观气泡移除 + inflight 不悬空
    expect(f.chatStore.getMessages('s8').filter((m) => m.role === 'user' && m.status !== 'error')).toHaveLength(1)
    expect(f.chatStore.getInflight('s8')).toBe(1) // 首发的 1；steer 失败回滚后不叠加
    await nextTick()
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('[D2 / form-hang-fix] steer 返回值契约：失败 false，成功 true，早退 false（输入未被消费）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8d2', textToSegments('hi'))
    f.emit('s8d2', msg('s8d2', 'message.message_start', { messageId: 'a1' }))
    // 失败：RPC reject → false
    f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('WS断'))
    await expect(f.useChat.steer('s8d2', textToSegments('补充'))).resolves.toBe(false)
    // 成功：RPC resolve → true
    await expect(f.useChat.steer('s8d2', textToSegments('再补'))).resolves.toBe(true)
    // 早退：空 segments → false（form-hang-fix 契约收窄——原「无事发生 return true」
    // 语义废除，早退也是输入未被消费，调用方须恢复/保留）
    await expect(f.useChat.steer('s8d2', [])).resolves.toBe(false)
    f.dispose()
  })

  it('首尾空白保真：原文（含空白）直达 submitDelivery（Gate B 观测①回归，统一 submit 通路）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8w', textToSegments('hi'))
    f.emit('s8w', msg('s8w', 'message.message_start', { messageId: 'a1' }))
    f.emit('s8w', msg('s8w', 'message.complete', { stopReason: 'end_turn' }))
    await f.useChat.send('s8w', textToSegments('  注意  '))
    const calledContent = f.chatApi.submitDelivery.mock.calls[1]![1] as string
    expect(calledContent).toBe('  注意  ')
    f.dispose()
  })

  it('纯空白文本不发送：空挡拦截（保真修复后空白拦截归调用方）', async () => {
    const f = makeFixture()
    await f.useChat.send('s8b', textToSegments('hi'))
    f.emit('s8b', msg('s8b', 'message.message_start', { messageId: 'a1' }))
    f.emit('s8b', msg('s8b', 'message.complete', { stopReason: 'end_turn' }))
    await f.useChat.send('s8b', textToSegments('   '))
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1) // 仅首发那次
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

  it('hydrate（reconcile 生产通路验收路径）：注入历史 + truncated 窗口标志', () => {
    const f = makeFixture()
    // use-session 点击切入把 getHistory reply 经 historyWindowFromReply 归一后写 store
    // （use-session.ts reconcileHistory 通路）；store.hydrate 消费同形态窗口契约
    f.chatStore.hydrate('s10', [], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 20 }))
    expect(f.useChat.hasMoreHistory('s10')).toBe(true)
    f.dispose()
  })

  it('[u6] loadMoreHistory：游标翻页（cursor = 分区最旧消息身份）页响应收敛 truncated=false', async () => {
    const f = makeFixture()
    f.chatStore.hydrate(
      's11',
      [{ id: 'm1', role: 'user', content: 'q', status: 'complete', timestamp: 1 }],
      historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 20 }),
    )
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
    f.chatStore.hydrate('s11b', [], historyWindowFromReply({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 }))
    // 窗口契约字段写入 store 窗口状态（u4b 透传）
    expect(f.chatStore.getHistoryWindow('s11b')).toEqual({ truncated: true, loadedTurns: 20, totalTurnsEstimate: 42 })
    // [u6] 游标翻页页响应仍截断（锚前有更早历史）
    f.chatApi.getHistory.mockResolvedValueOnce({ messages: [], truncated: true, loadedTurns: 20, totalTurnsEstimate: 40 })
    await f.useChat.loadMoreHistory('s11b')
    expect(f.useChat.hasMoreHistory('s11b')).toBe(true)
    f.dispose()
  })

  it('disposeSession：取消订阅 + 清内核投影，再 send 重新订阅', async () => {
    const f = makeFixture()
    await f.useChat.send('s12', textToSegments('hi'))
    expect(f.chatApi.streamSubscribe).toHaveBeenCalledTimes(1)
    // 预置投影 → dispose 清分区（clearDeliveryProjection 编排）
    replaceDeliveryProjection('s12', [{ clientUuid: 'u-1', preview: 'p', state: 'queued', lane: 'queued' }])
    f.useChat.disposeSession('s12')
    expect(getDeliveryProjection('s12')).toHaveLength(0)
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

  it('subagentId 非空 → subagentAction(message) 被调且 text 序列化含 file/session 段；统一 submit 不被调', async () => {
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
      text: ' #sess-9 /a.ts:L1-L5 展开讲讲',
    })
    // 不走主 agent 通道（§3.3.8 命题 1：无主 agent turn）
    expect(f.chatApi.submitDelivery).not.toHaveBeenCalled()
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
    expect(params.task).toBe(' 帮我修 bug')
    expect(f.chatApi.submitDelivery).not.toHaveBeenCalled()
    f.dispose()
  })

  it('纯 chip 无文本 → 空文本挡：不调 subagentAction，toast 可读错误（不静默）', async () => {
    const f = makeFixture()
    await f.useChat.send('d3', [{ type: 'subagent', subagentId: 'rec-1', slug: 'build-api' }])
    expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
    expect(f.chatApi.submitDelivery).not.toHaveBeenCalled()
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
      // [R2-A5 失败信号] send 契约 Promise<boolean>：定向分流 RPC 失败内部消化 toast，
      // false = 输入未消费（调用方 restoreSegments 恢复草稿）
    ).resolves.toBe(false)
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

  it('主 agent busy 时定向消息不转统一 submit（与主 agent turn 正交）', async () => {
    const f = makeFixture()
    await f.useChat.send('d6', textToSegments('首发'))
    f.emit('d6', msg('d6', 'message.message_start', { messageId: 'a1' }))
    expect(f.chatStore.isActive('d6')).toBe(true)
    await f.useChat.send('d6', [
      { type: 'subagent', subagentId: 'rec-1', slug: 'build-api' },
      { type: 'text', text: 'busy 时追问' },
    ])
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1) // 仅首发
    expect(f.chatApi.subagentAction).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('session 段（无 subagent 段）走统一 submit，#sessionId 序列化进 prompt + u- 标记（U1 验证）', async () => {
    const f = makeFixture()
    await f.useChat.send('d7', [
      { type: 'session', sessionId: 'sess-1', label: '旧会话' },
      { type: 'text', text: '看看这个' },
    ])
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(1)
    const [calledSid, calledContent, calledUuid] = f.chatApi.submitDelivery.mock.calls[0] as unknown as [
      string, string, string,
    ]
    expect(calledSid).toBe('d7')
    // 非纯文本消息（session 段）：u- 标记拼进 prompt（msg-id-mapper 映射通路不变，D8 双标记共存）
    expect(calledContent.startsWith('#sess-1 看看这个')).toBe(true)
    expect(calledContent).toMatch(/<!--taiji:msg:u-[0-9a-fA-F-]{36}-->$/)
    expect(calledUuid).toMatch(/^u-[0-9a-fA-F-]{36}$/)
    expect(f.chatApi.subagentAction).not.toHaveBeenCalled()
    f.dispose()
  })
})

// ── [投递所有权内核 u3b] inflight 占位闭环 + 乐观气泡/回执 ─────────────────────────

describe('统一 submit 的 inflight 占位闭环（u3b：占位保留服务 direct 抵消）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    resetDeliveryProjectionForTest()
  })

  it('send 乐观插入 → inflight +1；确认帧到达 → 抵消归零（direct 车道抵消机制保留，D7）', async () => {
    const f = makeFixture()
    await f.useChat.send('s30', textToSegments('hi'))
    expect(f.chatStore.getInflight('s30')).toBe(1)

    f.emit('s30', userEndFrame('s30', 'hi'))
    expect(f.chatStore.getInflight('s30')).toBe(0)
    f.dispose()
  })

  it('submitDelivery RPC 失败 → catch 回滚 −1 + 乐观气泡回滚（pi 侧无消息、回执永不到来）', async () => {
    const f = makeFixture()
    f.chatApi.submitDelivery.mockRejectedValueOnce(new Error('WS断'))

    // [R2-A5 失败信号] 失败路径返回 false（内部已 toast + 回滚，调用方恢复草稿）
    await expect(f.useChat.send('s31', textToSegments('hi'))).resolves.toBe(false)

    expect(f.chatStore.getInflight('s31')).toBe(0)
    expect(f.chatStore.getMessages('s31')).toHaveLength(0)
    expect(f.toast.error).toHaveBeenCalled()
    f.dispose()
  })

  it('editAndResend 同样挂钩（统一 submit 化：其 message_end 走 ① 标记匹配回收）', async () => {
    const f = makeFixture()
    await f.useChat.send('s33', textToSegments('old'))
    const userMsgId = f.chatStore.getMessages('s33').find((m) => m.role === 'user')!.id
    f.emit('s33', msg('s33', 'message.message_start', { messageId: 'a1' }))
    f.emit('s33', msg('s33', 'message.complete', { stopReason: 'end_turn' }))

    // [R2-A5 失败信号] 成功路径返回 true（Promise<boolean> 契约，与 send 同）
    await expect(f.useChat.editAndResend('s33', userMsgId, textToSegments('edited'))).resolves.toBe(true)

    // 统一 submit 化后编辑重发与 send 同编排：乐观气泡 + inflight 占位（原「不挂钩」契约退役）。
    // 首发的 1（未确认——本用例未发 message_end(user)）+ 编辑重发的 1 = 2。
    expect(f.chatStore.getInflight('s33')).toBe(2)
    expect(f.chatApi.submitDelivery).toHaveBeenCalledTimes(2)
    f.dispose()
  })
})

// ── [投递所有权内核 u3b / D7] session.delivery 帧消费 + 乐观气泡 morph + 送达回执入流 ──

describe('session.delivery 帧消费与气泡 morph（u3b / D7）', () => {
  beforeEach(() => {
    resetChatModuleStateForTest()
    resetDeliveryProjectionForTest()
  })

  /** session.delivery 帧工厂 */
  function deliveryFrame(sid: string, entries: Array<{ clientUuid: string; state: string; lane: string }>): ServerMessage {
    return {
      type: 'session.delivery',
      payload: {
        sessionId: sid,
        entries: entries.map((e) => ({ clientUuid: e.clientUuid, preview: 'p', state: e.state, lane: e.lane })),
      },
    } as unknown as ServerMessage
  }

  it('morph：steer 车道帧到达 → 乐观气泡移出对话流 + 投影落位（队列区数据）+ dispatching 占位回收', async () => {
    const f = makeFixture()
    await f.useChat.send('m1', textToSegments('补充要求'))
    const bubbleId = f.chatStore.getMessages('m1').find((m) => m.role === 'user')!.id
    expect(f.chatStore.getMessages('m1').some((m) => m.id === bubbleId)).toBe(true)

    f.emit('m1', deliveryFrame('m1', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'steer' }]))

    // 气泡 morph：移出对话流（气泡 → 队列条目）
    expect(f.chatStore.getMessages('m1').some((m) => m.id === bubbleId)).toBe(false)
    // 投影落位（单一数据源，u3c QueueBubble 消费）
    expect(getDeliveryProjection('m1')).toHaveLength(1)
    expect(getDeliveryProjection('m1')[0]).toMatchObject({ clientUuid: bubbleId, state: 'in-flight', lane: 'steer' })
    // 非直发车道：dispatching 空窗占位回收（无「本条即将触发 message_start」语义）
    expect(f.chatStore.isPendingSend('m1')).toBe(false)
    f.dispose()
  })

  it('direct 车道帧：气泡保持待确认（不 morph 不移除），投影照常落位', async () => {
    const f = makeFixture()
    await f.useChat.send('m2', textToSegments('直达消息'))
    const bubbleId = f.chatStore.getMessages('m2').find((m) => m.role === 'user')!.id

    f.emit('m2', deliveryFrame('m2', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'direct' }]))

    // direct → 待确认气泡保持（既有 inflightCounts 抵消机制服务 direct）
    expect(f.chatStore.getMessages('m2').some((m) => m.id === bubbleId)).toBe(true)
    expect(getDeliveryProjection('m2')).toHaveLength(1)
    f.dispose()
  })

  it('delivered 帧条目无 morph 面（transcript 权威由 reducer 承担）', async () => {
    const f = makeFixture()
    await f.useChat.send('m3', textToSegments('已送达消息'))
    const bubbleId = f.chatStore.getMessages('m3').find((m) => m.role === 'user')!.id

    f.emit('m3', deliveryFrame('m3', [{ clientUuid: bubbleId, state: 'delivered', lane: 'steer' }]))

    // delivered 条目：无 morph 动作（气泡既已不在也不重建；帧只更新投影）
    expect(getDeliveryProjection('m3')[0]?.state).toBe('delivered')
    f.dispose()
  })

  // [u3b 迁移] 本用例承接 store.test.ts 前身「steer 投递后 user 气泡进消息流且 segments 完整
  //（用户可见行为）」——原用例的 queue_update drain 驱动链已退役（D7），用户可见判据原样保留：
  // 富内容段（skill badge）不丢、引用恒等（morph 暂存搬运非重建）、序列化文本保真。
  it('送达回执 → 按序入流：morph 段经 message_end(user) ① 标记匹配回填为正常气泡（用户可见）', async () => {
    const f = makeFixture()
    const segs: Segment[] = [{ type: 'skill', name: 'deploy' }, { type: 'text', text: ' --prod' }]
    await f.useChat.send('m4', segs)
    const bubble = f.chatStore.getMessages('m4').find((m) => m.role === 'user')!
    const bubbleId = bubble.id

    // 1) steer 车道帧 → morph（气泡移除 + 原段暂存）
    f.emit('m4', deliveryFrame('m4', [{ clientUuid: bubbleId, state: 'in-flight', lane: 'steer' }]))
    expect(f.chatStore.getMessages('m4').some((m) => m.id === bubbleId)).toBe(false)

    // 2) 内核投递完成：message_end(user) 携带裸标记（bare = clientUuid 去 u- 前缀）
    const bare = bubbleId.slice(2)
    f.emit('m4', userEndFrame('m4', 'deploy --prod', bare))

    // morph 段按原 segments 回填为正常 user 气泡（按序入流，用户可见 DOM 断言）
    const users = f.chatStore.getMessages('m4').filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    const delivered = users[0]!
    expect(delivered.status).toBe('complete')
    // 段保真：skill badge 段引用恒等（morph 暂存搬运非重建）+ 序列化文本与提交原样一致
    expect(toRaw(delivered.content)).toBe(segs)
    expect(segmentsToText(delivered.content as Segment[])).toBe('<taiji-skill name="deploy"/> --prod')
    // 投影转 delivered（队列条目随即隐去）+ inflight 占位回收
    expect(getDeliveryProjection('m4')[0]?.state).toBe('delivered')
    expect(f.chatStore.getInflight('m4')).toBe(0)
    f.dispose()
  })

  it('multi-burst：两条连发均 queued → 倒序 morph 互不误删（truncateFrom 尾部先行）', async () => {
    const f = makeFixture()
    await f.useChat.send('m5', textToSegments('第一条'))
    await f.useChat.send('m5', textToSegments('第二条'))
    const ids = f.chatStore.getMessages('m5').filter((m) => m.role === 'user').map((m) => m.id)
    expect(ids).toHaveLength(2)

    f.emit('m5', deliveryFrame('m5', [
      { clientUuid: ids[0]!, state: 'queued', lane: 'queued' },
      { clientUuid: ids[1]!, state: 'queued', lane: 'queued' },
    ]))

    // 两条气泡全部 morph 移除（倒序截断不误删后条）
    expect(f.chatStore.getMessages('m5').filter((m) => m.role === 'user')).toHaveLength(0)
    expect(getDeliveryProjection('m5')).toHaveLength(2)
    // 投递序回执：第一条先回（气泡回填），第二条后回——回填顺序与发送序一致
    //（回执入流产生新消息 id（appendUser 生成新 u-<uuid>），按 content 文本断言顺序）
    f.emit('m5', userEndFrame('m5', '第一条', ids[0]!.slice(2)))
    f.emit('m5', userEndFrame('m5', '第二条', ids[1]!.slice(2)))
    const users = f.chatStore.getMessages('m5').filter((m) => m.role === 'user')
    expect(users).toHaveLength(2)
    const textOf = (m: (typeof users)[number]) =>
      (Array.isArray(m.content) ? (m.content as unknown as Array<{ type: string; text?: string }>) : [])
        .filter((s) => s.type === 'text')
        .map((s) => s.text ?? '')
        .join('')
    expect(textOf(users[0]!)).toBe('第一条')
    expect(textOf(users[1]!)).toBe('第二条')
    f.dispose()
  })

  it('occupancy idle 帧只写投影（flush 触发源退役——重投由内核驱动）', async () => {
    const f = makeFixture()
    await f.useChat.send('m6', textToSegments('hi'))
    f.emit('m6', msg('m6', 'session.occupancy', { turn: 'idle', compacting: false, bash: false }))
    // 前身：全 idle + 队列非空 → flush 投递；退役后 occupancy 只维护投影，无任何投递编排
    expect(f.toast.error).not.toHaveBeenCalled()
    expect(f.toast.warning).not.toHaveBeenCalled()
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
    expect(f.chatStore.getMessages('e3')).toHaveLength(0)
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

// ── [RD-1#9] 未列 session.* 帧类型的 dev 观测（协议漂移零痕迹 → 一次/类型 warn）──────────

describe('未列 session.* 帧类型的 dev 观测（RD-1#9）', () => {
  /** 只取本观测点的 warn 行（send 路径另有 subscribe 端口未注入的 warn，须滤除）。 */
  function frameWarns(warn: ReturnType<typeof vi.spyOn>): string[] {
    return warn.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((m: string) => m.includes('unhandled session frame type'))
  }

  beforeEach(() => {
    resetChatModuleStateForTest()
    __resetDevModeForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetDevModeForTesting()
    resetChatModuleStateForTest()
  })

  it('dev 下未列 session.* 类型 → console.warn 一次/类型；已列类型不 warn', () => {
    provideDevMode(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = makeFixture()
    void f.useChat.send('s90', textToSegments('hi'))

    // 已列类型（session.renamed 有 case）不 warn
    f.emit('s90', msg('s90', 'session.renamed', { name: 'renamed' }))
    expect(frameWarns(warn)).toHaveLength(0)

    // 未列 session.* 类型：去重后一次/类型
    f.emit('s90', msg('s90', 'session.exited', { code: 1 }))
    f.emit('s90', msg('s90', 'session.exited', { code: 2 }))
    expect(frameWarns(warn)).toEqual([
      expect.stringContaining('unhandled session frame type session.exited'),
    ])

    // 另一未列类型独立计数
    f.emit('s90', msg('s90', 'session.stats_update', {}))
    expect(frameWarns(warn)).toHaveLength(2)
    f.dispose()
  })

  it('非 session.* 前缀的全局帧不 warn（app.info / config.* 由其他域消费，warn 即误报）', () => {
    provideDevMode(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = makeFixture()
    void f.useChat.send('s91', textToSegments('hi'))

    f.emit('s91', msg('s91', 'app.info', { version: '1' }))
    f.emit('s91', msg('s91', 'config.plugins', { plugins: [] }))
    expect(frameWarns(warn)).toHaveLength(0)
    f.dispose()
  })

  it('非 dev（未注入 provideDevMode）→ 零 warn（生产零噪音）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = makeFixture()
    void f.useChat.send('s92', textToSegments('hi'))

    f.emit('s92', msg('s92', 'session.exited', { code: 1 }))
    expect(frameWarns(warn)).toHaveLength(0)
    f.dispose()
  })
})
