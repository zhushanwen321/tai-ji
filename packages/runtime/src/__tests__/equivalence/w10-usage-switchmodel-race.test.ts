/**
 * W10 竞态回归用例：switchModel 与 context.update 乱序到达（data-source-governance P1.3）。
 *
 * 验收对照（.taiji-harness/2026-08-19-data-source-governance-p1p4/acceptance/w10-acceptance.md 交付物 3）：
 * 模拟「switchModel 与 context.update 乱序到达」（fake timers 控制防抖窗口），断言最终
 * usagePercent 与 get_session_stats 快照一致——结构自愈，不依赖写入顺序。
 *
 * 结构自愈的机制（W10 五写点收编；W12 后广播形态更新）：
 * - inputTokens 唯一数据源 = usage 实例快照（fetch get_session_stats 写入；旧 setInputTokens
 *   / session.inputTokens 直写已删）。W12 起 state_changed / context.update 都由「快照应用后
 *   挂钩」发布（payload 全字段读快照），W10 的「快照 tokens × resolver 新窗口」本地重算
 *   （recomputeUsageWithWindow）已随即时广播退役删除。
 * - 两条失效（switchModel 的 usage markDirty / applyContextUpdate 的 usage markDirty）
 *   任意顺序到达，防抖聚合后一次拉取收敛 pi 权威值——pi 侧 getContextUsage 按当前 model
 *   的 contextWindow 算 percent，setModel 后天然是新窗口。
 *
 * mock 层用例用 fake timers（项目规范，禁真实 sleep）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage, ProviderId } from '@taiji/shared'
import { SessionService } from '../../services/session/session-service.js'
import { SCALAR_STATE_DEBOUNCE_MS } from '../../services/session/replicated-states.config.js'
import type { IMessageBus } from '../../services/message-bus/message-bus.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'

/** 测试模型注册表：modelId → contextWindow（注入 resolver，模拟 runtime 模型配置）。 */
const MODEL_WINDOWS: Record<string, number> = {
  'model-a': 200_000,
  'model-b': 100_000,
  'model-c': 50_000,
  'model-d': 400_000,
}

/** pi 侧 contextUsage 权威快照 mock：tokens 不随模型变（context 占用只跟对话内容有关）。 */
const TOKENS = 20_000

interface Fixture {
  svc: SessionService
  bus: IMessageBus
  client: {
    setModel: ReturnType<typeof vi.fn<(provider: string, modelId: string) => Promise<void>>>
    getSessionStats: ReturnType<typeof vi.fn<() => Promise<unknown>>>
    getState: ReturnType<typeof vi.fn<() => Promise<unknown>>>
    getCommands: ReturnType<typeof vi.fn<() => Promise<unknown[]>>>
  }
  /** pi 侧当前模型（setModel mock 时切换，getState/getSessionStats 跟随）。 */
  setCurrentModel: (modelId: string) => void
}

/**
 * 最小装置：fake pi client（get_session_stats 按「当前模型」返回权威 contextUsage——
 * 对齐 pi agent-session.getContextUsage 用 this.model 的 contextWindow 算 percent）。
 */
function makeFixture(): Fixture {
  let currentModel = 'model-a'
  const contextUsageOf = (modelId: string) => {
    const contextWindow = MODEL_WINDOWS[modelId] ?? 0
    const percent = contextWindow > 0 ? (TOKENS / contextWindow) * 100 : 0
    return { tokens: TOKENS, contextWindow, percent }
  }
  const client = {
    setModel: vi.fn(async (_provider: string, modelId: string) => { currentModel = modelId }),
    getSessionStats: vi.fn(async () => ({ contextUsage: contextUsageOf(currentModel) })),
    getState: vi.fn(async () => ({
      sessionName: 'race',
      thinkingLevel: 'low',
      model: { id: currentModel, provider: 'p' },
      pendingMessageCount: 0,
    })),
    getCommands: vi.fn(async () => []),
  }
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  const bus = {
    publish: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    unsubscribeAll: vi.fn(),
    clearSession: vi.fn(),
  } as unknown as IMessageBus
  const svc = new SessionService(
    pm,
    { broadcast: vi.fn() } as unknown as IMessageBroker,
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'p', modelId: 'model-a' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
    bus,
  )
  svc.setMessageBus(bus)
  // W18：resolver 注入链已删（W12 后生产零消费）——usage 全字段来自 pi getSessionStats 快照
  return { svc, bus, client, setCurrentModel: (m) => { currentModel = m } }
}

/** 播种激活 session + 四实例（usage 快照落位 = 当前模型的 pi 权威 contextUsage 投影；label/queue 已撤销 PR #185）。 */
async function seedActiveSession(fx: Fixture, sessionId: string): Promise<void> {
  await fx.svc.initializeManagedSession(sessionId, {} as unknown as IPiEngine, '/tmp', 'race')
  await vi.advanceTimersByTimeAsync(1) // flush 四实例播种 refetch
}

/** 此刻 get_session_stats().contextUsage 的投影（竞态用例的权威终态基准，直接调 mock RPC）。 */
async function authoritativeProjection(
  fx: Fixture,
): Promise<{ inputTokens: number; contextLimit: number; usagePercent: number }> {
  const stats = await fx.client.getSessionStats() as {
    contextUsage: { tokens: number; contextWindow: number; percent: number }
  }
  const cu = stats.contextUsage
  return {
    inputTokens: cu.tokens,
    contextLimit: cu.contextWindow,
    usagePercent: Math.min(Math.round(cu.percent), 100),
  }
}

