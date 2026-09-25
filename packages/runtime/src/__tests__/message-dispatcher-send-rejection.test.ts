/**
 * 错误分类迁移（D6）验收测试。
 *
 * 迁移口径：
 * - `classifyPromptRejection` 双字符串映射：**逐字保留**（迁移后由内核适配器
 *   session-delivery-registry.promptWithBusyRetry 消费；dispatcher 侧 re-export 保持既有
 *   import 路径与 PS-22/PS-23 探针锁定面）。registry 侧行为断言见
 *   src/__tests__/session-delivery-registry.test.ts「u2 错误分类迁移（D6）」。
 * - pi busy 类拒绝的处置迁移（compacting → 持有等 compaction_end；processing → occupancy
 *   反转 generating；非 busy → message.error）在本文件锁定。
 * - busy 维度「零 send.rejected + 排队/即时投递」退役断言的唯一归宿 =
 *   src/services/session/__tests__/message-dispatcher.test.ts（同构用例已收拢，本文件不再重复）。

 *
 * 运行：cd packages/runtime && npx vitest run src/__tests__/message-dispatcher-send-rejection.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageDispatcher, classifyPromptRejection } from '../services/session/message-dispatcher.js'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import {
  createSessionDeliveryRegistry,
  type SessionDeliveryDeps,
} from '../services/session/session-delivery-registry.js'
import type { IDispatcherSessionOps } from '../services/session/session-internal.js'
import type { IManagedSessionView } from '../services/session/types.js'
import type { IMessageBus } from '../services/message-bus/message-bus.js'
import type { IPiEngine, IProcessManager } from '../services/ports/pi-engine.js'
import type { ClientMessage, ServerMessage } from '@taiji/shared'
import type { WorkspaceService } from '../services/workspace/workspace-service.js'
import type { SkillInjector, SkillInjectionResult } from '../services/session/skill-injector.js'

/** pi 0.84.4 agent-session.js prompt() 双拒绝分支原文（PS-22 / PS-23 探针锁守卫）。 */
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
    isGenerating: false,
    isCompacting: false,
    isBashRunning: false,
    bashRunToken: undefined,
    occupancy: { turn: 'idle', compacting: false, bash: false },
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
    isBashRunning: opts.isBashRunning ?? false,
    isGenerating: opts.isGenerating ?? false,
    isCompacting: opts.isCompacting ?? false,
    occupancy: {
      turn: opts.isGenerating ? 'generating' : 'idle',
      compacting: opts.isCompacting ?? false,
      bash: opts.isBashRunning ?? false,
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
  const dispatcher = new MessageDispatcher(svc, pm, workspace, bus, registry)
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

/** session.occupancy 帧的 turn 序列（前端占用投影唯一输入——用户可见状态级证据）。 */
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

  it('非 busy 的 pi 错误（auth / 无模型等）→ null（走普通错误面）', () => {
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

  it('auto 压缩 / post-run 原文 → occupancy 反转 generating（防幽灵空闲），零 send.rejected', async () => {
    const h = makeMocks({ promptError: new Error(PI_PROCESSING_MSG) })
    await h.dispatcher.sendMessage('s1', 'hello')
    await h.flush()
    expect(findRejected(h.broadcasts)).toBeUndefined()
    expect(h.session.isGenerating).toBe(true)
    expect(h.session.occupancy?.turn).toBe('generating')
    // 用户可见断言：occupancy 帧是前端 sessionPhase / 占用短路的唯一输入，末帧必为 generating
    const turns = occupancyTurns(h.broadcasts)
    expect(turns.length).toBeGreaterThan(0)
    expect(turns[turns.length - 1]).toBe('generating')
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

  it('handler 侧 rejected ack 分支保留（协议兼容面；u5 随协议条目退役清理）', async () => {
    const { cap, handler } = makeSendHandler({ blocked: true, rejected: true })

    await handler.handleSessionMessage(sendMsg({ sessionId: 's1', content: 'hello' }), {} as never)

    expect(cap.replies[0].type).toBe('message.status')
    expect(cap.replies[0].payload).toMatchObject({ sessionId: 's1', status: 'rejected' })
  })
})
