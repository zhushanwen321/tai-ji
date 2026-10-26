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
 * - **退役路径显式断言**（原测试的否定用例转正）：busy 预检与 send.rejected 退役后，busy 维度
 *   不再产生拒绝广播、不再拦提交（排队取代拒绝，D5），消息由内核在册持有。
 *
 * 本文件是「busy 退役断言」与 dispatcher 投递错误路径的唯一归宿（原 message-dispatcher-precheck.test.ts
 * 的独有断言已收编：prompt 失败 isGenerating 复位并入投递失败用例、workspace.record 降级单列；
 * send-rejection 侧同构用例已删除，仅存 clientUuid 透传用例）。
 *
 * 来源（分节注释见内）：
 * - message-dispatcher（原主文件：内核出站交接 / busy 退役 / handled 终局 / abort 三分型）
 * - revoke-orchestrator（撤回七步编排 ①-⑧）
 * - revoke-probe（U7 探针：A6 信令不污染 + A9 workflow 拦截）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/message-dispatcher.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TAIJI_NAV_COMMAND } from '@taiji/shared'
import { MessageDispatcher } from '../message-dispatcher.js'
import { RevokeOrchestrator } from '../revoke-orchestrator.js'
import {
  createSessionDeliveryRegistry,
  type SessionDeliveryDeps,
} from '../session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../event-interpreter.js'
import type { IDispatcherSessionOps } from '../session-internal.js'
import { isGeneratingTurn } from '../types.js'
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
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false },
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
  /** [CP6 移植] deps.getSession 的返回视图（收尾窗回调重查/置位断言用；缺省同 session）。 */
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
    abort: vi.fn(async () => {}),
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
    clearSessionOutcome: vi.fn(),
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
    dispatcher, registry, session, client, published, calls, injectMock, hookMock, injectState, flush, promptArgs, svc,
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
    // 唯一 msg-2 进入内核投递（msg-1 不采用决零投递）
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

  it('投递失败（prompt 抛错）→ message.error 广播 + isGenerating 复位 + 不发 skillNotice（提示不丢弃）', async () => {
    const h = makeHarness({ promptError: new Error('rpc dead') })
    h.injectState.notices = [notice('skill_missing', ['ghost'])]
    await h.dispatcher.sendMessage('s1', '带 skill 的消息')
    await h.flush()
    expect(h.published.filter((m) => m.type === 'session.skillNotice')).toHaveLength(0)
    expect(h.published.some((m) => m.type === 'message.error')).toBe(true)
    // busy 态复位（原 precheck 用例收编）：turn 没跑起来，不得滞留 dispatching（[D1] 读口迁移：isGenerating ≡ isGeneratingTurn(turn)）
    expect(isGeneratingTurn(h.session.occupancy?.turn)).toBe(false)
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
      expect(isGeneratingTurn(h.session.occupancy?.turn)).toBe(true)
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

  // [MF-1-8 退役] steerMessage / followUpMessage 转发路径测试已删除：消费方经 delivery.submit
  // 统一提交（u3b 内核化保持），协议侧 message.steer / message.follow_up 条目同批退役。
})

/**
 * busy 维度退役（u2 显式断言）：预检与 send.rejected 的**否定用例**——busy 各维度不再拒绝、
 * 不再广播 send.rejected、prompt 不立即调用（内核持有等时机）。原「拒绝转 send.rejected」测试族
 * 的断言强度平移到「排队承接」面（消息不丢 = 内核条目在册）。
 */
describe('MessageDispatcher busy 维度退役（排队取代拒绝，D5）', () => {
  it('turn=generating：零 send.rejected + 内核按 steer 投递路径即时投递（turn 边界注入，不等拒绝）', async () => {

    const h = makeHarness({
      sessionByClient: {
        occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false },
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

  it('turn=settling（pi post-run 窗口）：零 send.rejected + 受理即出站（v3 settling 持有退役）', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'settling', compacting: false, bash: false, handingOff: false } },
    })
    const result = await h.dispatcher.sendMessage('s1', 'settling 窗口消息')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)

    // v3 受理即出站：settling 非 hold 维度（唯一提交侧等待 = compaction）——pi post-run
    // 窗口提交经 prompt(streamingBehavior) 直接入 pi 队列（忙时入队不拒），消息不丢
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('in-flight')
  })

  it('compacting 命中：零拒绝广播 + 持有；compaction 结束后自动投递', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'idle', compacting: true, bash: false, handingOff: false } },

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

  it('bash 命中：零拒绝广播 + 受理即出站（v3 bash 持有退役——pi 队列忙时入队不拒）', async () => {

    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'idle', compacting: false, bash: true, handingOff: false } },
    })
    const result = await h.dispatcher.sendMessage('s1', 'bash 期间消息')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
    // v3 受理即出站：bash 运行中提交不再排队——prompt(steer) 直接入 pi 队列，轮边界注入
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.promptArgs()[2]).toBe('steer')

  })

  it('occupancy 全 idle：直发成功（对照组——空闲路径不受影响）', async () => {
    const h = makeHarness()
    const result = await h.dispatcher.sendMessage('s1', '空闲期消息')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    expect(h.published.filter((m) => m.type === 'send.rejected')).toHaveLength(0)
  })
})

/**
 * [pi1-disposition-chat-flow D1/D3] 原 CP6 短窗测试组随窗口机制退役删除；occupancy 的
 * 回落现由 pi 权威事实驱动（handled 响应即回落；ADR-0122 终局事件化）。本组锚定投递
 * 链路上的 handled 终局行为（终局 / 通知 / occupancy 回落幂等门 / started 不驱动界面）。
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

/**
 * abort 入口三分型（chat-flow-consistency design-turn-statemachine 缺陷 2 + 缺陷 10 同批）。
 * 入口快照 turnAtEntry 分型：型 1（dispatching/generating，有回合可中止）= 现状路径
 * （idle 转移 + stopped 终态 + complete{aborted} 广播）；型 2（压缩取消）与型 3（settling/
 * 已空闲，无回合可中止）= 不写终态、不广播、不动 turn（'idle' 调用只允许出现在型 1 内——
 * 缺陷 10：原实现在判型前无条件复位 turn，settling+compacting 时把 settling 提前旁路）。
 */
