/**
 * 命令链路内核测试（pi1-disposition-chat-flow U1，§4.1 验收条款 1-7）：
 * - D2① 命令识别与不注标出站（清单缓存 + 识别 + 裸命令文本）
 * - G3③ 受理回执命令标志（isCommand 随 submit 回执返回）
 * - D1② handled → delivered tombstone 终局 + D1③ 终局通知 + resync 判重防线继承
 * - D14①b（G2）无标记且命中清单宽限后静默终局 + 双成因日志 + 不重投 + occupancy 收尾
 * - D3③ sweep occupancy 收尾（confirm 分支 / 静默终局分支 / 幂等门）
 * - D14③① G3 闸①命令档 prompt 不限时（timeoutMs=0）+ 普通消息档位不变
 * - D2 清单新鲜度：get_commands 失败 → 全量按普通消息出站（分支 c 兜底）
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-delivery-commands.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSessionDeliveryRegistry } from '../session-delivery-registry.js'
import { applySessionOccupancyTransition } from '../event-interpreter.js'
import { markerLiteral } from '@taiji/shared'
import type { SkillInjector } from '../skill-injector.js'
import type { IMessageBus } from '../../message-bus/message-bus.js'
import type { IManagedSessionView } from '../types.js'
import type { IPiEngine } from '../../ports/pi-engine.js'

const CLIENT_UUID = 'u-9c1e2b3a-1111-4222-8333-444455556666'

interface HarnessOptions { // oe-exempt:20261004:test:测试 harness 参数包（单文件局部，非架构契约）
  /** client.prompt 的返回（disposition 接线）。 */
  promptResult?: unknown
  /** get_commands 清单（扩展命令 name；source 过滤在 registry 侧单点执行）。 */
  commands?: Array<{ name: string; source?: string }>
  /** get_entries 的 transcript entries（confirm 分支凭据）。 */
  entries?: unknown[]
  /** getCommands 拒绝（清单失败降级用例）。 */
  commandsError?: Error
}

function makeHarness(opts: HarnessOptions = {}) {
  const view = {
    id: 's1',
    cwd: '/test/workspace',
    lastActiveAt: 1_000,
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    occupancy: { turn: 'idle' as string, compacting: false, bash: false },
  } as unknown as IManagedSessionView
  const client = {
    prompt: vi.fn(async (..._args: unknown[]) => (opts.promptResult ?? {}) as never),
    getCommands: vi.fn(async () => {
      if (opts.commandsError) throw opts.commandsError
      return (opts.commands ?? []) as never
    }),
    getEntries: vi.fn(async () => ({ data: { entries: opts.entries ?? [] } }) as never),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] }) as never),
    onEvent: vi.fn(() => () => {}),
  }
  const published: Array<{ type: string; payload: unknown }> = []
  const inject = vi.fn(async (_c: unknown, text: string) => ({ text, notices: [] }))
  const injector = { inject } as unknown as SkillInjector
  const settledCbs: Array<(sid: string) => void> = []
  const registry = createSessionDeliveryRegistry(
    {
      getSession: (sid) => (sid === 's1' ? view : undefined),
      ensureActive: async () => client as unknown as IPiEngine,
      subscribeAgentSettled: (cb) => {
        settledCbs.push(cb)
        return () => {}
      },
      recordWorkspace: () => {},
      getMessageBus: () => ({ publish: vi.fn((_sid: string, msg: { type: string; payload: unknown }) => published.push(msg)) } as unknown as IMessageBus),
    },
    injector,
  )
  const occupancyTurn = (): string => (view as unknown as { occupancy: { turn: string } }).occupancy.turn
  const emitSettled = (): void => {
    for (const cb of settledCbs) cb('s1')
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 60; i += 1) await Promise.resolve()
  }
  return { registry, client, view, published, occupancyTurn, emitSettled, flush }
}

/** 清单就绪前置：创建运行时 → 事件型 reconcile 触发 watchClient 附着 + 清单拉取（flush 后快照就位）。 */
async function attachWithCommandList(h: ReturnType<typeof makeHarness>): Promise<void> {
  h.registry.getOrCreateDelivery('s1')
  await h.registry.reconcile('s1', 'agent-settled')
  await h.flush()
}

