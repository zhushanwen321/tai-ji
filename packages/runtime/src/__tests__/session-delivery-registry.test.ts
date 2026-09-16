/**
 * SessionDeliveryRegistry（u2 内核适配层）单元验收测试。
 *
 * 覆盖设计 delivery-ownership-kernel.md 的四类新逻辑：
 * - **检重**（D5② tombstone）+ lane 判定（D1）：同 id 重报不重投；idle/generating/compacting 三档判定
 * - **对账三分处置**（D3 + P-adopt）：自有条目回收重投 / 带标记无记录条目按 transcript 扫描重建 /
 *   无标记外来文本收养
 * - **回执接线**（D2 两阶段）：message_end(user) 裸标记命中 → 条目 delivered + onSettled 记账
 * - **错误分类迁移**（D6）：pi 两条 busy 拒绝串 → compacting 持有重投 / processing 反转 occupancy
 * 另覆盖合批拆分（内核 doSend 合批 → 适配层按标记逐条还原，V1/V6/V9/V10 前提）。
 * 末尾两组为缺陷修复回归（u3a 核验发现）：① 用户回收（cancel/drain）不广播 message.error
 * （V9/V11 语义 = 文本回草稿，非投递失败）；② delivery.resync 对 failed 条目的用户重试
 * （§3.4 错误规格表「重试钮 = resync 单条重报」）。
 *
 * 材料：真实 createDelivery 内核 + 真实 registry + mock pi client / mock session view（
 * 内核 timer 走 vitest fake timers）。pi 事件流用 onEvent 订阅替身驱动（回执注入点）。
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-delivery-registry.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createSessionDeliveryRegistry,
  extractMarkerIds,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
} from '../services/session/session-delivery-registry.js'
import type { IManagedSessionView } from '../services/session/types.js'
import { applySessionOccupancyTransition } from '../services/session/event-interpreter.js'
import type { IPiEngine } from '../services/ports/pi-engine.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { ServerMessage } from '@taiji/shared'
import type { SkillInjectionResult, SkillInjector, SkillNotice } from '../services/session/skill-injector.js'

const PI_COMPACTING_MSG =
  'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
const PI_PROCESSING_MSG =
  "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."

/** mock session view（occupancy 经转移原语写入——sentinel 视图与 IManagedSessionView 结构兼容）。 */
function makeView(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
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
  view?: Partial<IManagedSessionView>
  promptError?: Error
  /** pi 侧 transcript（get_entries 响应 entries） */
  transcript?: Array<{ type: string; message?: { role: string; content: unknown } }>
  /** clear_queue 返回值（槽位滞留文本） */
  cleared?: { steering: string[]; followUp: string[] }
}

