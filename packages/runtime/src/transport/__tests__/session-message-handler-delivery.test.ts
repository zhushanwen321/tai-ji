/**
 * delivery.* 四 RPC + session.delivery state topic 装配测试（投递所有权内核 u3a；设计 §3.3
 * D5/D7/D9②、§3.4 错误规格表、§4 V5 断连重连重放）。
 *
 * 覆盖：
 * - handles/routes 认领 delivery.submit / cancel / drain / resync（协议配对用例面）
 * - submit：reply 形态（clientUuid + 帧四态之一 + lane）+ 帧发布（条目可见、preview 剥投递
 *   标记 + 截断）+ 内核状态迁移经 onChange 跟随（queued → in-flight）
 * - 持有态（compacting）：lane/state 双 queued（V9 队列态可撤的帧形态前提）
 * - 帧数据源 = 内核 entries() **投影视图**（D9②/D5③）：cancelled 不投影、delivered 投影、
 *   tombstone 元数据不泄漏；假句柄路锁定「以 entries(options) 投影形态调用」（防误用全量视图）
 * - 变更驱动（onChange）而非轮询：无变更推进 60s 零新帧（负断言）
 * - state topic last-value（真实 MessageBus）：同 session 多帧 stateSnapshot 只留最新 +
 *   不入 ring + topicOf('session.delivery') === 'state'（登记表锁）
 * - session.subscribe reply 的 stateSnapshot 含 delivery 帧（切 session/重连恢复装配面，V5）
 * - cancel：queued 可撤（cancelled:true + 全文回草稿、剥标记）+ 不可撤分支（cancelled:false
 *   + reason，不谎报，§3.4）
 * - drain：发送序全量取回 + 帧空条目集形态（entries: []）
 * - resync：deduped 命中已送达条目 + reply 不携带条目（单源防分叉）+ 存留状态经帧恢复
 * - 防御路径：注册表未注入 → delivery_unsupported；字段校验 → invalid_payload
 * - releaseDeliveryTopic（session 销毁清理）解绑后不再发帧
 *
 * Mock 边界：真实 SessionDeliveryRegistry（组合根同构 deps：mock session view + mock pi
 * 句柄 + 真实 MessageBus 实例）；不触真实数据目录（无 fs 面）；真 pi 不拉起。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-delivery.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import { DELIVERY_PREVIEW_MAX_CHARS, SessionDeliveryTopic, deliveryPreview, stripDeliveryMarkers } from '../session-delivery-topic.js'
import {
  createSessionDeliveryRegistry,
  resetActiveDeliveryRegistryForTest,
  type SessionDeliveryDeps,
  type SessionDeliveryRegistry,
} from '../../services/session/session-delivery-registry.js'
import { MessageBus, topicOf } from '../../services/message-bus/message-bus.js'
import type { BusClient } from '../../services/message-bus/types.js'
import type { IManagedSessionView } from '../../services/session/types.js'
import type { IPiEngine } from '../../services/ports/pi-engine.js'
import type { SkillInjector, SkillInjectionResult } from '../../services/session/skill-injector.js'
import type { DeliveryEntry, DeliveryHandle, DeliveryHandleV2, DeliveryProjectionOptions } from '@zhushanwen/session-delivery'
import type { ClientMessage, ServerMessage } from '@taiji/shared'

// ── 常量 / 装置 ───────────────────────────────────────────────────

const SID = 'sess-delivery-1'
const SID_UNKNOWN = 'sess-delivery-unknown'
const UUID_A = 'u-11111111-1111-4111-8111-111111111111'
const UUID_B = 'u-22222222-2222-4222-8222-222222222222'
const UUID_C = 'u-33333333-3333-4333-8333-333333333333'
const UUID_UNKNOWN = 'u-99999999-9999-4999-8999-999999999999'

/** 富内容消息形态（core u3b：prompt 文本 + msg-id-mapper 的 u- 标记）——预览必须剥掉。 */
const MARKED_CONTENT = `PLEASE_DELIVER_${'X'.repeat(120)}\n<!--taiji:msg:${UUID_A}-->`

function makeSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: SID,
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

