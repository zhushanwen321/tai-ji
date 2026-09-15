/**
 * W8 等价性 + 失效接线用例（data-source-governance P1.1 / P1.2 第二批）。
 *
 * 验收对照（.xyz-harness/2026-08-19-data-source-governance-p1p4/acceptance/w8-acceptance.md）：
 * - 「事件风暴（模拟丢 context.update）后实例值收敛 get_session_stats 快照」→ describe
 *   「mock RPC 层」it 1 + describe「真实 pi 子进程」it 1（真实 get_session_stats 权威源）
 * - queue 深度实例用例已随实例撤销删除（PR #185 MF2：.get() 生产零消费，深度真值 =
 *   queue_update 帧内 pendingMessageCount 推送投影，renderer 对账直读帧值——帧翻译
 *   覆盖见 mock it 4）
 * - commands 快照与失效（getCommands 全部调用路径 = 失效源）→ mock it 2 + it 3
 * - RPC 频率采样（P0.5② 终判输入）：usage/commands 实例的快照 RPC 次数与 p95 延迟 →
 *   真实 pi it 2（数字 console.log 输出，写进 builder 汇报做量化终判；落登记表由主 agent
 *   串行处理）
 *
 * skip-if-no-real-pi：真实 pi 用例以 describe.skipIf(!REAL_PI_READY) 包裹（binary + LLM 凭证
 * 双判定，describe 名注入理由，约定见 pi-fixture.ts 头注释）；mock 层 describe 不依赖凭证，
 * 无条件执行（CI 覆盖凭证无关子集）。mock 层用例用 fake timers（项目规范，禁真实 sleep）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage } from '@xyz-agent/shared'
import { SessionService } from '../../services/session/session-service.js'
import { ReplicatedState } from '../../services/session/replicated-state.js'
import {
  createUsageStateConfig,
  createCommandsStateConfig,
  SCALAR_STATE_DEBOUNCE_MS,
} from '../../services/session/replicated-states.config.js'
import { translate } from '../../infra/pi/event-adapter.js'
import type { PiQueueUpdateEvent } from '../../infra/pi/pi-protocol.js'
import type { IMessageBroker } from '../../interfaces.js'
import type { IPiEngine, IProcessManager } from '../../services/ports/pi-engine.js'
import { spawnPiFixture, REAL_PI_READY, REAL_PI_SKIP_REASON, type PiFixture } from './pi-fixture.js'

/** 事件风暴规模：模拟风暴期密集到达的 context 相关事件（防抖应聚合为一次拉取）。 */
const EVENT_STORM_SIZE = 20

type StatsShape = Record<string, unknown>

/** get_session_stats 的最小权威快照 mock（contextUsage 三字段，对齐 pi PiContextUsage）。 */
function makeStats(overrides: Record<string, unknown> = {}): StatsShape {
  return {
    contextUsage: { tokens: 1000, contextWindow: 20000, percent: 5 },
    ...overrides,
  }
}

/** mock client：实例 fetch（getState/getSessionStats/getCommands）+ getCommands RPC 路径。 */
function makeClient(state: StatsShape, commands: unknown[] = []) {
  return {
    getCommands: vi.fn(async () => commands),
    getState: vi.fn(async () => state),
    getSessionStats: vi.fn(async () => makeStats()),
    setModel: vi.fn(async () => undefined),
  }
}

/** 最小 SessionService 装置（对齐 W7 scalar-state-invalidation.test.ts 的构造形态）。 */
function makeSessionService(
  client: ReturnType<typeof makeClient>,
  captureSend?: (send: (msg: ServerMessage) => void) => void,
): SessionService {
  const broker = { broadcast: vi.fn() } as unknown as IMessageBroker
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => client as unknown as IPiEngine),
  } as unknown as IProcessManager
  return new SessionService(
    pm,
    broker,
    (id, send) => {
      captureSend?.(send)
      return { attach: vi.fn(), detach: vi.fn() }
    },
    '/test/project-root',
    {} as never, // extensionService：被测路径未消费
    { getDefaultModel: () => ({ provider: 'test-provider', modelId: 'test-model' }) } as never, // configStore
    { scanSessions: vi.fn(() => []), extractSessionOutcome: vi.fn(() => null), persistSessionEnd: vi.fn() } as never, // sessionStore
    { pruneStaleCache: vi.fn(), readGitInfo: vi.fn(() => undefined) } as never, // gitInfoReader
    {} as never, // workspaceService
  )
}