function makeHarness(opts: HarnessOptions = {}) {
  const view = makeView(opts.view)
  const published: ServerMessage[] = []
  const settledCbs: Array<(sid: string) => void> = []
  const eventListeners: Array<(e: unknown) => void> = []
  const promptCalls: Array<[string, unknown, unknown]> = []
  const notices = vi.fn()
  let cleared = opts.cleared ?? { steering: [], followUp: [] }

  const client = {
    prompt: vi.fn(async (text: string, images?: unknown, behavior?: unknown) => {
      promptCalls.push([text, images, behavior])
      if (opts.promptError) throw opts.promptError
      return {}
    }),
    getEntries: vi.fn(async () => ({ data: { entries: opts.transcript ?? [] } })),
    clearQueue: vi.fn(async () => {
      const out = cleared
      cleared = { steering: [], followUp: [] }
      return out
    }),
    onEvent: vi.fn((cb: (e: unknown) => void) => {
      eventListeners.push(cb)
      return () => {
        const i = eventListeners.indexOf(cb)
        if (i >= 0) eventListeners.splice(i, 1)
      }
    }),
  }
  const injector = {
    inject: vi.fn(async (_client: unknown, text: string): Promise<SkillInjectionResult> => ({
      text: text,
      notices: [] as SkillNotice[],
    })),
  } as unknown as SkillInjector
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === view.id ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: (cb) => {
      settledCbs.push(cb)
      return () => {}
    },
    recordWorkspace: vi.fn(),
    getMessageBus: () =>
      ({ publish: (_sid: string, msg: ServerMessage) => published.push(msg) }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deps, injector)
  /** 推进一帧 pi 事件（回执注入点） */
  const emitPiEvent = (event: unknown): void => {
    for (const cb of [...eventListeners]) cb(event)
  }
  const userMessageEnd = (text: string): void =>
    emitPiEvent({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text }] } })
  const emitSettled = (sid = view.id): void => {
    for (const cb of settledCbs) cb(sid)
  }
  /** flush 异步链（投递交接 + 对账各 await 段） */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await Promise.resolve()
  }
  return {
    registry, deps, view, client, injector, published, promptCalls, notices,
    emitPiEvent, userMessageEnd, emitSettled, flush,
    setCleared: (next: { steering: string[]; followUp: string[] }) => { cleared = next },
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

describe('u2 检重与 lane 判定', () => {
  it('idle 提交 → lane=direct + 出站文本带裸标记（clientUuid 去 u- 前缀形态）+ prompt 受理', async () => {
    const h = makeHarness()
    const result = h.registry.submit('s1', { content: '你好', clientUuid: 'u-3f2504e0-4f89-41d3-9a0c-0305e82c3301' })
    expect(result.lane).toBe('direct')
    expect(result.clientUuid).toBe('u-3f2504e0-4f89-41d3-9a0c-0305e82c3301')
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    const [text, images, behavior] = h.promptCalls[0]!
    expect(images).toBeUndefined()
    expect(behavior).toBe('steer')
    expect(text).toContain('你好')
    expect(extractMarkerIds(text)).toEqual(['3f2504e0-4f89-41d3-9a0c-0305e82c3301'])
  })

  it('generating 提交 → lane=steer（活跃 run 车道），投递不被持有', async () => {
    const h = makeHarness({ view: { isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } } })
    const result = h.registry.submit('s1', { content: '补充', clientUuid: 'u-11111111-1111-4111-8111-111111111111' })
    expect(result.lane).toBe('steer')
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })

  it('compacting 提交 → lane=queued 且内核持有（不调 prompt）；compaction 结束后边沿自动投递', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')
    const result = h.registry.submit('s1', { content: '压缩中发送', clientUuid: 'u-22222222-2222-4222-8222-222222222222' })
    expect(result.lane).toBe('queued')
    await h.flush()
    expect(h.promptCalls).toHaveLength(0) // 持有：pi 暂不可收（F10）
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('queued')

    // compaction_end 边沿（经转移原语派生）→ 持有期轮询到期后投递
    applySessionOccupancyTransition(h.view, null, 'compacting-end')
    await vi.advanceTimersByTimeAsync(600)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
  })

  it('settling 窗口保守按不可收（检查点 4 降级档）：turn=settling → lane=queued 且不投递', async () => {
    const h = makeHarness({ view: { occupancy: { turn: 'settling', compacting: false, bash: false } } })
    const result = h.registry.submit('s1', { content: 'settling 窗口消息', clientUuid: 'u-33333333-3333-4333-8333-333333333333' })
    expect(result.lane).toBe('queued')
    await h.flush()
    expect(h.promptCalls).toHaveLength(0)
  })

  it('检重（D5② tombstone）：同 clientUuid 已送达后重报被吞（不重投）', async () => {
    const h = makeHarness()
    const id = 'u-44444444-4444-4444-8444-444444444444'
    h.registry.submit('s1', { content: '唯一', clientUuid: id })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    // 送达回执（message_end 命中标记）→ tombstone
    const text = h.promptCalls[0]![0] as string
    h.userMessageEnd(text)
    expect(h.registry.entries('s1')?.tombstones.map((t) => t.id)).toEqual([id])
    // 同 id 重报复（断连 resync 形态）
    h.registry.submit('s1', { content: '唯一', clientUuid: id })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1) // 零新增投递
  })
})

