/**
 * HandoffService（服务协议 / handoff-prompt / MessageBus 集成 BLOCKER-1）合并测试。
 *
 * 来源（各来源节以基名 describe 包裹，节内顶层 hook/helper/mock 随节下沉）：
 * - handoff-service.test.ts
 * - handoff-message-bus.test.ts
 *
 * 运行：cd packages/runtime && TAIJI_SKIP_REAL_PI=1 npx vitest run src/services/__tests__/handoff-service.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message, ServerMessage } from '@taiji/shared'
import type { IMessageBroker } from '../../interfaces.js'
import { HANDOFF_PROMPT_TEMPLATE, REPLY_MAX_LENGTH, buildHandoffPrompt, sanitizeReply } from '../handoff-prompt.js'
import { HandoffService, HANDOFF_TIMEOUT_MS } from '../handoff-service.js'
import { MessageBus } from '../message-bus/message-bus.js'
import type { BusClient } from '../message-bus/types.js'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { SessionService } from '../session/session-service.js'

describe('handoff-service', () => {
/**
 * HandoffService 单元测试（agent-driven）。
 *
 * 覆盖新流程：runHandoff 让源 session 跑 handoff turn → 从 turn-end 终态帧提取 doc →
 * 新建 session + 注入 doc + 广播（无 doc/reply 字段，DM3）。abort / timeout /
 * 空文档 / 并发检查 / 重试过滤两分支（willRetry 跳过 / stopReason:error 拒绝，U3②
 * D15.1 混合案 a+）/ buildHandoffPrompt 全覆盖。
 *
 * [U3②] 事件驱动形态：mock client emit pi 原始 agent_end 事件（onEvent 契约不变），
 * handoff 内部经 event-adapter 翻译成派生视图消费——原「首个 agent_end 即收尾」的重试误杀
 * 由 willRetry 跳过 + stopReason 拒绝修复；原 extractFinalTextFromAgentEnd 直测族随
 * 函数退役删除（提取逻辑迁 event-adapter extractFinalContent，text 非 string 畸形归一
 * 语义以行为用例 TC-S1 锚定）。
 *
 * 测试框架：vitest（禁止 node:test）。
 */
/**
 * Mock IPiEngine：记录 onEvent 注册的 listener，提供 emit 触发。
 * prompt/abort 默认立即 resolve（fire-and-forget ack）。
 */
interface MockClient {
  prompt: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  _listeners: Set<(event: unknown) => void>
  _exitListeners: Set<(code: number | null, stderr: string) => void>
  /** 触发所有已注册 listener（单参数 event，符合 PiEventListener 签名）。 */
  emit(event: unknown): void
  /** 触发所有已注册 onExit 回调（模拟 pi 进程退出）。 */
  emitExit(code: number | null): void
}

function createMockClient(): MockClient {
  const listeners = new Set<(event: unknown) => void>()
  const exitListeners = new Set<(code: number | null, stderr: string) => void>()
  const client: MockClient = {
    prompt: vi.fn(async () => ({})),
    abort: vi.fn(async () => ({})),
    _listeners: listeners,
    _exitListeners: exitListeners,
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    onExit: vi.fn((callback: (code: number | null, stderr: string) => void) => {
      exitListeners.add(callback)
      return () => {
        exitListeners.delete(callback)
      }
    }),
    emit(event: unknown) {
      for (const l of listeners) l(event)
    },
    emitExit(code: number | null) {
      for (const l of exitListeners) l(code, '')
    },
  }
  return client
}

function createMockSessionService(opts: {
  srcSessionId: string
  newSessionId?: string
  srcClient: MockClient
  newClient: MockClient
}): SessionService {
  const newSessionId = opts.newSessionId ?? 'new-1'
  return {
    getHistory: vi.fn(async () => ({
      messages: [makeMessage('user', 'hi')] as Message[],
      truncated: false,
      loadedTurns: 1,
      totalTurnsEstimate: 1,
    })),
    getSession: vi.fn(() => ({
      cwd: '/tmp',
      label: 'src',
      sessionFilePath: '/tmp/s.json',
    })) as unknown as SessionService['getSession'],
    // D6（state-truth-sync C5）：runHandoff create 前读源生效值会调 findScannedSession
    //（内存实例字段缺值时的 sidecar 兜底）——默认无 sidecar（E9 回落语义用例另行 mock）。
    findScannedSession: vi.fn(() => undefined) as unknown as SessionService['findScannedSession'],
    create: vi.fn(async () => ({
      id: newSessionId,
      label: 'handoff from src',
      cwd: '/tmp',
    })) as unknown as SessionService['create'],
    markHandedOff: vi.fn() as unknown as SessionService['markHandedOff'],
    ensureActive: vi.fn(async (sessionId: string) => {
      if (sessionId === opts.srcSessionId) return opts.srcClient as unknown as IPiEngine
      if (sessionId === newSessionId) return opts.newClient as unknown as IPiEngine
      throw new Error(`ensureActive: unexpected sessionId ${sessionId}`)
    }) as unknown as SessionService['ensureActive'],
  } as unknown as SessionService
}

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
  } as unknown as IMessageBroker
}

function makeMessage(role: 'user' | 'assistant', content: string): Message {
  return {
    id: `msg-${role}`,
    role,
    content,
    status: 'done' as const,
  } as unknown as Message
}