function makeFakeHandle(entries: DeliveryEntry[]) {
  let current = entries
  const subs = new Set<() => void>()
  const handle = {
    send: vi.fn(),
    sendChecked: vi.fn(async () => {}),
    flush: vi.fn(),
    depth: vi.fn(() => 0),
    dispose: vi.fn(),
    // 双视图分流：无参 = 全量视图（active + tombstones），带 options = 投影视图（D9②）
    entries: vi.fn((options?: DeliveryProjectionOptions) =>
      options === undefined
        ? { active: current, tombstones: [{ id: 'tombstone-leak', state: 'cancelled', lane: 'queued', settledAt: 1 }] }
        : { entries: current },
    ),
    onChange: vi.fn((cb: () => void) => {
      subs.add(cb)
      return () => {
        subs.delete(cb)
      }
    }),
  }
  return {
    handle,
    setEntries: (next: DeliveryEntry[]) => {
      current = next
      for (const cb of [...subs]) cb()
    },
    /** 退订是否仍生效（release 断言用）。 */
    subscriberCount: () => subs.size,
  }
}

function makeEntry(id: string, state: DeliveryEntry['state'], lane: DeliveryEntry['lane']): DeliveryEntry {
  return { id, state, lane, payload: { kind: 'text', content: `body-${id}` }, createdAt: 1, updatedAt: 1, sendAttempts: 0 }
}

interface Harness {
  handler: SessionMessageHandler
  registry: SessionDeliveryRegistry
  bus: MessageBus
  session: IManagedSessionView
  promptFn: ReturnType<typeof vi.fn>
  /** 真实内核句柄（registry 装配；伪造句柄用例自带独立类型，见 makeFakeHandle）。 */
  handle: DeliveryHandleV2
  sent: ServerMessage[]
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { code: string; message: string; id?: string; details?: Record<string, unknown> }[]
  flush: () => Promise<void>
  frames: () => ServerMessage<'session.delivery'>[]
  lastFrame: () => ServerMessage<'session.delivery'> | undefined
  frameUuids: () => string[]
  attachSubscriber: () => BusClient
}

function makeHarness(opts: { session?: Partial<IManagedSessionView>; withRegistry?: boolean; withBus?: boolean } = {}): Harness {
  const session = makeSession(opts.session)
  const promptCalls: unknown[][] = []
  const promptFn = vi.fn(async (...args: unknown[]) => {
    promptCalls.push(args)
  })
  const piClient = {
    prompt: promptFn,
    touchActivity: vi.fn(),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
  }
  const bus = new MessageBus()
  const sent: ServerMessage[] = []
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === SID ? session : undefined),
    ensureActive: async () => piClient as unknown as IPiEngine,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => bus,
  }
  const injector = {
    inject: vi.fn(async (_c: IPiEngine, text: string): Promise<SkillInjectionResult> => ({ text, notices: [] })),
  } as unknown as SkillInjector
  const registry = createSessionDeliveryRegistry(deps, injector)
  const handle = registry.getOrCreateDelivery(SID)

  const replies: Harness['replies'] = []
  const errors: Harness['errors'] = []
  let pushSeq = 0
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      errors.push({ code, message, id, details })
    }),
    sessionService: {} as unknown as SessionHandlerContext['sessionService'],
    nextPushId: vi.fn(() => {
      pushSeq += 1
      return `push-${pushSeq}`
    }),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    ...(opts.withRegistry === false ? {} : { deliveryRegistry: registry }),
    ...(opts.withBus === false ? {} : { messageBus: bus }),
  }
  const handler = new SessionMessageHandler(ctx as unknown as SessionHandlerContext)

  const frames = (): ServerMessage<'session.delivery'>[] =>
    sent.filter((m): m is ServerMessage<'session.delivery'> => m.type === 'session.delivery')

  return {
    handler,
    registry,
    bus,
    session,
    promptFn,
    handle,
    sent,
    replies,
    errors,
    flush: async () => {
      for (let i = 0; i < 40; i += 1) await Promise.resolve()
    },
    frames,
    lastFrame: () => frames()[frames().length - 1],
    frameUuids: () => {
      const entries = frames()[frames().length - 1]?.payload.entries ?? []
      return entries.map((e) => e.clientUuid)
    },
    attachSubscriber: () => {
      const client: BusClient = {
        readyState: 1,
        send: (raw: string) => {
          sent.push(JSON.parse(raw) as ServerMessage)
        },
      }
      return client
    },
  }
}