describe('u2 两阶段回执接线（D2）', () => {
  it('message_end(user) 标记命中 → 条目 delivered + onSettled 记账口径（受理不回调）', async () => {
    const h = makeHarness()
    const id = 'u-55555555-5555-4555-8555-555555555555'
    h.registry.submit('s1', { content: '回执用例', clientUuid: id })
    await h.flush()
    // 受理阶段：条目 in-flight（两阶段第一阶段），未终态
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('in-flight')
    expect(h.registry.entries('s1')?.tombstones).toHaveLength(0)

    const text = h.promptCalls[0]![0] as string
    h.userMessageEnd(text)
    const full = h.registry.entries('s1')!
    expect(full.active).toHaveLength(0)
    expect(full.tombstones[0]).toMatchObject({ id, state: 'delivered' })
  })

  it('无标记消息（agent 通路 sendChecked）受理即记账：不永挂 in-flight', async () => {
    const h = makeHarness()
    const handle = h.registry.getOrCreateDelivery('s1')
    await handle.sendChecked({ payload: { kind: 'text', content: 'notify: 子代理完成' } })
    const full = h.registry.entries('s1')!
    expect(h.client.prompt).toHaveBeenCalledWith('notify: 子代理完成', undefined, 'steer')
    expect(full.active).toHaveLength(0)
    expect(full.tombstones).toHaveLength(1)
  })
})

describe('u2 对账器三分处置（D3）', () => {
  it('own：槽位滞留在途条目 → clear_queue 收回 → 队首重投（同 id）', async () => {
    const h = makeHarness({ view: { isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } } })
    const id = 'u-66666666-6666-4666-8666-666666666666'
    h.registry.submit('s1', { content: '滞留消息', clientUuid: id })
    await h.flush()
    const text = h.promptCalls[0]![0] as string
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('in-flight')

    // settled 边沿（run 结束，槽位无人 drain 的滞留形态）+ 槽位文本 = 该条目
    applySessionOccupancyTransition(h.view, null, 'idle')
    h.setCleared({ steering: [text], followUp: [] })
    h.emitSettled()
    await h.flush()
    expect(h.promptCalls).toHaveLength(2) // 收回重投
    expect(h.promptCalls[1]![0]).toBe(text)
    expect(h.registry.entries('s1')?.active[0]?.id).toBe(id) // 同一条目重投（非新建）
  })

  it('rebuild-未送达：带标记但内核无记录（reattach）→ transcript 无标记 → 重建重投', async () => {
    const h = makeHarness({ transcript: [] })
    h.registry.getOrCreateDelivery('s1') // 已存在投递运行时（真实流前提）
    const text = '孤儿文本\n<!--taiji:msg:77777777-7777-4777-8777-777777777777-->'
    h.setCleared({ steering: [text], followUp: [] })
    await h.registry.reconcile('s1', 'pi-restored')
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]![0]).toBe(text)
    expect(h.registry.entries('s1')?.active[0]?.id).toBe('77777777-7777-4777-8777-777777777777')
  })

  it('rebuild-已送达：transcript 命中标记 → 不重投，只落 delivered 记账（判重锚）', async () => {
    const text = '已落盘文本\n<!--taiji:msg:88888888-8888-4888-8888-888888888888-->'
    const h = makeHarness({
      transcript: [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } }],
      cleared: { steering: [text], followUp: [] },
    })
    h.registry.getOrCreateDelivery('s1')
    await h.registry.reconcile('s1', 'pi-restored')
    await h.flush()
    expect(h.promptCalls).toHaveLength(0) // 不重投（无重复送达）
    expect(h.registry.entries('s1')?.tombstones[0]).toMatchObject({
      id: '88888888-8888-4888-8888-888888888888',
      state: 'delivered',
    })
  })

  it('adopt：无标记外来文本（notifyDone 形态）→ 收养以新 id 正常投递（不丢弃不原样回塞）', async () => {
    const h = makeHarness()
    h.registry.getOrCreateDelivery('s1')
    h.setCleared({ steering: ['subagent notifyDone 原文'], followUp: [] })
    await h.registry.reconcile('s1', 'agent-settled')
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    const text = h.promptCalls[0]![0] as string
    expect(text).toContain('subagent notifyDone 原文')
    // 收养条目带新标记（内核出站身份；D3③ 收养 = 入内核 FIFO 正常投递）
    expect(extractMarkerIds(text)).toHaveLength(1)
    expect(h.registry.entries('s1')?.active[0]?.lane).toBe('direct')
  })

  it('槽位为空 → 无处置（clear_queue 返回空不入重建/收养通道）', async () => {
    const h = makeHarness()
    h.registry.getOrCreateDelivery('s1')
    await h.registry.reconcile('s1', 'agent-settled')
    await h.flush()
    expect(h.promptCalls).toHaveLength(0)
    expect(h.registry.entries('s1')?.active).toHaveLength(0)
  })

  it('非空闲不触发对账（触发条件①）：generating 时即使槽位非空也不清（不抢占活跃 run）', async () => {
    const h = makeHarness({
      view: { isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } },
      cleared: { steering: ['滞留'], followUp: [] },
    })
    await h.registry.reconcile('s1', 'watchdog')
    await h.flush()
    expect(h.client.clearQueue).not.toHaveBeenCalled()
  })
})

