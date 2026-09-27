/**
 * SessionService.setThinkingLevel 返回 pi 生效值锁定（P3，pi-assumption final gate V3 附带发现）。
 *
 * 背景：pi 会钳制模型族不支持的思考档（mimo 族 max → high，clampThinkingLevel 就近
 * 回落），且钳制时不发事件不写 entry。旧实现 reply 与内存缓存都用请求值——前端 pending
 * 确认（session.thinkingLevelSet 回灌）与 summary 投影会短暂显示未生效档位。
 *
 * 锁定：
 * - pi 生效值 ≠ 请求值 → 返回生效值 + 内存缓存（getSummary 投影源）写生效值
 * - get_state 异常形态（thinkingLevel 缺失/非 string）→ 请求值兜底不炸
 * - 无活跃进程 → fail-fast 抛 SESSION_NOT_ACTIVE（code-harden RT-4#4，旧「请求值兜底」已废）
 *
 * mock 构造照抄 session-service-w07-bus.test.ts makeEnv（被测方法路径不消费
 * extensionService/sessionStore 等依赖，{} as never 占位）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-service-thinking-effective.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionService } from '../services/session/session-service.js'
import { MessageBus } from '../services/message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../services/session/replicated-states.config.js'
import { SESSION_NOT_ACTIVE } from '../utils/errors.js'
import type { IMessageBroker } from '../interfaces.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { BusClient } from '../services/message-bus/types.js'
import type { ServerMessage } from '@taiji/shared'

function makeEnv(getStateValue: () => unknown, withClient = true) {
  const broadcasts: ServerMessage[] = []
  const broker = { broadcast: vi.fn((m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBroker
  const client = {
    setThinkingLevel: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    getState: vi.fn(async () => ({ thinkingLevel: getStateValue() })),
  } as unknown as IPiEngine
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => (withClient ? client : undefined)),
  } as unknown as IProcessManager

  const bus = new MessageBus()
  const svc = new SessionService(
    pm,
    broker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService
    { getDefaultModel: () => ({ provider: 'p', modelId: 'm' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  return { svc, client, pm, broadcasts, bus }
}

/** 收集型 mock ws（BusClient 契约，w12-owner-snapshot-publish 同款）：收集原始 JSON 帧。 */
function createMockWs(): BusClient & { sent: string[] } {
  const sent: string[] = []
  return { readyState: 1, send: (payload: string) => { sent.push(payload) }, sent }
}

function findStateMsg(msgs: ServerMessage[], type: string): ServerMessage | undefined {
  return msgs.find((m) => m.type === type)
}

describe('SessionService.setThinkingLevel 返回 pi 生效值（P3）', () => {
  it('请求 max 被 pi 钳制为 high → 返回 high；pi 收到请求值 max；缓存（getSummary 投影源）为 high 非请求值', async () => {
    const { svc, client } = makeEnv(() => 'high')
    await svc.initializeManagedSession('s1', client, '/tmp', 't')
    const returned = await svc.setThinkingLevel('s1', 'max')
    expect(returned).toBe('high')
    expect(client.setThinkingLevel).toHaveBeenCalledWith('max')
    expect(svc.getSummary('s1')?.thinkingLevel).toBe('high')
  })

  it('生效值与请求值一致（无钳制）→ 返回请求值，行为同旧版', async () => {
    const { svc } = makeEnv(() => 'high')
    await svc.initializeManagedSession('s1', {} as unknown as IPiEngine, '/tmp', 't')
    const returned = await svc.setThinkingLevel('s1', 'high')
    expect(returned).toBe('high')
  })

  it('get_state 异常形态（thinkingLevel 缺失）→ 请求值兜底不炸', async () => {
    const { svc } = makeEnv(() => undefined)
    await svc.initializeManagedSession('s1', {} as unknown as IPiEngine, '/tmp', 't')
    const returned = await svc.setThinkingLevel('s1', 'low')
    expect(returned).toBe('low')
  })

  it('无活跃进程 → fail-fast 抛 SESSION_NOT_ACTIVE（code-harden RT-4#4，不再请求值兜底）', async () => {
    const { svc } = makeEnv(() => 'high', false)
    // [code-harden RT-4#4] 旧契约「请求值兜底 + 直写」已废：切档位落到回收/崩溃窗口时
    // 必须报错（恢复动作内嵌错误消息），不得乐观写未生效档位。
    await expect(svc.setThinkingLevel('s1', 'low')).rejects.toMatchObject({
      code: SESSION_NOT_ACTIVE,
      message: expect.stringContaining('重开后可重试'),
    })
  })
})

