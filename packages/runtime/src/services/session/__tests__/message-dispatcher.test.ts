/**
 * MessageDispatcher × 投递所有权内核（u2 内核化）验收测试。
 *
 * 迁移自「sendPrompt 骨架 + SkillInjector 挂载」测试族（原断言锁定已退役行为：注入器在
 * dispatcher 内部调用、busy 预检拒绝、prompt 调用参数形态）。u2 迁移后的口径：
 * - **职责划分**：dispatcher = 入口 touch + BeforeSend hook（提交前唯一 veto）+ 内核提交；
 *   出站交接（ensureActive → skill 注入 → prompt → 三副作用置位）在 delivery registry 适配层。
 * - **断言强度保持**：hook 审核原文 / hook 改写的 transform 语义 / blocked 面 / 注入恰好一次
 *   且先于 prompt / notices 逐条发布（clientUuid 从裸标记提取）/ 投递失败不发 notice
 *   ——逐条迁移，非删除。
 * - **退役面显式断言**（原测试的否定面转正）：busy 预检与 send.rejected 退役后，busy 维度
 *   不再产生拒绝广播、不再拦提交（排队取代拒绝，D5），消息由内核在册持有。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/message-dispatcher.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher } from '../message-dispatcher.js'
import {
  createSessionDeliveryRegistry,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
} from '../session-delivery-registry.js'
import { applySessionOccupancyTransition, OCCUPANCY_SETTLE_WINDOW_MS, occupancySettleWindow } from '../event-interpreter.js'
import type { IDispatcherSessionOps } from '../session-internal.js'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine, IProcessManager } from '../../ports/pi-engine.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { SkillInjectionResult, SkillInjector, SkillNotice } from '../skill-injector.js'

const CLIENT_UUID = 'u-12345678-1234-1234-1234-1234567890ab'

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test/workspace',
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
    occupancy: { turn: 'idle', compacting: false, bash: false },
    ...overrides,
  }
}

interface HarnessOptions {
  hookModifiedContent?: string
  hookBlocked?: boolean
  promptError?: Error
  sessionByClient?: Partial<IManagedSessionView>
  /** [CP6 移植] deps.getSession 的返回视图（收口窗回调重查/置位断言用；缺省同 session）。 */
  sessionView?: unknown
}

function makeHarness(opts: HarnessOptions = {}) {
  const calls: string[] = []
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => {
      calls.push('prompt')
      if (opts.promptError) throw opts.promptError
      return {}
    }),
    // 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient 到达本 fake
    touchActivity: vi.fn(),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
  }
  const session = makeMockSession(opts.sessionByClient ?? {})
  const svc = {
    ensureActive: vi.fn(async () => {
      calls.push('ensureActive')
      return client as unknown as IPiEngine
    }),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(() => session),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  } as unknown as IDispatcherSessionOps
  const pm = { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager
  const workspaceService = {
    record: vi.fn(() => {
      calls.push('record')
    }),
  } as unknown as WorkspaceService
  const published: ServerMessage[] = []
  const messageBus = {
    publish: vi.fn((_sid: string, msg: ServerMessage) => published.push(msg)),
  } as unknown as IMessageBus
  const injectState = { notices: [] as SkillNotice[] }
  const injectMock = vi.fn(async (_client: IPiEngine, text: string): Promise<SkillInjectionResult> => {
    calls.push('inject')
    return { text: `INJECTED::${text}`, notices: injectState.notices }
  })

  // 投递内核装配（出站交接点 = registry 适配层；活动注册表槽供 dispatcher 取用）
  let sessionForGet: unknown = opts.sessionView !== undefined ? opts.sessionView : session
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === 's1' ? (sessionForGet as IManagedSessionView) : undefined),
    ensureActive: svc.ensureActive as (sid: string) => Promise<IPiEngine>,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: (cwd) => workspaceService.record(cwd),
    getMessageBus: () => messageBus,
  }
  const registry = createSessionDeliveryRegistry(deps, { inject: injectMock } as unknown as SkillInjector)
  const hookMock = vi.fn(async () => {
    calls.push('hook')
    if (opts.hookBlocked) return { blocked: true, reason: '被插件拦截' }
    return opts.hookModifiedContent !== undefined
      ? { blocked: false, modifiedContent: opts.hookModifiedContent }
      : { blocked: false }
  })
  const dispatcher = new MessageDispatcher(svc, pm, workspaceService, messageBus)
  dispatcher.setSendMessageHook(hookMock)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  const promptArgs = (): unknown[] => (client.prompt.mock.calls[0] ?? []) as unknown[]
  return {
    dispatcher, registry, session, client, published, calls, injectMock, hookMock, injectState, flush, promptArgs,
    /** [CP6 移植] 模拟回收/重建竞态：fire 时重查 getSession 已查不到该 session。 */
    setGetSessionResult: (v: unknown): void => { sessionForGet = v },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  resetActiveDeliveryRegistryForTest()
})
afterEach(() => {
  vi.useRealTimers()
  resetActiveDeliveryRegistryForTest()
})

