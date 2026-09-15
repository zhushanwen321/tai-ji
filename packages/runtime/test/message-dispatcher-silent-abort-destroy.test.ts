/**
 * MessageDispatcher abort 强杀分支测试（integrity-hardening D3a：pi 半死自愈，修 M5；
 * [W7] chat-domain-v1x-liveness-governance D3 改造为三级阶梯的真冻结终点）。
 *
 * 锁定决策：abort RPC 以 RpcTimeoutError 失败 且 真冻结判据成立（快超时探测无响应 +
 * 事件窗静默超保守窗——mock 显式提供 getState 超时 + lastEventAt 远超窗）时走阶梯 3
 * 「检测即收敛」——destroySession 强杀 + 与 onSessionExit 同构的收敛编排
 * （detach → destroy → stopped 终态 → session.exited → removeSessionEntry）；
 * 非超时错误保持现行 abort 收口行为（不销毁）。
 * 阶梯全量用例（阶梯 1 有界重试 / 阶梯 2 用户显式强关 / 防重入 / 窗值配置）见
 * src/services/session/__tests__/message-dispatcher-abort-liveness.test.ts（W7 领地）。
 *
 * 覆盖：
 * - 超时 + 真冻结 → pm.destroySession 被调 + svc.detachSession/removeSessionEntry 被调 +
 *   persistSessionOutcome('stopped') + publish session.exited（含「重发即可恢复」指引）+
 *   isGenerating 复位
 * - 顺序约束：session.exited 必须在 removeSessionEntry 之前（其后 messageBus.clearSession
 *   清空订阅者，再发等于空投）
 * - 超时 + 真冻结 → 不发 message.error（前端 handleSessionExited 已把 reason 插入聊天流，双发即双报）
 * - 非超时（普通 Error）→ destroySession/detachSession/removeSessionEntry 均不调，
 *   现行 message.error 收口保持
 *
 * mock 策略：全部依赖 mock（svc/pm/bus/workspace），client.abort reject 指定错误。
 *
 * 运行：npx vitest run test/message-dispatcher-silent-abort-destroy.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MessageDispatcher } from '../src/services/session/message-dispatcher.js'
import { RpcTimeoutError } from '../src/infra/pi/rpc-client.js'
import type { IDispatcherSessionOps } from '../src/services/session/session-internal.js'
import type { IManagedSessionView } from '../src/services/session/types.js'
import type { IMessageBus } from '../src/services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../src/services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'

/** 收敛动作的全局调用序（跨 svc/pm/bus 三方 mock 记录，供顺序断言）。 */
const invocationOrder: string[] = []

function makeMockSession(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: true,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
  }
}

function makeMocks(abortError: Error) {
  const session = makeMockSession()
  const client = {
    abort: vi.fn(async () => { throw abortError }),
    // [W7] 真冻结判据显式化（阶梯 3 直杀的唯一触发组合）：探测无响应 + 事件窗静默超保守窗。
    getState: vi.fn(async () => { throw new RpcTimeoutError('get_state', 10_000) }),
    lastEventAt: Date.now() - 700_000,
  } as unknown as IPiEngine

  // ServerMessage payload 是 union，属性直接访问过不了 tsc；测试只读 type + payload 字段，
  // 收窄为宽松形状（运行时按 ServerMessage 原样 push，无变换）
  const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = []
  const bus = {
    publish: vi.fn((_sid: string, m: ServerMessage) => {
      invocationOrder.push(`publish:${m.type}`)
      broadcasts.push(m as unknown as { type: string; payload: Record<string, unknown> })
    }),
  } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转。
  // ensureActive/getSession 不在 abort 收敛路径上，空 mock 即可。
  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => {
      invocationOrder.push('getSessionByClient')
      return session
    }),
    detachSession: vi.fn(() => { invocationOrder.push('detachSession') }),
    persistSessionOutcome: vi.fn(() => { invocationOrder.push('persistSessionOutcome') }),
    removeSessionEntry: vi.fn(() => { invocationOrder.push('removeSessionEntry') }),
    ensureActive: vi.fn(),
    getSession: vi.fn(),
  }

  const pm = {
    getClient: vi.fn(() => client),
    destroySession: vi.fn(async () => { invocationOrder.push('destroySession') }),
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, broadcasts, svc, pm, bus }
}

