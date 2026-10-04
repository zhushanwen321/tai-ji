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
 * 本文件是「busy 退役断言」与 dispatcher 投递错误路径的唯一归宿（原 message-dispatcher-precheck.test.ts
 * 的独有断言已收编：prompt 失败 isGenerating 复位并入投递失败用例、workspace.record 降级单列；
 * send-rejection 侧同构用例已删除，仅存 clientUuid 透传用例）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/message-dispatcher.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher } from '../message-dispatcher.js'
import {
  createSessionDeliveryRegistry,
  type SessionDeliveryDeps,
} from '../session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../event-interpreter.js'
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
  /** client.prompt 的返回值（disposition 接线用例注入；缺省 {} = 无 disposition 字段）。 */
  promptResult?: unknown
  /** get_commands 清单（命令识别用例注入；缺省 [] = 空清单）。 */
  commands?: Array<{ name: string; source: string }>
  sessionByClient?: Partial<IManagedSessionView>
  /** [CP6 移植] deps.getSession 的返回视图（收口窗回调重查/置位断言用；缺省同 session）。 */
  sessionView?: unknown
  /** workspace.record 同步抛错（best-effort 副作用的降级路径用例注入）。 */
  recordWorkspaceError?: Error
}

function makeHarness(opts: HarnessOptions = {}) {
  const calls: string[] = []
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => {
      calls.push('prompt')
      if (opts.promptError) throw opts.promptError
      return opts.promptResult ?? {}
    }),
    // 入口同步 touch（idle-pi-reclamation D6-1）经 pm.getClient 到达本 fake
    touchActivity: vi.fn(),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    getCommands: vi.fn(async () => opts.commands ?? []),
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
      if (opts.recordWorkspaceError) throw opts.recordWorkspaceError
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
  dispatcher.setDeliveryRegistry(registry)
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
})
afterEach(() => {
  vi.useRealTimers()
})

const notice = (reason: SkillNotice['reason'], skills: string[]): SkillNotice => ({ reason, skills })