function msg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

const WS = {} as never

/** 订阅该 session 的一条连接（live 帧落到 harness.sent）。 */
function subscribeLive(h: Harness): BusClient {
  const client = h.attachSubscriber()
  h.bus.subscribe(SID, client)
  return client
}

/** 最后一条指定 type 的 reply payload。 */
function replyOf(h: Harness, type: string): Record<string, unknown> | undefined {
  const hits = h.replies.filter((r) => r.type === type)
  return hits[hits.length - 1]?.payload
}

function frameEntries(h: Harness): ServerMessage<'session.delivery'>['payload']['entries'] {
  return h.lastFrame()?.payload.entries ?? []
}

beforeEach(() => {
  vi.useFakeTimers()
  resetActiveDeliveryRegistryForTest()
})

afterEach(() => {
  vi.useRealTimers()
  resetActiveDeliveryRegistryForTest()
})

// ── 协议面：RPC 认领 ──────────────────────────────────────────────

describe('delivery 域 RPC 认领（D5 四 RPC）', () => {
  it('handles 认领 delivery.submit / cancel / drain / resync', () => {
    const h = makeHarness()
    expect(h.handler.handles).toEqual(
      expect.arrayContaining(['delivery.submit', 'delivery.cancel', 'delivery.drain', 'delivery.resync']),
    )
  })
})

// ── delivery.submit ──────────────────────────────────────────────

describe('delivery.submit 受理 + 帧装配（D1/D5/D9②）', () => {
  it('idle session：reply {clientUuid, state=queued, lane=direct} + 帧含该条目（lane=direct）', async () => {
    const h = makeHarness()
    subscribeLive(h)

    await h.handler.handleSessionMessage(
      msg('delivery.submit', { sessionId: SID, content: MARKED_CONTENT, clientUuid: UUID_A }),
      WS,
    )

    expect(h.errors).toHaveLength(0)
    expect(replyOf(h, 'delivery.submit')).toEqual({ clientUuid: UUID_A, state: 'queued', lane: 'direct' })
    // 用户可见断言：队列区唯一数据源帧里出现该条目（clientUuid = 乐观气泡 id，可 morph/可撤）
    expect(frameEntries(h)).toEqual([{ clientUuid: UUID_A, preview: expect.any(String), state: 'queued', lane: 'direct' }])
  })

  it('preview = 展示投影：剥除投递标记（双形态）+ 按 DELIVERY_PREVIEW_MAX_CHARS 截断，禁止当全文', async () => {
    const h = makeHarness()
    subscribeLive(h)

    await h.handler.handleSessionMessage(
      msg('delivery.submit', { sessionId: SID, content: MARKED_CONTENT, clientUuid: UUID_A }),
      WS,
    )

    const preview = frameEntries(h)[0]?.preview ?? ''
    expect(preview).toContain('PLEASE_DELIVER_')
    expect(preview).not.toContain('taiji:msg')
    expect(preview.length).toBe(DELIVERY_PREVIEW_MAX_CHARS)
  })

  it('变更驱动跟随内核迁移：受理后在途 → 帧 state=in-flight（onChange 装配生效）', async () => {
    const h = makeHarness()
    subscribeLive(h)

    await h.handler.handleSessionMessage(
      msg('delivery.submit', { sessionId: SID, content: 'hello', clientUuid: UUID_A }),
      WS,
    )
    expect(frameEntries(h)[0]?.state).toBe('queued')

    await h.flush() // 内核 port.send 受理完成 → in-flight
    expect(h.promptFn).toHaveBeenCalledTimes(1)
    expect(frameEntries(h)[0]?.state).toBe('in-flight')
  })

  it('持有态（compacting 中）：lane=queued + state=queued（V9 队列态可撤的帧形态）', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })
    subscribeLive(h)

    await h.handler.handleSessionMessage(
      msg('delivery.submit', { sessionId: SID, content: 'hello', clientUuid: UUID_A }),
      WS,
    )

    expect(replyOf(h, 'delivery.submit')).toEqual({ clientUuid: UUID_A, state: 'queued', lane: 'queued' })
    expect(frameEntries(h)[0]).toEqual({ clientUuid: UUID_A, preview: 'hello', state: 'queued', lane: 'queued' })
  })

  it('生成中（generating）：lane=steer（lane 判定单一实现归 runtime 内核，D1）', async () => {
    const h = makeHarness({ session: { isGenerating: true, occupancy: { turn: 'generating', compacting: false, bash: false } } })
    subscribeLive(h)

    await h.handler.handleSessionMessage(
      msg('delivery.submit', { sessionId: SID, content: 'hello', clientUuid: UUID_A }),
      WS,
    )

    expect(replyOf(h, 'delivery.submit')).toMatchObject({ lane: 'steer' })
    expect(frameEntries(h)[0]?.lane).toBe('steer')
  })
})