describe('u2 错误分类迁移（D6）', () => {
  it('pi 报压缩中（TOCTOU）→ 回到持有等待（不投失败），compaction 结束后重投', async () => {
    const h = makeHarness({ promptError: new Error(PI_COMPACTING_MSG) })
    h.registry.submit('s1', { content: '撞压缩窗口', clientUuid: 'u-99999999-9999-4999-8999-999999999999' })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1) // 首次尝试
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('queued') // 未转 failed（持有重试而非失败）
    // 结束后重试成功（清错误 → 走持有期轮询释放路径）
    h.client.prompt.mockImplementation(async (text: string, images?: unknown, behavior?: unknown) => {
      h.promptCalls.push([text, images, behavior])
      return {}
    })
    // pi 侧 compaction_end 事件 = 持有释放条件（D6 事件驱动，不空转轮询）
    h.emitPiEvent({ type: 'compaction_end', reason: 'manual', aborted: false, willRetry: false })
    await vi.advanceTimersByTimeAsync(1200)
    await h.flush()
    expect(h.promptCalls.length).toBeGreaterThanOrEqual(2)
    expect(h.registry.entries('s1')?.tombstones).toHaveLength(0)
  })

  it('pi 报 already processing（runtime 不知情的 turn）→ occupancy 反转 generating + 按 steer 重投', async () => {
    const h = makeHarness({ promptError: new Error(PI_PROCESSING_MSG) })
    h.registry.submit('s1', { content: '幽灵空闲撞墙', clientUuid: 'u-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    await h.flush()
    // 权威信号反转：pi 有 turn 在跑 → occupancy turn=generating（防幽灵空闲死循环）
    const occ = h.view.occupancy
    expect(occ?.turn).toBe('generating')
    expect(h.view.isGenerating).toBe(true)
    // 重投（第二次 prompt）成功 → 条目继续在途（不再撞墙）
    expect(h.promptCalls.length).toBeGreaterThanOrEqual(2)
    expect(h.promptCalls[1]![2]).toBe('steer')
  })

  it('非 busy 错误（auth 失败等）不上反转、按失败抛出（内核受理失败路径）', async () => {
    const h = makeHarness({ promptError: new Error('Authentication failed: 401') })
    h.registry.submit('s1', { content: '真失败', clientUuid: 'u-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })
    await h.flush()
    // 入口即拦：checked 受理失败 → 条目移出内核（不留幽灵）+ message.error 广播可见
    expect(h.registry.entries('s1')?.active).toHaveLength(0)
    expect(h.published.some((m) => m.type === 'message.error')).toBe(true)
    expect(h.view.occupancy?.turn).toBe('idle') // 未伪造 busy
  })
})

describe('u2 合批拆分（内核合批 → 适配层逐条还原）', () => {
  it('持有多条后释放：逐条投递为独立 prompt（不合并成一条）', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')
    h.registry.submit('s1', { content: '第一条', clientUuid: 'u-cccccccc-cccc-4ccc-8ccc-cccccccccccc' })
    h.registry.submit('s1', { content: '第二条', clientUuid: 'u-dddddddd-dddd-4ddd-8ddd-dddddddddddd' })
    await h.flush()
    expect(h.promptCalls).toHaveLength(0)

    applySessionOccupancyTransition(h.view, null, 'compacting-end')
    await vi.advanceTimersByTimeAsync(600)
    await h.flush()
    await h.flush()
    // 逐条（非合批）：两条 prompt 调用，各自文本含自身内容与标记
    expect(h.promptCalls.map((c) => c[0]).some((t) => (t as string).includes('第一条'))).toBe(true)
    expect(h.promptCalls.map((c) => c[0]).some((t) => (t as string).includes('第二条'))).toBe(true)
    expect(h.promptCalls.every((c) => !(c[0] as string).includes('第一条') || !(c[0] as string).includes('第二条'))).toBe(true)
    expect(h.promptCalls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('u2 撤销（cancel）', () => {
  it('queued 态撤销：本地移除 + 文本随回执返回（不投递）', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')
    const id = 'u-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    h.registry.submit('s1', { content: '要撤的', clientUuid: id })
    await h.flush()
    const outcome = await h.registry.cancel('s1', id)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.content).toContain('要撤的')
    applySessionOccupancyTransition(h.view, null, 'compacting-end')
    await vi.advanceTimersByTimeAsync(600)
    await h.flush()
    expect(h.promptCalls).toHaveLength(0) // 撤销生效：未投递
  })

  it('投递中撤销（在槽位）：clear_queue 收回 → 目标回草稿、其余保持相对序重投', async () => {
    const h = makeHarness({ view: { isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } } })
    const keepId = 'u-ffffffff-ffff-4fff-8fff-ffffffffffff'
    const dropId = 'u-01234567-89ab-4cde-8f01-23456789abcd'
    h.registry.submit('s1', { content: '保留的', clientUuid: keepId })
    await h.flush()
    h.registry.submit('s1', { content: '撤销的', clientUuid: dropId })
    await h.flush()
    const texts = h.promptCalls.map((c) => c[0] as string)
    const keepText = texts.find((t) => t.includes('保留的'))!
    const dropText = texts.find((t) => t.includes('撤销的'))!
    h.setCleared({ steering: [keepText, dropText], followUp: [] })

    const outcome = await h.registry.cancel('s1', dropId)
    expect(outcome.cancelled).toBe(true)
    expect(outcome.content).toContain('撤销的')
    await h.flush()
    // 目标条目已终态（tombstone cancelled）
    expect(h.registry.entries('s1')?.tombstones.some((t) => t.id === dropId && t.state === 'cancelled')).toBe(true)
    // 其余条目保持相对序重投：gate 在 run 活跃期不开（v1 三标志语义），settled 边沿驱动
    applySessionOccupancyTransition(h.view, null, 'idle')
    h.emitSettled()
    await h.flush()
    const redelivered = h.promptCalls.slice(2).map((c) => c[0] as string)
    expect(redelivered.some((t) => t.includes('保留的'))).toBe(true)
    expect(redelivered.every((t) => !t.includes('撤销的'))).toBe(true)
  })
})

// ── 缺陷修复回归①：用户回收（cancel/drain）不广播 message.error（V9/V11） ──────
// 缺陷：内核 cancel/drain 对挂起 sendChecked waiter 的 reject（'delivery cancelled' /
// 'delivery drained'）走 onDeliveryFailure 的无条件广播面 → 撤销成功仍弹错误气泡，与
// 「文本回草稿」语义矛盾（设计 §3.4 / V9 / V11）。修复 = 双信号过滤（契约文案前缀 +
// 条目不在 active 且 tombstone=cancelled）后只记日志；真失败（受理失败 / 重试耗尽）不受影响。

describe('回收语义（V9/V11）：cancel/drain 不广播 message.error', () => {
  const errorsOf = (published: ServerMessage[]): ServerMessage[] =>
    published.filter((m) => m.type === 'message.error')

  it('queued 态撤销：无 message.error（撤销 = 文本回草稿）+ 条目终态 cancelled', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')
    const id = 'u-10000001-0000-4000-8000-000000000001'
    h.registry.submit('s1', { content: '要撤的', clientUuid: id })
    await h.flush()

    const outcome = await h.registry.cancel('s1', id)
    await h.flush()

    expect(outcome.cancelled).toBe(true)
    expect(outcome.content).toContain('要撤的')
    expect(errorsOf(h.published)).toHaveLength(0)
    expect(h.registry.entries('s1')?.active).toHaveLength(0)
    expect(h.registry.entries('s1')?.tombstones).toMatchObject([{ id, state: 'cancelled' }])
  })

  it('投递中（出站批次在途、条目仍 queued）撤销：无 message.error + 挂起 waiter 收尾不留悬挂', async () => {
    const h = makeHarness()
    // 出站批次卡在 prompt（未受理窗口）：条目仍 queued，sendChecked 挂起（reject 面可达）
    h.client.prompt.mockImplementation(() => new Promise(() => {}))
    const id = 'u-10000002-0000-4000-8000-000000000002'
    h.registry.submit('s1', { content: '投递中撤的', clientUuid: id })
    await h.flush()
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('queued')

    const outcome = await h.registry.cancel('s1', id)
    await h.flush()

    expect(outcome.cancelled).toBe(true)
    expect(outcome.content).toContain('投递中撤的')
    expect(errorsOf(h.published)).toHaveLength(0)
    expect(h.registry.entries('s1')?.tombstones).toMatchObject([{ id, state: 'cancelled' }])
  })

  it('delivery.drain（forceQuit 全量回收）：无 message.error + 全文取回 + cancelled 判重锚', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')
    const id1 = 'u-10000003-0000-4000-8000-000000000003'
    const id2 = 'u-10000004-0000-4000-8000-000000000004'
    h.registry.submit('s1', { content: '第一条', clientUuid: id1 })
    h.registry.submit('s1', { content: '第二条', clientUuid: id2 })
    await h.flush()

    const drained = h.registry.drain('s1')
    await h.flush()

    expect(drained.map((d) => d.clientUuid)).toEqual([id1, id2])
    expect(drained[0]?.content).toContain('第一条')
    expect(drained[1]?.content).toContain('第二条')
    expect(errorsOf(h.published)).toHaveLength(0)
    expect(h.registry.entries('s1')?.active).toHaveLength(0)
    // drain 后同 id 重报不复活（cancelled tombstone 判重锚）：resync 返回判重命中集
    await expect(h.registry.resync('s1', [id1])).resolves.toEqual([id1])
  })

  it('真失败（受理失败）仍有 message.error：过滤条件不吞真失败', async () => {
    const h = makeHarness({ promptError: new Error('Authentication failed: 401') })
    const id = 'u-10000005-0000-4000-8000-000000000005'
    h.registry.submit('s1', { content: '真失败', clientUuid: id })
    await h.flush()

    const errors = errorsOf(h.published)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      type: 'message.error',
      payload: { message: expect.stringContaining('Authentication failed: 401') },
    })
    // 受理失败条目入口即拦（移出内核、不落 cancelled tombstone）——非回收语义
    expect(h.registry.entries('s1')?.tombstones).toHaveLength(0)
  })
})

