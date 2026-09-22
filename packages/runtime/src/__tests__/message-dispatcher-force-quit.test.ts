/**
 * MessageDispatcher.forceQuit / 强杀收敛编排测试（sidebar 强制退出入口）。
 *
 * 锁定：
 * - FQ1: forceQuit 活跃 session → 按序 detach → destroy → persist stopped('User forced quit') →
 *        广播 session.exited{code:null, reason:用户指引文案} → removeEntry（与 abort 超时路径同构）
 * - FQ2: forceQuit 不在活跃进程表（pm.getClient 返回 undefined）→ 幂等成功：
 *        不调 destroy/persist/removeEntry、不广播（竞态兜底，菜单渲染后 session 恰好退出）
 * - FQ3: abort RPC 超时 + 真冻结判据成立（探测无响应 + 事件窗静默超保守窗，W7 阶梯 3）→
 *        复用同一强杀编排：persist stopped 带 'Abort failed (pi frozen...)' 诊断 reason +
 *        session.exited 用户文案。[W7] abort 超时不再无条件判死——阶梯全量用例见
 *        services/session/__tests__/message-dispatcher-abort-liveness.test.ts
 * - FQ4（code-harden RT-4#1）: 编排中段抛错 → 终态三步（full-reset / session.exited /
 *        removeEntry）finally 必达，异常不上抛
 * - FQ5/FQ6（code-harden RT-4#1）: 无活跃进程分支按 occupancy 分型——≠idle 继续完整
 *        收敛（不再「幂等成功」假成功）；=idle 保持幂等成功竞态兜底
 *
 * mock 模式参考 message-dispatcher-bash.test.ts 的 makeMocks。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-force-quit.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import { RpcTimeoutError } from '../utils/errors.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

type SessionExitedMsg = ServerMessage<'session.exited'>
function findSessionExited(b: ServerMessage[]): SessionExitedMsg | undefined {
  return b.find((m) => m.type === 'session.exited') as SessionExitedMsg | undefined
}

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
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
  }
}

interface MockOpts {
  /** pm.getClient 返回值；undefined 模拟 session 不在活跃进程表 */
  active?: boolean
  abortError?: Error
}

interface ForceQuitMocks {
  dispatcher: MessageDispatcher
  destroySessionFn: ReturnType<typeof vi.fn>
  detachSessionFn: ReturnType<typeof vi.fn>
  persistOutcomeFn: ReturnType<typeof vi.fn>
  removeEntryFn: ReturnType<typeof vi.fn>
  /** svc.getSession（FQ5/FQ6 注入 occupancy 用） */
  svcGetSession: ReturnType<typeof vi.fn>
  broadcasts: ServerMessage[]
  callOrder: string[]
}

function makeMocks(opts: MockOpts = {}): ForceQuitMocks {
  const client = opts.abortError
    ? {
        abort: vi.fn(async () => { throw opts.abortError! }),
        // [W7] 真冻结判据显式化：探测无响应（getState 超时）+ 事件窗静默超保守窗
        //（lastEventAt 远超默认窗 600s）= 阶梯 3 直达强杀的唯一触发组合。旧 mock（无
        // getState / 无事件产出成员）会隐式落同一路径，显式化避免语义漂移。
        getState: vi.fn(async () => { throw new RpcTimeoutError('get_state', 10_000) }),
        lastEventAt: Date.now() - 700_000,
      }
    : { abort: vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abort']>>) }

  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // 编排顺序断言：detach → destroy → persist → removeEntry 必须按此相对顺序
  const callOrder: string[] = []
  const detachSessionFn = vi.fn(() => { callOrder.push('detach') })
  const destroySessionFn = vi.fn(async () => { callOrder.push('destroy') })
  const persistOutcomeFn = vi.fn(() => { callOrder.push('persist') })
  const removeEntryFn = vi.fn(() => { callOrder.push('remove') })

  // S2 ISP 化：结构性满足 dispatcher 窄接口（6 方法 = 实际消费面），无强转。
  // ensureActive/getSession 不在 forceQuit/abort 收敛路径上，空 mock 即可。
  const svcGetSession = vi.fn()
  const svc: IDispatcherSessionOps = {
    getSessionByClient: vi.fn(() => makeMockSession()),
    detachSession: detachSessionFn,
    persistSessionOutcome: persistOutcomeFn,
    removeSessionEntry: removeEntryFn,
    ensureActive: vi.fn(),
    getSession: svcGetSession,
  }

  const pm = {
    getClient: vi.fn(() => (opts.active === false ? undefined : client)),
    destroySession: destroySessionFn,
  } as unknown as IProcessManager

  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, destroySessionFn, detachSessionFn, persistOutcomeFn, removeEntryFn, svcGetSession, broadcasts, callOrder }
}