// ── 帧数据源 = 投影视图（D9②/D5③） ───────────────────────────────

describe('帧数据源 = 内核投影视图（D9②：cancelled 不投影 / tombstone 不泄漏）', () => {
  it('活跃全量 + delivered 投影 + cancelled 不投影（真实内核三态同帧）', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })
    subscribeLive(h)

    for (const [uuid, content] of [[UUID_A, 'msg-A'], [UUID_B, 'msg-B'], [UUID_C, 'msg-C']] as const) {
      await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content, clientUuid: uuid }), WS)
    }
    // A → cancelled（queued 本地撤销）；B → delivered（送达回执，直接经内核句柄驱动）
    expect(h.handle.confirmDelivered(UUID_B)).toBe(true)
    await h.handler.handleSessionMessage(msg('delivery.cancel', { sessionId: SID, clientUuid: UUID_A }), WS)

    const entries = frameEntries(h)
    // 内核投影序：活跃条目（FIFO）在前、delivered 窗口在后；cancelled 结构性缺席
    expect(entries.map((e) => [e.clientUuid, e.state])).toEqual([
      [UUID_C, 'queued'],
      [UUID_B, 'delivered'],
    ])
    // tombstone 元数据不泄漏（帧条目字段集 = D5 四字段）
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual(['clientUuid', 'lane', 'preview', 'state'])
    expect(h.registry.entries(SID)?.tombstones.map((t) => t.id).sort()).toEqual([UUID_A, UUID_B])
  })

  it('装配以 entries(options) 投影形态调用（假句柄双视图分流：全量视图的 tombstone 不入帧）', () => {
    const bus = new MessageBus()
    const sent: ServerMessage[] = []
    const client = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage) } as BusClient
    bus.subscribe(SID, client)

    const fake = makeFakeHandle([makeEntry('u-fake-1', 'queued', 'steer')])
    const registry = createSessionDeliveryRegistry(
      {
        getSession: () => makeSession(),
        ensureActive: async () => ({}) as unknown as IPiEngine,
        subscribeAgentSettled: () => () => {},
        recordWorkspace: vi.fn(),
        getMessageBus: () => bus,
      },
      { inject: vi.fn(async (_c: IPiEngine, text: string) => ({ text, notices: [] })) } as unknown as SkillInjector,
    )
    registry.getOrCreateDelivery(SID, () => fake.handle as unknown as DeliveryHandle)

    const topic = new SessionDeliveryTopic({ getRegistry: () => registry, getBus: () => bus, nextPushId: () => 'push-t' })
    topic.sync(SID)

    expect(fake.handle.entries).toHaveBeenCalledWith({})
    const frames = sent.filter((m) => m.type === 'session.delivery') as ServerMessage<'session.delivery'>[]
    expect(frames).toHaveLength(1)
    expect(frames[0]?.payload.entries).toEqual([{ clientUuid: 'u-fake-1', preview: 'body-u-fake-1', state: 'queued', lane: 'steer' }])
    registry.disposeAll()
  })

  it('变更驱动而非轮询：无内核变更时推进 60s 零新帧（onChange 订阅面）', () => {
    const bus = new MessageBus()
    const sent: ServerMessage[] = []
    const client = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw) as ServerMessage) } as BusClient
    bus.subscribe(SID, client)

    const fake = makeFakeHandle([makeEntry('u-fake-1', 'queued', 'queued')])
    const registry = createSessionDeliveryRegistry(
      {
        getSession: () => makeSession(),
        ensureActive: async () => ({}) as unknown as IPiEngine,
        subscribeAgentSettled: () => () => {},
        recordWorkspace: vi.fn(),
        getMessageBus: () => bus,
      },
      { inject: vi.fn(async (_c: IPiEngine, text: string) => ({ text, notices: [] })) } as unknown as SkillInjector,
    )
    registry.getOrCreateDelivery(SID, () => fake.handle as unknown as DeliveryHandle)

    const topic = new SessionDeliveryTopic({ getRegistry: () => registry, getBus: () => bus, nextPushId: () => 'push-t' })
    topic.sync(SID)
    const afterSync = sent.filter((m) => m.type === 'session.delivery').length
    expect(afterSync).toBe(1)
    // 订阅数 = topic 本帧订阅 + registry 的在途镜像订阅（u2 既有 onChange 消费方）
    const subsAfterSync = fake.subscriberCount()

    vi.advanceTimersByTime(60_000)
    expect(sent.filter((m) => m.type === 'session.delivery')).toHaveLength(1) // 无变更 → 无帧（非轮询）

    // 内核迁移 → onChange 驱动一帧（新值）
    fake.setEntries([makeEntry('u-fake-1', 'in-flight', 'queued')])
    const frames = sent.filter((m) => m.type === 'session.delivery') as ServerMessage<'session.delivery'>[]
    expect(frames).toHaveLength(2)
    expect(frames[1]?.payload.entries[0]?.state).toBe('in-flight')

    // release 后本 topic 退订 + 内核变更不再发帧（session 销毁清理语义）
    topic.release(SID)
    expect(fake.subscriberCount()).toBe(subsAfterSync - 1)
    fake.setEntries([makeEntry('u-fake-1', 'failed', 'queued')])
    expect(sent.filter((m) => m.type === 'session.delivery')).toHaveLength(2)
    registry.disposeAll()
  })
})

