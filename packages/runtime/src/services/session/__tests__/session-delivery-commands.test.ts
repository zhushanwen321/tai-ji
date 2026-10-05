/**
 * 无标记条目链路内核测试（pi1-disposition-chat-flow U1 起源；ADR-0122 命令终局事件化 +
 * skill-input-marker-pollution started 基终局后的现行契约）：
 * - D2① 命令识别与不注标出站（清单缓存 + 识别 + 裸命令文本）；手打 skill / prompt 模板
 *   与 `<taiji-skill>` 芯片标记同判（无标记条目统一识别集）
 * - G3③ 受理回执标志（isCommand 随 submit 回执返回，前端空窗豁免契约）
 * - D1② handled → delivered tombstone 终局 + D1③ 终局通知 + resync 判重防线继承
 * - 断连终局事件化（ADR-0122）：handled/queued/started disposition = 无标记条目的受理
 *   终局（prompt 响应即受理回执，零时间窗零扫描）；pi 断连 → 在途条目批量显式失败
 *   （message.error 逐条上报）+ 撤销待收回条目就地兑现
 * - D2 清单新鲜度：get_commands 失败 → 全量按普通消息出站（分支 c 兜底）
 *
 * [已不可达用例删除登记] 原「D14①b（G2）无标记条目宽限后静默终局」「D3③ sweep
 * occupancy 收尾」两 describe 随 sweepInFlight（10s 宽限 + transcript 比对）整体退役
 * （ADR-0122 命令终局事件化：回执长时间不到的唯一现实成因 = 进程死亡，由断连事件
 * 收口）而不可达，2026-10-05 投递域清理批次删除。
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

  it('queued / started 响应 = 无标记条目受理终局：delivered tombstone + 通知（ADR-0122 终局事件化）', async () => {
    for (const disposition of ['queued', 'started']) {
      const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }], promptResult: { disposition } })
      await attachWithCommandList(h)
      h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
      await h.flush()
      // prompt 响应即受理回执：三值同为「pi 已受理输入」的确定性事实，终局零时间窗
      const full = h.registry.entries('s1')
      expect(full?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'delivered')).toBe(true)
      expect(full?.active.some((e) => e.id === CLIENT_UUID)).toBe(false)
      expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(1)
      h.registry.dispose('s1')
    }
  })

  it('started 终局（技能通路 started 基终局）：手打 skill 条目 delivered tombstone + 通知', async () => {
    const h = makeHarness({ commands: [{ name: 'skill:search', source: 'skill' }], promptResult: { disposition: 'started' } })
    await attachWithCommandList(h)
    const receipt = h.registry.submit('s1', { content: '/skill:search', clientUuid: CLIENT_UUID })
    expect(receipt.isCommand).toBe(true) // 空窗豁免标志随识别集扩展覆盖技能条目
    await h.flush()
    const outbound = h.client.prompt.mock.calls[0]![0] as string
    expect(outbound).toBe('/skill:search') // 不注标出站：纯单词 skillName 不被尾附标记污染
    const full = h.registry.entries('s1')
    expect(full?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'delivered')).toBe(true)
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(1)
  })

  it('started 响应对带标记条目不终局：等待 message_end 标记回执（D4）', async () => {
    const h = makeHarness({ promptResult: { disposition: 'started' } })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '普通消息', clientUuid: CLIENT_UUID })
    await h.flush()
    expect(h.registry.entries('s1')?.active.some((e) => e.id === CLIENT_UUID && e.state === 'in-flight')).toBe(true)
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(0)
  })
})

describe('芯片通路识别（skill-input-marker-pollution：统一切 started 基终局）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('正文含 <taiji-skill> 标记 → 无标记出站 + started 终局（不依赖清单就绪）', async () => {
    const h = makeHarness({ promptResult: { disposition: 'started' } })
    await attachWithCommandList(h)
    const receipt = h.registry.submit('s1', { content: '正文 <taiji-skill name="review"/>', clientUuid: CLIENT_UUID })
    expect(receipt.isCommand).toBe(true)
    await h.flush()
    const outbound = h.client.prompt.mock.calls[0]![0] as string
    expect(outbound).toBe('正文 <taiji-skill name="review"/>') // 不注标出站
    expect(h.registry.entries('s1')?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'delivered')).toBe(true)
    expect(h.published.filter((m) => m.type === 'session.deliveryHandled').length).toBe(1)
  })
})

describe('断连终局事件（ADR-0122：pi 进程死亡 → 挂起投递批量显式失败）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('断连 → in-flight 条目批量 failed + message.error 逐条上报（用户可见「执行结果未确认」）', async () => {
    const h = makeHarness({ promptResult: {} }) // 无 disposition：条目受理后留守 in-flight
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '消息一', clientUuid: CLIENT_UUID })
    const SECOND = 'u-9c1e2b3a-1111-4222-8333-444455556667'
    h.registry.submit('s1', { content: '消息二', clientUuid: SECOND })
    await h.flush()
    expect(h.registry.entries('s1')?.active.every((e) => e.state === 'in-flight')).toBe(true)

    h.registry.onPiDisconnected('s1')
    // 显式失败终局：条目转 failed（留守活跃集等用户处置），逐条用户可见上报
    const errors = h.published.filter((m) => m.type === 'message.error')
    expect(errors.length).toBe(2)
    for (const e of errors) {
      const payload = e.payload as { sessionId: string; message: string }
      expect(payload.sessionId).toBe('s1')
      expect(payload.message).toContain('执行结果未确认')
      expect(payload.message).toContain('重发前请核对')
    }
    const states = h.registry.entries('s1')?.active.map((e) => e.state)
    expect(states).toEqual(['failed', 'failed'])
    // 失败条目经 resync 用户重试通路复活（failed → queued → 重投）
    applySessionOccupancyTransition(h.view, null, 'idle')
    const retried = await h.registry.resync('s1', [CLIENT_UUID, SECOND])
    expect(retried).toEqual([])
    await h.flush()
    expect(h.client.prompt.mock.calls.length).toBeGreaterThanOrEqual(4) // 2 首投 + 2 重投
  })

  it('断连 → 撤销待收回条目就地兑现（cancelled 终态，不重投不复活）', async () => {
    const h = makeHarness({ promptResult: {} })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '要撤的消息', clientUuid: CLIENT_UUID })
    await h.flush()
    expect(h.registry.entries('s1')?.active[0]!.state).toBe('in-flight')
    // 用户撤销：in-flight → 待收回（意图登记，收回失败留守）
    const cancelOutcome = await h.registry.cancel('s1', CLIENT_UUID)
    expect(cancelOutcome.cancelled).toBe(false) // 收回未兑现（clearQueue mock 返回空集）
    expect(h.registry.entries('s1')?.active[0]!.state).toBe('in-flight')

    h.registry.onPiDisconnected('s1')
    // 进程死亡 = 文本已离场：撤销意图就地兑现，不报失败
    const full = h.registry.entries('s1')
    expect(full?.active.some((e) => e.id === CLIENT_UUID)).toBe(false)
    expect(full?.tombstones.some((t) => t.id === CLIENT_UUID && t.state === 'cancelled')).toBe(true)
    expect(h.published.filter((m) => m.type === 'message.error').length).toBe(0)
  })

  it('断连幂等：无运行时 / 无在途条目时 no-op', async () => {
    const h = makeHarness({ promptResult: { disposition: 'handled' }, commands: [{ name: 'plan', source: 'extension' }] })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
    await h.flush()
    expect(h.registry.entries('s1')?.active).toHaveLength(0)
    expect(() => h.registry.onPiDisconnected('s1')).not.toThrow()
    expect(() => h.registry.onPiDisconnected('s2')).not.toThrow()
  })
})

describe('D14③①（G3 闸①）：命令档 prompt 不限时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('命令条目与普通消息同参出站（命令档墙钟豁免已随 ADR-0122 退役）', async () => {
    const h = makeHarness({ commands: [{ name: 'plan', source: 'extension' }] })
    await attachWithCommandList(h)
    h.registry.submit('s1', { content: '/plan', clientUuid: CLIENT_UUID })
    h.registry.submit('s1', { content: '普通消息', clientUuid: 'u-9c1e2b3a-1111-4222-8333-444455556667' })
    await h.flush()
    expect(h.client.prompt.mock.calls[0]!.length).toBeLessThanOrEqual(3) // 无墙钟档位实参
    expect(h.client.prompt.mock.calls[1]!.length).toBeLessThanOrEqual(3)
  })
})