describe('MessageDispatcher × 内核出站交接（u2）', () => {
  it('sendMessage：hook 审核原文 → 内核通道 ensureActive → inject → prompt（顺序与迁移前一致）', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '原始 <taiji-skill name="a"/> 文本')
    // 受理回执透出（must-fix ①：delivery.submit reply 经组合点消费，不经第二个提交通道）
    expect(result.blocked).toBe(false)
    expect(result.receipt).toMatchObject({ clientUuid: expect.any(String), lane: 'direct', state: 'queued' })
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

  it('并发提交 per-session 串行：hook 完成序不可重排内核提交序（到达序 = 提交序，复审 R2）', async () => {
    const h = makeHarness()
    const order: string[] = []
    const gates: Array<() => void> = []
    h.dispatcher.setSendMessageHook(async (_sid: string, content: string) => {
      order.push(`hook:${content}`)
      await new Promise<void>((resolve) => gates.push(resolve))
      order.push(`hook-done:${content}`)
      return { blocked: false }
    })

    const p1 = h.dispatcher.sendMessage('s1', 'msg-1')
    const p2 = h.dispatcher.sendMessage('s1', 'msg-2')
    await h.flush()

    // 第二条在前驱 hook 完成前不得进入受理段（串行链生效——不串行时两条 hook 并发启动）
    expect(order).toEqual(['hook:msg-1'])
    gates[0]?.()
    await h.flush()
    expect(order).toEqual(['hook:msg-1', 'hook-done:msg-1', 'hook:msg-2'])
    gates[1]?.()
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.blocked).toBe(false)
    expect(r2.blocked).toBe(false)

    // 用户可见断言：内核按到达序投递（prompt 序 = msg-1 先于 msg-2）
    const prompts = h.client.prompt.mock.calls.map((c) => String(c[0]))
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('msg-1')
    expect(prompts[1]).toContain('msg-2')
  })

  it('前驱 hook 否决不毒化链：blocked 正常返回，后继提交照常受理', async () => {
    const h = makeHarness()
    h.dispatcher.setSendMessageHook(async (_sid: string, content: string) =>
      content === 'msg-1' ? { blocked: true, reason: '插件拦截' } : { blocked: false },
    )

    const [r1, r2] = await Promise.all([
      h.dispatcher.sendMessage('s1', 'msg-1'),
      h.dispatcher.sendMessage('s1', 'msg-2'),
    ])
    await h.flush()

    expect(r1.blocked).toBe(true)
    expect(r2.blocked).toBe(false)
    expect(r2.receipt).toMatchObject({ lane: 'direct' })
    // 唯一 msg-2 进入内核投递（msg-1 被否决零投递）
    const prompts = h.client.prompt.mock.calls.map((c) => String(c[0]))
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('msg-2')
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

  it('投递失败（prompt 抛错）→ message.error 广播 + isGenerating 复位 + 不发 skillNotice（提示不空投）', async () => {
    const h = makeHarness({ promptError: new Error('rpc dead') })
    h.injectState.notices = [notice('skill_missing', ['ghost'])]
    await h.dispatcher.sendMessage('s1', '带 skill 的消息')
    await h.flush()
    expect(h.published.filter((m) => m.type === 'session.skillNotice')).toHaveLength(0)
    expect(h.published.some((m) => m.type === 'message.error')).toBe(true)
    // busy 态复位（原 precheck 用例收编）：turn 没跑起来，不得滞留 dispatching/isGenerating
    expect(h.session.isGenerating).toBe(false)
    expect(h.session.occupancy?.turn).toBe('idle')
  })

  it('workspace.record 抛同步异常 → 注册表 best-effort catch（warn 留痕）+ 投递不受阻（原 precheck W6 收编）', async () => {
    const h = makeHarness({ recordWorkspaceError: new Error('cache boom') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await h.dispatcher.sendMessage('s1', 'hello')
      await h.flush()
      // 不向上抛，prompt 正常受理（record 失败不阻断发消息主流程）
      expect(result.blocked).toBe(false)
      expect(h.client.prompt).toHaveBeenCalledTimes(1)
      // prompt 成功置位不回退（record 副作用失败不影响状态机）
      expect(h.session.isGenerating).toBe(true)
      // 有诊断信号（非 fail-silent）
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('无 notices 时不发布任何 skillNotice', async () => {
    const h = makeHarness()
    await h.dispatcher.sendMessage('s1', '普通消息')
    await h.flush()
    expect(h.published.filter((m) => m.type === 'session.skillNotice')).toHaveLength(0)
    // 投递受理会写 occupancy 'dispatching'（三副作用之一，D7 保留）——非 notice/error 帧
    expect(h.published.filter((m) => m.type !== 'session.occupancy')).toHaveLength(0)
  })

  // [MF-1-8 退役] steerMessage / followUpMessage 转发腿测试已删除：消费方经 delivery.submit
  // 统一提交（u3b 内核化保持），协议侧 message.steer / message.follow_up 条目同批退役。
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
    expect(result).toMatchObject({ blocked: false })
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
    expect(result).toMatchObject({ blocked: false })
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
    expect(result).toMatchObject({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    expect(h.client.prompt).not.toHaveBeenCalled()

    // [MF-1-9] 持有等待已事件化：view 维度复位后显式触发边沿（生产 = dispatcher
    // compacting-end 转移后经 notifyHoldRelease 驱动）
    applySessionOccupancyTransition(h.session, null, 'compacting-end')
    h.registry.notifyHoldRelease('s1')
    await vi.advanceTimersByTimeAsync(1)
    await h.flush()
    expect(h.client.prompt).toHaveBeenCalledTimes(1) // 压缩结束 → 自动投递
  })

  it('bash 命中：零拒绝广播 + 持有（bash 与 prompt 互斥由内核持有承接）', async () => {

    const h = makeHarness({
      sessionByClient: { isBashRunning: true, occupancy: { turn: 'idle', compacting: false, bash: true } },
    })
    const result = await h.dispatcher.sendMessage('s1', 'bash 期间消息')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    expect(h.client.prompt).not.toHaveBeenCalled()

  })

  it('occupancy 全 idle：直发成功（对照组——空闲路径不受影响）', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '空闲期消息')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
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
 * [pi1-disposition-chat-flow D1/D3] 原 CP6 短窗测试组随窗口机制退役删除；occupancy 的
 * 回落现由 pi 权威事实驱动（handled 响应）+ sweepInFlight 收尾承接。本组锚定投递链路上的
 * handled 终局行为（终局 / 通知 / occupancy 回落幂等门 / started 不驱动界面）。
 */
describe('handled 终局与 occupancy 事实驱动（D1/D3，CP6 退役后）', () => {
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
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('handled 响应（命令接管）：条目 delivered 终局 + session.deliveryHandled 通知 + dispatching→idle 回落', async () => {
    const view = makeView()
    const h = makeHarness({ sessionView: view, promptResult: { disposition: 'handled' } })
    await h.dispatcher.sendMessage('s1', '/any-command')
    await h.flush()
    // occupancy 事实驱动回落（D3②：命令不会跟回合事件，pi 权威回答取代时间窗）
    expect(view.occupancy.turn).toBe('idle')
    // D1③ 终局通知（一次性事件）一对一发出
    const handled = h.published.filter((m) => m.type === 'session.deliveryHandled')
    expect(handled.length).toBe(1)
    expect(handled[0]!.payload).toMatchObject({ sessionId: 's1', clientUuid: expect.any(String) })
    // D1② tombstone 终局（delivered——对账器不重投，resync 判重防线继承）
    const entries = h.registry.entries('s1')
    expect(entries?.tombstones.some((t) => t.state === 'delivered')).toBe(true)
    expect(entries?.active.some((e) => e.state === 'in-flight' || e.state === 'queued')).toBe(false)
  })

  it('幂等门：handled 回落不覆盖 generating（turn 事件已推进时不覆盖真实状态）', async () => {
    const view: FakeView = { id: 's1', cwd: '/w/s1', occupancy: { turn: 'generating', compacting: false, bash: false } }
    const h = makeHarness({ sessionView: view, promptResult: { disposition: 'handled' } })
    await h.dispatcher.sendMessage('s1', '/todos')
    await h.flush()
    // 回落仅限 dispatching（不覆盖 generating/settling；真误判由 turn 事件自愈）
    expect(view.occupancy.turn).toBe('generating')
    // 终局与通知照常（幂等门只约束 occupancy，不约束终局链路）
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(1)
  })

  it('started 响应（普通消息）：无终局通知、occupancy 保持 dispatching 等 turn-start 驱动（D4）', async () => {
    const view = makeView()
    const h = makeHarness({ sessionView: view, promptResult: { disposition: 'started' } })
    await h.dispatcher.sendMessage('s1', '普通消息')
    await h.flush()
    // queued/started 不驱动界面（D4）：无回落、无通知，occupancy 由 turn-start 事件推进
    expect(view.occupancy.turn).toBe('dispatching')
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(0)
  })

  it('无 disposition 字段（pi < 1.0 / mock）：全链路与升级前一致（无回落、无通知）', async () => {
    const view = makeView()
    const h = makeHarness({ sessionView: view })
    await h.dispatcher.sendMessage('s1', 'legacy prompt')
    await h.flush()
    expect(view.occupancy.turn).toBe('dispatching')
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(0)
  })
})