describe('D2①：命令识别与不注标出站', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('命令条目不注标出站：prompt 收到裸命令文本（★2 根因消除）；普通消息仍带投递标记', async () => {
    const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }] })
    await attachWithCommandList(h)
    const receipt = h.registry.submit('s1', { content: '/plan write x', clientUuid: CLIENT_UUID })
    await h.flush()
    expect(h.client.prompt).toHaveBeenCalledTimes(1)
    const outbound = (h.client.prompt.mock.calls[0]![0] as string)
    expect(outbound).toBe('/plan write x') // 裸文本：无任何投递标记
    expect(outbound).not.toContain('taiji:msg')
    expect(receipt.isCommand).toBe(true)
    // 对照：普通消息出站形态零变化（尾附裸标记）
    const SECOND_UUID = 'u-9c1e2b3a-1111-4222-8333-444455556667'
    h.registry.submit('s1', { content: '普通消息', clientUuid: SECOND_UUID })
    await h.flush()
    const plainOutbound = (h.client.prompt.mock.calls[1]![0] as string)
    expect(plainOutbound.startsWith('普通消息\n<!--taiji:msg:')).toBe(true)
    expect(plainOutbound.endsWith(markerLiteral(SECOND_UUID.replace(/^u-/, '')))).toBe(true)
  })

  it('`:N` 消歧后缀命令命中识别集（裸 name 未注册时两侧同样 miss → 普通消息形态）', async () => {
    const h = makeHarness({ commands: [{ name: 'cmd:1', source: 'extension' }, { name: 'cmd:2', source: 'extension' }] })
    await attachWithCommandList(h)
    const hit = h.registry.submit('s1', { content: '/cmd:2 args', clientUuid: CLIENT_UUID })
    expect(hit.isCommand).toBe(true)
    const miss = h.registry.submit('s1', { content: '/cmd', clientUuid: 'u-9c1e2b3a-1111-4222-8333-444455556667' })
    expect(miss.isCommand).toBeUndefined()
  })

  it('清单失败（get_commands 拒绝）：全量按普通消息出站（D2 分支 c 兜底——识别是优化非正确性前提）', async () => {
    const h = makeHarness({ commandsError: new Error('get_commands malformed') })
    await attachWithCommandList(h)
    const receipt = h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
    expect(receipt.isCommand).toBeUndefined()
    await h.flush()
    const outbound = (h.client.prompt.mock.calls[0]![0] as string)
    expect(outbound).toContain('taiji:msg') // 带标记出站
  })
})

describe('D1①②③：handled 终局 + 通知 + 判重防线继承', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('handled：条目 delivered tombstone（不进 in-flight 等待）+ session.deliveryHandled 通知 + occupancy 回落', async () => {
    const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }], promptResult: { disposition: 'handled' } })
    await attachWithCommandList(h)
    const receipt = h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
    expect(receipt.state).toBe('queued')
    await h.flush()
    // D1②：复用送达确认原语写 tombstone（终态 delivered——「离开系统的事实」）
    const full = h.registry.entries('s1')
    expect(full?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'delivered')).toBe(true)
    expect(full?.active.some((e) => e.id === CLIENT_UUID)).toBe(false)
    // D1③：一次性事件通知一对一发出
    const handled = h.published.filter((m) => m.type === 'session.deliveryHandled')
    expect(handled.length).toBe(1)
    expect(handled[0]!.payload).toEqual({ sessionId: 's1', clientUuid: CLIENT_UUID })
    // D3②：occupancy 事实驱动回落（命令不会跟回合事件）
    expect(h.occupancyTurn()).toBe('idle')
  })

  it('handled tombstone 不重投（断线重连 resync 判重防线继承）：resync 判重命中', async () => {
    const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }], promptResult: { disposition: 'handled' } })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
    await h.flush()
    // 断线重连 resync：tombstone 判重命中 → 不重报（重投会重复执行命令）
    const deduped = await h.registry.resync('s1', [CLIENT_UUID])
    expect(deduped).toEqual([CLIENT_UUID])
    expect(h.client.prompt).toHaveBeenCalledTimes(1) // 无第二次出站
  })

  it('queued / started 响应不驱动界面：无通知、条目维持 in-flight 等凭据（D4）', async () => {
    for (const disposition of ['queued', 'started']) {
      const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }], promptResult: { disposition } })
      await attachWithCommandList(h)
      h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
      await h.flush()
      expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(0)
      expect(h.registry.entries('s1')?.active.some((e) => e.id === CLIENT_UUID && e.state === 'in-flight')).toBe(true)
      h.registry.dispose('s1')
    }
  })
})