describe('HandoffService', () => {
  let broker: ReturnType<typeof createMockBroker>
  let broadcastSessionList: () => void
  let nextPushId: () => string
  let srcClient: MockClient
  let newClient: MockClient
  let sessionService: SessionService
  let service: HandoffService

  beforeEach(() => {
    broker = createMockBroker()
    broadcastSessionList = vi.fn()
    nextPushId = vi.fn(() => 'push-123')
    srcClient = createMockClient()
    newClient = createMockClient()
    sessionService = createMockSessionService({
      srcSessionId: 'src-1',
      newSessionId: 'new-1',
      srcClient,
      newClient,
    })
    service = new HandoffService({ sessionService, broker, broadcastSessionList, nextPushId })
  })

  it('TC1: runHandoff 主路径 — agent_end 提取 doc，新建 session 注入 wrapWithXmlTag(doc)，广播无 doc/reply', async () => {
    const runPromise = service.runHandoff('src-1')

    // 等一微任务让 ensureActive + onEvent + prompt 注册完成
    await new Promise((r) => setTimeout(r, 0))

    expect(srcClient.onEvent).toHaveBeenCalled()
    expect(srcClient.prompt).toHaveBeenCalledTimes(1)
    expect(srcClient.prompt).toHaveBeenCalledWith(HANDOFF_PROMPT_TEMPLATE)

    // emit agent_end with text content
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc content' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // B2：new session 注入 wrapWithXmlTag(doc, srcLabel)
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('<handoff_document source="src"')
    expect(injectedPrompt).toContain('doc content')
    expect(injectedPrompt).toContain('</handoff_document>')
    expect(injectedPrompt).toContain('Immediately execute the next incomplete item')
    // 广播
    expect(broadcastSessionList).toHaveBeenCalled()
    expect(broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.handoffComplete',
        id: 'push-123',
        payload: {
          srcSessionId: 'src-1',
          newSessionId: 'new-1',
          sourceLabel: 'src',
        },
      }),
    )
    // payload 不含 doc / reply 字段（DM3 协议变更）
    // W5：也不含多余的 sessionId（协议类型只有 srcSessionId/newSessionId/sourceLabel，
    // sessionId 会被前端 routeInbound 误当路由字段）
    // wave:perf-w08（02 D1-1）：handoffStarted 广播已删除（前端无消费方）——
    // 主路径全程只广播 handoffComplete 一次
    const handoffCompleteCall = vi.mocked(broker.broadcast).mock.calls.find(
      (c: any[]) => c[0].type === 'session.handoffComplete',
    )![0] as { payload: Record<string, unknown> }
    expect(handoffCompleteCall.payload).not.toHaveProperty('doc')
    expect(handoffCompleteCall.payload).not.toHaveProperty('reply')
    expect(handoffCompleteCall.payload).not.toHaveProperty('sessionId')
    expect(vi.mocked(broker.broadcast).mock.calls).toHaveLength(1)

    // listener 已清理（detach 调用 → _listeners 空 → inflight 清空）
    expect(srcClient._listeners.size).toBe(0)
    // inflight 已清空：再调 runHandoff 不会同步 reject 'already in progress'
    // （会卡在 await agentEndPromise，我们立即 abort 掉避免悬挂）
    const again = service.runHandoff('src-1').catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    await service.abortHandoff('src-1')
    await again
  })

  it('TC2: reply 不追加到源 session prompt，而是追加到新 session 注入', async () => {
    const runPromise = service.runHandoff('src-1', 'focus on tests')
    await new Promise((r) => setTimeout(r, 0))

    // B3：buildHandoffPrompt 不再接受 reply 参数，源 session prompt 只含模板
    expect(srcClient.prompt).toHaveBeenCalledWith(HANDOFF_PROMPT_TEMPLATE)
    expect(srcClient.prompt).not.toHaveBeenCalledWith(
      expect.stringContaining('focus on tests'),
    )

    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'd' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await runPromise

    const call = vi.mocked(broker.broadcast).mock.calls[0]![0] as { payload: Record<string, unknown> }
    expect(call.payload).not.toHaveProperty('reply')
  })

  it('TC2b: reply 追加到新 session 注入（wrapWithXmlTag 之后）', async () => {
    const runPromise = service.runHandoff('src-1', 'focus on tests')
    await new Promise((r) => setTimeout(r, 0))

    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc content' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await runPromise

    // B2+B3：new session 注入 wrapWithXmlTag(doc) + reply
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('<handoff_document source="src"')
    expect(injectedPrompt).toContain('doc content')
    expect(injectedPrompt).toContain('</handoff_document>')
    // reply 追加到末尾
    expect(injectedPrompt).toContain('focus on tests')
    // reply 在 xml tag 之后
    const xmlCloseIndex = injectedPrompt.indexOf('</handoff_document>')
    const replyIndex = injectedPrompt.indexOf('focus on tests')
    expect(replyIndex).toBeGreaterThan(xmlCloseIndex)
  })

  it('TC2c: wave:perf-w08 handoffStarted 广播已删除 — 全程零 handoffStarted，仅完成后 handoffComplete 一次', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    // handoff 开始时零广播（原 B1 handoffStarted 已删——前端无消费方，02 文档 D1-1）
    expect(broker.broadcast).not.toHaveBeenCalled()
    // prompt 正常发出
    expect(srcClient.prompt).toHaveBeenCalledTimes(1)

    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'd' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await runPromise

    // 完成后应有 handoffComplete（且是唯一一次广播）
    expect(broker.broadcast).toHaveBeenCalledTimes(1)
    expect(broker.broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.handoffComplete',
    }))
  })

  it('TC3: agent_end 末条 content 无 text → rejects（empty），create 未调，只广播 handoffStarted', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    srcClient.emit({
      type: 'agent_end',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'write', input: {} }],
          stopReason: 'stop',
        },
      ],
      willRetry: false,
    })

    await expect(runPromise).rejects.toThrow('empty')
    expect(sessionService.create).not.toHaveBeenCalled()
    // wave:perf-w08：handoffStarted 广播已删，empty 路径全程零广播（原断言 1 次 handoffStarted）
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC4: timeout — 不 emit agent_end，advance timer → rejects（timeout），create 未调', async () => {
    vi.useFakeTimers()
    try {
      const runPromise = service.runHandoff('src-1')
      // 预挂 catch，避免 timer 触发的 reject 在 await expect 之前成为 unhandled rejection
      const expectPromise = expect(runPromise).rejects.toThrow('timeout')
      // 让 ensureActive / onEvent / prompt（async resolve）跑完
      await vi.advanceTimersByTimeAsync(0)

      // 推进到超时
      await vi.advanceTimersByTimeAsync(HANDOFF_TIMEOUT_MS)

      await expectPromise
      expect(sessionService.create).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('TC5: 并发检查 — 同 session 再调 runHandoff 同步 reject（already in progress）', async () => {
    // 第一次不 emit agent_end，保持 pending
    const first = service.runHandoff('src-1').catch(() => {})
    await new Promise((r) => setTimeout(r, 0))

    await expect(service.runHandoff('src-1')).rejects.toThrow('already in progress')

    // 让第一个干净收尾（emit 空 doc 触发 reject 清理 inflight）
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'x' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await first
  })

  it('TC6: abortHandoff — abort 调用，runHandoff rejects（abort），只广播 handoffStarted，返回 true', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    await expect(service.abortHandoff('src-1')).resolves.toBe(true)

    expect(srcClient.abort).toHaveBeenCalledTimes(1)
    await expect(runPromise).rejects.toThrow('abort')
    // wave:perf-w08：handoffStarted 广播已删，abort 路径零广播（原断言 1 次 handoffStarted）
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC7: abortHandoff 幂等 — inflight 空时 no-op，abort 未调，返回 false', async () => {
    await expect(service.abortHandoff('src-1')).resolves.toBe(false) // no-op，不抛
    expect(srcClient.abort).not.toHaveBeenCalled()
  })

  it('TC8: abort 失败兜底 — abort 抛错，abortHandoff 仍 resolve（true），runHandoff rejects（abort），console.warn 被调', async () => {
    srcClient.abort = vi.fn(async () => {
      throw new Error('pi dead')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    await expect(service.abortHandoff('src-1')).resolves.toBe(true)
    await expect(runPromise).rejects.toThrow('abort')

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('TC8b: W3 pi 中途退出 — onExit 触发后 runHandoff rejects（source pi exited），不挂到 timeout', async () => {
    const runPromise = service.runHandoff('src-1')
    // 预挂 catch，避免 reject 成为 unhandled rejection
    const expectPromise = expect(runPromise).rejects.toThrow('source pi exited')
    // 让 ensureActive / onEvent / onExit / prompt（async resolve）跑完
    await new Promise((r) => setTimeout(r, 0))

    // 模拟 pi 中途崩溃：触发 onExit 回调
    srcClient.emitExit(1)

    await expectPromise
    // 远未到 timeout（10 分钟），证明 exit 事件命中而非超时
    // wave:perf-w08：handoffStarted 广播已删，exit 路径零广播（原断言 1 次 handoffStarted）
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  it('TC8c: W4 settle 后 abort no-op — agent_end resolve 后再 abort 不抛错且广播未发（已 settle 的 promise 不再 reject）', async () => {
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    // emit agent_end → finalize resolve（内部已 cleanupInflight 移除 entry）
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc' }], stopReason: 'stop' }],
      willRetry: false,
    })
    await runPromise

    // settle 后再 abort：inflight 已空 → no-op 返回 false（不广播、不重复 reject）
    await expect(service.abortHandoff('src-1')).resolves.toBe(false)
    // runHandoff 主路径已广播 session.handoffComplete，不应再叠加 handoffAborted
    const aborted = vi.mocked(broker.broadcast).mock.calls.some(
      (c) => (c[0] as { type?: string }).type === 'session.handoffAborted',
    )
    expect(aborted).toBe(false)
  })

  it('TC8d: C1 竞态 — agent_end finalize 清理 inflight 后 abort 到达，半文档不泄漏到新 session', async () => {
    // 模拟竞态：agent_end 先 finalize（cleanupInflight 移除 entry），用户随后调 abort。
    // 修复前：abort 发现 inflight 空，返回 false 且不加入 abortedSessions → 微任务执行时
    // abortedSessions.has 为 false → 半文档泄漏到新 session。
    // 修复后：abort 发现 inflight 空，仍加入 abortedSessions → runHandoff 检查命中 → throw。
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    // emit agent_end → finalize resolve（cleanupInflight 移除 entry，但 runHandoff 尚未继续）
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial doc' }], stopReason: 'stop' }],
      willRetry: false,
    })
    // 让 finalize 的 microtask 排队但不让 runHandoff 继续——在此窗口调 abort。
    // 由于 JS 单线程，emit 触发 finalize 后同步返回，此时 inflight 已被 cleanupInflight 移除。
    // abortHandoff 应仍标记 abortedSessions。
    await expect(service.abortHandoff('src-1')).resolves.toBe(false) // inflight 无 entry → false
    // runHandoff 应因 abortedSessions 检查而 throw，不创建新 session
    await expect(runPromise).rejects.toThrow('handoff aborted')
    expect(sessionService.create).not.toHaveBeenCalled()
    // handoffStarted 已删除（wave:perf-w08），handoffComplete 不应广播
    const hasComplete = vi.mocked(broker.broadcast).mock.calls.some(
      (c) => (c[0] as { type?: string }).type === 'session.handoffComplete',
    )
    expect(hasComplete).toBe(false)
  })

  it('TC8f: abort called while agentEndPromise pending → agent_end resolve wins race → abortedSessions guard rejects, no new session', async () => {
    // M5: 测试 agent_end 与 abort 竞态的另一时序——abort 先到（inflight 有 entry），
    // agent_end 随后 resolve。abortHandoff 标记 abortedSessions + reject entry，
    // 但 agent_end 的 finalize 可能先执行（settled 保护）。
    // 无论哪种时序，abortedSessions 检查保证不创建新 session。
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    // agentEndPromise 仍 pending，此时调 abortHandoff（inflight 有 entry → 返回 true）
    await expect(service.abortHandoff('src-1')).resolves.toBe(true)
    expect(srcClient.abort).toHaveBeenCalledTimes(1)

    // agent_end 随后到达（abort reject 已 settle → agent_end finalize no-op，
    // 或 agent_end finalize 先 settle → abort reject no-op）。
    // 无论时序，runHandoff 应 reject 'handoff aborted'。
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'late doc' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await expect(runPromise).rejects.toThrow('handoff aborted')
    // abortedSessions 检查阻断：createSession 未被调用
    expect(sessionService.create).not.toHaveBeenCalled()
    // handoffStarted 已删除（wave:perf-w08），handoffComplete 不应广播
    const hasComplete = vi.mocked(broker.broadcast).mock.calls.some(
      (c) => (c[0] as { type?: string }).type === 'session.handoffComplete',
    )
    expect(hasComplete).toBe(false)
  })

  it('TC8e: session switch during active handoff → handoff continues in background → handoffComplete broadcasts correctly', async () => {
    // m8: 用户在 handoff 进行中切换 session（renderer 侧行为，不影响 runtime handoff）。
    // runtime handoff 继续在后台运行——验证 handoff 仍能正常完成。
    const runPromise = service.runHandoff('src-1')
    await new Promise((r) => setTimeout(r, 0))

    // 模拟 session 切换（renderer selectSession 等，不影响 runtime handoff 流程）。
    // handoff 继续在后台运行。
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'background doc' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // handoff 完成后 handoffComplete 广播正确
    expect(broker.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.handoffComplete',
        payload: {
          srcSessionId: 'src-1',
          newSessionId: 'new-1',
          sourceLabel: 'src',
        },
      }),
    )
    // new session 注入了文档
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('background doc')
  })

  it('TC_empty: source session 无历史（messages 为空）→ reject "handoff: no history to handoff"', async () => {
    // m9: getHistory 返回空 messages → reject，不触发后续流程
    vi.mocked(sessionService.getHistory).mockResolvedValueOnce({
      messages: [] as Message[],
      truncated: false,
      loadedTurns: 0,
      totalTurnsEstimate: 0,
    })

    await expect(service.runHandoff('src-1')).rejects.toThrow('handoff: no history to handoff')
    // 无历史 → 不应调 ensureActive / prompt / broadcast
    expect(srcClient.prompt).not.toHaveBeenCalled()
    expect(broker.broadcast).not.toHaveBeenCalled()
  })

  describe('D6 源生效值继承（state-truth-sync C5）——链 = staging override > 源当前生效值 > 全局默认', () => {
    /** 触发 agent_end 并等 runHandoff 收尾（doc 文本任意非空）。 */
    async function runWithAgentEnd(options?: { modelOverride?: string; thinkingOverride?: string }): Promise<void> {
      const runPromise = service.runHandoff('src-1', undefined, options)
      await new Promise((r) => setTimeout(r, 0))
      srcClient.emit({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc' }], stopReason: 'stop' }],
        willRetry: false,
      })
      await runPromise
    }

    /** 取 create 第三参（options 对象）。 */
    function createOptions(): Record<string, unknown> {
      expect(sessionService.create).toHaveBeenCalledTimes(1)
      return vi.mocked(sessionService.create).mock.calls[0]![2] as Record<string, unknown>
    }

    it('TC-D6a: 活跃源（内存实例带生效值）→ create 透传源 modelId + thinkingLevel', async () => {
      // 源 session 切过模型（switchModel 直写内存实例 modelId/thinkingLevel 的形态）
      vi.mocked(sessionService.getSession).mockImplementation((() => ({
        cwd: '/tmp', label: 'src', sessionFilePath: '/tmp/s.json',
        modelId: 'p/flash', thinkingLevel: 'high',
      })) as never)

      await runWithAgentEnd()

      const opts = createOptions()
      expect(opts.modelOverride).toBe('p/flash')
      expect(opts.thinkingOverride).toBe('high')
    })

    it('TC-D6b: staging override 优先——传了不覆盖（fork-ask 暂存值 > 源生效值）', async () => {
      vi.mocked(sessionService.getSession).mockImplementation((() => ({
        cwd: '/tmp', label: 'src', sessionFilePath: '/tmp/s.json',
        modelId: 'p/flash', thinkingLevel: 'high',
      })) as never)

      await runWithAgentEnd({ modelOverride: 'staging/m', thinkingOverride: 'low' })

      const opts = createOptions()
      expect(opts.modelOverride).toBe('staging/m')
      expect(opts.thinkingOverride).toBe('low')
    })

    it('TC-D6c: E9 源真值不可读（内存字段缺值且无 sidecar）→ create 不带 override（回落全局默认，现行为不劣化）', async () => {
      // 默认 mock：getSession 返回无 modelId/thinkingLevel + findScannedSession → undefined
      await runWithAgentEnd()

      const opts = createOptions()
      expect(opts.modelOverride).toBeUndefined()
      expect(opts.thinkingOverride).toBeUndefined()
    })

    it('TC-D6d: 字段级独立走链——内存 modelId 命中、thinkingLevel 空串归一后由 sidecar 扫描值兜底', async () => {
      // restore 播种空串占位形态：内存 thinkingLevel='' 不得吞掉 sidecar 档
      vi.mocked(sessionService.getSession).mockImplementation((() => ({
        cwd: '/tmp', label: 'src', sessionFilePath: '/tmp/s.json',
        modelId: 'mem/m', thinkingLevel: '',
      })) as never)
      vi.mocked(sessionService.findScannedSession).mockImplementation((() => ({
        filePath: '/tmp/s.json', modelId: 'side/m', thinkingLevel: 'medium',
      })) as never)

      await runWithAgentEnd()

      const opts = createOptions()
      expect(opts.modelOverride).toBe('mem/m')
      expect(opts.thinkingOverride).toBe('medium')
    })

    it('TC-D6e: 刻意不继承 preset——create options 无 presetId 键（承接 session 不带源 preset 的 tools/noSkills 限制，D6 两条链分别声明）', async () => {
      vi.mocked(sessionService.getSession).mockImplementation((() => ({
        cwd: '/tmp', label: 'src', sessionFilePath: '/tmp/s.json',
        modelId: 'p/flash', thinkingLevel: 'high',
      })) as never)

      await runWithAgentEnd()

      const opts = createOptions()
      // handoff 现状不传 presetId：不新增 preset 继承档（否则首次继承源 preset 的
      // tools/noSkills 全套限制——夹带行为变更）。静态检查见 binding-registry-hydrate Part 2。
      expect(opts).not.toHaveProperty('presetId')
      // 防顺手继承漂移（CREATE_DERIVED_CALLERS 承诺）运行时侧
      expect(opts).not.toHaveProperty('spawnSource')
      expect(opts).not.toHaveProperty('parentAgentSessionId')
    })
  })

  describe('U3② 重试过滤两分支（D15.1 混合案 a+）', () => {
    /** 发起 runHandoff 并等监听注册完成。 */
    /**
     * 发起 runHandoff 并等监听注册完成。返回包装对象（不经 async return 展平 runPromise——
     * async 函数 return promise 时调用方 await 会等到其 settle，emit 必须发生在 await 之前，
     * 展平会让 emit 永远执行不到 = 测试死锁）。
     */
    async function startHandoff(): Promise<{ runPromise: Promise<void> }> {
      const runPromise = service.runHandoff('src-1')
      await new Promise((r) => setTimeout(r, 0))
      return { runPromise }
    }

    it('TC-retry-skip: willRetry:true 中间失败帧跳过（不误杀），后续正常帧 resolve', async () => {
      const runPromise = await startHandoff()

      // pi 出错自动重试的中间失败帧：stopReason=error + willRetry=true + 空 messages
      //（原实现「首个 agent_end 即收尾」在此误杀：空文档 reject）。现在必须跳过。
      srcClient.emit({
        type: 'agent_end',
        messages: [],
        willRetry: true,
      })

      // 跳过语义 = 仍 inflight 在途（无 reject/resolve）；发一条普通消息确认未被收尾
      srcClient.emit({ type: 'message_update', message: { role: 'assistant', content: [] } })
      await new Promise((r) => setTimeout(r, 0))
      expect(sessionService.create).not.toHaveBeenCalled()

      // 重试成功轮：正常终态帧 → resolve → create 新 session
      srcClient.emit({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'doc after retry' }], stopReason: 'stop' }],
        willRetry: false,
      })
      await runPromise
      // runHandoff 在 agentEndPromise settle 后还有收尾链（create → ensureActive → 注入
      // prompt），await runPromise 只等 agentEndPromise——补一个宏任务等收尾链跑完
      await new Promise((r) => setTimeout(r, 0))
      expect(sessionService.create).toHaveBeenCalledTimes(1)
      expect(newClient.prompt).toHaveBeenCalledTimes(1)
      expect(newClient.prompt.mock.calls[0]![0] as string).toContain('doc after retry')
    })

    it('TC-retry-exhausted: 重试用尽终态（willRetry:false + stopReason:error）→ 拒绝，不建会话', async () => {
      const { runPromise } = await startHandoff()

      // 中间失败帧 ×2（均跳过）
      srcClient.emit({ type: 'agent_end', messages: [], willRetry: true })
      srcClient.emit({ type: 'agent_end', messages: [], willRetry: true })

      // 重试用尽：最后一帧恒 willRetry=false + stopReason=error → 拒绝（干净 reject 优于脏数据）
      srcClient.emit({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'partial error text' }], stopReason: 'error' }],
        willRetry: false,
      })

      await expect(runPromise).rejects.toThrow('agent run failed')
      expect(sessionService.create).not.toHaveBeenCalled()
      expect(broker.broadcast).not.toHaveBeenCalled()
    })

    it('TC-stopReason-error-reject: 终态 error 帧带非空正文 → 拒绝（错误文本不得当交接文档注入新会话，Q8 残余缺口）', async () => {
      const { runPromise } = await startHandoff()

      srcClient.emit({
        type: 'agent_end',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'mid-stream error output' }], stopReason: 'error' }],
        willRetry: false,
      })

      await expect(runPromise).rejects.toThrow('handoff: agent run failed (stopReason=error)')
      expect(sessionService.create).not.toHaveBeenCalled()
      expect(newClient.prompt).not.toHaveBeenCalled()
    })
  })

  describe('终态帧文本提取（原 extractFinalTextFromAgentEnd 直测族的行为化改写，U3②）', () => {
    it('TC-S1: 畸形 text block（{type:"text", text:123}）整块过滤 → 空文档 reject（不拼 "123"）', async () => {
      const runPromise = service.runHandoff('src-1')
      await new Promise((r) => setTimeout(r, 0))

      srcClient.emit({
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 123 as unknown as string },
              { type: 'text', text: { nested: true } as unknown as string },
            ],
            stopReason: 'stop',
          },
        ],
        willRetry: false,
      })

      await expect(runPromise).rejects.toThrow('empty document')
      expect(sessionService.create).not.toHaveBeenCalled()
    })
  })

  describe('buildHandoffPrompt', () => {
    it('TC10a: 返回纯模板，不含 reply', () => {
      const result = buildHandoffPrompt()
      expect(result).toBe(HANDOFF_PROMPT_TEMPLATE)
      expect(result).not.toContain('focus on:')
    })

    it('TC10b: sanitizeReply 处理换行 + 超长', () => {
      const longReply = 'line1\nline2\rline3\n' + 'x'.repeat(6000)
      const result = sanitizeReply(longReply)
      // 结果不含原始换行
      expect(result).not.toMatch(/[\r\n]/)
      // 长度受控
      expect(result.length).toBeLessThanOrEqual(REPLY_MAX_LENGTH)
    })

    it('TC10c: S3 reply 含 tab/NUL 等控制字符 → sanitize 全部 strip + 折叠空白', () => {
      // \t=tab, \0=NUL, \x0b=vertical tab, \x1b=ESC, \x7f=DEL——均属 C0 控制字符集 + DEL，
      // 须被 strip 成空格再折叠，避免畸形空白注入 prompt。
      const dirty = 'a\tb\x00c\x0bd\x1be\x7ff\t\t\tg'
      const result = sanitizeReply(dirty)
      // 控制字符全部被替换 / 折叠：结果只剩字母 + 单空格分隔
      expect(result).toBe('a b c d e f g')
      expect(result).not.toMatch(/[\x00-\x1F\x7F]/)
      expect(result).not.toMatch(/\s{2,}/)
    })

    it('TC10d: M2 reply 含 C1/BiDi/zero-width/BOM 等 Unicode 控制字符 → sanitize strip', () => {
      // C1: \u0080-\u009F, zero-width: \u200B-\u200F, BiDi override: \u202A-\u202E, \u2066-\u2069, BOM: \uFEFF
      const dirty = 'a\u0080b\u009Fc\u200Bd\u200Fe\u202Af\u202Eg\u2066h\u2069i\uFEFFj'
      const result = sanitizeReply(dirty)
      // 所有 Unicode 控制字符被替换为空格再折叠
      expect(result).toBe('a b c d e f g h i j')
      expect(result).not.toMatch(/[\u0080-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/)
      expect(result).not.toMatch(/\s{2,}/)
    })
  })
})
})

