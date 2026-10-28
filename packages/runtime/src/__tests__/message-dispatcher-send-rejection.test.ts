/**
 * 错误分类迁移（D6）验收测试。
 *
 * 迁移口径：
 * - `classifyPromptRejection` 双字符串映射：**逐字保留**（消费方 = 内核适配器
 *   session-delivery-registry 的 promptAwaitingCompaction catch 面——classifyBusyRejection
 *   分型消费〔时为 promptWithBusyRetry，随 u5a 退役〕；dispatcher 侧 re-export 已随过度设计
 *   审计候选 1 删除；pi1-disposition-chat-flow U3① 再下沉 infra/pi/pi-rejection.js——文案
 *   infra/pi 单点驻留，本文件改从定义方 import）。registry 侧行为
 *   断言见 src/__tests__/session-delivery-registry.test.ts「u2 错误分类迁移（D6）」。
 * - pi busy 类拒绝的处置（compacting → 持有等 compaction_end；processing → 按真失败
 *   首败即停 message.error〔v3 busy 分型重试随 u5a 退役，registry 不再反转 occupancy〕；
 *   非 busy → message.error）在本文件锁定（断言对象 = 分类原语 + dispatcher 链处置，
 *   registry 侧 catch 面由 occupancy-runtime.test.ts #8a/#8b 帧序锁定）。
 * - busy 维度「零 send.rejected + 排队/即时投递」退役断言的唯一归宿 =
 *   src/services/session/__tests__/message-dispatcher.test.ts（同构用例已收拢，本文件不再重复）。

 *
 *
 * 来源（分节注释见内）：
 * - message-dispatcher-send-rejection（原主文件：错误分类迁移 D6 + 端到端 clientUuid 透传）
 * - message-dispatcher-bash-race（W1 abortBash/sendBash 竞态）
 * - message-dispatcher-compact（compact 零广播 M4）
 * - message-dispatcher-require-command（requireCommand 原子校验 u5a）
 * - plugin-send-path-queued-semantics（检查点 3：{queued} 语义透明性）
 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-send-rejection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher } from '../services/session/message-dispatcher.js'
import { applySessionOccupancyTransition } from '../services/session/event-interpreter.js'
import { registerSessionRpcHandlers } from '../services/plugin-service/api/session-api.js'
import type { PluginRpcServer } from '../services/plugin-service/plugin-rpc-server.js'
import { isGeneratingTurn } from '../services/session/types.js'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import {
  createSessionDeliveryRegistry,
  type SessionDeliveryDeps,
} from '../services/session/session-delivery-registry.js'
// classifyPromptRejection 已下沉 infra/pi（U3①，D5③ 文案 infra/pi 单点驻留）——本文件从定义方 import。
import { classifyPromptRejection } from '../infra/pi/pi-rejection.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager, PiBashResult } from '../services/ports/pi-engine.js'
import type { SessionOccupancyTransition } from '../services/session/types.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { SkillInjector, SkillInjectionResult } from '../services/session/skill-injector.js'

/** pi 0.84.4 agent-session.js prompt() 双拒绝分支原文（PS-22 / PS-23 探针锁检查）。 */
const PI_COMPACTING_MSG = 'Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.'
const PI_PROCESSING_MSG = "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."

function makeMockSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
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

interface MockOpts {
  isBashRunning?: boolean
  isGenerating?: boolean
  isCompacting?: boolean
  promptError?: Error
}

function makeMocks(opts: MockOpts = {}) {
  const session = makeMockSession({
    occupancy: {
      turn: opts.isGenerating ? 'generating' : 'idle',
      compacting: opts.isCompacting ?? false,
      bash: opts.isBashRunning ?? false,
      handingOff: false,
    },
  })
  const promptCalls: unknown[][] = []
  const promptFn = vi.fn(async (...args: unknown[]) => {
    promptCalls.push(args)
    if (opts.promptError) throw opts.promptError
    return {}
  })
  const client = {
    prompt: promptFn,
    touchActivity: vi.fn(),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
  }
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    getSessionByClient: vi.fn(() => session),
    getSession: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }
  const pm = { getClient: vi.fn(() => client as unknown as IPiEngine) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService
  const injector = {
    inject: vi.fn(async (_c: IPiEngine, text: string): Promise<SkillInjectionResult> => ({ text, notices: [] })),
  } as unknown as SkillInjector
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === 's1' ? session : undefined),
    ensureActive: svc.ensureActive as (sid: string) => Promise<IPiEngine>,
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () => bus,
  }
  const registry = createSessionDeliveryRegistry(deps, injector)
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  dispatcher.setDeliveryRegistry(registry)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  return { dispatcher, registry, session, broadcasts, promptFn, promptCalls, flush, client }
}