describe('D14①b（G2）：无标记且命中清单宽限后静默终局', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('响应丢失形态：宽限（10s）后 watchdog 对账轮静默终局 + 双成因日志 + 通知 + occupancy 收尾，不重投', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // 清单就绪但 prompt 无 disposition（pi 重启响应丢失模拟：handled 永不到来）
      const h = makeHarness({ commands: [{ name: 'todos', source: 'extension' }], promptResult: { disposition: 'started' } })
      await attachWithCommandList(h)
      h.registry.submit('s1', { content: '/todos', clientUuid: CLIENT_UUID })
      await h.flush()
      expect(h.registry.entries('s1')?.active.some((e) => e.id === CLIENT_UUID && e.state === 'in-flight')).toBe(true)
      const promptCallsAtSweep = h.client.prompt.mock.calls.length
      // 推进：越过在途宽限（10s）→ watchdog tick（30s 周期）触发对账轮
      await vi.advanceTimersByTimeAsync(30_000)
      await h.flush()
      // 静默终局：delivered tombstone + 通知，不重投
      const full = h.registry.entries('s1')
      expect(full?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'delivered')).toBe(true)
      expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(1)
      expect(h.client.prompt.mock.calls.length).toBe(promptCallsAtSweep) // 不重投
      // 双成因日志（D14①b：排障按 pi 侧进程记录区分，不按单一成因误导）。
      // registry warn 形态 = console.warn('[session-delivery]', ...args)——全参拼接匹配。
      const g2log = warnSpy.mock.calls.find((args) => args.map(String).join(' ').includes('command entry finalized without receipt'))
      expect(g2log).toBeDefined()
      expect(g2log!.map(String).join(' ')).toContain('pi restart response loss OR stale command list false-positive')
      // D3③ occupancy 收尾：清空最后一笔在途条目 → dispatching→idle
      expect(h.occupancyTurn()).toBe('idle')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('宽限未到不提前终局（10s 宽限早于 30s 空窗计时器——不与投递竞速）', async () => {
    const h = makeHarness({ commands: [{ name: 'todos', source: 'extension' }], promptResult: { disposition: 'started' } })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '/todos', clientUuid: CLIENT_UUID })
    await h.flush()
    await vi.advanceTimersByTimeAsync(9_000)
    expect(h.registry.entries('s1')?.active.some((e) => e.id === CLIENT_UUID && e.state === 'in-flight')).toBe(true)
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(0)
  })

  it('带标记条目不属命令静默终局判据面：transcript 未命中走既有 requeue 重投路径（G2 判据只作用于无标记命令条目）', async () => {
    const h = makeHarness({ commands: [{ name: 'todos', source: 'extension' }], promptResult: {} })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '普通消息', clientUuid: CLIENT_UUID })
    await h.flush()
    await vi.advanceTimersByTimeAsync(30_000)
    await h.flush()
    // 带标记条目 transcript 未命中 → 既有 requeue 路径（非命令静默终局）
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(0)
    // 回收重投走 busy gate 复核（内核既有语义：busy 由 settled 边沿驱动——真实链 =
    // agent_settled 置 idle 后 gate 开；mock 无事件流，按同一边沿语义模拟）
    applySessionOccupancyTransition(h.view, null, 'idle')
    h.emitSettled()
    await h.flush()
    expect(h.client.prompt.mock.calls.length).toBeGreaterThanOrEqual(2) // requeue 重投
  })
})

describe('D3③：sweep occupancy 收尾（confirm 分支 + 幂等门）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('confirm 分支（transcript 命中）：清空最后一笔在途条目时 dispatching→idle', async () => {
    const bare = CLIENT_UUID.replace(/^u-/, '')
    const h = makeHarness({
      // transcript 已含投递标记（送达事实在 transcript，事件流回执丢失）
      entries: [{ type: 'message', message: { role: 'user', content: `正文\n${markerLiteral(bare)}` } }],
    })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '正文', clientUuid: CLIENT_UUID })
    await h.flush()
    expect(h.occupancyTurn()).toBe('dispatching')
    await vi.advanceTimersByTimeAsync(30_000)
    await h.flush()
    expect(h.registry.entries('s1')?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'delivered')).toBe(true)
    expect(h.occupancyTurn()).toBe('idle')
  })

  it('幂等门：收尾不覆盖 generating（turn 事件已推进时保持真实状态）', async () => {
    const h = makeHarness({ commands: [{ name: 'todos', source: 'extension' }], promptResult: { disposition: 'started' } })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '/todos', clientUuid: CLIENT_UUID })
    await h.flush()
    // turn 事件已推进（真实状态 generating）——G2 终局后的收尾不得覆盖
    applySessionOccupancyTransition(h.view, null, 'generating')
    await vi.advanceTimersByTimeAsync(30_000)
    await h.flush()
    expect(h.occupancyTurn()).toBe('generating')
  })
})

describe('D14③①（G3 闸①）：命令档 prompt 不限时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('命令条目 prompt 以 timeoutMs=0（不限时档）出站；普通消息档位不变（undefined = CMD_TIMEOUT_MS）', async () => {
    const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }] })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
    h.registry.submit('s1', { content: '普通消息', clientUuid: 'u-9c1e2b3a-1111-4222-8333-444455556667' })
    await h.flush()
    expect(h.client.prompt.mock.calls[0]![4]).toBe(0) // 命令档：不限时
    expect(h.client.prompt.mock.calls[1]![4]).toBeUndefined() // 普通档：缺省
  })
})