// ── 缺陷修复回归②：delivery.resync 用户重试（§3.4「重试钮 = resync 单条重报」） ──
// 缺陷：resync 对 active 中的 id 一律 skip → failed 条目点重试零反应，「不会静默积压」的
// 恢复动作落空。修复 = 对 active 中 state='failed' 的重报 id 走内核 requeue（failed → queued
// 唯一入口）+ flush；其余 active 条目（queued/in-flight）行为不变。

describe('delivery.resync 用户重试（§3.4 重试钮）：failed → queued 并重投', () => {
  it('failed 条目经 resync 单条重报 → 回到 queued 并重投（pi 恢复后闭环 delivered）', async () => {
    const h = makeHarness({ promptError: new Error('pi unreachable') })
    const handle = h.registry.getOrCreateDelivery('s1')
    const id = 'u-20000001-0000-4000-8000-000000000001'
    // failed 只能由非 checked 批次产生（checked 条目入口即拦 reject，不落 failed）——
    // agent 通路经 handle.send 提交（completion-backflow 同形）。内核 backoff 默认
    // ms=100 / max=50 → 第 51 次尝试转 failed（§3.4 重试耗尽行）。
    handle.send({ payload: { kind: 'text', content: '重试我' } }, { id })
    await h.flush()
    for (let i = 0; i < 60; i += 1) await vi.advanceTimersByTimeAsync(100)
    await h.flush()
    expect(h.registry.entries('s1')?.active[0]).toMatchObject({ id, state: 'failed' })
    const attemptsBeforeRetry = h.promptCalls.length
    expect(attemptsBeforeRetry).toBeGreaterThan(50)

    // 用户点重试钮 = delivery.resync 单条重报：failed → queued（requeue）+ 立即 flush
    const deduped = await h.registry.resync('s1', [id])
    expect(deduped).toEqual([]) // 非终态：不进判重命中集（条目仍是队列行）
    await h.flush()
    expect(h.registry.entries('s1')?.active[0]).toMatchObject({ id, state: 'queued' })
    expect(h.promptCalls.length).toBeGreaterThan(attemptsBeforeRetry) // 重投确实发生

    // pi 可达后重投受理成功 → 终态 delivered（恢复动作闭环）
    h.client.prompt.mockImplementation(async (text: string, images?: unknown, behavior?: unknown) => {
      h.promptCalls.push([text, images, behavior])
      return {}
    })
    await vi.advanceTimersByTimeAsync(150)
    await h.flush()
    const full = h.registry.entries('s1')!
    expect(full.active).toHaveLength(0)
    expect(full.tombstones.some((t) => t.id === id && t.state === 'delivered')).toBe(true)
  })

  it('resync 对 queued/delivered 条目保持现状（不误重投）：queued 不动 + delivered 命中判重集', async () => {
    const h = makeHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')
    const heldId = 'u-20000002-0000-4000-8000-000000000002'
    h.registry.submit('s1', { content: '滞留中', clientUuid: heldId })
    await h.flush()

    await expect(h.registry.resync('s1', [heldId])).resolves.toEqual([])
    await h.flush()
    expect(h.registry.entries('s1')?.active[0]).toMatchObject({ id: heldId, state: 'queued' })
    expect(h.promptCalls).toHaveLength(0) // 持有期不因 resync 抢跑

    applySessionOccupancyTransition(h.view, null, 'compacting-end')
    await vi.advanceTimersByTimeAsync(600)
    await h.flush()
    const sent = h.promptCalls[0]?.[0] as string
    h.userMessageEnd(sent) // 送达回执
    await expect(h.registry.resync('s1', [heldId])).resolves.toEqual([heldId])
  })
})
