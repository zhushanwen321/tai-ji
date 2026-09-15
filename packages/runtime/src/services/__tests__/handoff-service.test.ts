/**
 * HandoffService 单元测试（agent-driven）。
 *
 * 覆盖新流程：runHandoff 让源 session 跑 handoff turn → 从 agent_end 提取 doc →
 * 新建 session + 注入 doc + 广播（无 doc/reply 字段，DM3）。abort / timeout /
 * 空文档 / 并发守卫 / extractFinalTextFromAgentEnd / buildHandoffPrompt 全覆盖。
 *
 * 测试框架：vitest（禁止 node:test）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  HandoffService,
  HANDOFF_TIMEOUT_MS,
  extractFinalTextFromAgentEnd,
} from '../handoff-service.js'
import { HANDOFF_PROMPT_TEMPLATE, REPLY_MAX_LENGTH, buildHandoffPrompt, sanitizeReply } from '../handoff-prompt.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { SessionService } from '../session/session-service.js'
import type { IPiEngine } from '../ports/pi-engine.js'
import type { Message } from '@taiji/shared'

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

  it('TC5: 并发守卫 — 同 session 再调 runHandoff 同步 reject（already in progress）', async () => {
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
    // 无论哪种时序，abortedSessions 守卫保证不创建新 session。
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
    // abortedSessions 守卫阻断：createSession 未被调用
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
      // tools/noSkills 全套限制——夹带行为变更）。静态守卫见 binding-registry-hydrate Part 2。
      expect(opts).not.toHaveProperty('presetId')
      // 防顺手继承漂移（CREATE_DERIVED_CALLERS 承诺）运行时面
      expect(opts).not.toHaveProperty('spawnSource')
      expect(opts).not.toHaveProperty('parentAgentSessionId')
    })
  })

  describe('extractFinalTextFromAgentEnd', () => {
    it('TC9a: 正常单 text block', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ])
      expect(result).toBe('hello')
    })

    it('TC9b: 多 text block join', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] },
      ])
      expect(result).toBe('hello world')
    })

    it('TC9c: messages undefined → ""', () => {
      expect(extractFinalTextFromAgentEnd(undefined)).toBe('')
    })

    it('TC9d: messages 空数组 → ""', () => {
      expect(extractFinalTextFromAgentEnd([])).toBe('')
    })

    it('TC9e: 末条 content 非 text（tool_use）→ ""', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'write', input: {} }] },
      ])
      expect(result).toBe('')
    })

    it('TC9f: content 是 string（非数组）→ ""', () => {
      const result = extractFinalTextFromAgentEnd([
        { role: 'assistant', content: 'plain string content' },
      ])
      expect(result).toBe('')
    })

    it('TC9g: S1 text 字段非 string（{type:"text", text:123}）→ 过滤掉 → ""', () => {
      // pi 若发畸形 {type:'text', text:123}，不应被拼成 "123"；归一化为空文档走 empty reject。
      const result = extractFinalTextFromAgentEnd([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 123 as unknown as string },
            { type: 'text', text: { nested: true } as unknown as string },
          ],
          stopReason: 'stop',
        },
      ])
      expect(result).toBe('')
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