/** 取广播中的唯一 send.rejected payload（不存在则 undefined）。 */
function findRejected(broadcasts: ServerMessage[]) {
  return broadcasts.find((m) => m.type === 'send.rejected')?.payload as
    | Extract<ServerMessage, { type: 'send.rejected' }>['payload']
    | undefined
}

function findError(broadcasts: ServerMessage[]) {
  return broadcasts.find((m) => m.type === 'message.error')
}

/** session.occupancy 帧的 turn 序列（前端占用派生视图唯一输入——用户可见状态级证据）。 */
function occupancyTurns(broadcasts: ServerMessage[]): string[] {
  return broadcasts
    .filter((m) => m.type === 'session.occupancy')
    .map((m) => (m.payload as ServerMessage<'session.occupancy'>['payload']).turn)
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('classifyPromptRejection —— pi 拒绝原文映射（D6 识别函数，迁移落点 = 内核适配器）', () => {
  it('manual 压缩原文 → compacting', () => {
    expect(classifyPromptRejection(PI_COMPACTING_MSG)).toBe('compacting')
  })

  it('auto 压缩 / post-run 原文 → processing', () => {
    expect(classifyPromptRejection(PI_PROCESSING_MSG)).toBe('processing')
  })

  it('按 includes 匹配：错误消息含原文片段（带前后缀）仍命中', () => {
    expect(classifyPromptRejection(`RPC failed: ${PI_PROCESSING_MSG}`)).toBe('processing')
    expect(classifyPromptRejection(`${PI_COMPACTING_MSG} (session s1)`)).toBe('compacting')
  })

  it('非 busy 的 pi 错误（auth / 无模型等）→ null（走普通错误范围）', () => {
    expect(classifyPromptRejection('No model configured')).toBeNull()
    expect(classifyPromptRejection('Authentication failed: 401')).toBeNull()
    expect(classifyPromptRejection('')).toBeNull()
  })
})

// busy 维度「零 send.rejected + 排队/即时投递」退役断言的唯一归宿 =
// src/services/session/__tests__/message-dispatcher.test.ts「busy 维度退役」describe
// （同构用例已收拢，本文件不再重复——R3-B2）。

describe('pi busy 类拒绝的处置迁移（D6：适配器 catch 面）', () => {
  it('manual 压缩原文（TOCTOU）→ 零 send.rejected + 持有等 compaction_end（不误判失败）', async () => {
    const h = makeMocks({ promptError: new Error(PI_COMPACTING_MSG) })
    const result = await h.dispatcher.sendMessage('s1', 'hello')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect(findRejected(h.broadcasts)).toBeUndefined()
    expect(findError(h.broadcasts)).toBeUndefined() // 不进错误气泡链路
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('queued') // 持有（非 failed）
  })

  it('auto 压缩 / post-run 原文（processing）→ 首败即停 message.error（v3 busy 分型重试退役）', async () => {
    const h = makeMocks({ promptError: new Error(PI_PROCESSING_MSG) })
    await h.dispatcher.sendMessage('s1', 'hello')
    await h.flush()
    expect(findRejected(h.broadcasts)).toBeUndefined()
    // v3：受理即出站下全部投递恒带 streamingBehavior，pi 忙时入队不拒——processing 拒绝
    // 按真失败首败即停：occupancy 不伪造 busy（turn 收敛回 idle），错误进 message.error
    // 广播链路（错因可见，用户裁决重发）
    expect(isGeneratingTurn(h.session.occupancy?.turn)).toBe(false)
    expect(h.session.occupancy?.turn).toBe('idle')
    const err = findError(h.broadcasts)
    expect(err).toBeDefined()
    expect((err!.payload as { message: string }).message).toContain('Agent is already processing')
  })

  it('非 busy pi 错误（No model configured）→ message.error 广播（错因可见）+ 零 send.rejected', async () => {
    const h = makeMocks({ promptError: new Error('No model configured') })
    const result = await h.dispatcher.sendMessage('s1', 'hello')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect(findRejected(h.broadcasts)).toBeUndefined()
    const err = findError(h.broadcasts)

    expect(err).toBeDefined()
    expect((err!.payload as { message: string }).message).toContain('No model configured')
  })
})

describe('正常路径行为不变', () => {
  it('prompt 成功 → 零 send.rejected / message.error + {blocked:false}', async () => {
    const h = makeMocks()
    const result = await h.dispatcher.sendMessage('s1', 'hello', undefined, 'uuid-ok')
    await h.flush()
    expect(result).toMatchObject({ blocked: false })
    expect((h.promptCalls[0]?.[0] as string)).toContain('hello')
    expect(findRejected(h.broadcasts)).toBeUndefined()
    expect(findError(h.broadcasts)).toBeUndefined()
  })

  it('clientUuid 透传进入内核条目 id（renderer 消歧锚从广播挪到条目 id）', async () => {
    const h = makeMocks()
    await h.dispatcher.sendMessage('s1', 'hello', undefined, 'u-11111111-1111-4111-8111-111111111111')
    await h.flush()
    expect(h.registry.entries('s1')?.active[0]?.id).toBe('u-11111111-1111-4111-8111-111111111111')
    expect(h.promptCalls[0]?.[0] as string).toContain('<!--taiji:msg:11111111-1111-4111-8111-111111111111-->')
  })
})

describe('transport → dispatcher 端到端 clientUuid 透传（message.send case 接线）', () => {
  // makeHandler 范式同 session-message-handler-subscribe.test.ts：mock ctx，捕获 reply 与
  // sessionService.sendMessage 实参（transport 层解构/传参断言；sessionService → dispatcher
  // 为一行签名委托，由 typecheck + 上文 dispatcher 单测覆盖）。
  function makeSendHandler(replyStatus?: { blocked: boolean; rejected?: boolean }) {
    const cap = {
      replies: [] as { id: string | undefined; type: string; payload: Record<string, unknown> }[],
      sendArgs: [] as unknown[][],
    }
    const ctx = {
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      sendError: vi.fn(),
      sessionService: {
        sendMessage: vi.fn(async (...args: unknown[]) => {
          cap.sendArgs.push(args)
          return replyStatus ?? { blocked: false }
        }),
      },
    }
    const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    return { cap, handler }
  }

  function sendMsg(payload: Record<string, unknown>): ClientMessage {
    return { type: 'message.send', id: 'req-1', payload } as unknown as ClientMessage
  }

  it('payload 带 clientUuid → sessionService.sendMessage 收到四参（含 clientUuid），成功后 reply message.status', async () => {
    const { cap, handler } = makeSendHandler()

    await handler.handleSessionMessage(
      sendMsg({ sessionId: 's1', content: 'hello', clientUuid: 'uuid-e2e-1' }),
      {} as never,
    )

    expect(cap.sendArgs).toHaveLength(1)
    expect(cap.sendArgs[0]).toEqual(['s1', 'hello', undefined, 'uuid-e2e-1'])
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0].type).toBe('message.status')
  })

  it('payload 不带 clientUuid → sendMessage 第 4 参 undefined（存量调用形态不变）', async () => {
    const { cap, handler } = makeSendHandler()

    await handler.handleSessionMessage(sendMsg({ sessionId: 's1', content: 'hello' }), {} as never)

    expect(cap.sendArgs[0]).toEqual(['s1', 'hello', undefined, undefined])
  })

  it('handler 侧 rejected ack 分支保留（协议兼容范围；u5 随协议条目退役清理）', async () => {
    const { cap, handler } = makeSendHandler({ blocked: true, rejected: true })

    await handler.handleSessionMessage(sendMsg({ sessionId: 's1', content: 'hello' }), {} as never)

    expect(cap.replies[0].type).toBe('message.status')
    expect(cap.replies[0].payload).toMatchObject({ sessionId: 's1', status: 'rejected' })
  })
})