describe('handoff-message-bus', () => {
/**
 * Handoff + MessageBus 集成测试（wave:handoff-integration）。
 *
 * 端到端验证 BLOCKER-1：handoff 完成后新 session 的流式响应从 message_start 完整可见。
 *
 * 核心场景：
 * - handoffService.runHandoff → newClient.prompt(doc) 后，EventInterpreter 产生的
 *   message_start/text_delta 经 send 回调进 bus.publish(newId, msg)。
 * - renderer subscribe(newId) 后，bus 回放 ring 里的 message_start + text_delta 等事件。
 * - 新 session 流式完整可见。
 *
 * 测试模式：用真实 MessageBus 实例（不 mock），只 mock 外部依赖（RpcClient/SessionService）。
 * send 回调直接调 bus.publish（模拟 runtime-wiring 的双写逻辑）。
 *
 * 测试框架：vitest（禁止 node:test）。
 */
/**
 * 测试辅助：构造 ServerMessage（绕过 payload 形状检查，只关心 type + payload.sessionId）。
 * 集成测试不验证 payload 内部结构（那是 protocol wave 的事），只验证 bus 的 ring/seq/subscribe 语义。
 * 使用 `as unknown as ServerMessage` 避免 ServerMessageType 联合的字面量检查。
 */
function makeMsg(type: string, payload: Record<string, unknown>): ServerMessage {
  return { type, payload } as unknown as ServerMessage
}

// ── Mock helpers ──────────────────────────────────────────────────

/**
 * Mock IPiEngine：记录 onEvent 注册的 listener，提供 emit 触发。
 * prompt/abort 默认立即 resolve（fire-and-forget ack）。
 */
interface MockClient {
  prompt: ReturnType<typeof vi.fn>
  abort: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  exited: boolean
  _listeners: Set<(event: unknown) => void>
  /** 触发所有已注册 listener。 */
  emit(event: unknown): void
}

function createMockClient(): MockClient {
  const listeners = new Set<(event: unknown) => void>()
  // 这些用例不测退出路径：onExit 只支持注册/解绑（runHandoff 会订阅），不提供触发。
  const exitListeners = new Set<(code: number | null, stderr: string) => void>()
  const client: MockClient = {
    prompt: vi.fn(async () => ({})),
    abort: vi.fn(async () => ({})),
    exited: false,
    _listeners: listeners,
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }),
    onExit: vi.fn((callback: (code: number | null, stderr: string) => void) => {
      exitListeners.add(callback)
      return () => {
        exitListeners.delete(callback)
      }
    }),
    emit(event: unknown) {
      for (const l of listeners) l(event)
    },
  }
  return client
}

