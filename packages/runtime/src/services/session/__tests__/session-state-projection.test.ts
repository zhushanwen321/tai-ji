/**
 * SessionStateProjection 模块直接测试（S5：replicated states 快照投影族 + context/usage
 * 副作用域从 SessionService 迁出后的直接测试面——G2 形态：stub pm/client + 真实
 * MessageBus，不构造 Facade 全家桶，import 不含 session-service）。
 *
 * 覆盖四块（对应实现迁移面）：
 * - 订阅播种：subscribe 注册的 handler 触发 registerReplicatedStates（四实例 + refetch
 *   立即拉取）；幂等注册 dispose 旧实例。
 * - 快照投影核心路径：fetch 成功后 setTimeout 0 宏任务发布 context.update /
 *   session.commands / session.state_changed（payload 全字段来自实例快照）+ 无值占位帧
 *   （tokens=null）+ diff 抑制 + fallback 双写缓存 + 销毁守卫（hasSession false 不 publish）。
 * - 副作用域：applyContextUpdate（事件只失效 + 防抖 300ms 重拉）/ handleTurnUsageSideEffects
 *   （project sidecar 兜底）/ handleTurnEndSideEffects（isGenerating 复位 + outcome 映射）/
 *   fetchAndBroadcastContext（fetchContext 吞错兜底）。
 * - onSessionDisposed：实例组 dispose（此后 markDirty/refetch 不再拉取）+ Map 清理 +
 *   diff 基线清除（同 id 重建后同值组合重新发帧）。
 *
 * timer 红线：防抖/退避/setTimeout 0 发布全用 fake timers（TEST-STRATEGY）。
 * 运行：cd packages/runtime && npx vitest run session-state-projection
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionStateProjection, type SessionStateProjectionDeps } from '../session-state-projection.js'
import { MessageBus } from '../../message-bus/message-bus.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../replicated-states.config.js'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { ServerMessage } from '@taiji/shared'

/** get_state 权威响应形状（pi rpc-mode getState：标量 + model 对象）。 */
function stateResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { thinkingLevel: 'high', model: { provider: 'xiaomi', id: 'mimo' }, ...overrides }
}

/** get_session_stats 权威响应形状（contextUsage 三字段）。 */
function statsResponse(tokens: number | null): Record<string, unknown> {
  return { contextUsage: { tokens, contextWindow: 128000, percent: 25 } }
}

/** 最小 IManagedSessionView stub（projection 只读 id/modelId/thinkingLevel/isGenerating）。 */
function makeSessionView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/tmp',
    label: 'stub',
    modelId: 'fallback/model',
    thinkingLevel: 'low',
    createdAt: 0,
    lastActiveAt: 0,
    tokenCount: 0,
    inputTokens: 0,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    ...overrides,
  }
}

/**
 * 构造 projection 直测环境：内存 sessions Map（getSession/hasSession）、真实 MessageBus
 * （publish spy）、fake pi client（getState/getSessionStats/getCommands 计数可控）。
 * stats/state/commands/fetchContext 参数可传 vi.fn 定制失败与形状分支。
 */
function makeEnv(opts: {
  session?: IManagedSessionView
  state?: () => Promise<Record<string, unknown>>
  stats?: () => Promise<Record<string, unknown>>
  commands?: () => Promise<unknown>
  fetchContext?: () => Promise<{ inputTokens: number; contextLimit: number; usagePercent: number } | null>
  active?: boolean
} = {}) {
  const sessions = new Map<string, IManagedSessionView>()
  if (opts.session !== null) sessions.set(opts.session?.id ?? 's1', opts.session ?? makeSessionView())
  const client = {
    getState: opts.state ?? vi.fn(async () => stateResponse()),
    getSessionStats: opts.stats ?? vi.fn(async () => statsResponse(100)),
    getCommands: opts.commands ?? vi.fn(async () => [{ name: '/cmd', description: 'd' }]),
  }
  const pm = {
    getClient: vi.fn(() => (opts.active === false ? undefined : (client as unknown as IPiEngine))),
  } as unknown as IProcessManager
  const bus = new MessageBus()
  const publishSpy = vi.spyOn(bus, 'publish')
  const deps: SessionStateProjectionDeps = {
    pm,
    getSession: (sessionId) => sessions.get(sessionId),
    hasSession: (sessionId) => sessions.has(sessionId),
    getMessageBus: () => bus,
    fetchContext: opts.fetchContext ?? vi.fn(async () => null),
    persistSessionOutcome: vi.fn(),
    tryPersistProjectBinding: vi.fn(),
    tryPersistModelBinding: vi.fn(),
  }
  const projection = new SessionStateProjection(deps)
  return { projection, deps, bus, publishSpy, client, sessions }
}

