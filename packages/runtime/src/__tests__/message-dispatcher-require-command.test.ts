/**
 * MessageDispatcher requireCommand 原子校验 + 回执 reason 分类单测
 * （plugin-header-action-modal-points D6/AP-4，u5a 验收①②）。
 *
 * [merge 后内核形态适配] 投递所有权内核架构下受理段 = touch → 串行链 →
 * runAcceptance（hook → requireCommand 校验 → submitToKernel）；prompt 直发/busy 预检
 * 已退役（D5 排队取代拒绝），校验位置 = hook 之后、内核提交之前——restore 窗口由
 * ensureCommandAvailable 的重试循环覆盖（pm.getClient 按间隔重取，附着后命令表即可
 * 探测，总预算耗尽 fail-closed）。
 *
 * 锁定：
 * - 校验顺序：hook → getCommands →（命中后）内核投递腿 prompt（mock 调用序断言；
 *   校验直连 client.getCommands()，不走 sessionService.getCommands 的 markDirty 查询语义）
 * - 未命中：500ms × 6 次重试（P9 定案）耗尽后拒发，回执 reason:'command-missing'，
 *   prompt 未调用（E14 结构性防线：命令串永不漏进模型）；不广播 send.rejected /
 *   message.error（回执机制是唯一反馈面——send.rejected 会触发前端队列重投，
 *   插件写命令绝不能入用户队列）
 * - 命中（首次 / 重试窗口内恢复）：内核受理（receipt 非空）+ 投递腿 prompt 到达
 * - 无 requireCommand：getCommands 零触达，内核受理（既有路径回归）
 * - reason 分类：hook 拦截 → 'hook-blocked'
 * - 手敲 `/` 扩展命令的 occupancy 收口（u5a #12）已随投递腿迁入 registry 的
 *   CP6 短窗（armOccupancySettleWindowFor），本文件不再覆盖——见
 *   session-delivery-registry.test.ts 与 message-dispatcher.test.ts 的 CP6 用例。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-require-command.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import {
  createSessionDeliveryRegistry,
  type SessionDeliveryDeps,
} from '../services/session/session-delivery-registry.js'
import type { SkillInjector } from '../services/session/skill-injector.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'

// ── fakes ──

interface HarnessOptions {
  /** client.getCommands 的逐次返回队列（queue.shift()，耗尽后重复末项）。 */
  commandQueue?: Array<Array<{ name: string; source: string }> | Error>
  hookBlocked?: boolean
}

function makeHarness(opts: HarnessOptions = {}) {
  const calls: string[] = []
  const getCommands = vi.fn(async () => {
    calls.push('getCommands')
    const next = opts.commandQueue?.shift()
    if (next instanceof Error) throw next
    if (next !== undefined) return next
    return opts.commandQueue?.length === 0 ? [] : (opts.commandQueue?.[opts.commandQueue!.length - 1] ?? [])
  })
  const client = {
    prompt: vi.fn(async () => {
      calls.push('prompt')
      return {}
    }),
    touchActivity: vi.fn(),
    getCommands,
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
  }
  const session = {
    id: 's1',
    cwd: '/test',
    occupancy: { turn: 'idle', compacting: false, bash: false },
  } as unknown as IManagedSessionView
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => {
      calls.push('ensureActive')
      return client as unknown as IPiEngine
    }),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    getSession: vi.fn(() => session),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }
  const pm = { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus
  const hookMock = vi.fn(async (): Promise<{ blocked: boolean; reason?: string; modifiedContent?: string } | null> => {
    calls.push('hook')
    if (opts.hookBlocked) return { blocked: true, reason: '被插件拦截' }
    return { blocked: false }
  })
  const injectMock = vi.fn(async (_c: unknown, text: string) => ({ text, notices: [] }))
  const deps: SessionDeliveryDeps = {
    getSession: (sid: string) => (sid === 's1' ? session : undefined),
    ensureActive: svc.ensureActive as (sid: string) => Promise<IPiEngine>,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: (_cwd: string) => workspace.record(_cwd),
    getMessageBus: () => bus,
  }
  const registry = createSessionDeliveryRegistry(deps, { inject: injectMock } as unknown as SkillInjector)
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  dispatcher.setDeliveryRegistry(registry)
  dispatcher.setSendMessageHook(hookMock)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  return { dispatcher, calls, client, getCommands, broadcasts, hookMock, registry, flush }
}