const notice = (reason: SkillNotice['reason'], skills: string[]): SkillNotice => ({ reason, skills })

describe('MessageDispatcher × 内核出站交接（u2）', () => {
  it('sendMessage：hook 审核原文 → 内核通道 ensureActive → inject → prompt（顺序与迁移前一致）', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '原始 <taiji-skill name="a"/> 文本')
    expect(result).toEqual({ blocked: false })
    await h.flush()
    expect(h.injectMock).toHaveBeenCalledTimes(1)
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    // hook 审核原文 → 注入器处理出站文本（含内核裸标记）→ prompt → 三副作用置位
    expect(h.calls).toEqual(['hook', 'ensureActive', 'inject', 'prompt', 'record'])
    expect((h.promptArgs()[0] as string)).toContain('INJECTED::原始 <taiji-skill name="a"/> 文本')
  })

  it('sendMessage：hook 改写文本时注入器收到改写后文本（hook 之后语义保持）', async () => {
    const h = makeHarness({ hookModifiedContent: '改写后 <taiji-skill name="a"/>' })
    await h.dispatcher.sendMessage('s1', '用户原文')
    await h.flush()
    expect(h.injectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('改写后 <taiji-skill name="a"/>'),
      '/test/workspace',
    )
  })

  it('sendMessage：hook 拦截 → blocked + 零投递（提交前唯一 veto 面）', async () => {
    const h = makeHarness({ hookBlocked: true })
    const result = await h.dispatcher.sendMessage('s1', '被拦的消息')
    await h.flush()
    expect(result.blocked).toBe(true)
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(h.injectMock).not.toHaveBeenCalled()
    expect(h.published.some((m) => m.type === 'message.error')).toBe(true)
  })

  it('notices 在投递受理后逐条发布，clientUuid 取裸标记（u- 前缀剥离形态）', async () => {
    const h = makeHarness()
    h.injectState.notices = [notice('budget_exceeded', ['skill-a']), notice('skill_missing', ['ghost'])]
    await h.dispatcher.sendMessage('s1', '正文', undefined, CLIENT_UUID)
    await h.flush()
    const skillNotices = h.published.filter((m) => m.type === 'session.skillNotice')
    expect(skillNotices).toHaveLength(2)
    // 内核出站标记 id = clientUuid 的裸 uuid 形态（u3b 回执契约）；notice 提取后归一为
    // renderer 气泡 id 形态（`u-<uuid>`，与迁移前 payload 逐字一致）
    expect(skillNotices[0]?.payload).toEqual({
      sessionId: 's1',
      clientUuid: CLIENT_UUID,
      reason: 'budget_exceeded',
      skills: ['skill-a'],
    })
    expect(skillNotices[1]?.payload).toEqual({
      sessionId: 's1',
      clientUuid: CLIENT_UUID,
      reason: 'skill_missing',
      skills: ['ghost'],
    })
  })

  it('未传 clientUuid（老协议调用方，内核生成条目 id）：notice payload 缺省该字段（无气泡可锚定）', async () => {
    const h = makeHarness()
    h.injectState.notices = [notice('context_window_unavailable', ['skill-a'])]
    await h.dispatcher.sendMessage('s1', '纯文本，非 segments 序列化')
    await h.flush()
    const msg = h.published.find((m) => m.type === 'session.skillNotice')
    // 迁移前口径保持：clientUuid 只在调用方传入 renderer 气泡 id 时提取（内部生成 id 无气泡）
    expect(msg?.payload).toEqual({ sessionId: 's1', reason: 'context_window_unavailable', skills: ['skill-a'] })
    expect('clientUuid' in (msg?.payload ?? {})).toBe(false)
  })

  it('投递失败（prompt 抛错）→ message.error 广播 + 不发 skillNotice（提示不空投）', async () => {
    const h = makeHarness({ promptError: new Error('rpc dead') })
    h.injectState.notices = [notice('skill_missing', ['ghost'])]
    await h.dispatcher.sendMessage('s1', '带 skill 的消息')
    await h.flush()
    expect(h.published.filter((m) => m.type === 'session.skillNotice')).toHaveLength(0)
    expect(h.published.some((m) => m.type === 'message.error')).toBe(true)
  })

  it('无 notices 时不发布任何 skillNotice', async () => {
    const h = makeHarness()
    await h.dispatcher.sendMessage('s1', '普通消息')
    await h.flush()
    expect(h.published.filter((m) => m.type === 'session.skillNotice')).toHaveLength(0)
    // 投递受理会写 occupancy 'dispatching'（三副作用之一，D7 保留）——非 notice/error 帧
    expect(h.published.filter((m) => m.type !== 'session.occupancy')).toHaveLength(0)
  })

  it('steerMessage / followUpMessage：同走内核提交（注入恰好一次；intent 分型保持）', async () => {
    const steerHarness = makeHarness()
    await steerHarness.dispatcher.steerMessage('s1', 'steer 文本')
    await steerHarness.flush()
    expect(steerHarness.injectMock).toHaveBeenCalledTimes(1)
    expect(steerHarness.calls).toEqual(['ensureActive', 'inject', 'prompt', 'record'])
    expect(steerHarness.promptArgs()[2]).toBe('steer')

    const followHarness = makeHarness()
    await followHarness.dispatcher.followUpMessage('s1', 'followUp 文本')
    await followHarness.flush()
    // intent 'after-run' → pi streamingBehavior 'followUp'（F3 语义保持）
    expect(followHarness.promptArgs()[2]).toBe('followUp')
  })
})