describe('MessageDispatcher abort 强杀分支（D3a：RpcTimeoutError → 检测即收敛）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invocationOrder.length = 0
  })

  it('abort RPC 超时 → destroySession 强杀 + 同构收敛编排（detach → destroy → stopped → session.exited → removeEntry）', async () => {
    const { dispatcher, session, broadcasts, svc, pm } = makeMocks(
      new RpcTimeoutError('abort', 60_000),
    )
    await dispatcher.abort('s1')

    // 强杀被调
    expect(pm.destroySession).toHaveBeenCalledTimes(1)
    expect(pm.destroySession).toHaveBeenCalledWith('s1')
    // 收敛编排：detach + removeEntry
    expect(svc.detachSession).toHaveBeenCalledWith('s1')
    expect(svc.removeSessionEntry).toHaveBeenCalledWith('s1')
    // stopped 终态（[W7] reason 带真冻结判据：探测无响应 + 事件流静默）
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', expect.stringContaining('pi frozen'))
    // isGenerating 复位
    expect(session.isGenerating).toBe(false)

    // session.exited 广播：带 sessionId + code null + 「重发即可恢复」指引（G3 措辞）
    const exited = broadcasts.find((m) => m.type === 'session.exited')
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    expect(exited!.payload.reason).toContain('重发')
    // 不发 message.error（前端 handleSessionExited 把 reason 插入聊天流，双发即双报）
    expect(broadcasts.find((m) => m.type === 'message.error')).toBeUndefined()

    // 顺序约束：exited publish 必须先于 removeSessionEntry（其后 bus.clearSession 清订阅者）
    expect(invocationOrder.indexOf('publish:session.exited')).toBeLessThan(
      invocationOrder.indexOf('removeSessionEntry'),
    )
    // destroySession 先于 removeSessionEntry（进程先死再清条目，与 lifecycle.delete 同构）
    expect(invocationOrder.indexOf('destroySession')).toBeLessThan(
      invocationOrder.indexOf('removeSessionEntry'),
    )
  })

  it('abort 非超时失败（普通 Error）→ 不强杀、不收敛条目，保持现行 message.error 收口', async () => {
    const { dispatcher, broadcasts, svc, pm } = makeMocks(
      new Error('pi process exited with code 1'),
    )
    await dispatcher.abort('s1')

    // 不强杀、不动 session 条目
    expect(pm.destroySession).not.toHaveBeenCalled()
    expect(svc.detachSession).not.toHaveBeenCalled()
    expect(svc.removeSessionEntry).not.toHaveBeenCalled()
    // 现行收口：stopped 终态 + message.error（不广播 session.exited）
    expect(svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', expect.stringContaining('Abort failed'))
    const errMsg = broadcasts.find((m) => m.type === 'message.error')
    expect(errMsg).toBeDefined()
    expect(errMsg!.payload).toMatchObject({ sessionId: 's1' })
    expect(broadcasts.find((m) => m.type === 'session.exited')).toBeUndefined()
  })

  it('session 已无 Map 条目（并发 deleteSession 先行）→ 收敛编排仍不抛错（幂等防御）', async () => {
    // 并发竞态：getSessionByClient 返回 undefined（条目已被 delete 路径删走）。
    // [W7] 真冻结判据成员同样显式（与 makeMocks 同款），路径 = 阶梯 3 直杀的幂等防御。
    const client = {
      abort: vi.fn(async () => { throw new RpcTimeoutError('abort', 60_000) }),
      getState: vi.fn(async () => { throw new RpcTimeoutError('get_state', 10_000) }),
      lastEventAt: Date.now() - 700_000,
    } as unknown as IPiEngine
    const broadcasts: Array<{ type: string; payload: Record<string, unknown> }> = []
    const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m as unknown as { type: string; payload: Record<string, unknown> }) }) } as unknown as IMessageBus
    const svc: IDispatcherSessionOps = {
      getSessionByClient: vi.fn(() => undefined),
      detachSession: vi.fn(),
      persistSessionOutcome: vi.fn(),
      removeSessionEntry: vi.fn(),
      ensureActive: vi.fn(),
      getSession: vi.fn(),
    }
    const pm = {
      getClient: vi.fn(() => client),
      // destroySession 幂等：processes Map 无条目（已删）时静默跳过
      destroySession: vi.fn(async () => {}),
    } as unknown as IProcessManager
    const workspace = { record: vi.fn() } as unknown as WorkspaceService
    const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)

    // 不得 throw（否则 session-message-handler 的 .catch 兜底吞掉，收敛中断）
    await expect(dispatcher.abort('s1')).resolves.toBeUndefined()
    expect(broadcasts.find((m) => m.type === 'session.exited')).toBeDefined()
  })
})