// ── state topic last-value + 重连恢复（真实 MessageBus） ───────────

describe('session.delivery state topic（D5：last-value / 不入 ring / 重连恢复）', () => {
  it('topic 登记为 state 类（登记表锁：last-value 语义的结构前提）', () => {
    expect(topicOf('session.delivery')).toBe('state')
  })

  it('last-value：同 session 多帧只留最新（stateSnapshot 单条）+ 不入 ring', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'A', clientUuid: UUID_A }), WS)
    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'B', clientUuid: UUID_B }), WS)

    const snapshot = h.bus.subscribe(SID, h.attachSubscriber())
    const deliveryFrames = snapshot.stateSnapshot.filter((m) => m.type === 'session.delivery')
    expect(deliveryFrames).toHaveLength(1)
    expect((deliveryFrames[0]?.payload as ServerMessage<'session.delivery'>['payload']).entries.map((e) => e.clientUuid)).toEqual([UUID_A, UUID_B])
    // state 类不入 ring：ring 里没有 delivery 帧（重连恢复靠 stateSnapshot 回放而非回放窗口）
    expect(snapshot.snapshot.some((m) => m.type === 'session.delivery')).toBe(false)
  })

  it('session.subscribe reply 的 stateSnapshot 含 delivery 帧（切 session/重连队列区恢复装配面，V5）', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'A', clientUuid: UUID_A }), WS)
    await h.handler.handleSessionMessage(msg('session.subscribe', { sessionId: SID }), WS)

    const payload = replyOf(h, 'session.subscribe') as { stateSnapshot: ServerMessage[] } | undefined
    const frame = payload?.stateSnapshot.find((m) => m.type === 'session.delivery') as ServerMessage<'session.delivery'> | undefined
    expect(frame?.payload.entries.map((e) => e.clientUuid)).toEqual([UUID_A])
  })
})