/**
 * busy 维度退役（u2 显式断言）：预检与 send.rejected 的**否定面**——busy 各维度不再拒绝、
 * 不再广播 send.rejected、prompt 不立即调用（内核持有等时机）。原「拒绝转 send.rejected」测试族
 * 的断言强度平移到「排队承接」面（消息不丢 = 内核条目在册）。
 */
describe('MessageDispatcher busy 维度退役（排队取代拒绝，D5）', () => {
  it('turn=generating：零 send.rejected + 内核按 steer 车道即时投递（turn 边界注入，不等拒绝）', async () => {
    const h = makeHarness({
      sessionByClient: {
        occupancy: { turn: 'generating', compacting: false, bash: false },
        isGenerating: true,
      },
    })
    const result = await h.dispatcher.sendMessage('s1', '活跃 run 期消息')
    await h.flush()
    expect(result).toEqual({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    // 迁移前该形态被预检拒绝（send.rejected → renderer defer 队列）；现由内核按 lane=steer
    // 直接经 pi streamingBehavior 入队（D1/D3：单一所有者，消息不丢且不失序）
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.promptArgs()[2]).toBe('steer')
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('in-flight')
  })

  it('turn=settling（pi post-run 窗口）：零 send.rejected + 持有（settling 非投递窗口，检查点 4）', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'settling', compacting: false, bash: false } },
    })
    const result = await h.dispatcher.sendMessage('s1', 'settling 窗口消息')
    await h.flush()
    expect(result).toEqual({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    expect(h.client.prompt).not.toHaveBeenCalled()
    expect(h.registry.entries('s1')?.active).toHaveLength(1) // 内核在册（消息不丢）
  })

  it('compacting 命中：零拒绝广播 + 持有；compaction 结束后自动投递', async () => {
    const h = makeHarness({
      sessionByClient: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } },
    })
    const result = await h.dispatcher.sendMessage('s1', '压缩中消息')
    await h.flush()
    expect(result).toEqual({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    expect(h.client.prompt).not.toHaveBeenCalled()

    applySessionOccupancyTransition(h.session, null, 'compacting-end')
    await vi.advanceTimersByTimeAsync(600)
    await h.flush()
    expect(h.client.prompt).toHaveBeenCalledTimes(1) // 压缩结束 → 自动投递
  })

  it('bash 命中：零拒绝广播 + 持有（bash 与 prompt 互斥由内核持有承接）', async () => {
    const h = makeHarness({
      sessionByClient: { isBashRunning: true, occupancy: { turn: 'idle', compacting: false, bash: true } },
    })
    const result = await h.dispatcher.sendMessage('s1', 'bash 期间消息')
    await h.flush()
    expect(result).toEqual({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    expect(h.client.prompt).not.toHaveBeenCalled()
  })

  it('occupancy 全 idle：直发成功（对照组——空闲路径不受影响）', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '空闲期消息')
    await h.flush()
    expect(result).toEqual({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
  })

  it('入口同步 touch 保持（hook 执行窗口内不显空闲，防 idle 回收误伤）', async () => {
    const h = makeHarness()
    const touch = h.client.touchActivity as unknown as { mock: { calls: unknown[] } }
    await h.dispatcher.sendMessage('s1', '消息')
    expect(touch.mock.calls.length).toBeGreaterThanOrEqual(1)
  })
})

/**
 * CP6：命令-only prompt 的 occupancy 收口（scheduler-trigger-inversion §11 CP6）。
 *
 * 前提已实测确认：pi 对 `/` 开头文本先执行命令 handler、纯命令不产 turn 事件；dispatcher
 * 已在 prompt 前置 dispatching ⇒ 无收口则永远卡住。断言口径泛化（不限于 scheduler 场景）:
 * 收口对**所有** prompt 生效。
 */