// ════════════════ 来源: message-dispatcher-bash-race.test.ts ════════════════

type BashResultMsg = ServerMessage<'message.bashResult'>
type BashAbortedMsg = ServerMessage<'message.bashAborted'>
/** 返回所有 message.bashResult 广播（W1 竞态需断言「总数==1」故需数组而非首条）。 */
function findBashResults(b: ServerMessage[]): BashResultMsg[] {
  return b.filter((m): m is BashResultMsg => m.type === 'message.bashResult')
}
function findBashAborted(b: ServerMessage[]): BashAbortedMsg | undefined {
  return b.find((m): m is BashAbortedMsg => m.type === 'message.bashAborted')
}

function makeBashRaceSession(overrides: Partial<IManagedSessionView> = {}): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    ...overrides,
  }
}

/**
 * W1 专用 mock：client.bash 用可控 Promise（bashResolve/bashReject），
 * 调用方可在 sendBash await 期间触发 abortBash，再 resolve/reject client.bash。
 */
function makeRaceMocks() {
  const session = makeBashRaceSession()

  let bashResolve!: (r: PiBashResult) => void
  let bashReject!: (e: Error) => void
  const bashPromise = new Promise<PiBashResult>((res, rej) => {
    bashResolve = res
    bashReject = rej
  })
  const bashFn = vi.fn(() => bashPromise)
  const abortBashFn = vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['abortBash']>>)
  const compactFn = vi.fn(async () => ({}) as Awaited<ReturnType<IPiEngine['compact']>>)

  const client = {
    prompt: vi.fn(async () => ({})),
    bash: bashFn,
    abortBash: abortBashFn,
    compact: compactFn,
  } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写路径已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（7 方法 = 消费方实际用到的全部），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, bashFn, abortBashFn, compactFn, broadcasts, bashResolve, bashReject }
}

