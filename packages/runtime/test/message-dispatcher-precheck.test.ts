/**
 * MessageDispatcher 预检测试（D-009：busy 时拒绝，广播 send.rejected，不调 pi.prompt）。
 *
 * 锁定 fix-state-tearing 的 D-009 核心决策：sendPrompt 入口检查 activeSession.isGenerating，
 * 若 busy 则广播 send.rejected 并返回 {blocked:true, rejected:true}，不调用 client.prompt。
 *
 * 覆盖：
 * - isGenerating=true → 广播 send.rejected + 不调 pi.prompt + 返回 rejected:true
 * - isGenerating=false → 正常调 pi.prompt + 不广播 send.rejected
 * - BeforeSend hook blocked → 返回 {blocked:true}（不调 pi.prompt，hook 已广播 message.error）
 * - pi.prompt 抛异常 → 广播 message.error + isGenerating 复位 false + 返回 blocked:true
 *
 * mock 策略：全部依赖 mock（svc/pm/bus/workspace），不 spawn pi。wave:perf-w09 后 dispatcher
 * 只依赖 publish 抽象（broker 双写腿已删）。
 *
 * 运行：npx vitest run test/message-dispatcher-precheck.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'

function makeMockSession(isGenerating: boolean): IManagedSessionView {
  // [u3b 预检改读 occupancy] 预检输入源从三布尔改为 occupancy 投影（session-dead-structural-fixes
  // D2）。fixture 镜像真实链路的原子同步：isGenerating=true ↔ turn='generating'。
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    occupancy: { turn: isGenerating ? 'generating' : 'idle', compacting: false, bash: false },
  }
}

function makeMocks(opts: { isGenerating?: boolean; promptError?: Error } = {}) {
  const session = makeMockSession(opts.isGenerating ?? false)
  const promptFn = opts.promptError
    ? vi.fn(async () => { throw opts.promptError! })
    : vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
  // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
  // 到达 fake client——fake 须补齐该接口成员
  const client = { prompt: promptFn, touchActivity: vi.fn() } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写腿已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空守卫分支）
  const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, promptFn, broadcasts, bus }
}

describe('MessageDispatcher D-009 预检（busy → send.rejected）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('isGenerating=true → 广播 send.rejected + 不调 pi.prompt + 返回 rejected:true', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isGenerating: true })
    // sendMessage 调 sendPrompt（hookContent = content）
    const result = await dispatcher.sendMessage('s1', 'hello')
    // pi.prompt 未被调用
    expect(promptFn).not.toHaveBeenCalled()
    // 广播了 send.rejected
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeDefined()
    expect(rejected!.payload).toMatchObject({
      sessionId: 's1',
      reason: 'busy',
    })
    // 返回 rejected
    expect(result.rejected).toBe(true)
    expect(result.blocked).toBe(true)
  })

  it('isGenerating=false → 正常调 pi.prompt + 不广播 send.rejected', async () => {
    const { dispatcher, promptFn, broadcasts } = makeMocks({ isGenerating: false })
    await dispatcher.sendMessage('s1', 'hello')
    expect(promptFn).toHaveBeenCalledWith('hello', undefined)
    const rejected = broadcasts.find((m) => m.type === 'send.rejected')
    expect(rejected).toBeUndefined()
  })
})

describe('MessageDispatcher 错误路径', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pi.prompt 抛异常 → 广播 message.error + isGenerating 复位 false', async () => {
    const { dispatcher, promptFn, broadcasts, session } = makeMocks({
      isGenerating: false,
      promptError: new Error('pi crashed'),
    })
    await dispatcher.sendMessage('s1', 'hello')
    expect(promptFn).toHaveBeenCalled()
    // isGenerating 被复位
    expect(session.isGenerating).toBe(false)
    // 广播了 message.error
    const errMsg = broadcasts.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect(errMsg!.payload).toMatchObject({ sessionId: 's1' })
  })

  it('W6: workspace.record 抛同步异常 → 被 catch + console.warn + 不阻断 pi.prompt + isGenerating 保持 true', async () => {
    // record 抛同步异常（模拟 cache.set OOM 等极端场景）
    const session = makeMockSession(false)
    const promptFn = vi.fn(async () => ({}) as unknown as Awaited<ReturnType<IPiEngine['prompt']>>)
    // touchActivity：sendPrompt 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient
    // 到达 fake client——fake 须补齐该接口成员
    const client = { prompt: promptFn, touchActivity: vi.fn() } as unknown as IPiEngine
    const broadcasts: ServerMessage[] = []
    const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus
    const svc: IDispatcherSessionOps = {
      ensureActive: vi.fn(async () => client),
      getSessionByClient: vi.fn(() => session),
      persistSessionOutcome: vi.fn(),
      getSession: vi.fn(),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    }
    // getClient → undefined：无附着 client 形态（sendPrompt 入口 touch 的空守卫分支）
    const pm = { getClient: vi.fn(() => undefined) } as unknown as IProcessManager
    const workspace = { record: vi.fn(() => { throw new Error('cache boom') }) } as unknown as WorkspaceService
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)

    // 不该向上抛
    const result = await dispatcher.sendMessage('s1', 'hello')
    // pi.prompt 仍被调用（record 失败不阻断发消息主流程）
    expect(promptFn).toHaveBeenCalledWith('hello', undefined)
    // isGenerating 保持 true（prompt 成功，record 副作用失败不影响状态机）
    expect(session.isGenerating).toBe(true)
    // 正常返回（非 blocked）
    expect(result.blocked).toBe(false)
    // console.warn 被调（有诊断信号，非 fail-silent）
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