describe('SessionService.switchModel 返回 pi 生效模型（U6 回执普查）', () => {
  it('pi pattern 换模（get_state 读回 ≠ 请求值）→ 返回生效复合串；缓存（getSummary 投影源）写生效值非请求值', async () => {
    // 请求 model-a，pi pattern 引擎实际切到同族 model-b（事故 A 形态）
    const { svc, client } = makeEnv(() => 'high')
    ;(client.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      thinkingLevel: 'high',
      model: { id: 'model-b', provider: 'p' },
    })
    await svc.initializeManagedSession('s1', client, '/tmp', 't')
    const returned = await svc.switchModel('s1', 'p' as never, 'model-a')
    expect(client.setModel).toHaveBeenCalledWith('p', 'model-a')
    expect(returned).toBe('p/model-b')
    expect(svc.getSummary('s1')?.modelId).toBe('p/model-b')
  })

  it('get_state 读回与请求一致 → 返回请求复合串（常态路径）', async () => {
    const { svc } = makeEnv(() => 'high')
    await svc.initializeManagedSession('s1', {} as unknown as IPiEngine, '/tmp', 't')
    const returned = await svc.switchModel('s1', 'p' as never, 'model-a')
    expect(returned).toBe('p/model-a')
  })

  it('get_state 失败 → 请求值兜底不炸（读回是旁路，不反噬切模型主链路）', async () => {
    const { svc, client } = makeEnv(() => 'high')
    ;(client.getState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('state unavailable'))
    await svc.initializeManagedSession('s1', client, '/tmp', 't')
    const returned = await svc.switchModel('s1', 'p' as never, 'model-a')
    expect(returned).toBe('p/model-a')
  })

  it('get_state 读回畸形 model（id 空串）→ 请求值兜底（U6 生效值 guard 分支）', async () => {
    const env = makeEnv(() => 'high')
    ;(env.client.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      thinkingLevel: 'high',
      model: { id: '', provider: 'p' },
    })
    await env.svc.initializeManagedSession('s1', env.client, '/tmp', 't')
    const returned = await env.svc.switchModel('s1', 'p' as never, 'model-a')
    expect(returned).toBe('p/model-a')
    // 缓存（getSummary 投影源）同步兜底为请求值，不落畸形生效值
    expect(env.svc.getSummary('s1')?.modelId).toBe('p/model-a')
  })

  it('get_state 读回畸形 model（provider 缺失）→ 请求值兜底（U6 生效值 guard 分支）', async () => {
    const env = makeEnv(() => 'high')
    ;(env.client.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
      thinkingLevel: 'high',
      model: { id: 'model-b' },
    })
    await env.svc.initializeManagedSession('s1', env.client, '/tmp', 't')
    const returned = await env.svc.switchModel('s1', 'p' as never, 'model-a')
    expect(returned).toBe('p/model-a')
    expect(env.svc.getSummary('s1')?.modelId).toBe('p/model-a')
  })

  it('pi pattern 换模 → state_changed 广播 payload 的 modelId 为生效值非请求值（markDirty 防抖收敛链）', async () => {
    vi.useFakeTimers()
    try {
      const env = makeEnv(() => 'high')
      // 播种权威值：model-a / high（防抖拉取成功，快照就绪）
      ;(env.client.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
        thinkingLevel: 'high',
        model: { id: 'model-a', provider: 'p' },
      })
      await env.svc.initializeManagedSession('s1', env.client, '/tmp', 't')
      await vi.advanceTimersByTimeAsync(1)

      // pi pattern 引擎实际切到 model-b（事故 A 形态）：get_state 读回生效值 ≠ 请求值
      ;(env.client.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
        thinkingLevel: 'high',
        model: { id: 'model-b', provider: 'p' },
      })
      const returned = await env.svc.switchModel('s1', 'p' as never, 'model-a')
      expect(returned).toBe('p/model-b')
      // switchModel RPC 成功响应 markDirty → 防抖重拉 → 快照挂钩发布 state_changed
      await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)

      const late = env.bus.subscribe('s1', createMockWs())
      const snapshotMsg = findStateMsg(late.stateSnapshot, 'session.state_changed')
      expect(snapshotMsg?.payload).toMatchObject({
        sessionId: 's1',
        modelId: 'p/model-b', // 生效值，非请求值 p/model-a
      })
      // 第三处消费点：缓存直写（session.modelId ← effectiveModelId）投影 getSummary /
      // session 列表（toSummary），与 payload 的实例快照路径是两条独立数据链——都要是生效值
      expect(env.svc.getSummary('s1')?.modelId).toBe('p/model-b')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionService.setModelCapabilityReconciler — 附着触发能力对账（U6-D2②）', () => {
  // D2② 在线对账回路的触发点在附着收敛路径（initializeManagedSession 末尾）：
  // reconciler 已注册 → fire-and-forget 以 session id 恰调一次；未注册 → false 臂跳过。
  // 现有用例全部跑在未注册态（false 臂），本 describe 锁 true 臂 + 吞错双保险语义。

  it('reconciler 已注册 → 附着以 session id 恰调 1 次，附着主链路返回值/状态不受影响', async () => {
    const { svc, client } = makeEnv(() => 'high')
    const reconciler = vi.fn(async () => [])
    svc.setModelCapabilityReconciler(reconciler)

    const session = await svc.initializeManagedSession('s1', client, '/tmp', 't')

    expect(reconciler).toHaveBeenCalledTimes(1)
    expect(reconciler).toHaveBeenCalledWith('s1')
    // 附着主链路无恙：返回视图 + summary 投影正常（对账是纯旁路诊断）
    expect(session).toBeTruthy()
    expect(svc.getSummary('s1')).toBeTruthy()
  })

  it('reconciler reject → 附着仍正常 resolve，无 unhandled rejection（降级绝不阻断附着）', async () => {
    const { svc, client } = makeEnv(() => 'high')
    const reconciler = vi.fn(async () => { throw new Error('reconcile boom') })
    svc.setModelCapabilityReconciler(reconciler)

    // 触发臂是 fire-and-forget（.catch 吞错）——若 catch 缺失，rejection 会在
    // 微任务排空后升级为 unhandledRejection，此处进程级监听即红灯。
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const session = await svc.initializeManagedSession('s1', client, '/tmp', 't')
      expect(reconciler).toHaveBeenCalledTimes(1)
      // 排空微任务（fire-and-forget promise 的 rejection 结算）
      await new Promise(r => setTimeout(r, 0))
      expect(session).toBeTruthy()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