describe('W8 usage / queue / commands 失效接线（mock RPC 层）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('usage 事件风暴（模拟丢 context.update）后实例值收敛 get_session_stats 快照，防抖聚合风暴为一次拉取', async () => {
    const fetchStats = vi.fn(async () => makeStats())
    const usageState = new ReplicatedState(createUsageStateConfig(fetchStats))
    usageState.refetch()
    await vi.advanceTimersByTimeAsync(1)
    expect(usageState.get()).toEqual({ inputTokens: 1000, contextLimit: 20000, usagePercent: 5 }) // 播种完成

    // 模拟丢 context.update：权威源已变（pi 侧完成新 turn，contextUsage 更新），
    // 但 runtime 未收到任何 context 相关事件（实例无失效、无直写——快照停留旧值）。
    fetchStats.mockResolvedValue(makeStats({
      contextUsage: { tokens: 3000, contextWindow: 20000, percent: 15 },
    }))

    // 事件风暴：密集 markDirty（模拟风暴期/重连批量到达的 context 相关事件）
    for (let i = 0; i < EVENT_STORM_SIZE; i++) usageState.markDirty()
    expect(usageState.isDirty()).toBe(true)
    expect(usageState.get()).toEqual({ inputTokens: 1000, contextLimit: 20000, usagePercent: 5 }) // 失效瞬间不直写

    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    // 收敛：唯一数据写路径 = get_session_stats 快照（风暴 20 次失效防抖聚合为 1 次拉取）
    expect(fetchStats).toHaveBeenCalledTimes(2) // 播种 1 + 风暴聚合 1
    expect(usageState.get()).toEqual({ inputTokens: 3000, contextLimit: 20000, usagePercent: 15 })
    expect(usageState.isDirty()).toBe(false)

    // tokens=null（pi compact 后无新 turn）= 合法「无值」态：空快照保持旧值（不覆盖不 guard）
    fetchStats.mockResolvedValue(makeStats({ contextUsage: { tokens: null, contextWindow: 20000, percent: null } }))
    usageState.markDirty()
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(usageState.get()).toEqual({ inputTokens: 3000, contextLimit: 20000, usagePercent: 15 })
    usageState.dispose()
  })

  it('commands markDirty 后收敛 get_commands 快照（空数组 = 合法态整字段覆盖，不清空为「不动」）', async () => {
    const fetchCommands = vi.fn(async (): Promise<unknown> => [{ name: 'cmd-a' }, { name: 'cmd-b' }])
    const commandsState = new ReplicatedState(createCommandsStateConfig(fetchCommands))
    commandsState.refetch()
    await vi.advanceTimersByTimeAsync(1)
    expect(commandsState.get()?.commands).toHaveLength(2)

    // 命令集清空（扩展禁用）：空数组覆盖旧数组（ownerSnapshotMerge 整字段覆盖语义）
    fetchCommands.mockResolvedValue([])
    commandsState.markDirty()
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(commandsState.get()?.commands).toEqual([])
    expect(commandsState.isDirty()).toBe(false)

    // 非 array 返回 = 协议异常：保留旧值 + dirty 不清
    fetchCommands.mockResolvedValue('not-an-array')
    commandsState.markDirty()
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(commandsState.get()?.commands).toEqual([])
    expect(commandsState.isDirty()).toBe(true)
    commandsState.dispose()
  })

  it('session-service 接线：applyContextUpdate / getCommands 分别触发 usage / commands 实例 markDirty 并收敛', async () => {
    const state = { pendingMessageCount: 1, sessionName: 'n', thinkingLevel: 'low', model: { id: 'm', provider: 'p' } }
    const client = makeClient(state as StatsShape, [{ name: 'cmd-a' }])
    client.getSessionStats.mockResolvedValue(makeStats({
      contextUsage: { tokens: 5000, contextWindow: 20000, percent: 25 },
    }))
    const svc = makeSessionService(client)
    await svc.initializeManagedSession('s-w8', client as unknown as IPiEngine, '/tmp', 'test')
    await vi.advanceTimersByTimeAsync(1) // flush 四实例播种 refetch（label/queue 已撤销，PR #185）

    const states = svc.getScalarReplicatedStates('s-w8')
    expect(states).toBeDefined()
    const usageSpy = vi.spyOn(states!.usage, 'markDirty')
    const commandsSpy = vi.spyOn(states!.commands, 'markDirty')

    // usage 失效：applyContextUpdate = turn_end / agent_end / compaction 三事件路径的汇聚点
    svc.applyContextUpdate('s-w8', 123, 456)
    expect(usageSpy).toHaveBeenCalledTimes(1)

    // commands 失效：getCommands RPC 查询即失效（对齐现有发布路径的事件源全集）
    await svc.getCommands('s-w8')
    expect(commandsSpy).toHaveBeenCalledTimes(1)

    // 防抖到点：两实例收敛到各自快照 RPC 的权威值
    await vi.advanceTimersByTimeAsync(SCALAR_STATE_DEBOUNCE_MS + 1)
    expect(states!.usage.get()).toEqual({ inputTokens: 5000, contextLimit: 20000, usagePercent: 25 })
    expect(states!.commands.get()?.commands).toEqual([{ name: 'cmd-a' }])
  })

  it('translate(queue_update) 输出附深度：pendingMessageCount = steering + followUp 条数和（= pi 队列深度的推送投影）', () => {
    const event = {
      type: 'queue_update',
      steering: ['steer-1'],
      followUp: ['follow-1', 'follow-2'],
    } as PiQueueUpdateEvent
    const translated = translate(event, 's-depth')
    expect(translated).toHaveLength(1)
    const frame = translated[0]
    if (frame.kind !== 'message') throw new Error(`expected message kind, got ${frame.kind}`)
    expect(frame.message.type).toBe('message.queue_update')
    expect(frame.message.payload).toEqual({
      sessionId: 's-depth',
      steering: ['steer-1'],
      followUp: ['follow-1', 'follow-2'],
      pendingMessageCount: 3, // 1 steering + 2 followUp（pi pendingMessageCount 同源公式）
    })

    // 空队列：深度 0（合法值，非空值语义）
    const empty = translate({ type: 'queue_update', steering: [], followUp: [] } as PiQueueUpdateEvent, 's-empty')
    const emptyFrame = empty[0]
    if (emptyFrame.kind !== 'message') throw new Error(`expected message kind, got ${emptyFrame.kind}`)
    expect((emptyFrame.message.payload as { pendingMessageCount: number }).pendingMessageCount).toBe(0)
  })
})