/**
 * 创建 mock BusClient（模拟 WebSocket）。
 */
function createMockBusClient(): BusClient & { _sent: string[] } {
  const sent: string[] = []
  const client: BusClient & { _sent: string[] } = {
    readyState: 1, // OPEN
    send: vi.fn((data: string) => { sent.push(data) }),
    _sent: sent,
  }
  return client
}

/**
 * 创建 mock SessionService，send 回调直接调 bus.publish（模拟 runtime-wiring）。
 *
 * 关键：initializeManagedSession 的 send 回调做双写（bus.publish + broker.broadcast），
 * 这里只保留 bus.publish 路径（broker.broadcast 在集成测试中不关心）。
 */
function createMockSessionService(opts: {
  srcSessionId: string
  newSessionId: string
  srcClient: MockClient
  newClient: MockClient
  bus: MessageBus
}): SessionService {
  const { srcSessionId, newSessionId, srcClient, newClient } = opts

  return {
    getHistory: vi.fn(async () => ({
      messages: [{ id: 'msg-1', role: 'user', content: 'hi', status: 'complete', timestamp: Date.now() }] as Message[],
      truncated: false,
    })),
    getSession: vi.fn(() => ({
      cwd: '/tmp',
      label: 'src',
      sessionFilePath: '/tmp/s.json',
    })) as unknown as SessionService['getSession'],
    // D6（state-truth-sync C5）：runHandoff create 前读源生效值会调 findScannedSession
    //（内存实例字段缺值时的 sidecar 兜底）——mock 缺方法会 TypeError。
    findScannedSession: vi.fn(() => undefined) as unknown as SessionService['findScannedSession'],
    create: vi.fn(async () => ({
      id: newSessionId,
      label: 'handoff from src',
      cwd: '/tmp',
    })) as unknown as SessionService['create'],
    markHandedOff: vi.fn() as unknown as SessionService['markHandedOff'],
    ensureActive: vi.fn(async (sessionId: string) => {
      if (sessionId === srcSessionId) return srcClient as unknown as IPiEngine
      if (sessionId === newSessionId) return newClient as unknown as IPiEngine
      throw new Error(`ensureActive: unexpected sessionId ${sessionId}`)
    }) as unknown as SessionService['ensureActive'],
  } as unknown as SessionService
}