// ── delivery.cancel（V9/V10） ────────────────────────────────────

describe('delivery.cancel（V9/V10：queued 可撤 / 不可撤不谎报）', () => {
  it('queued 撤销成功：cancelled:true + 全文回草稿（剥标记）+ 帧移除该条目', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })
    subscribeLive(h)

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: MARKED_CONTENT, clientUuid: UUID_A }), WS)
    expect(frameUuidsOf(h)).toEqual([UUID_A])

    await h.handler.handleSessionMessage(msg('delivery.cancel', { sessionId: SID, clientUuid: UUID_A }), WS)

    const reply = replyOf(h, 'delivery.cancel')
    expect(reply?.cancelled).toBe(true)
    expect(reply?.content).toContain('PLEASE_DELIVER_')
    expect(reply?.content).not.toContain('taiji:msg')
    expect(frameEntries(h)).toEqual([]) // 撤销后帧同步移除（队列区隐去）
  })

  it('不可撤（未知 uuid）：cancelled:false + reason，条目不动（§3.4 反馈面，不谎报成功）', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })
    subscribeLive(h)

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'A', clientUuid: UUID_A }), WS)
    await h.handler.handleSessionMessage(msg('delivery.cancel', { sessionId: SID, clientUuid: UUID_UNKNOWN }), WS)

    const reply = replyOf(h, 'delivery.cancel')
    expect(reply?.cancelled).toBe(false)
    // reason 为非空人类可读原因（文案 SSOT 在 registry 侧，transport 只透传——不断言具体措辞）
    expect(typeof reply?.reason).toBe('string')
    expect((reply?.reason as string).length).toBeGreaterThan(0)
    expect(reply?.content).toBeUndefined()
    expect(frameUuidsOf(h)).toEqual([UUID_A])
  })
})

// ── delivery.drain（V11 forceQuit） ──────────────────────────────

describe('delivery.drain（V11：全量回收回草稿 + 空条目集帧形态）', () => {
  it('返回全部条目全文（发送序，剥标记）+ 帧 entries: []', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })
    subscribeLive(h)

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'first', clientUuid: UUID_A }), WS)
    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'second', clientUuid: UUID_B }), WS)

    await h.handler.handleSessionMessage(msg('delivery.drain', { sessionId: SID }), WS)

    const reply = replyOf(h, 'delivery.drain') as { sessionId: string; entries: { clientUuid: string; content: string }[] }
    expect(reply.sessionId).toBe(SID)
    expect(reply.entries.map((e) => [e.clientUuid, e.content])).toEqual([
      [UUID_A, 'first'],
      [UUID_B, 'second'],
    ])
    expect(reply.entries.every((e) => !e.content.includes('taiji:msg'))).toBe(true)
    // 空条目集形态（稳态帧：队列已清空，renderer 队列区整段隐去）
    expect(frameEntries(h)).toEqual([])
  })
})

// ── delivery.resync（D5：断连重报判重） ──────────────────────────

describe('delivery.resync（D5：判重去重 + 单源恢复）', () => {
  it('deduped 命中已送达条目 + reply 不携带条目（存留状态经帧恢复，防双源分叉）', async () => {
    const h = makeHarness()
    subscribeLive(h)

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'A', clientUuid: UUID_A }), WS)
    expect(h.handle.confirmDelivered(UUID_A)).toBe(true) // 送达回执（真实回执链路归 u2 测试面）
    await h.handler.handleSessionMessage(msg('delivery.resync', { sessionId: SID, clientUuids: [UUID_A, UUID_UNKNOWN] }), WS)

    const reply = replyOf(h, 'delivery.resync') as { sessionId: string; deduped: string[] }
    expect(reply.sessionId).toBe(SID)
    expect(reply.deduped).toEqual([UUID_A])
    expect(Object.keys(reply)).toEqual(['sessionId', 'deduped']) // 条目权威在帧，reply 不复述
    // 存留条目（delivered 窗口内）经随后的帧可见（last-value 单源）
    expect(frameEntries(h).map((e) => [e.clientUuid, e.state])).toEqual([[UUID_A, 'delivered']])
  })
})