/** 取广播中的唯一 send.rejected / message.error（无则 undefined）。 */
const findRejected = (broadcasts: ServerMessage[]) => broadcasts.find((m) => m.type === 'send.rejected')
const findError = (broadcasts: ServerMessage[]) => broadcasts.find((m) => m.type === 'message.error')

describe('requireCommand 原子校验（D6/u5a：hook 后、内核提交前）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('校验顺序：hook → getCommands →（命中后）投递腿 prompt；重试全程（未命中）prompt 不调用', async () => {
    const { dispatcher, calls } = makeHarness({ commandQueue: [[]] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    const result = await pending

    expect(result).toEqual({ blocked: true, rejected: true, reason: 'command-missing' })
    expect(calls[0]).toBe('hook')
    // requireCommand 校验只依赖 pm.getClient 直取 + client.getCommands（内核化后受理段
    // 不再走 svc.ensureActive——restore 窗口由重试循环覆盖）
    expect(calls.indexOf('getCommands')).toBeGreaterThan(calls.indexOf('hook'))
    expect(calls).not.toContain('prompt')
    expect(calls.filter((c) => c === 'getCommands')).toHaveLength(7) // 初始 1 次 + 重试 6 次（P9 定案）
  })

  it('命中：内核受理（receipt 非空 + lane 投影）且投递腿 prompt 到达', async () => {
    const { dispatcher, calls, client, flush } = makeHarness({ commandQueue: [[{ name: 'schedule', source: 'extension' }]] })
    const result = await dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await flush()

    expect(result.blocked).toBe(false)
    expect(result.receipt).toBeDefined()
    expect(result.receipt?.lane).toBe('direct')
    expect(calls[0]).toBe('hook')
    expect(calls.indexOf('getCommands')).toBeGreaterThan(calls.indexOf('hook'))
    expect(client.prompt).toHaveBeenCalledTimes(1)
  })

  it('重试窗口内恢复（P9 探针：附着→命令注册 gap 毫秒级）：第 2 次探测命中 → 投放', async () => {
    const { dispatcher, client } = makeHarness({
      commandQueue: [[], [{ name: 'schedule', source: 'extension' }]],
    })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 + 50)
    const result = await pending
    await Promise.resolve()

    expect(result.blocked).toBe(false)
    expect(result.receipt).toBeDefined()
    expect(client.prompt).toHaveBeenCalledTimes(1)
  })

  it('无 requireCommand：getCommands 零触达，内核受理（既有路径回归）', async () => {
    const { dispatcher, getCommands, flush } = makeHarness()
    const result = await dispatcher.sendMessage('s1', '普通消息')
    await flush()

    expect(result.blocked).toBe(false)
    expect(result.receipt).toBeDefined()
    expect(getCommands).not.toHaveBeenCalled()
  })

  it('未命中拒发不广播 send.rejected / message.error（回执机制是唯一反馈面，防队列误重投）', async () => {
    const { dispatcher, broadcasts } = makeHarness({ commandQueue: [[]] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    await pending

    expect(findRejected(broadcasts)).toBeUndefined()
    expect(findError(broadcasts)).toBeUndefined()
  })

  it('探测 RPC 抛错视同未命中参与重试，预算耗尽后拒发（fail-closed）', async () => {
    const { dispatcher, client } = makeHarness({ commandQueue: [new Error('probe boom')] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    const result = await pending

    expect(result).toEqual({ blocked: true, rejected: true, reason: 'command-missing' })
    expect(client.prompt).not.toHaveBeenCalled()
  })

  it('hook 拦截 → reason:"hook-blocked"（且先于命令校验，getCommands 零触达）', async () => {
    const { dispatcher, getCommands } = makeHarness({ hookBlocked: true })
    const result = await dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')

    expect(result).toEqual({ blocked: true, reason: 'hook-blocked' })
    expect(getCommands).not.toHaveBeenCalled()
  })
})