describe('abort 入口三分型（chat-flow-consistency 缺陷 2/10）', () => {
  it('型 1（turn=generating）：idle 转移 + stopped 终态 + complete{aborted} 广播', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } },
    })
    await h.dispatcher.abort('s1')
    await h.flush()
    expect(h.session.occupancy?.turn).toBe('idle')
    expect(h.svc.persistSessionOutcome).toHaveBeenCalledWith('s1', 'stopped', 'User aborted')
    expect(h.published.some((m) => m.type === 'message.complete')).toBe(true)
  })

  it('型 3（turn=settling 收尾窗口）：不写终态、不广播 complete、occupancy 不动（settling 留给 agent_settled 收口）', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'settling', compacting: false, bash: false, handingOff: false } },
    })
    await h.dispatcher.abort('s1')
    await h.flush()
    // done 已写（agent_end 副作用），abort 覆盖即谎报「回合被中止」——不写终态
    expect(h.svc.persistSessionOutcome).not.toHaveBeenCalled()
    expect(h.published.some((m) => m.type === 'message.complete')).toBe(false)
    // occupancy 不动：settling 留给 agent_settled 的 idle 转移正常收口
    expect(h.session.occupancy?.turn).toBe('settling')
  })

  it('型 2（压缩取消：compacting 且无回合）：不写终态、不广播、turn 不复位（缺陷 10：idle 移入型 1）', async () => {
    const h = makeHarness({
      sessionByClient: { occupancy: { turn: 'settling', compacting: true, bash: false, handingOff: false } },
    })
    await h.dispatcher.abort('s1')
    await h.flush()
    expect(h.svc.persistSessionOutcome).not.toHaveBeenCalled()
    expect(h.published.some((m) => m.type === 'message.complete')).toBe(false)
    // turn 仍是 settling（压缩取消不旁路 turn 维；compacting 由 pi compaction_end{aborted} 复位）
    expect(h.session.occupancy?.turn).toBe('settling')
    expect(h.session.occupancy?.compacting).toBe(true)
  })

  it('型 3（已空闲）：第二次 abort 无多余 complete 广播（缺陷 5 边界 5b 口径）', async () => {
    const h = makeHarness()
    await h.dispatcher.abort('s1')
    await h.dispatcher.abort('s1')
    await h.flush()
    expect(h.published.filter((m) => m.type === 'message.complete')).toHaveLength(0)
    expect(h.svc.persistSessionOutcome).not.toHaveBeenCalled()
  })
})

// ════════════════ 来源: revoke-orchestrator.test.ts ════════════════

const SID = 's1'
const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const UUID_B = '11111111-2222-4333-8444-555555555555'

/** mock session view（occupancy 经转移原语写入——与 registry 测试同款 sentinel 视图）。 */
function makeView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: SID,
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false },
    ...overrides,
  }
}

function msgEntry(id: string, parentId: string | null, role: string, text: string): unknown {
  return { type: 'message', id, parentId, message: { role, content: text } }
}
function customEntry(id: string, parentId: string | null, customType: string, data: unknown): unknown {
  return { type: 'custom', id, parentId, customType, data }
}
function labelEntry(id: string, parentId: string | null, targetId: string): unknown {
  return { type: 'label', id, parentId, label: 'taiji:revoked', targetId }
}

/** 可变 pi 树（get_entries 的数据源；prompt 副作用 mutate 它模拟 navigateTree）。 */
interface MutableTree {
  entries: unknown[]
  leafId: string | null
}

/** 模拟 navigateTree 成功：label 锚挂 expectedParent、叶子切换（appendLabelChange 落盘语义）。 */
function applyRewind(tree: MutableTree, targetEntryId: string, expectedParentId: string | null): void {
  const label = labelEntry(`L-${targetEntryId}`, expectedParentId, targetEntryId) as { id: string }
  tree.entries = [...tree.entries, label]
  tree.leafId = label.id
}

interface HarnessOptions {
  view?: Partial<IManagedSessionView>
  hasRunningWorkflow?: (sessionId: string) => Promise<boolean>
  /**
   * prompt 到达副作用 = navigateTree 成功语义模拟（label 锚挂 expectedParent、叶子切换）。
   * 缺省 undefined = 树不变（模拟 command 抛错 / nav 无效果形态）。
   */
  rewind?: { target: string; parent: string | null }
}