/** 从 bus.publish 找指定 type 的最新消息（按 type 收窄返回 payload 类型）。 */
function lastPublished<T extends ServerMessage['type']>(fx: Fixture, type: T): ServerMessage<T> | undefined {
  const calls = vi.mocked(fx.bus.publish).mock.calls
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i]![1].type === type) return calls[i]![1] as ServerMessage<T>
  }
  return undefined
}

describe('W10 竞态回归：switchModel 与 context.update 乱序到达（结构自愈，fake timers）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('乱序 1（switchModel 先到、context.update 后到）：终态 usagePercent 与 get_session_stats 快照一致', async () => {
    const fx = makeFixture()
    const sid = 's-race-1'
    await seedActiveSession(fx, sid)
    // 播种断言：usage 快照 = 模型 A 权威（20000/200000 → 10%）
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.get()).toEqual({
      inputTokens: TOKENS, contextLimit: MODEL_WINDOWS['model-a'] ?? 0, usagePercent: 10,
    })

    // pi 侧新 turn 完成 + 已切模型 B：get_session_stats 权威翻新（tokens 不变，窗口 100k → 20%）
    vi.mocked(fx.bus.publish).mockClear()

    // 乱序：switchModel 先到（setModel RPC 即时生效 → markDirty modelId/usage/thinkingLevel）
    await fx.svc.switchModel(sid, 'p' as ProviderId, 'model-b')
    // context.update 后到（新 turn 的 agent_end 事件 → applyContextUpdate 只失效）
    fx.svc.applyContextUpdate(sid, TOKENS, TOKENS)

    // W12：即时广播退役——防抖到点三实例收敛后，快照挂钩发布帧。D1 协议收敛
    //（context-consistency Phase 1）后 usage 只在 context.update 帧：mock 权威按当前
    // 模型 B 的窗口 100k / percent 20 投影（与旧「快照 tokens × resolver 新窗口重算」的
    // 20 同值——切换前后等价）；state_changed 帧不再携带 usage（协议层已删三字段）。
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 50)
    const contextUpdate = lastPublished(fx, 'context.update')
    expect(contextUpdate?.payload).toMatchObject({
      sessionId: sid,
      inputTokens: TOKENS,
      contextLimit: MODEL_WINDOWS['model-b'] ?? 0,
      usagePercent: 20, // Math.round(20000 / 100000 * 100)
    })
    const stateChanged = lastPublished(fx, 'session.state_changed')
    expect(stateChanged?.payload).toMatchObject({
      sessionId: sid,
      modelId: 'p/model-b',
    })

    // 快照收敛断言（两次失效聚合一次拉取，不依赖两个信号的先后顺序）
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    const expected = await authoritativeProjection(fx)
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.get()).toEqual(expected)
    expect(fx.svc.getUsagePercent(sid)).toBe(expected.usagePercent)
    expect(fx.svc.getInputTokens(sid)).toBe(expected.inputTokens)
  })

  it('乱序 2（context.update 先到、switchModel 后到）：同一终态（写入顺序不影响收敛）', async () => {
    const fx = makeFixture()
    const sid = 's-race-2'
    await seedActiveSession(fx, sid)

    // pi 侧已切模型 B（权威翻新）——context.update 事件先到
    vi.mocked(fx.bus.publish).mockClear()
    fx.setCurrentModel('model-b')
    fx.svc.applyContextUpdate(sid, TOKENS, TOKENS)

    // switchModel 后到（RPC 响应驱动失效）
    await fx.svc.switchModel(sid, 'p' as ProviderId, 'model-b')

    // 防抖到点：收敛与乱序 1 完全一致（单一数据写路径 = fetch，顺序无关）
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    const expected = await authoritativeProjection(fx)
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.get()).toEqual({
      inputTokens: TOKENS, contextLimit: MODEL_WINDOWS['model-b'] ?? 0, usagePercent: 20,
    })
    expect(fx.svc.getUsagePercent(sid)).toBe(expected.usagePercent)
    expect(fx.svc.getInputTokens(sid)).toBe(expected.inputTokens)
  })

  it('快速连切 3 个模型：防抖聚合失效风暴，终态 = 最后模型的权威快照（无中间错值残留）', async () => {
    const fx = makeFixture()
    const sid = 's-race-3'
    await seedActiveSession(fx, sid)

    // 快速连切 B → C → B(每步间隔 < 防抖窗口,中间值只出现在即时广播,不落快照)
    await fx.svc.switchModel(sid, 'p' as ProviderId, 'model-b')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS / 2)
    await fx.svc.switchModel(sid, 'p' as ProviderId, 'model-c')
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS / 2)
    await fx.svc.switchModel(sid, 'p' as ProviderId, 'model-b')

    // 防抖到点:防抖窗口被连续 markDirty 重置,最终一次拉取收敛「此刻」pi 权威(= model B)
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    const usage = fx.svc.getScalarReplicatedStates(sid)?.usage.get()
    expect(usage).toEqual({
      inputTokens: TOKENS, contextLimit: MODEL_WINDOWS['model-b'] ?? 0, usagePercent: 20,
    })
    expect(fx.svc.getScalarReplicatedStates(sid)?.usage.isDirty()).toBe(false)
    // modelId 实例同收敛(最后切换的模型)
    expect(fx.svc.getScalarReplicatedStates(sid)?.modelId.get()).toEqual({ modelId: 'p/model-b' })
  })
})