/** 真实 timers 轮询等待（真实 pi 用例；fake timers 禁用于真实子进程 IO）。 */
async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${label}`)
    }
    await new Promise((r) => setTimeout(r, 25))
  }
}

/**
 * 等 turn 完成的上限（真实 LLM 调用）。
 * [HISTORICAL] 2026-08-20 PR #185 测试收尾：满并行全量（305 文件）+ 系统余载下真实 LLM
 * 轮次饿死——round-N agent_end 在 120s 内未完成（事件流证明轮次在推进、只是被拖慢；
 * 隔离跑全文件仅 11s 全绿，纯环境饿死非代码问题）。按主 agent 裁决对齐 equivalence
 * 目录 300-420s 口径放宽至 300s；断言强度不变，仅放宽等待上限（同 attach-lifecycle
 * 120→180→300 放宽史）。
 */
const TURN_TIMEOUT_MS = 300_000

/** pi RpcSessionStats.contextUsage 的宽形态（真实 pi 用例的投影口径，对齐 fetchContext）。 */
interface ContextUsageShape {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

describe.skipIf(!REAL_PI_READY)(
  `W8 equivalence: usage / queue / commands 实例收敛（真实 pi 子进程${REAL_PI_SKIP_REASON ? `｜skip：${REAL_PI_SKIP_REASON}` : ''}）`,
  () => {
  let fixture: PiFixture | null = null

  afterEach(async () => {
    if (fixture) {
      await fixture.dispose()
      fixture = null
    }
  })

  it('事件风暴（丢 context.update）后 usage 实例值收敛 get_session_stats 快照', { timeout: 420_000 }, async () => {
    const fx = await spawnPiFixture()
    fixture = fx

    const fetchStats = async (): Promise<StatsShape> => {
      const resp = await fx.sendCommand('get_session_stats')
      return (resp.data ?? {}) as StatsShape
    }
    const usageState = new ReplicatedState(createUsageStateConfig(fetchStats))
    usageState.refetch()
    await waitUntil('seed usage snapshot', () => usageState.get() !== undefined)

    // 一轮真实对话（pi 侧 contextUsage 从 null/旧值更新为真实占用）——
    // 模拟丢 context.update：不喂任何事件失效给实例（生产中 applyContextUpdate 会 markDirty，
    // 此处刻意丢弃，制造「事件丢失 → 实例快照失真」窗口）。
    await fx.sendCommand('prompt', { message: 'Reply with exactly: w8-usage-round-1' })
    await waitUntil(
      'round-1 agent_end',
      () => fx.collectEvents((e) => e.type === 'agent_end').length > 0,
      TURN_TIMEOUT_MS,
    )

    // 事件风暴：批量 markDirty（模拟风暴期密集到达的 context 相关事件 / 重连批量失效）
    for (let i = 0; i < EVENT_STORM_SIZE; i++) usageState.markDirty()
    await waitUntil('usage converge after storm', () => !usageState.isDirty())

    // 终态等价断言：实例快照逐字段 == 此刻权威 get_session_stats.contextUsage 投影
    const stats = await fetchStats()
    const cu = stats.contextUsage as ContextUsageShape
    expect(typeof cu.tokens).toBe('number') // agent_end 后必有 assistant usage（环境前置断言）
    const authoritativeUsagePercent = Math.min(Math.round(cu.percent ?? 0), 100)
    expect(usageState.get()).toEqual({
      inputTokens: cu.tokens,
      contextLimit: cu.contextWindow,
      usagePercent: authoritativeUsagePercent,
    })
    usageState.dispose()
  })

  // [2026-09 测试舰队审查 r2-26] it6「RPC 频率采样」已删：测量型用例（唯一产出是
  // console.log 采样数字，断言 near-constant），P0.5② 一次性验收输入——采样应由
  // bench 脚本承担而非回归套件，且每跑一次消耗 2 轮真实 LLM。
})