function makeRevokeHarness(opts: HarnessOptions = {}) {
  const view = makeView(opts.view)
  const tree: MutableTree = { entries: [], leafId: null }
  const promptCalls: string[] = []
  let getEntriesGate: Promise<void> | null = null
  let releaseGate: (() => void) | null = null
  const evictSpy = vi.fn()
  const invalidateSpy = vi.fn()
  // 撤回信号广播路径经 deps.notifyEntryInvalidation 注入（[MF-1-7] 生产 = 组合根注册
  // pluginService.notifyEntryInvalidation 闭包，经 SessionService setter 流转）
  const signalSpy = vi.fn()

  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      if (opts.rewind) applyRewind(tree, opts.rewind.target, opts.rewind.parent)
      return {}
    }),
    getEntries: vi.fn(async () => {
      if (getEntriesGate) await getEntriesGate
      return { data: { entries: tree.entries, leafId: tree.leafId } }
    }),
    getCommands: vi.fn(async () => [{ name: TAIJI_NAV_COMMAND, source: 'taiji' }]),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
    touchActivity: vi.fn(),
  }
  const injector = {
    inject: vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text,
      notices: [] as SkillNotice[],
    })),
  } as unknown as SkillInjector
  const deliveryDeps: SessionDeliveryDeps = {
    getSession: (sid: string) => (sid === SID ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => ({ publish: () => undefined }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deliveryDeps, injector)

  // 真实 dispatcher 的 sendSystemCommand（⑧ 断言对象：不经 hook / 不经内核 / 直连 prompt）
  const dispatcher = new MessageDispatcher(
    {
      ensureActive: async () => client as unknown as IPiEngine,
      getSessionByClient: () => view,
      persistSessionOutcome: vi.fn(),
      getSession: (sid: string) => (sid === SID ? view : undefined),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    } as unknown as IDispatcherSessionOps,
    { getClient: (sid: string) => (sid === SID ? (client as unknown as IPiEngine) : undefined) } as unknown as IProcessManager,
    {} as unknown as WorkspaceService,
    undefined,
  )

  const orchestrator = new RevokeOrchestrator({
    getSession: (sid: string) => (sid === SID ? view : undefined),
    ensureActive: async () => client as unknown as IPiEngine,
    hasRunningWorkflow: opts.hasRunningWorkflow ?? (async () => false),
    evictHistoryRebuildCache: evictSpy,
    invalidateDerivedState: invalidateSpy,
    notifyEntryInvalidation: (sid: string) => signalSpy(sid),
    registry: () => registry,
    sendSystemCommand: (sid, commandLine, requireCommand) => dispatcher.sendSystemCommand(sid, commandLine, requireCommand),
  })

  const revoke = (targetId: string) => orchestrator.revokeMessage(SID, targetId)
  /** flush 异步链（编排各 await 段 + 内核投递交接）。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return {
    view, tree, registry, client, promptCalls, evictSpy, invalidateSpy, signalSpy, revoke, flush,
    setTree: (entries: unknown[], leafId: string | null) => {
      tree.entries = entries
      tree.leafId = leafId
    },
    /** 卡住下一次起的 get_entries（编排数据范围卡点构造）。 */
    blockGetEntries: () => {
      getEntriesGate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
    },
    releaseGetEntries: () => {
      releaseGate?.()
      getEntriesGate = null
      releaseGate = null
    },
  }
}

/** 标准树：e1(首条 user) → e2(user M，撤回目标) → e3(assistant)，leaf=e3。 */
function standardTree(): { entries: unknown[]; leafId: string } {
  return {
    entries: [
      msgEntry('e1', null, 'user', '你好\n<!--taiji:msg:00000000-0000-4000-8000-000000000001-->'),
      msgEntry('e2', 'e1', 'user', `帮我写个排序\n<!--taiji:msg:${UUID_A}-->`),
      msgEntry('e3', 'e2', 'assistant', '好的，这是排序实现……'),
    ],
    leafId: 'e3',
  }
}

describe('U4 撤回编排：happy path（⑧ 信令不污染 + ⑦ 前置）', () => {
  it('entryId 直用形态：revoked:true + transcript 原文（含裸标记 raw 不剥）+ prompt 只收命令串 + 无内核条目', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')

    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    // ⑧：prompt 只收命令串（TAIJI_NAV_COMMAND 拼装 + entryId），无裸标记尾附、无其他文本
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
    // ⑧：信令不经内核（registry 无条目——若经 submit 会留下条目/标记文本）
    expect(h.registry.entries(SID)?.active ?? []).toHaveLength(0)
    // ④ history 缓存清理触达；派生态失效同样触达但后置⑥（时序契约见「派生态失效时序」用例）
    expect(h.evictSpy).toHaveBeenCalledWith(SID)
    expect(h.invalidateSpy).toHaveBeenCalledWith(SID)
  })

  it('u- 形态 通道 a（msg-id-mapper custom entry 映射）：clientUuid → userEntryId 定位成功', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('e2', 'e1', 'user', `帮我写个排序\n<!--taiji:msg:${UUID_A}-->`),
        customEntry('c1', 'e2', 'taiji.client-msg-id', { clientUuid: `u-${UUID_A}`, userEntryId: 'e2' }),
        msgEntry('e3', 'e2', 'assistant', '好的'),
      ],
      'e3',
    )

    const reply = await h.revoke(`u-${UUID_A}`)

    expect(reply.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })

  it('u- 形态 通道 b（纯文本无映射 entry → 裸标记末尾锚）：定位成功', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('e2', 'e1', 'user', `纯文本消息\n<!--taiji:msg:${UUID_A}-->`),
        msgEntry('e3', 'e2', 'assistant', '收到'),
      ],
      'e3',
    )

    const reply = await h.revoke(`u-${UUID_A}`)

    expect(reply.revoked).toBe(true)
    if (reply.revoked) expect(reply.content).toBe(`纯文本消息\n<!--taiji:msg:${UUID_A}-->`)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })

  it('裸 uuid 形态 targetId（U8 保留原 id，无 u- 前缀）→ 进双通道，通道 b 末尾锚命中', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // U8 外来条目保留原 id：气泡/内核条目 id 为裸 uuid（无 u- 前缀），裸标记恰以裸 uuid 落盘
    const reply = await h.revoke(UUID_A)

    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })

  it('8 位 hex entryId 形态（pi entryId）仍直用：不进 uuid 双通道分派', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'a1b2c3d4', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('a1b2c3d4', 'e1', 'user', '直用目标'),
        msgEntry('e3', 'a1b2c3d4', 'assistant', '回复'),
      ],
      'e3',
    )

    const reply = await h.revoke('a1b2c3d4')

    expect(reply).toEqual({ sessionId: SID, revoked: true, content: '直用目标' })
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} a1b2c3d4`])
  })

  it('首条消息完备分支：expectedParentId=null → 回溯链终止于根（label 成根）校验通过', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e1', parent: null } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', `首条消息\n<!--taiji:msg:${UUID_A}-->`),
        msgEntry('e2', 'e1', 'assistant', '回复'),
      ],
      'e2',
    )

    const reply = await h.revoke(`u-${UUID_A}`)

    expect(reply.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e1`])
  })
})

describe('① 临界区互斥（A12①：并发两撤回恰一条 revoked 一条 busy）', () => {
  it('第一个撤回卡在 workflow 检查 await 时，第二个撤回同步段互斥自检回 busy', async () => {
    let releaseWorkflow: (() => void) | undefined
    const workflowGate = new Promise<void>((resolve) => {
      releaseWorkflow = resolve
    })
    const h = makeRevokeHarness({
      hasRunningWorkflow: () => workflowGate.then(() => false),
      rewind: { target: 'e2', parent: 'e1' },
    })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // 第一个撤回：同步段置位 revoking → 卡在 workflow 检查（临界区后第一个 await）
    const p1 = h.revoke('e2')
    const p2 = h.revoke('e1') // 第二个撤回在第一个的 await 窗口内到达
    const r2 = await p2
    expect(r2).toEqual({ sessionId: SID, revoked: false, error: 'busy' })

    releaseWorkflow?.()
    const r1 = await p1
    expect(r1).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    // 互斥释放后可再次置位（无泄漏）
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })
})