describe('MessageDispatcher forceQuit —— sidebar 强制退出', () => {
  it('FQ1: 活跃 session → detach→destroy→persist(stopped,User forced quit)→广播 session.exited(code:null)→removeEntry，按序执行', async () => {
    const m = makeMocks({ active: true })

    await m.dispatcher.forceQuit('s1')

    // 编排顺序：destroy 是 async 但必须在 detach 之后、persist 之前完成
    expect(m.callOrder).toEqual(['detach', 'destroy', 'persist', 'remove'])
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
    const exited = findSessionExited(m.broadcasts)
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    // exitReason 面向用户可操作：含恢复指引（重开/历史完整）
    expect(exited!.payload.reason).toContain('强制退出')
    expect(exited!.payload.reason).toContain('恢复')
  })

  it('FQ2: 不在活跃进程表 → 幂等成功：不 destroy/persist/remove、不广播', async () => {
    const m = makeMocks({ active: false })

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.destroySessionFn).not.toHaveBeenCalled()
    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })

  it('FQ4: 编排中段抛错（destroy throw）→ 终态三步仍完成（full-reset + session.exited + removeEntry），不沿调用链上抛', async () => {
    const m = makeMocks({ active: true })
    ;(m.destroySessionFn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('kill exploded'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      // [code-harden RT-4#1] destroy 失败只降级日志：full-reset / session.exited / removeEntry
      // 在 finally 中必达，异常不再上抛成 uncaughtException 连坐全 runtime。
      await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

      expect(m.removeEntryFn).toHaveBeenCalledTimes(1)
      const exited = findSessionExited(m.broadcasts)
      expect(exited).toBeDefined()
      expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('forceQuitSession pre-terminal steps failed'), expect.any(Error))
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('FQ5: 无活跃进程但 occupancy≠idle（条目还在、turn 卡 generating）→ 继续完整收敛而非「幂等成功」假成功', async () => {
    // [code-harden RT-4#1] 旧行为：无 client 一律「幂等成功」返回——占用态卡死且事件源
    // 已断（无进程可产生 agent_settled）时，isGenerating/turn 投影永久滞留。改为继续收敛。
    const m = makeMocks({ active: false })
    const stuckSession = { ...makeMockSession(), occupancy: { turn: 'generating', compacting: false, bash: false } }
    ;(m.svcGetSession as ReturnType<typeof vi.fn>).mockReturnValue(stuckSession)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await m.dispatcher.forceQuit('s1')

      // 完整收敛链：stopped 终态 + session.exited 广播 + removeEntry。
      //（destroySession 仍被调用——生产侧对无进程条目幂等 no-op，编排统一走同一条链。）
      expect(m.detachSessionFn).toHaveBeenCalledTimes(1)
      expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', 'User forced quit')
      expect(m.removeEntryFn).toHaveBeenCalledTimes(1)
      expect(findSessionExited(m.broadcasts)).toBeDefined()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('occupancy not idle'))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('FQ6: 无活跃进程且占用已复位（occupancy=idle）→ 保持幂等成功（真实竞态兜底不受影响）', async () => {
    const m = makeMocks({ active: false })
    const idleSession = { ...makeMockSession(), occupancy: { turn: 'idle', compacting: false, bash: false } }
    ;(m.svcGetSession as ReturnType<typeof vi.fn>).mockReturnValue(idleSession)

    await expect(m.dispatcher.forceQuit('s1')).resolves.toBeUndefined()

    expect(m.persistOutcomeFn).not.toHaveBeenCalled()
    expect(m.removeEntryFn).not.toHaveBeenCalled()
    expect(m.broadcasts).toHaveLength(0)
  })
})

describe('MessageDispatcher abort RPC 超时 —— 复用强杀编排', () => {
  it('FQ3: abort 超时 + 真冻结判据（探测无响应 + 事件窗静默超窗）→ 同一编排收敛 + stopped 带冻结诊断 reason + session.exited 用户文案', async () => {
    const m = makeMocks({
      active: true,
      abortError: new RpcTimeoutError('abort', 5000),
    })

    await m.dispatcher.abort('s1')

    expect(m.callOrder).toEqual(['detach', 'destroy', 'persist', 'remove'])
    expect(m.persistOutcomeFn).toHaveBeenCalledWith('s1', 'stopped', expect.stringContaining('Abort failed (pi frozen'))
    const exited = findSessionExited(m.broadcasts)
    expect(exited).toBeDefined()
    expect(exited!.payload).toMatchObject({ sessionId: 's1', code: null })
    expect(exited!.payload.reason).toContain('冻结')
  })
})