describe('MessageDispatcher —— W1 abortBash/sendBash 竞态检查', () => {
  beforeEach(() => vi.clearAllMocks())

  it('W1a: abortBash 在 sendBash await 期间抢先收尾后，pi resolve 到达时 sendBash 仍发布真实 bashResult（D1 closure——与 pi 落盘一致，例外①消灭）', async () => {
    const { dispatcher, broadcasts, bashResolve, abortBashFn } = makeRaceMocks()

    // sendBash 启动，await client.bash() 挂起
    const sendPromise = dispatcher.sendBash('s1', 'long-running-cmd', false)
    await Promise.resolve() // 让 sendBash 跑到 await client.bash

    // 此时 bashStart 已广播，client.bash 已被调用（pending）
    expect(broadcasts.some((m) => m.type === 'message.bashStart')).toBe(true)
    expect(abortBashFn).not.toHaveBeenCalled()

    // 用户调 abortBash：广播兜底终态 message.bashAborted（bashAbortedEffect 只清态不产 entry）
    await dispatcher.abortBash('s1')
    expect(abortBashFn).toHaveBeenCalledTimes(1)
    const aborted = findBashAborted(broadcasts)
    expect(aborted).toBeDefined()
    expect(aborted!.payload).toMatchObject({ sessionId: 's1' })

    // pi 响应到达：client.bash resolve 带真实 output
    bashResolve({ output: 'real output', exitCode: 0, cancelled: false, truncated: false })
    const result = await sendPromise

    // 关键断言（D1 closure 修订，conversation-turn-attribution-closure D1）：旧逻辑静默跳过
    // 导致 pi 文件有 entry 而 live 无（登记例外①）；新逻辑发布真实数据——bashAborted 只清态、
    // 真实 bashResult 产 entry，两帧职责正交（均幂等），双终态担忧不成立。bashResult 总数 = 1
    //（abort 兜底走独立 bashAborted 帧，不再是 bashResult 哨兵——msg-pipeline-debloat D4-3）。
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    // sendBash 发布的真实数据（token 已旋转仍发布；cancelled 随 pi 返回值透传——
    // mock 刻意用 cancelled:false 显式验证「guard 命中与结果 cancelled 与否正交、照发不筛」）
    expect(allResults[0]!.payload).toMatchObject({ output: 'real output', cancelled: false })

    // 不广播 message.error（pi 是正常 resolve，无错误）
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)

    // sendBash 正常完成（发布路径走完）→ 回执 settled
    expect(result).toEqual({ status: 'settled' })
  })

  it('W1b: abortBash 抢先收尾后，client.bash reject 到达时 sendBash 不广播 message.error（避免双重报错）', async () => {
    const { dispatcher, broadcasts, bashReject } = makeRaceMocks()

    const sendPromise = dispatcher.sendBash('s1', 'doomed-cmd', false)
    await Promise.resolve()

    // abortBash 抢先收尾（广播 message.bashAborted 兜底终态）
    await dispatcher.abortBash('s1')
    expect(findBashAborted(broadcasts)).toBeDefined()

    // pi 响应到达：client.bash reject
    bashReject(new Error('stream closed by abort'))
    const result = await sendPromise

    // 关键断言：sendBash 检测到被 abort 抢先收尾，不广播 message.error
    //（bashAborted 已是收尾帧，再补 message.error 会双重报错）。
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)

    // catch abort-skip：无 bashResult 兜底帧（D4-3 后兜底终态只走 bashAborted 独立帧）
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(0)

    // 回执 settled+error（已执行、已由 abortBash 抢先收尾——消费方不得恢复草稿）
    expect(result).toEqual({ status: 'settled', error: 'stream closed by abort' })
  })

  it('W1c: 无 abort 时 sendBash 正常广播真实 bashResult（检查不影响正常路径）', async () => {
    const { dispatcher, broadcasts, bashResolve } = makeRaceMocks()

    const sendPromise = dispatcher.sendBash('s1', 'normal-cmd', false)
    await Promise.resolve()

    // 无 abort：pi 正常 resolve
    bashResolve({ output: 'done', exitCode: 0, cancelled: false, truncated: false })
    const result = await sendPromise

    // 正常广播真实 bashResult（cancelled:false）
    const allResults = findBashResults(broadcasts)
    expect(allResults).toHaveLength(1)
    expect(allResults[0]!.payload).toMatchObject({ output: 'done', exitCode: 0, cancelled: false })
    // 不广播 message.error
    expect(broadcasts.some((m) => m.type === 'message.error')).toBe(false)
    expect(result).toEqual({ status: 'settled' })
  })
})