describe('② nav-failed 幂等重试（A8/A12：⑥ 校验失败 → 重试命中 ⑤ 幂等判定）', () => {
  it('第一次撤回树未回退 → nav-failed；重试时目标已被带走（全文件存在、不在活跃路径）→ revoked:true 且不发信令', async () => {
    // 第一次：prompt 不产生树变更（navigateTree throw 形态——command 抛错 prompt 照常成功）
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const first = await h.revoke('e2')
    expect(first).toEqual({ sessionId: SID, revoked: false, error: 'nav-failed' })
    expect(h.promptCalls).toHaveLength(1)
    // nav-failed 不触发派生态失效（树未确认回退）
    expect(h.invalidateSpy).not.toHaveBeenCalled()

    // 重试时点：树实际已回退（前次撤回真实生效但 reply 丢失的形态）——label 挂 e1、leaf 切走
    applyRewind(h.tree, 'e2', 'e1')
    const getEntriesBefore = h.client.getEntries.mock.calls.length
    const second = await h.revoke('e2')

    expect(second).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    // ⑤ 两分支均不发信令（防复活性跳转）：prompt 无新增调用
    expect(h.promptCalls).toHaveLength(1)
    // 只消费了一次 get_entries（⑤ 数据范围），无 ⑥ 校验读
    expect(h.client.getEntries.mock.calls.length).toBe(getEntriesBefore + 1)
    // 幂等分支补触发派生态失效（首次尝试可能已树回退但失效未触发——残影在此清除）
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.invalidateSpy).toHaveBeenCalledWith(SID)
  })

  it('get_entries RPC 自身失败归 nav-failed（不误报 no-mapping），不触发信令', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    h.client.getEntries.mockRejectedValueOnce(new Error('transport broken'))

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'nav-failed' })
    expect(h.promptCalls).toHaveLength(0)
  })
})

describe('③ no-mapping 双分支', () => {
  it('u- 双通道 miss（无 custom entry 映射 + 无末尾锚命中）→ no-mapping，无信令', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke(`u-${UUID_B}`)
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })
    expect(h.promptCalls).toHaveLength(0)
    // 定位失败提前 return：④ history 缓存清理未触达（撤回未发生）
    expect(h.evictSpy).not.toHaveBeenCalled()
  })

  it('entryId 不在文件（基线 stale）→ ⑤ 兜底判 no-mapping', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e999')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })
    expect(h.promptCalls).toHaveLength(0)
  })
})

describe('④ hold try/finally 全路径释放（A11 硬契约：提前 return 后 hold 已释）', () => {
  it('busy 提前 return（turn generating）→ hold 已释放（再次置位成功）', async () => {
    const h = makeRevokeHarness({ view: { occupancy: { turn: 'generating', compacting: false, bash: false, handingOff: false } } })
    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'busy' })
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })

  it('workflow-running 提前 return → hold 已释放', async () => {
    const h = makeRevokeHarness({ hasRunningWorkflow: async () => true })
    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'workflow-running' })
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })

  it('no-mapping 提前 return → hold 已释放，后续提交正常投递（不永久 queued）', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke(`u-${UUID_B}`)
    expect(reply.revoked).toBe(false)
    if (!reply.revoked) expect(reply.error).toBe('no-mapping')

    // 行为锚：hold 释放后新提交不被持有（泄漏形态 = 永久 queued 死轮询）
    h.registry.submit(SID, { content: '新消息', clientUuid: `u-${UUID_B}` })
    await h.flush()
    await vi.advanceTimersByTimeAsync(600)
    expect(h.promptCalls).toHaveLength(1)
  })
})

describe('⑤ compaction_end 边沿不提前投递（A11：hold 窗口内判定源唯一）', () => {
  it('revoking hold 期间 compaction 边沿到达（compacting 复位）不投递；revoking 释放后投递', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // 撤回开始并卡在数据范围（get_entries gate——② 已快照过 active 集合）。① 空闲检查
    // 在此通过（view 空闲开局），compaction 在撤回窗口**内**开始（步骤见下）——这是
    // 「撤回进行中恰好有 compaction 短暂发生又结束」的真实时序。
    h.blockGetEntries()
    const p = h.revoke('e2')
    await h.flush()

    // 撤回窗口内新 compaction 开始：view 置 compacting（[D1] 读口迁移：occupancy.compacting）
    h.view.occupancy = { ...h.view.occupancy!, compacting: true }

    // revoking 窗口内新提交（② 快照之后 → 不被编排 cancel，A11 场景形态；compacting
    // 期间提交 → lane=queued，deliverOne 持有于 'compacting'）
    h.registry.submit(SID, { content: '撤回期间的新消息', clientUuid: `u-${UUID_B}` })
    await h.flush()

    // compaction_end 边沿：compacting 复位——正常（无 revoking）会在此边沿后投递
    h.view.occupancy = { ...h.view.occupancy!, compacting: false }
    await vi.advanceTimersByTimeAsync(1_500)

    // 判定源唯一：compaction 边沿不提前投递（revoking 仍持有）
    expect(h.promptCalls.filter((t2) => t2.startsWith(`/${TAIJI_NAV_COMMAND}`))).toHaveLength(0)
    expect(h.promptCalls).toHaveLength(0)

    // 释放数据范围卡点 → 编排走完（⑥ 校验过）→ finally 释放 hold → 持有期轮询退出 → 投递
    h.releaseGetEntries()
    const reply = await p
    expect(reply.revoked).toBe(true)
    await vi.advanceTimersByTimeAsync(1_500)
    await h.flush()

    const navCalls = h.promptCalls.filter((t2) => t2.startsWith(`/${TAIJI_NAV_COMMAND}`))
    const userCalls = h.promptCalls.filter((t2) => !t2.startsWith(`/${TAIJI_NAV_COMMAND}`))
    expect(navCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
    // revoking 释放 + compacting 已复位 → 新消息按新分支正常投递（A11 验收锚）
    expect(userCalls).toHaveLength(1)
    expect(userCalls[0]).toContain('撤回期间的新消息')
  })
})