function createMockBroker(): IMessageBroker {
  return {
    broadcast: vi.fn(),
    send: vi.fn(),
    sendError: vi.fn(),
  } as unknown as IMessageBroker
}

// ── 测试 ──────────────────────────────────────────────────────────

describe('Handoff + MessageBus integration (BLOCKER-1)', () => {
  let bus: MessageBus
  let broker: IMessageBroker
  let broadcastSessionList: () => void
  let nextPushId: () => string
  let srcClient: MockClient
  let newClient: MockClient
  let sessionService: SessionService
  let service: HandoffService

  const SRC_ID = 'src-1'
  const NEW_ID = 'new-1'

  beforeEach(() => {
    bus = new MessageBus()
    broker = createMockBroker()
    broadcastSessionList = vi.fn()
    nextPushId = vi.fn(() => 'push-123')
    srcClient = createMockClient()
    newClient = createMockClient()
    sessionService = createMockSessionService({
      srcSessionId: SRC_ID,
      newSessionId: NEW_ID,
      srcClient,
      newClient,
      bus,
    })
    service = new HandoffService({ sessionService, broker, broadcastSessionList, nextPushId })
  })

  /**
   * TC1: handoff 注入新 session 时，bus.publish 缓存 message_start + text_delta。
   *
   * 场景：runHandoff 流程中，newClient.prompt(doc) 后，EventInterpreter 产生的
   * message_start/text_delta 经 send 回调进 bus.publish(newId, msg)。
   * 验证 bus 的 streamRing 包含这些事件。
   *
   * wave:perf-w06（D5-1）：text_delta 归 transient——不入 ring、不分配 seq、直传订阅者；
   * 只有 stream 类（message_start）入 ring。快照完整性语义随之调整。
   */
  it('TC1: handoff flow publishes message_start (stream) to bus ring; text_delta is transient', async () => {
    // 启动 handoff
    const runPromise = service.runHandoff(SRC_ID)
    await new Promise((r) => setTimeout(r, 0))

    // srcClient.prompt 已被调用（handoff prompt）
    expect(srcClient.prompt).toHaveBeenCalledTimes(1)

    // emit agent_end → runHandoff 完成 → create new session → newClient.prompt(doc)
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'handoff doc' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // newClient.prompt 已被调用（wrapWithXmlTag(doc) 注入）
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('<handoff_document source="')
    expect(injectedPrompt).toContain('handoff doc')
    expect(injectedPrompt).toContain('</handoff_document>')

    // 模拟 EventInterpreter 产生的流式事件：message_start + text_delta
    // 使用 makeMsg 构造合法的 ServerMessage
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID, role: 'assistant' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Hello' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' world' }))

    // 验证 bus 内部 ring 只含 stream 类（message_start）；text_delta 是 transient 不入 ring
    // subscribe 返回 snapshot 验证 ring 内容
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    expect(result.snapshot).toHaveLength(1)
    expect(result.snapshot[0]!.type).toBe('message.message_start')
    // seq 只对 stream/state 分配：message_start 是 seq 1，两条 text_delta 不占 seq
    expect(result.snapshot[0]!.seq).toBe(1)
    expect(result.lastSeq).toBe(1)
  })

  /**
   * TC2: renderer subscribe(newId) 后拿到 stream 类完整 snapshot。
   *
   * 场景：bus.publish 若干条后，调 subscribe(newId)，验证 snapshot 包含
   * message_start + complete（stream 类，按顺序回放）。
   *
   * wave:perf-w06（D5-1）：text_delta 归 transient（高频流，丢失可接受、不回放），
   * subscribe 快照只含 stream 类；delta 的连续性靠 live push 保证。
   */
  it('TC2: subscribe after publish returns stream-only snapshot (message_start + complete)', () => {
    // 发布一系列流式事件
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID, role: 'assistant' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Part 1' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Part 2' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Part 3' }))
    bus.publish(NEW_ID, makeMsg('message.complete', { sessionId: NEW_ID, role: 'assistant' }))

    // renderer subscribe
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    // snapshot 只含 stream 类（message_start + complete），按发布顺序
    expect(result.snapshot).toHaveLength(2)
    expect(result.snapshot.map((m) => m.type)).toEqual([
      'message.message_start',
      'message.complete',
    ])
    // lastSeq 只随 stream/state 类推进（2 条 stream）
    expect(result.lastSeq).toBe(2)
  })

  /**
   * TC3: subscribe 后的 live push 正确路由。
   *
   * 场景：subscribe 后继续 publish，验证新事件自动推给已订阅的 ws。
   * wave:perf-w06（D5-1）：transient 类（text_delta）不入 ring 但 live push 照常直传（无 seq）。
   */
  it('TC3: live push after subscribe delivers new events to subscribed ws', () => {
    // 先发布 2 条（1 条 stream + 1 条 transient——ring 只存前者）
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'initial' }))

    // subscribe
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    expect(result.snapshot).toHaveLength(1)
    expect(result.lastSeq).toBe(1)

    // 清除 subscribe 期间的 send 记录
    vi.mocked(ws.send).mockClear()

    // 继续发布新事件（live push）
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' live' }))

    // ws 应该收到 live push（transient 直传）
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sentPayload = JSON.parse(vi.mocked(ws.send).mock.calls[0]![0]) as ServerMessage
    expect(sentPayload.type).toBe('message.text_delta')
    expect((sentPayload.payload as { delta?: string }).delta).toBe(' live')
    expect(sentPayload.seq).toBeUndefined() // transient 不分配 seq
  })

  /**
   * TC4: 多个 ws 同时订阅新 session，都收到 broadcast。
   *
   * 场景：bus.publish 对所有 subscribers 广播。
   */
  it('TC4: multiple ws subscribers all receive broadcast on publish', () => {
    const ws1 = createMockBusClient()
    const ws2 = createMockBusClient()
    const ws3 = createMockBusClient()

    // 三个 ws 都订阅同一 session
    bus.subscribe(NEW_ID, ws1)
    bus.subscribe(NEW_ID, ws2)
    bus.subscribe(NEW_ID, ws3)

    // 发布事件
    const event = makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'broadcast' })
    bus.publish(NEW_ID, event)

    // 所有 ws 都应收到
    expect(ws1.send).toHaveBeenCalledTimes(1)
    expect(ws2.send).toHaveBeenCalledTimes(1)
    expect(ws3.send).toHaveBeenCalledTimes(1)

    // 内容一致
    const expected = JSON.stringify(event)
    expect(vi.mocked(ws1.send).mock.calls[0]![0]).toBe(expected)
    expect(vi.mocked(ws2.send).mock.calls[0]![0]).toBe(expected)
    expect(vi.mocked(ws3.send).mock.calls[0]![0]).toBe(expected)
  })

  /**
   * TC5: handoff 被 abort 后，bus 中的事件不被清除（幂等）。
   *
   * 场景：abort 只取消 turn，bus 的 ring 不受影响。
   * 事件已通过 send 回调进 bus.publish，abort 不会回滚。
   */
  it('TC5: abort handoff does not clear bus ring (events preserved)', async () => {
    // 先在 bus 中发布一些事件（模拟 newClient.prompt 后的流式输出）
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'data' }))

    // 验证事件已在 bus 中（wave:perf-w06：ring 只存 stream 类 message_start）
    const ws1 = createMockBusClient()
    const before = bus.subscribe(NEW_ID, ws1)
    expect(before.snapshot).toHaveLength(1)
    expect(before.snapshot[0]!.type).toBe('message.message_start')

    // 启动 handoff 并 abort
    const runPromise = service.runHandoff(SRC_ID).catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    await service.abortHandoff(SRC_ID)
    await runPromise

    // abort 后 bus 中的事件仍在
    const ws2 = createMockBusClient()
    const after = bus.subscribe(NEW_ID, ws2)
    expect(after.snapshot).toHaveLength(1)
    expect(after.snapshot[0]!.type).toBe('message.message_start')
  })

  /**
   * TC6: newClient.prompt(doc) 后立即 subscribe，snapshot 可能为空。
   *
   * 场景：bus.publish 是同步的（send 回调内），prompt ack 返回后可能还没产生 message_start。
   * subscribe 空 snapshot 是合法状态（ES1）。
   */
  it('TC6: subscribe before any publish returns empty snapshot (ES1)', () => {
    // 直接 subscribe 一个从未 publish 过的 session
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    // 空 snapshot 是合法状态
    expect(result.snapshot).toHaveLength(0)
    expect(result.lastSeq).toBe(0)
    expect(result.stateSnapshot).toHaveLength(0)
  })

  /**
   * TC7: 完整 handoff 流程 → bus 缓存事件 → subscribe 拿到完整 snapshot。
   *
   * 端到端场景：
   * 1. runHandoff(srcSessionId) → agent_end → create new session → newClient.prompt(doc)
   * 2. newClient 产生 message_start + text_delta + agent_end 事件
   * 3. 事件经 send 回调进 bus.publish(NEW_ID, msg)
   * 4. renderer subscribe(NEW_ID) → snapshot 包含完整事件序列
   *
   * 这是 BLOCKER-1 的核心验证：handoff 完成后新 session 的流式响应完整可见。
   */
  it('TC7: end-to-end handoff → bus cache → subscribe returns complete streaming snapshot', async () => {
    // ── Step 1: 启动 handoff ──
    const runPromise = service.runHandoff(SRC_ID)
    await new Promise((r) => setTimeout(r, 0))

    // ── Step 2: 源 session 产生 agent_end（handoff 文档）──
    srcClient.emit({
      type: 'agent_end',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'handoff doc content' }], stopReason: 'stop' }],
      willRetry: false,
    })

    await runPromise

    // ── Step 3: newClient.prompt(wrapWithXmlTag(doc)) 已被调用 ──
    expect(newClient.prompt).toHaveBeenCalledTimes(1)
    const injectedPrompt = newClient.prompt.mock.calls[0][0] as string
    expect(injectedPrompt).toContain('<handoff_document source="src"')
    expect(injectedPrompt).toContain('handoff doc content')
    expect(injectedPrompt).toContain('</handoff_document>')

    // ── Step 4: 模拟 newClient 产生流式事件（EventInterpreter 输出）──
    // 这些事件经 send 回调进 bus.publish(NEW_ID, msg)
    bus.publish(NEW_ID, makeMsg('message.message_start', { sessionId: NEW_ID, role: 'assistant' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: 'Hello' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' from' }))
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' new session' }))
    bus.publish(NEW_ID, makeMsg('message.complete', { sessionId: NEW_ID, role: 'assistant' }))

    // ── Step 5: renderer subscribe(newId) ──
    // 此时 renderer 收到 handoffComplete → selectSession(newId) → subscribeSession(newId)
    const ws = createMockBusClient()
    const result = bus.subscribe(NEW_ID, ws)

    // ── Step 6: 验证 snapshot 包含 stream 类完整事件序列 ──
    //（wave:perf-w06/D5-1：text_delta 是 transient 不入 ring，快照只含 message_start + complete）
    expect(result.snapshot).toHaveLength(2)
    expect(result.snapshot.map((m) => m.type)).toEqual([
      'message.message_start',
      'message.complete',
    ])
    expect(result.lastSeq).toBe(2)

    // ── Step 7: subscribe 后继续 publish（live push）──
    vi.mocked(ws.send).mockClear()
    bus.publish(NEW_ID, makeMsg('message.text_delta', { sessionId: NEW_ID, delta: ' (continued)' }))

    // ws 收到 live push
    expect(ws.send).toHaveBeenCalledTimes(1)
    const sentPayload = JSON.parse(vi.mocked(ws.send).mock.calls[0]![0]) as ServerMessage
    expect(sentPayload.type).toBe('message.text_delta')
    expect((sentPayload.payload as { delta?: string }).delta).toBe(' (continued)')
  })

  /**
   * TC8: ring 容量溢出时，subscribe 只返回最新的 ringCapacity 条。
   *
   * 场景：如果 handoff 过程中产生了大量事件（超过 ring 容量），
   * 最旧的事件会被淘汰，subscribe 只返回保留的事件。
   *
   * wave:perf-w06（D5-3）：溢出淘汰由 O(1) 覆盖写环形缓冲完成；text_delta 是 transient
   * 不入 ring，改用 stream 类（message.status）驱动溢出。subscribe 不再返回 gap 字段
   * （R-03：bus 内死 gauge 已删，gap 由 session-message-handler 基于 fromSeq 判定，
   * 见 src/__tests__/session-message-handler-subscribe.test.ts）。
   */
  it('TC8: ring overflow — subscribe returns only ringCapacity most recent events', () => {
    // 用小容量 bus
    const smallBus = new MessageBus(5)

    // 发布 8 条 stream 类事件（超过容量 5）
    for (let i = 0; i < 8; i++) {
      smallBus.publish(NEW_ID, makeMsg('message.status', { sessionId: NEW_ID, status: `chunk-${i}` }))
    }

    const ws = createMockBusClient()
    const result = smallBus.subscribe(NEW_ID, ws)

    // 只保留最新的 5 条（chunk-3 到 chunk-7），按 seq 顺序导出
    expect(result.snapshot).toHaveLength(5)
    expect((result.snapshot[0]!.payload as { status?: string }).status).toBe('chunk-3')
    expect((result.snapshot[4]!.payload as { status?: string }).status).toBe('chunk-7')
    expect(result.snapshot[0]!.seq).toBe(4) // 最旧 seq 随淘汰正确推进
    expect(result.snapshot[4]!.seq).toBe(8)
    expect(result.lastSeq).toBe(8) // seq 仍然单调递增到 8
    // R-03：gap 不再由 bus 返回（死 gauge 已删），由 handler 基于 fromSeq 判定
    expect('gap' in result).toBe(false)
  })
})
})