// [2026-09 测试舰队审查 r2-21] 'W3 compact busy 预检' describe（3 用例）已删：
// 与 message-dispatcher-compact.test.ts 的 TC5-busy预检（isBashRunning/isGenerating）+
// TC5-成功（正常进入压缩 + 零广播）逐条重复（同断言集合），compact dispatcher
// 唯一归并地在彼文件；本文件保留 W1 bashRunToken 竞态段（无重复替身）。

// ════════════════ 来源: message-dispatcher-compact.test.ts ════════════════

function makeCompactSession(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
    bashRunToken: undefined,
  }
}

interface MockOpts {
  /** busy 预检占用态的转移序列（经转移原语构造，禁止 fixture 直写 occupancy） */
  busyTransitions?: SessionOccupancyTransition[]
  compactResult?: unknown
  compactError?: Error
}

function makeCompactMocks(opts: MockOpts = {}) {
  const session = makeCompactSession()
  // 占用态经转移原语构造（publish 传 null：本文件只捕获 dispatcher 自身的广播，
  // occupancy state 帧不参与断言）
  for (const transition of opts.busyTransitions ?? []) {
    applySessionOccupancyTransition(session, null, transition)
  }

  const compactFn = opts.compactError
    ? vi.fn(async () => { throw opts.compactError! })
    : vi.fn(async () => opts.compactResult ?? { summary: 'S', tokensBefore: 100, estimatedTokensAfter: 30 })

  const client = { compact: compactFn } as unknown as IPiEngine

  // wave:perf-w09（D1-2）：dispatcher 只依赖 publish 抽象（broker 双写路径已删），mock bus 收集发布消息
  const broadcasts: ServerMessage[] = []
  const bus = { publish: vi.fn((_sid: string, m: ServerMessage) => { broadcasts.push(m) }) } as unknown as IMessageBus

  // S2 ISP 化：结构性满足 dispatcher 窄接口（7 方法 = 消费方实际用到的全部），无强转
  const svc: IDispatcherSessionOps = {
    ensureActive: vi.fn(async () => client),
    getSessionByClient: vi.fn(() => session),
    persistSessionOutcome: vi.fn(),
    clearSessionOutcome: vi.fn(),
    getSession: vi.fn(),
    removeSessionEntry: vi.fn(),
    detachSession: vi.fn(),
  }

  const pm = { getClient: vi.fn(() => client) } as unknown as IProcessManager
  const workspace = { record: vi.fn() } as unknown as WorkspaceService

  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus)
  return { dispatcher, session, compactFn, broadcasts }
}