describe('⑥ ③ b 末尾锚（内嵌标记字面不误命中）', () => {
  it('标记字面内嵌非末尾 → 不命中（no-mapping）；末尾真标记命中（对照组）', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'eB', parent: 'eA' } })
    h.setTree(
      [
        msgEntry('e0', null, 'user', '你好'),
        // UUID_A 内嵌在正文中（非末尾）——用户原文里的标记字面
        msgEntry('eA', 'e0', 'user', `用户提到了 <!--taiji:msg:${UUID_A}--> 这个字面，然后继续说`),
        // UUID_B 的真标记恒尾附
        msgEntry('eB', 'eA', 'user', `另一条消息\n<!--taiji:msg:${UUID_B}-->`),
        msgEntry('eC', 'eB', 'assistant', '回复'),
      ],
      'eC',
    )

    // 内嵌字面不误命中（恒尾附构造保证真标记在尾）
    const miss = await h.revoke(`u-${UUID_A}`)
    expect(miss).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })

    // 对照组：末尾锚命中（custom entry 缺失 → 纯 b 通道）
    const hit = await h.revoke(`u-${UUID_B}`)
    expect(hit.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} eB`])
  })
})

describe('⑦ revoking 进 hold 判定 + 与 compacting 叠加', () => {
  it('revoking 单独有效：置位期间 submit 被持有，释放后投递', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.submit(SID, { content: 'hold 窗口内提交', clientUuid: `u-${UUID_A}` })
    await h.flush()
    await vi.advanceTimersByTimeAsync(1_200)
    expect(h.promptCalls).toHaveLength(0) // revoking hold（无 compacting/bash——判定源是 revoking 本身）

    h.registry.endRevokeHold(SID)
    await vi.advanceTimersByTimeAsync(1_200)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })

  it('与 compacting 叠加：compacting 复位后 revoking 仍持有（两 hold 并存，逐一释放）', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    h.view.occupancy = { ...h.view.occupancy!, compacting: true }
    expect(h.registry.beginRevokeHold(SID)).toBe(true)

    h.registry.submit(SID, { content: '叠加 hold 提交', clientUuid: `u-${UUID_A}` })
    await h.flush()

    // 第一个 hold 源释放（compaction_end 边沿）——revoking 仍持有
    h.view.occupancy = { ...h.view.occupancy!, compacting: false }
    await vi.advanceTimersByTimeAsync(1_200)
    expect(h.promptCalls).toHaveLength(0)

    // 第二个 hold 源释放（撤回编排 finally）——投递恢复
    h.registry.endRevokeHold(SID)
    await vi.advanceTimersByTimeAsync(1_200)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })
})

describe('⑧ 信令不污染（A6 单测路径：prompt 只收命令串、无标记尾附、不经内核）', () => {
  it('u- 形态经通道 b 定位：命令串 = TAIJI_NAV_COMMAND 拼装 + 定位出的 entryId，prompt 文本不含裸标记', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    h.setTree(
      [
        msgEntry('e1', null, 'user', '你好'),
        msgEntry('e2', 'e1', 'user', `帮我写个排序\n<!--taiji:msg:${UUID_A}-->`),
        msgEntry('e3', 'e2', 'assistant', '好的'),
      ],
      'e3',
    )

    const reply = await h.revoke(`u-${UUID_A}`)
    expect(reply.revoked).toBe(true)

    expect(h.promptCalls).toHaveLength(1)
    const cmd = h.promptCalls[0]!
    // 只收命令串：精确等值（TAIJI_NAV_COMMAND 常量拼装，无用户文本混入）
    expect(cmd).toBe(`/${TAIJI_NAV_COMMAND} e2`)
    // 无标记尾附（不经内核 submit——withDeliveryMarker 尾附会污染 command args）
    expect(cmd).not.toContain('taiji:msg')
    // 内核无信令条目（信令不进 FIFO / 不占投递路径）
    const entries = h.registry.entries(SID)
    expect([...(entries?.active ?? []), ...(entries?.tombstones ?? [])].map((e) => e.id)).not.toContain(cmd)
  })
})

describe('派生态失效时序（⑥ 树回退校验通过后触发——信令前失效 = 无效失效，回归钉）', () => {
  it('invalidateDerivedState 晚于信令 prompt 与 ⑥ 校验读，且失效时点的树 = 撤回后树（label 锚已挂、leaf 已切）', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // pi 真实时序模拟（harness 的 prompt 副作用按 navigateTree 语义切树，getEntries 返回值
    // 随之切换）：逐次记录 getEntries 返回的 leafId——信令前（③⑤ 定位/校验读）= 撤回前
    // leaf，信令后（⑥ 校验读）= 撤回后 leaf，钉住「无参 getEntries 的取数时序」缺陷核心部分。
    const getEntriesLeafIds: Array<string | null> = []
    const baseGetEntries = h.client.getEntries.getMockImplementation()!
    h.client.getEntries.mockImplementation(async () => {
      const msg = await baseGetEntries()
      getEntriesLeafIds.push(msg.data.leafId)
      return msg
    })
    // 失效时点的树快照（SessionRecords.invalidateDerivedState 同步触发 fire-and-forget
    // 全量重算——重算消费调用时点的树；记录调用时点可变树状态即重算消费方）
    const consumedTrees: Array<{ leafId: string | null; hasLabel: boolean }> = []
    h.invalidateSpy.mockImplementation(() => {
      consumedTrees.push({
        leafId: h.tree.leafId,
        hasLabel: h.tree.entries.some((e) => (e as { id?: unknown }).id === 'L-e2'),
      })
    })

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })

    // 取数时序：两次拉取即 ③⑤ 数据范围（撤回前 leaf=e3）与 ⑥ 校验读（撤回后 leaf=L-e2），
    // 值切换点 = prompt 副作用，构造性对齐真实 pi 的同 client 顺序处理
    expect(getEntriesLeafIds).toEqual(['e3', 'L-e2'])
    // 时序断言（vi 全局单调调用序）：失效晚于信令 prompt、也晚于 ⑥ 校验读（树回退确认后）
    const invalidateOrder = h.invalidateSpy.mock.invocationCallOrder[0]!
    expect(invalidateOrder).toBeGreaterThan(h.client.prompt.mock.invocationCallOrder[0]!)
    expect(invalidateOrder).toBeGreaterThan(h.client.getEntries.mock.invocationCallOrder[1]!)
    // 失效触发的重算消费撤回后树：调用时点 label 锚已挂、叶子已切（若失效先行触发，
    // 此处消费的是撤回前树 → 全量重建被撤残影）
    expect(consumedTrees).toEqual([{ leafId: 'L-e2', hasLabel: true }])
  })
})

describe('撤回信号广播（插件镜像重建路径：与派生态失效恒配对，U7）', () => {
  it('⑥′ 时点：撤回信号广播晚于信令 prompt 与 ⑥ 校验读，且与 invalidateDerivedState 成对触发', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })

    // 时序（vi 全局单调调用序）：信号晚于信令 prompt 与 ⑥ 校验读（树回退确认后——
    // 信令前广播 = 插件重新拉取仍读撤回前数据，无效重建）
    expect(h.signalSpy).toHaveBeenCalledTimes(1)
    expect(h.signalSpy).toHaveBeenCalledWith(SID)
    const signalOrder = h.signalSpy.mock.invocationCallOrder[0]!
    expect(signalOrder).toBeGreaterThan(h.client.prompt.mock.invocationCallOrder[0]!)
    expect(signalOrder).toBeGreaterThan(h.client.getEntries.mock.invocationCallOrder[1]!)
    // 恒配对：records 失效路径先行同批触发（同处 invalidateDerived 私有入口）
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.invalidateSpy.mock.invocationCallOrder[0]).toBeLessThan(signalOrder)
  })

  it('树未回退（「目标仍在活跃链」nav-failed 分支）→ 无信号无失效', async () => {
    const h = makeRevokeHarness() // 无 rewind = 树不变
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'nav-failed' })
    expect(h.signalSpy).not.toHaveBeenCalled()
    expect(h.invalidateSpy).not.toHaveBeenCalled()
  })

  it('定位失败提前 return（no-mapping）→ 无信号', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e999')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'no-mapping' })
    expect(h.signalSpy).not.toHaveBeenCalled()
  })

  it('⑤ 幂等分支（目标已被前序撤回带走）→ 信号与失效同步各一次', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    // 前次撤回真实生效但 reply 丢失的形态：label 挂 e1、leaf 切走
    applyRewind(h.tree, 'e2', 'e1')

    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: true, content: `帮我写个排序\n<!--taiji:msg:${UUID_A}-->` })
    expect(h.invalidateSpy).toHaveBeenCalledTimes(1)
    expect(h.signalSpy).toHaveBeenCalledTimes(1)
    expect(h.signalSpy).toHaveBeenCalledWith(SID)
  })
})

describe('① 空闲检查四维判定（handingOff 纳入 busy——交接期撤回拦截）', () => {
  it('handingOff=true（turn idle，交接置位到 settle 窗口）→ busy，prompt 零调用', async () => {
    const h = makeRevokeHarness({ view: { occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: true } } })
    const reply = await h.revoke('e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'busy' })
    expect(h.promptCalls).toHaveLength(0)
    // hold 已释放（finally 覆盖 busy 提前 return——A11 硬契约）
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })
})

describe('错误码边界（D8）', () => {
  it('pi-reclaimed：ensureActive 拉活失败回终态码（区别于 extension-missing）', async () => {
    const h = makeRevokeHarness()
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    // 拉活失败（编排数据范围的 ensureActive——⑤ 之前）：直接构造 orchestrator 级失败
    const failing = new RevokeOrchestrator({
      getSession: () => undefined,
      ensureActive: async () => {
        throw new Error('restore failed')
      },
      hasRunningWorkflow: async () => false,
      evictHistoryRebuildCache: vi.fn(),
      invalidateDerivedState: vi.fn(),
      notifyEntryInvalidation: vi.fn(),
      registry: () => h.registry,
      sendSystemCommand: vi.fn(async () => ({ kind: 'sent' as const })),
    })
    // beginRevokeHold 需要 registry（harness 已装配）
    const reply = await failing.revokeMessage(SID, 'e2')
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'pi-reclaimed' })
    // hold 已释放（finally 覆盖 pi-reclaimed 提前 return）
    expect(h.registry.beginRevokeHold(SID)).toBe(true)
    h.registry.endRevokeHold(SID)
  })

  it('extension-missing：命令探测耗尽 fail-closed，命令串不进模型（prompt 零调用）', async () => {
    const h = makeRevokeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)
    h.client.getCommands.mockResolvedValue([])

    const replyPromise = h.revoke('e2')
    // 探测重试预算（500ms × 6 次 + 首探）
    const reply = await vi.advanceTimersByTimeAsync(4_000).then(() => replyPromise)
    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'extension-missing' })
    expect(h.promptCalls).toHaveLength(0)
  })
})

// ════════════════ 来源: revoke-probe.test.ts ════════════════

/** workflow run 派生视图的最小形态（组合根 hasRunningWorkflow 推导只读 .records[].status）。 */
interface WorkflowRunProjection {
  id: string
  status: string
}

/** mock records 派生视图（A9 数据源——形态对齐组合根消费方，不 import session-records）。 */
interface WorkflowRecordsProjection {
  getWorkflows(sessionId: string): Promise<{ records: WorkflowRunProjection[] }>
}

function makeWorkflowRecords(runs: readonly WorkflowRunProjection[]): WorkflowRecordsProjection {
  return {
    async getWorkflows() {
      return { records: [...runs] }
    },
  }
}

/** 派生视图条目 payload 文本（检查式读取——kind text 的 content 字段）。 */
function payloadContentOf(entry: unknown): string {
  const payload = (entry as { payload?: { content?: unknown } }).payload
  return typeof payload?.content === 'string' ? payload.content : ''
}

interface ProbeHarnessOptions {
  view?: Partial<IManagedSessionView>
  /** workflow run 派生视图（A9 数据源；缺省空 = 无在跑 run）。 */
  workflowRuns?: ReadonlyArray<WorkflowRunProjection>
  /** navigateTree 成功语义模拟（label 锚挂 parent、叶子切换）；缺省 = 命令无效果形态。 */
  rewind?: { target: string; parent: string | null }
}

function makeProbeHarness(opts: ProbeHarnessOptions = {}) {
  const view = makeView(opts.view)
  const tree: MutableTree = { entries: [], leafId: null }
  const promptCalls: string[] = []
  const evictSpy = vi.fn()
  const invalidateSpy = vi.fn()
  // 撤回信号广播路径 spy（[MF-1-7] deps.notifyEntryInvalidation 注入——生产 = pluginService notify 闭包）
  const signalSpy = vi.fn()
  const workflowRecords = makeWorkflowRecords(opts.workflowRuns ?? [])

  // pi 事件流的 mock 订阅槽（送达回执 message_end 经此注入——D2 第二阶段确认通道）
  let piEventHandler: ((event: unknown) => void) | undefined
  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      if (text.startsWith(`/${TAIJI_NAV_COMMAND} `)) {
        // 注册命令串：pi 同步执行、不进模型、无 turn（P2 前提）——transcript 只长 label 锚
        if (opts.rewind) applyRewind(tree, opts.rewind.target, opts.rewind.parent)
      } else {
        // 其余 prompt = pi 开新回合：user message entry 落 transcript（A6 探针的对照面——
        // 信令若走用户消息侧，这里长出的 message entry 会被撤回前后对比抓红）
        const id = `m-${tree.entries.length + 1}`
        tree.entries = [...tree.entries, msgEntry(id, tree.leafId, 'user', text)]
        tree.leafId = id
      }
      return {}
    }),
    getEntries: vi.fn(async () => ({ data: { entries: tree.entries, leafId: tree.leafId } })),
    getCommands: vi.fn(async () => [{ name: TAIJI_NAV_COMMAND, source: 'taiji' }]),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn((handler: (event: unknown) => void) => {
      piEventHandler = handler
      return () => {
        piEventHandler = undefined
      }
    }),
    touchActivity: vi.fn(),
  }
  const injector = {
    inject: vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text,
      notices: [] as SkillNotice[],
    })),
  } as unknown as SkillInjector
  const deliveryDeps: SessionDeliveryDeps = {
    getSession: (sid: string) => (sid === SID ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => ({ publish: () => undefined }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deliveryDeps, injector)

  // 真实 dispatcher 的 sendSystemCommand（探针对象：不经 hook / 不经内核 / 直连 prompt）
  const dispatcher = new MessageDispatcher(
    {
      ensureActive: async () => client as unknown as IPiEngine,
      getSessionByClient: () => view,
      persistSessionOutcome: vi.fn(),
      getSession: (sid: string) => (sid === SID ? view : undefined),
      removeSessionEntry: vi.fn(),
      detachSession: vi.fn(),
    } as unknown as IDispatcherSessionOps,
    { getClient: (sid: string) => (sid === SID ? (client as unknown as IPiEngine) : undefined) } as unknown as IProcessManager,
    {} as unknown as WorkspaceService,
    undefined,
  )

  const orchestrator = new RevokeOrchestrator({
    getSession: (sid: string) => (sid === SID ? view : undefined),
    ensureActive: async () => client as unknown as IPiEngine,
    // 组合根同款推导（session-service 接线逐字一致）——拦截锚是派生视图 running 状态
    hasRunningWorkflow: async (sid) =>
      (await workflowRecords.getWorkflows(sid)).records.some((r) => r.status === 'running'),
    evictHistoryRebuildCache: evictSpy,
    invalidateDerivedState: invalidateSpy,
    notifyEntryInvalidation: signalSpy,
    registry: () => registry,
    sendSystemCommand: (sid, commandLine, requireCommand) => dispatcher.sendSystemCommand(sid, commandLine, requireCommand),
  })

  const revoke = (targetId: string) => orchestrator.revokeMessage(SID, targetId)
  /** flush 异步链（编排各 await 段 + 内核受理微任务）。 */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return {
    view, tree, registry, client, promptCalls, evictSpy, invalidateSpy, signalSpy, revoke, flush,
    /** 注入一条 pi 事件（送达回执 message_end 等——watchClient 订阅的 mock 通道）。 */
    emitPiEvent: (event: unknown) => piEventHandler?.(event),
    setTree: (entries: unknown[], leafId: string | null) => {
      tree.entries = entries
      tree.leafId = leafId
    },
    /** mock transcript 快照（撤回前后对比的数据范围——经 get_entries 同一观察通道取）。 */
    snapshotTranscript: async (): Promise<{ entries: unknown[]; leafId: string | null }> => {
      const msg = (await client.getEntries()) as { data?: { entries?: unknown; leafId?: unknown } }
      const entries = msg.data?.entries
      return {
        entries: Array.isArray(entries) ? [...entries] : [],
        leafId: typeof msg.data?.leafId === 'string' ? msg.data.leafId : null,
      }
    },
  }
}

const typeOf = (entry: unknown): unknown => (entry as { type?: unknown }).type

describe('A6 信令不污染（探针：transcript 撤回前后对比 + 命令串零残留）', () => {
  it('撤回前后 transcript 对比：新增条目恰一条非 message 的 label 锚，message entry 集合逐字不变', async () => {
    const h = makeProbeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const before = await h.snapshotTranscript()
    const reply = await h.revoke('e2')
    const after = await h.snapshotTranscript()

    expect(reply.revoked).toBe(true)
    // 撤回成功前提下的污染断言：唯一新增条目是 navigateTree 的 label 锚——
    // 若信令走用户消息侧（prompt mock 会落 user message entry），此处即红（P2 探针）
    expect(after.entries.length).toBe(before.entries.length + 1)
    const added = after.entries.slice(before.entries.length)
    expect(added).toHaveLength(1)
    expect(typeOf(added[0])).toBe('label')
    // message entry 集合逐字不变（无新增 message entry、既有条目零改写）
    const messagesOf = (entries: unknown[]) => entries.filter((e) => typeOf(e) === 'message')
    expect(messagesOf(after.entries)).toStrictEqual(messagesOf(before.entries))
  })

  it('__taiji_nav__ 命令串零残留：任何 message entry 不含，session.delivery 派生视图（帧数据源 = 内核派生视图）不含——对照锚：已送达用户消息文本确在派生视图中（断言非空）', async () => {
    const h = makeProbeHarness({ rewind: { target: 'e2', parent: 'e1' } })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    // 预置一条已送达的内核条目（真实链路：submit → 投出 → message_end(user) 裸标记回执
    // → delivered），使 session.delivery 派生视图非空——delivered 条目按 D4 惰性残留口径留存
    // 派生视图（cancelled tombstone 是轻量元数据不进派生视图，故对照锚必须用 delivered 条目）
    const seededText = `早期已送达的用户消息\n<!--taiji:msg:${UUID_B}-->`
    h.registry.submit(SID, { content: '早期已送达的用户消息', clientUuid: `u-${UUID_B}` })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toBe(seededText) // 出站文本 = 原文 + 裸标记（内核 withDeliveryMarker）
    h.emitPiEvent({ type: 'message_end', message: { role: 'user', content: seededText } })
    await h.flush()
    // 投递收尾副作用复位（markSessionActive 置 dispatching + 派生 isGenerating=true；
    // 真实回落 = pi 事件驱动（[D3③] handled 响应 / sweepInFlight 收尾，CP6 时间窗已退役），
    // fake 环境无事件流——按 event-interpreter idle 行语义手动复位，撤回前置 = 空闲
    //（[D1] 读口迁移：turn 维 occupancy 直写复位）
    h.view.occupancy = { turn: 'idle', compacting: false, bash: false, handingOff: false }

    const before = await h.snapshotTranscript()
    const reply = await h.revoke('e2')
    const after = await h.snapshotTranscript()

    expect(reply.revoked).toBe(true)
    // 两条 prompt = 种子投递 + 命令串（信令是唯一新增 prompt，且为命令形态）
    expect(h.promptCalls).toEqual([seededText, `/${TAIJI_NAV_COMMAND} e2`])

    // ① transcript：撤回后全部 message entry 序列化不含命令串（信令不被记录成对话内容）
    for (const entry of after.entries) {
      if (typeOf(entry) !== 'message') continue
      expect(JSON.stringify(entry)).not.toContain(TAIJI_NAV_COMMAND)
    }
    expect(after.entries.length).toBe(before.entries.length + 1)

    // ② session.delivery 派生视图（session-delivery-topic 的帧数据源 = handle.projection() 派生视图）：
    // 命令串零残留。若信令回归走内核 submit 面，命令条目将滞留 active（command 无
    // message_end 回执、永不 delivered）→ 此断言即红（D1 否决记录的「僵尸条目」形态）
    const projectionEntries = h.registry.getOrCreateDelivery(SID).projection().entries
    for (const entry of projectionEntries) {
      expect(JSON.stringify(entry)).not.toContain(TAIJI_NAV_COMMAND)
    }
    // 对照锚（防空派生视图假绿）：已送达条目确在派生视图中，payload 含用户文本
    expect(projectionEntries.some((e) => payloadContentOf(e).includes('早期已送达的用户消息'))).toBe(true)
    // ③ 内核全量视图（active + tombstone）序列化同样零残留，且撤回后无在册条目
    expect(JSON.stringify(h.registry.entries(SID))).not.toContain(TAIJI_NAV_COMMAND)
    expect(h.registry.entries(SID)?.active ?? []).toHaveLength(0)
  })
})

describe('A9 workflow-running 拦截回执（探针：mock workflow 派生视图）', () => {
  it('派生视图含 running run → {revoked:false, error:"workflow-running"}，零信令、树逐字不变、数据范围零拉取', async () => {
    const h = makeProbeHarness({
      workflowRuns: [{ id: 'wf-1', status: 'running' }],
      rewind: { target: 'e2', parent: 'e1' }, // 信令若被错误发出，树会变——反向断言锚
    })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const before = await h.snapshotTranscript()
    const getEntriesBeforeRevoke = h.client.getEntries.mock.calls.length

    const reply = await h.revoke('e2')

    expect(reply).toEqual({ sessionId: SID, revoked: false, error: 'workflow-running' })
    // 零信令：prompt 零调用（run 不被终止的 runtime 侧锚——树回退信令未发出）
    expect(h.promptCalls).toHaveLength(0)
    // 树逐字不变（entries + leafId 均未动）
    const after = await h.snapshotTranscript()
    expect(after).toEqual(before)
    // 拦截先于数据范围：编排零 get_entries 拉取（此后仅 +1 = after 快照自身的对照读）
    expect(h.client.getEntries.mock.calls.length).toBe(getEntriesBeforeRevoke + 1)
    // ④ history 缓存清理与 ⑥′ 派生态失效均未触达（撤回未发生，拦截先于缓存步骤）
    expect(h.evictSpy).not.toHaveBeenCalled()
    expect(h.invalidateSpy).not.toHaveBeenCalled()
  })

  it('对照：同派生视图 run 已完成（completed）→ 拦截不触发，撤回正常完成——拦截锚是 running 状态本身', async () => {
    const h = makeProbeHarness({
      workflowRuns: [{ id: 'wf-1', status: 'completed' }],
      rewind: { target: 'e2', parent: 'e1' },
    })
    const t = standardTree()
    h.setTree(t.entries, t.leafId)

    const reply = await h.revoke('e2')

    expect(reply.revoked).toBe(true)
    expect(h.promptCalls).toEqual([`/${TAIJI_NAV_COMMAND} e2`])
  })
})