/** fake lifecycle（subscribe 的注册目标）：收集 handler，notifySessionRegistered 按序直发。 */
function makeLifecycle() {
  const handlers: Array<(sessionId: string) => void> = []
  return {
    onSessionRegistered: (handler: (sessionId: string) => void) => { handlers.push(handler) },
    emit: (sessionId: string) => { for (const h of handlers) h(sessionId) },
    handlerCount: () => handlers.length,
  }
}

/** 播种 + 推进到快照落定与 setTimeout 0 发布宏任务全部执行完。 */
async function settle(projection: SessionStateProjection, sessionId = 's1') {
  projection.registerReplicatedStates(sessionId)
  await vi.advanceTimersByTimeAsync(0)
}

/** bus publish 的调用记录形态（sessionId + ServerMessage）。 */
type PublishCall = [string, ServerMessage]

/** 收集 bus publish 的某类型消息。 */
function messagesOf(calls: PublishCall[], type: string): Array<{ payload: Record<string, unknown> }> {
  return calls
    .map(([, msg]) => msg)
    .filter((m) => m.type === type)
    .map((m) => m as { payload: Record<string, unknown> })
}

/** publishSpy.mock.calls 的窄读视图（spy 泛型推断复杂，按调用形状断言读取）。 */
function publishedCalls(publishSpy: ReturnType<typeof vi.spyOn>): PublishCall[] {
  return publishSpy.mock.calls as unknown as PublishCall[]
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── 订阅播种（S5 订阅者换人的模块侧行为）──

describe('subscribe：onSessionRegistered 播种接线', () => {
  it('handler 注册进 source，触发即播种四实例并 refetch 立即拉取（get_state 两实例各一次 + stats/commands 各一次）', async () => {
    const env = makeEnv()
    const lifecycle = makeLifecycle()
    env.projection.subscribe(lifecycle)
    expect(lifecycle.handlerCount()).toBe(1)

    lifecycle.emit('s1')
    // thinkingLevel / modelId 是两个实例，各经 fetchStateSnapshot 拉一次 get_state
    expect(env.client.getState).toHaveBeenCalledTimes(2)
    expect(env.client.getSessionStats).toHaveBeenCalledTimes(1)
    expect(env.client.getCommands).toHaveBeenCalledTimes(1)
    expect(env.projection.getReplicatedStates('s1')).toBeDefined()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('幂等注册：同 id 重复播种先 dispose 旧实例（旧实例 refetch 不再拉取）', async () => {
    const env = makeEnv()
    await settle(env.projection)
    const first = env.projection.getReplicatedStates('s1')
    expect(first).toBeDefined()

    env.projection.registerReplicatedStates('s1')
    const second = env.projection.getReplicatedStates('s1')
    expect(second).not.toBe(first)
    // 旧实例已 dispose：refetch no-op（调用计数不再增长），新实例接管拉取
    const stateCalls = (env.client.getState as ReturnType<typeof vi.fn>).mock.calls.length
    first!.modelId.refetch()
    expect((env.client.getState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(stateCalls)
  })
})

// ── 快照投影核心路径 ──

describe('快照投影：fetch 成功后挂钩发布（「投影一次」）', () => {
  it('usage 快照落定 → context.update（payload 全字段来自快照）+ state_changed 组合投影', async () => {
    const env = makeEnv()
    await settle(env.projection)

    const ctx = messagesOf(publishedCalls(env.publishSpy), 'context.update')
    expect(ctx).toHaveLength(1)
    expect(ctx[0].payload).toEqual({ sessionId: 's1', inputTokens: 100, contextLimit: 128000, usagePercent: 25 })
    const stateChanged = messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')
    expect(stateChanged).toHaveLength(1)
    // modelId 组合 'provider/id'（get_state 投影口径），thinkingLevel 直读
    expect(stateChanged[0].payload).toEqual({ sessionId: 's1', modelId: 'xiaomi/mimo', thinkingLevel: 'high' })
  })

  it('commands 快照落定 → session.commands', async () => {
    const env = makeEnv()
    await settle(env.projection)
    const commands = messagesOf(publishedCalls(env.publishSpy), 'session.commands')
    expect(commands).toHaveLength(1)
    expect(commands[0].payload).toEqual({ sessionId: 's1', commands: [{ name: '/cmd', description: 'd' }] })
  })

  it('tokens=null（compact 后合法无值）→ context.update 无值占位帧（仅 sessionId）', async () => {
    const env = makeEnv({ stats: vi.fn(async () => statsResponse(null)) })
    await settle(env.projection)
    const ctx = messagesOf(publishedCalls(env.publishSpy), 'context.update')
    expect(ctx).toHaveLength(1)
    expect(ctx[0].payload).toEqual({ sessionId: 's1' })
  })

  it('diff 抑制：同值 state_changed 组合不重复发帧（基线命中）', async () => {
    const env = makeEnv()
    await settle(env.projection)
    expect(messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')).toHaveLength(1)
    // 同值失效重拉（防抖到点 → get_state 同值快照 → 挂钩再发布 → diff 抑制）
    env.projection.getReplicatedStates('s1')!.modelId.markDirty()
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect((env.client.getState as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')).toHaveLength(1)
  })

  it('快照缺失 fallback 双写缓存：get_state 失败退避窗口内 payload 用 session 缓存值', async () => {
    const env = makeEnv({ state: vi.fn(async () => { throw new Error('pi dead') }) })
    await settle(env.projection)
    // modelId / thinkingLevel fetch 全失败（退避重试排程中），state_changed 挂钩（finally 路径）
    // 仍发帧——payload fallback 到 session.modelId / thinkingLevel 双写缓存
    const stateChanged = messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')
    expect(stateChanged).toHaveLength(1)
    expect(stateChanged[0].payload).toEqual({ sessionId: 's1', modelId: 'fallback/model', thinkingLevel: 'low' })
  })

  it('销毁守卫：session 已从 Map 删除时 fetch 落定不 publish（防 bus 重建已 clearSession 的 entry）', async () => {
    const env = makeEnv()
    env.projection.registerReplicatedStates('s1')
    env.sessions.delete('s1') // 播种 fetch 在途期间 session 被销毁
    await vi.advanceTimersByTimeAsync(0)
    expect(env.publishSpy).not.toHaveBeenCalled()
  })

  it('无活跃 client：fetch 抛错（快照保持 undefined + 按退避序列重试）', async () => {
    const env = makeEnv({ active: false })
    env.projection.registerReplicatedStates('s1')
    await vi.advanceTimersByTimeAsync(0)
    const states = env.projection.getReplicatedStates('s1')
    expect(states!.usage.get()).toBeUndefined() // 失败保留「无快照」态（核心不变量 2）

    // 退避第一档 1s 后重试（仍失败，快照依旧未落定）
    await vi.advanceTimersByTimeAsync(1000)
    expect(states!.usage.get()).toBeUndefined()
  })
})

// ── 副作用域（markDirty / 防抖 / sidecar 兜底 / 终态映射）──

describe('副作用域：applyContextUpdate / handleTurn* / fetchAndBroadcastContext', () => {
  it('applyContextUpdate：事件只失效——防抖窗口内不重拉，到点后重拉 get_session_stats', async () => {
    const env = makeEnv()
    await settle(env.projection)
    const before = (env.client.getSessionStats as ReturnType<typeof vi.fn>).mock.calls.length

    env.projection.applyContextUpdate('s1', 999, 999)
    expect(env.projection.getReplicatedStates('s1')!.usage.isDirty()).toBe(true)
    expect((env.client.getSessionStats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before) // 未到防抖窗口

    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS)
    expect((env.client.getSessionStats as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1)
    expect(env.projection.getReplicatedStates('s1')!.usage.isDirty()).toBe(false) // 成功快照清 dirty
  })

  it('applyContextUpdate 对未注册 session 安全 no-op', () => {
    const env = makeEnv()
    expect(() => env.projection.applyContextUpdate('ghost', 1, 1)).not.toThrow()
  })

  it('handleTurnUsageSideEffects：turn_end project/model sidecar 兜底；session 不存在时跳过', () => {
    const env = makeEnv({ session: makeSessionView({ id: 's1', isGenerating: false }) })
    env.projection.handleTurnUsageSideEffects('s1')
    expect(env.deps.tryPersistProjectBinding).toHaveBeenCalledTimes(1)
    expect(env.deps.tryPersistModelBinding).toHaveBeenCalledTimes(1)
    expect(env.deps.tryPersistModelBinding).toHaveBeenCalledWith(env.sessions.get('s1'))
    env.projection.handleTurnUsageSideEffects('ghost')
    expect(env.deps.tryPersistProjectBinding).toHaveBeenCalledTimes(1)
    expect(env.deps.tryPersistModelBinding).toHaveBeenCalledTimes(1)
  })

  it('handleTurnEndSideEffects：isGenerating 复位 + sidecar 兜底（project/model 镜像）+ stopReason outcome 映射（error/aborted/其余→done）', () => {
    const env = makeEnv({ session: makeSessionView({ id: 's1', isGenerating: true }) })
    env.projection.handleTurnEndSideEffects('s1')
    expect(env.sessions.get('s1')!.isGenerating).toBe(false)
    expect(env.deps.tryPersistProjectBinding).toHaveBeenCalledTimes(1)
    expect(env.deps.tryPersistModelBinding).toHaveBeenCalledTimes(1)
    expect(env.deps.persistSessionOutcome).toHaveBeenCalledWith('s1', 'done')

    env.projection.handleTurnEndSideEffects('s1', 'error')
    expect(env.deps.persistSessionOutcome).toHaveBeenLastCalledWith('s1', 'error')
    env.projection.handleTurnEndSideEffects('s1', 'aborted')
    expect(env.deps.persistSessionOutcome).toHaveBeenLastCalledWith('s1', 'stopped')
  })

  it('handleAgentSettledSideEffects：run 级联结束 → isGenerating 复位；session 不存在时跳过（session-dead 幽灵忙碌兜底）', () => {
    const env = makeEnv({ session: makeSessionView({ id: 's1', isGenerating: true }) })
    env.projection.handleAgentSettledSideEffects('s1')
    expect(env.sessions.get('s1')!.isGenerating).toBe(false)
    // 只碰 isGenerating：不得写 session_end 终态 / sidecar（与 handleTurnEndSideEffects 的职责边界）
    expect(env.deps.persistSessionOutcome).not.toHaveBeenCalled()
    expect(env.deps.tryPersistProjectBinding).not.toHaveBeenCalled()
    expect(env.deps.tryPersistModelBinding).not.toHaveBeenCalled()

    expect(() => env.projection.handleAgentSettledSideEffects('ghost')).not.toThrow()
  })

  it('fetchAndBroadcastContext：fetchContext resolve 正常返回；reject 吞错不抛（fire-and-forget）', async () => {
    const ok = makeEnv()
    await ok.projection.fetchAndBroadcastContext('s1')
    expect(ok.deps.fetchContext).toHaveBeenCalledWith('s1')

    const fail = makeEnv({ fetchContext: vi.fn(async () => { throw new Error('rpc down') }) })
    await expect(fail.projection.fetchAndBroadcastContext('s1')).resolves.toBeUndefined()
  })
})

// ── 销毁清理（Facade removeSessionEntry 第 ⑤ 步直调面）──

describe('onSessionDisposed：实例组与 diff 基线清理', () => {
  it('dispose 后 markDirty/refetch 不再拉取 + 访问器清空 + 幂等', async () => {
    const env = makeEnv()
    await settle(env.projection)
    const states = env.projection.getReplicatedStates('s1')!
    const stateCalls = (env.client.getState as ReturnType<typeof vi.fn>).mock.calls.length

    env.projection.onSessionDisposed('s1')
    expect(env.projection.getReplicatedStates('s1')).toBeUndefined()

    states.usage.markDirty() // dispose 后 no-op：不置 dirty、不排防抖
    states.modelId.refetch()
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 100)
    expect((env.client.getState as ReturnType<typeof vi.fn>).mock.calls.length).toBe(stateCalls)

    expect(() => env.projection.onSessionDisposed('s1')).not.toThrow() // 幂等
  })

  it('diff 基线随销毁清除：同 id 重建播种后同值组合重新发帧（不误判同值）', async () => {
    const env = makeEnv()
    await settle(env.projection)
    expect(messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')).toHaveLength(1)

    env.projection.onSessionDisposed('s1')
    await settle(env.projection) // 同 id 重建 + 同值快照落定
    expect(messagesOf(publishedCalls(env.publishSpy), 'session.state_changed')).toHaveLength(2) // 基线已清 → 重新发帧
  })
})