/** compaction 生命周期相关的广播类型（M4 后 dispatcher 应零广播这些） */
const COMPACTION_TYPES = ['session.compacting', 'session.compacted', 'message.compactionSummary']

describe('MessageDispatcher compact —— 零广播（M4 事件驱动）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('TC5-成功: compact 成功 → 零 compaction 广播（interpreter 唯一源）+ client.compact 调用 + compacting 不置位', async () => {
    const { dispatcher, compactFn, session, broadcasts } = makeCompactMocks()

    await dispatcher.compact('s1')

    // client.compact 调用（RPC 触发保留）
    expect(compactFn).toHaveBeenCalledWith(undefined)
    // dispatcher 不置位 compacting（置位归 interpreter 的 compaction_start 事件；[D1] 读口迁移）
    expect(session.occupancy?.compacting).toBe(false)
    // 零 compaction 广播
    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-busy预检补compacting: occupancy.compacting=true → 抛错 + 零广播（防并发 compact 重入）', async () => {
    const { dispatcher, compactFn, broadcasts } = makeCompactMocks({ busyTransitions: ['compacting-start'] })

    await expect(dispatcher.compact('s1')).rejects.toThrow(/compaction already running/)
    expect(compactFn).not.toHaveBeenCalled()

    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-busy预检: occupancy.bash=true → 抛错 + 零广播', async () => {
    const { dispatcher, broadcasts } = makeCompactMocks({ busyTransitions: ['bash-start'] })

    await expect(dispatcher.compact('s1')).rejects.toThrow(/bash running/)

    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-busy预检: turn=generating（isGeneratingTurn）→ 抛错 + 零广播', async () => {
    const { dispatcher, broadcasts } = makeCompactMocks({ busyTransitions: ['generating'] })

    await expect(dispatcher.compact('s1')).rejects.toThrow(/agent generating/)

    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
  })

  it('TC5-catch: client.compact reject → 传播 error + 零广播 + compacting 复位', async () => {
    const { dispatcher, session, broadcasts } = makeCompactMocks({ compactError: new Error('pi compact failed') })

    await expect(dispatcher.compact('s1')).rejects.toThrow('pi compact failed')

    // 零广播（失败提示归 interpreter 的 compaction_end{errorMessage} → message.error 对话流）
    const compactionBroadcasts = broadcasts.filter((m) => COMPACTION_TYPES.includes(m.type))
    expect(compactionBroadcasts).toHaveLength(0)
    // finally 兜底复位（对 false 无害，防 transport 级失败 session 卡死）
    expect(session.occupancy?.compacting).toBe(false)
  })
})

// ════════════════ 来源: message-dispatcher-require-command.test.ts ════════════════

interface HarnessOptions {
  /** client.getCommands 的逐次返回队列（queue.shift()，耗尽后重复末项）。 */
  commandQueue?: Array<Array<{ name: string; source: string }> | Error>
  hookBlocked?: boolean
}