// ── 防御路径（错误规格 §3.4 / 组合根缺省装配） ────────────────────

describe('delivery 域防御路径', () => {
  it('注册表未注入（测试最小 mock 形态）→ 四 RPC 各报 delivery_unsupported + sessionId', async () => {
    const h = makeHarness({ withRegistry: false })

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'x', clientUuid: UUID_A }), WS)
    await h.handler.handleSessionMessage(msg('delivery.cancel', { sessionId: SID, clientUuid: UUID_A }), WS)
    await h.handler.handleSessionMessage(msg('delivery.drain', { sessionId: SID }), WS)
    await h.handler.handleSessionMessage(msg('delivery.resync', { sessionId: SID, clientUuids: [] }), WS)

    expect(h.errors.map((e) => e.code)).toEqual([
      'delivery_unsupported',
      'delivery_unsupported',
      'delivery_unsupported',
      'delivery_unsupported',
    ])
    expect(h.errors[0]?.details?.sessionId).toBe(SID)
    expect(h.replies).toHaveLength(0)
  })

  it('字段校验：submit 缺 clientUuid / resync clientUuids 非数组 → invalid_payload（不静默吞）', async () => {
    const h = makeHarness()

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'x' }), WS)
    await h.handler.handleSessionMessage(msg('delivery.resync', { sessionId: SID, clientUuids: 'oops' }), WS)

    expect(h.errors.map((e) => e.code)).toEqual(['invalid_payload', 'invalid_payload'])
    expect(h.promptFn).not.toHaveBeenCalled() // 非法请求不进内核
  })

  it('releaseDeliveryTopic（session 销毁清理）：解绑后内核变更不再发帧；RPC 入口按需重装', async () => {
    const h = makeHarness({ session: { isCompacting: true, occupancy: { turn: 'idle', compacting: true, bash: false } } })
    subscribeLive(h)

    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'A', clientUuid: UUID_A }), WS)
    const afterSubmit = h.frames().length
    h.handler.releaseDeliveryTopic(SID)

    // 解绑后内核变更（不经 RPC）：不再发帧（订阅已释放）
    h.handle.confirmDelivered(UUID_A)
    expect(h.frames().length).toBe(afterSubmit)

    // 下一次 RPC 装配入口按需重装 + 发布最新投影（自愈，无需外部重新接线）
    await h.handler.handleSessionMessage(msg('delivery.submit', { sessionId: SID, content: 'B', clientUuid: UUID_B }), WS)
    expect(h.errors).toHaveLength(0)
    expect(frameEntries(h).map((e) => [e.clientUuid, e.state])).toEqual([
      [UUID_B, 'queued'],
      [UUID_A, 'delivered'],
    ])
  })
})

// ── 纯函数面（帧 DTO 装配） ───────────────────────────────────────

describe('帧 DTO 装配纯函数', () => {
  it('stripDeliveryMarkers 剥双形态标记 + 收尾空白（草稿恢复/预览共用）', () => {
    expect(stripDeliveryMarkers(`你好\n<!--taiji:msg:11111111-1111-4111-8111-111111111111-->`)).toBe('你好')
    expect(stripDeliveryMarkers(`你好\n<!--taiji:msg:${UUID_A}-->`)).toBe('你好')
    expect(stripDeliveryMarkers('无标记')).toBe('无标记')
  })

  it('deliveryPreview 截断 + 剥标记（与 core mock 同窗口值）', () => {
    expect(DELIVERY_PREVIEW_MAX_CHARS).toBe(80)
    expect(deliveryPreview(`  ${'y'.repeat(200)}  `)).toBe('y'.repeat(80))
    expect(deliveryPreview(`hi\n<!--taiji:msg:whatever-->`)).toBe('hi')
  })
})

// ── 局部辅助（依赖 Harness 的方法封装，保持用例体短） ──────────────

function frameUuidsOf(h: Harness): string[] {
  return frameEntries(h).map((e) => e.clientUuid)
}