describe('CP6 命令-only prompt occupancy 收口（短窗 + 幂等门）', () => {
  type OccTurn = 'idle' | 'dispatching' | 'generating' | 'settling'
  interface FakeView {
    [key: string]: unknown
    id?: string
    cwd?: string
    occupancy: { turn: OccTurn; compacting: boolean; bash: boolean }
    isGenerating?: boolean
  }
  const makeView = (): FakeView => ({ id: 's1', occupancy: { turn: 'idle', compacting: false, bash: false } })

  beforeEach(() => {
    vi.useFakeTimers()
    occupancySettleWindow.resetForTest()
  })
  afterEach(() => {
    occupancySettleWindow.resetForTest()
    vi.useRealTimers()
  })

  it('prompt resolve 后无 turn 事件：2s 内回落 idle（命令-only 场景，维度与 scheduler 无关）', async () => {
    const view: FakeView = { id: 's1', cwd: '/w/s1', occupancy: { turn: 'idle', compacting: false, bash: false } }
    const h = makeHarness({ sessionByClient: view, sessionView: view })
    const result = await h.dispatcher.sendMessage('s1', '/any-command')
    expect(result).toEqual({ blocked: false })
    await h.flush() // 内核投递是异步腿：prompt resolve + 武装收口窗在此完成
    // prompt resolve 后仍在 dispatching（窗口未到期）
    expect(view.occupancy.turn).toBe('dispatching')
    // 短窗到期 → 回落 idle（幂等门允许：turn === dispatching）
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SETTLE_WINDOW_MS)
    expect(view.occupancy.turn).toBe('idle')
    // 前端可观察到 idle 帧（渲染按钮不复残留 stop）
    const occFrames = h.published.filter((m) => m.type === 'session.occupancy')
    expect(occFrames[occFrames.length - 1]?.payload).toEqual({
      sessionId: 's1', turn: 'idle', compacting: false, bash: false,
    })
  })

  it('短窗未到期（< 2s）：不提前回落（控制面量级，不给任务加预算）', async () => {
    const view = makeView()
    const h = makeHarness({ sessionByClient: view, sessionView: view })
    await h.dispatcher.sendMessage('s1', '/slow-command')
    await h.flush()
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SETTLE_WINDOW_MS - 1)
    expect(view.occupancy.turn).toBe('dispatching')
  })

  it('期间有 turn 事件（agent_start/turn_start 到达即 cancel）：窗口取消，状态不被覆盖', async () => {
    const view = makeView()
    const h = makeHarness({ sessionByClient: view, sessionView: view })
    await h.dispatcher.sendMessage('s1', '真实 turn 的 prompt')
    await h.flush()
    expect(view.occupancy.turn).toBe('dispatching')
    // interpreter 的 turn-start / agent_start 挂点即调此取消（与生产同一入口）
    occupancySettleWindow.cancel('s1')
    // turn 推进为 generating（真实状态）
    view.occupancy = { turn: 'generating', compacting: false, bash: false }
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SETTLE_WINDOW_MS * 3)
    // 窗口已取消 → 不得回落 idle（不覆盖真实状态）
    expect(view.occupancy.turn).toBe('generating')
  })

  it('幂等门（调度竞态兜底）：即使窗口未被取消，回调见 turn !== dispatching 也不覆盖', async () => {
    const view = makeView()
    const h = makeHarness({ sessionByClient: view, sessionView: view })
    await h.dispatcher.sendMessage('s1', 'turn already generating')
    await h.flush()
    // 模拟 "turn 事件已写状态但取消失败" 的竞态：只改状态不取消
    view.occupancy = { turn: 'settling', compacting: false, bash: false }
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SETTLE_WINDOW_MS)
    expect(view.occupancy.turn).toBe('settling')
    // 也未广播伪造 idle 帧
    expect(h.published.filter((m) => m.type === 'session.occupancy')
      .some((m) => (m.payload as { turn?: string }).turn === 'idle')).toBe(false)
  })

  it('session 已不在（回收/重建竞态）：回调静默 no-op，不报错', async () => {
    const view = makeView()
    const h = makeHarness({ sessionByClient: view, sessionView: view })
    await h.dispatcher.sendMessage('s1', '/cmd')
    await h.flush()
    expect(view.occupancy.turn).toBe('dispatching')
    // 投递后 session 被回收（getSession 已查不到）→ 窗口到期时回调早退，原视图不被回写
    h.setGetSessionResult(undefined)
    await vi.advanceTimersByTimeAsync(OCCUPANCY_SETTLE_WINDOW_MS)
    expect(view.occupancy.turn).toBe('dispatching')
  })
})