function makeRequireCommandHarness(opts: HarnessOptions = {}) {
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
    clearSessionOutcome: vi.fn(),
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
const findRejectedMsg = (broadcasts: ServerMessage[]) => broadcasts.find((m) => m.type === 'send.rejected')
const findErrorMsg = (broadcasts: ServerMessage[]) => broadcasts.find((m) => m.type === 'message.error')

describe('requireCommand 原子校验（D6/u5a：hook 后、内核提交前）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('命中：内核受理（receipt 非空 + lane 派生视图）且投递路径 prompt 到达', async () => {
    const { dispatcher, calls, client, flush } = makeRequireCommandHarness({ commandQueue: [[{ name: 'schedule', source: 'extension' }]] })
    const result = await dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await flush()

    expect(result.blocked).toBe(false)
    expect(result.receipt).toBeDefined()
    expect(result.receipt?.lane).toBe('direct')
    expect(calls[0]).toBe('hook')
    expect(calls.indexOf('getCommands')).toBeGreaterThan(calls.indexOf('hook'))
    expect(client.prompt).toHaveBeenCalledTimes(1)
  })

  it('无 requireCommand：无校验介入（无 500ms 重试特征），内核受理（既有路径回归）', async () => {
    const { dispatcher, calls, client, flush } = makeRequireCommandHarness()
    const result = await dispatcher.sendMessage('s1', '普通消息')
    await flush()

    expect(result.blocked).toBe(false)
    expect(result.receipt).toBeDefined()
    expect(client.prompt).toHaveBeenCalledTimes(1)
    // [pi1-disposition-chat-flow D2①] client.getCommands 的消费方现为两个：registry 命令
    // 清单缓存（watchClient 附着时恰 1 次）与本机制的 requireCommand 校验。requireCommand
    // 未配置的介入面改由「无重试特征」锁定：校验若介入（命令提交）会呈 1+6 次探测形态
    //（见上一用例），此处恰 1 次 = 仅 registry 清单拉取、零校验介入。
    expect(calls.filter((c) => c === 'getCommands')).toHaveLength(1)
  })

  it('未命中拒发不广播 send.rejected / message.error（回执机制是唯一反馈面，防队列误重投）', async () => {
    const { dispatcher, broadcasts } = makeRequireCommandHarness({ commandQueue: [[]] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    await pending

    expect(findRejectedMsg(broadcasts)).toBeUndefined()
    expect(findErrorMsg(broadcasts)).toBeUndefined()
  })

  it('探测 RPC 抛错视同未命中参与重试，预算耗尽后拒发（fail-closed）', async () => {
    const { dispatcher, client } = makeRequireCommandHarness({ commandQueue: [new Error('probe boom')] })
    const pending = dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')
    await vi.advanceTimersByTimeAsync(500 * 6 + 50)
    const result = await pending

    expect(result).toEqual({ blocked: true, rejected: true, reason: 'command-missing' })
    expect(client.prompt).not.toHaveBeenCalled()
  })

  it('hook 拦截 → reason:"hook-blocked"（且先于命令校验，getCommands 零触达）', async () => {
    const { dispatcher, getCommands } = makeRequireCommandHarness({ hookBlocked: true })
    const result = await dispatcher.sendMessage('s1', '/schedule off abc', undefined, undefined, 'schedule')

    expect(result).toEqual({ blocked: true, reason: 'hook-blocked' })
    expect(getCommands).not.toHaveBeenCalled()
  })
})

// ════════════════ 来源: plugin-send-path-queued-semantics.test.ts ════════════════

function makePluginSendView(): IManagedSessionView {
  return {
    id: 's1',
    cwd: '/test',
    label: 'test',
    modelId: 'm1',
    createdAt: 1,
    lastActiveAt: 1,
    tokenCount: 0,
    inputTokens: 0,
        bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false, handingOff: false },
  }
}

function makePluginSendHarness() {
  const view = makePluginSendView()
  const published: ServerMessage[] = []
  const promptCalls: string[] = []
  const client = {
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text)
      return {}
    }),
    touchActivity: vi.fn(),
    getEntries: vi.fn(async () => ({ data: { entries: [] } })),
    clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
    onEvent: vi.fn(() => () => {}),
  }
  const deps: SessionDeliveryDeps = {
    getSession: (sid) => (sid === view.id ? view : undefined),
    ensureActive: vi.fn(async () => client as unknown as IPiEngine),
    subscribeAgentSettled: () => () => {},
    recordWorkspace: vi.fn(),
    getMessageBus: () =>
      ({ publish: (_sid: string, msg: ServerMessage) => published.push(msg) }) as unknown as IMessageBus,
  }
  const registry = createSessionDeliveryRegistry(deps, {
    inject: async (_c: IPiEngine, text: string) => ({ text, notices: [] }),
  } as unknown as SkillInjector)
  const dispatcher = new MessageDispatcher(
    // 本测试走 runAcceptance 受理成功路径，clearSessionOutcome 必须存在（dmg-r1-1 跨回合终态放行）
    { clearSessionOutcome: vi.fn() } as unknown as IDispatcherSessionOps,
    { getClient: () => client as unknown as IPiEngine } as unknown as IProcessManager,
    { record: vi.fn() } as unknown as WorkspaceService,
    ({ publish: (_sid: string, msg: ServerMessage) => published.push(msg) }) as unknown as IMessageBus,
  )
  dispatcher.setDeliveryRegistry(registry)
  // 插件 RPC 表：捕获注册的 handler（真注册函数，非 mock）
  const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
  const rpcServer = {
    registerMethod: (name: string, fn: (params: Record<string, unknown>) => Promise<unknown>) => {
      handlers.set(name, fn)
    },
  } as unknown as PluginRpcServer
  registerSessionRpcHandlers(rpcServer, {
    listSessions: () => [],
    getSession: () => undefined,
    getActiveSession: () => undefined,
    // plugin-rpc-setup 的真实实现：deps.sessionService.sendMessage(sessionId, content)
    sendMessage: (sessionId: string | undefined, _role: string, content: string) =>
      dispatcher.sendMessage(sessionId as string, content),
    sessionEvents: { register: vi.fn(), unregister: vi.fn() },
  } as never)
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve()
  }
  return { registry, dispatcher, view, published, promptCalls, handlers, client, flush }
}

describe('检查点 3：plugin-service 经 dispatcher 的 {queued} 语义透明性', () => {
  it('busy（compacting）目标：插件 sendMessage 不抛错不拒绝，消息入内核排队；compaction 结束后按序投递', async () => {
    const h = makePluginSendHarness()
    applySessionOccupancyTransition(h.view, null, 'compacting-start')

    const send = h.handlers.get('plugin.sessions.sendMessage')!
    expect(send, '插件 RPC 表已注册 sendMessage').toBeTruthy()

    // ① 不拒绝：RPC resolve，回执契约形态 {accepted:true}（旧语义 = send.rejected 拒绝路径，插件不可见地失败）
    await expect(send({ sessionId: 's1', role: 'user', content: '插件消息' })).resolves.toEqual({ accepted: true })
    await h.flush()
    expect(h.promptCalls).toHaveLength(0) // 持有：pi 暂不可收
    expect(h.published.some((m) => m.type === 'send.rejected')).toBe(false) // ③ 零 send.rejected 帧
    expect(h.registry.entries('s1')?.active[0]?.state).toBe('queued') // 排队承接

    // ② 不丢：compaction 结束 → 内核按 FIFO 投递（含插件消息 + 裸标记身份）。
    // [MF-1-9] 持有等待已事件化：转移后显式触发 hold 解除边沿（生产 = dispatcher bash-end /
    // compacting-end 转移后经 notifyHoldRelease 驱动）
    applySessionOccupancyTransition(h.view, null, 'compacting-end')
    h.registry.notifyHoldRelease(h.view.id)
    await vi.advanceTimersByTimeAsync(1)
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toContain('插件消息')
  })

  it('idle 目标：插件 sendMessage 走同一内核通道（直接受理，出站带裸标记）', async () => {
    const h = makePluginSendHarness()
    const send = h.handlers.get('plugin.sessions.sendMessage')!
    await send({ sessionId: 's1', role: 'user', content: '插件直发' })
    await h.flush()
    expect(h.promptCalls).toHaveLength(1)
    expect(h.promptCalls[0]).toContain('插件直发')
    expect(h.promptCalls[0]).toMatch(/<!--taiji:msg:[^>]+-->$/)
    expect(h.published.some((m) => m.type === 'message.error')).toBe(false)
  })
})
