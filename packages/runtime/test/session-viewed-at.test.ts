/**
 * lastViewedAt 查看时间戳（idle pi reclamation 设计 D2 #6，u1b）。
 *
 * 三层覆盖：
 * 1. SessionService per-sid Map 语义（真实例）：未记录 sid 查询返回 undefined；
 *    记录后返回时间戳；重复查看覆盖更新。
 * 2. session.switch 处理器记录：fake sessionService 精确断言 markSessionViewed 以
 *    目标 sid 被调用，且入口挂点同时覆盖 summary 命中 / ensureActive 恢复两条分支。
 * 3. 记录失败隔离：markSessionViewed 抛错 / 成员缺省（最小 mock）时 switch 主流程
 *    （reply session.switched）不受影响。
 *
 * 可测性取舍说明（任务允许「经 handler 或直接调 session-service 方法」二选一）：
 * - 存储语义（第 1 层）用真 SessionService——构造依赖全桩化（构造器只存引用，
 *  无需 session-service.test.ts 的 7 模块 mock 链；BackgroundTaskService 轮询 timer
 *  unref 不持进程，路径经 globalSetup 的 TAIJI_AGENT_DATA_DIR=tmp 重定向，不触真实数据目录）。
 * - 处理器链路（第 2/3 层）不用真 service 挂进 handler：getSummary 未命中会拖入
 *  RespawnOrchestrator/restore 磁盘机制（与本测试目标无关的失败面）；fake 断言调用
 *  参数恰是要锁定的「handler → 记录方法」契约（mock 模式照抄
 *  session-message-handler-switch-reply.test.ts 先例）。故障注入（第 3 层）也只能在
 *  fake 上做——真 Map.set 不抛，无法注入失败。
 */
import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { ClientMessage } from '@taiji/shared'
import { SessionService } from '../src/services/session/session-service.js'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'
import { PiSessionStore } from '../src/infra/pi/session-store.js'
import type { IMessageBroker, IEventAdapter, IExtensionService } from '../src/interfaces.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { IGitInfoReader } from '../src/services/ports/git-info.js'

// ── 真 SessionService 装置（构造器只存引用，桩面照抄 session-service.test.ts）──

/** 最小 pm 桩：SessionService 构造器只消费 onSessionExit 注册位，其余面不触达。 */
function makePmStub(): IProcessManager {
  return {
    createSession: vi.fn(),
    destroySession: vi.fn(),
    getClient: vi.fn(() => undefined),
    getSessionIdByClient: vi.fn(() => undefined),
    hasClient: vi.fn(() => false),
    rekey: vi.fn(),
    onSessionExit: vi.fn(),
    destroyAll: vi.fn(),
  } as unknown as IProcessManager
}

/** 构造真 SessionService（依赖全桩化；路径推导经 globalSetup tmp 重定向，不触真实数据目录）。 */
function makeRealService(): SessionService {
  const broker: IMessageBroker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
  const adapterFactory = (): IEventAdapter => ({ attach: vi.fn(), detach: vi.fn() } as unknown as IEventAdapter)
  const extensionService: IExtensionService = { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService
  const gitInfoReader: IGitInfoReader = { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() }
  const workspaceService = { record: vi.fn(), list: vi.fn().mockReturnValue([]) }
  return new SessionService(
    makePmStub(),
    broker,
    adapterFactory,
    tmpdir(),
    extensionService,
    new PiConfigStore(),
    new PiSessionStore(),
    gitInfoReader,
    workspaceService as unknown as ConstructorParameters<typeof SessionService>[8],
  )
}

// ── handler 装置（照抄 session-message-handler-switch-reply.test.ts 的 makeHandler 模式）──

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string }[]
}

interface HandlerServiceShape {
  getSummary: ReturnType<typeof vi.fn>
  ensureActive: ReturnType<typeof vi.fn>
  markSessionViewed?: (sessionId: string) => void
}

function makeHandler(service: HandlerServiceShape) {
  const cap: Captured = { replies: [], errors: [] }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      cap.errors.push({ id, code, message })
    }),
    sessionService: service,
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { cap, handler }
}

function switchMsg(sessionId: string, id = 'req-1'): ClientMessage {
  return { type: 'session.switch', id, payload: { sessionId } } as unknown as ClientMessage
}

const SUMMARY = { id: 's-1', label: 'test', cwd: '/tmp' }

// ── 第 1 层：SessionService per-sid Map 语义（真实例）──

describe('lastViewedAt 查看时间戳：SessionService per-sid Map（idle pi reclamation D2 #6）', () => {
  it('未记录的 sid 查询返回 undefined（非 0——0 是合法 epoch，误用会豁免全部 session）', () => {
    const service = makeRealService()
    expect(service.getSessionLastViewedAt('never-viewed-sid')).toBeUndefined()
  })

  it('markSessionViewed 后查询返回记录时刻的时间戳；重复查看覆盖更新（保留最近一次）', () => {
    const service = makeRealService()
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      service.markSessionViewed('s-1')
      expect(service.getSessionLastViewedAt('s-1')).toBe(1_000)
      nowSpy.mockReturnValue(2_000)
      service.markSessionViewed('s-1')
      // 覆盖语义：查看窗口锚定最近一次查看，旧时间戳必须被顶掉
      expect(service.getSessionLastViewedAt('s-1')).toBe(2_000)
      // per-sid 隔离：s-1 的记录不外溢到其他 sid
      expect(service.getSessionLastViewedAt('s-2')).toBeUndefined()
    } finally {
      nowSpy.mockRestore()
    }
  })
})

// ── 第 2/3 层：session.switch 处理器记录与失败隔离 ──

describe('lastViewedAt 查看时间戳：session.switch 处理器记录（入口挂点 + 失败隔离）', () => {
  it('switch 请求 → markSessionViewed 以目标 sid 调用（summary 命中分支）', async () => {
    const markSessionViewed = vi.fn()
    const { cap, handler } = makeHandler({
      getSummary: vi.fn(() => SUMMARY),
      ensureActive: vi.fn(),
      markSessionViewed,
    })
    await handler.handleSessionMessage(switchMsg('s-1'), {} as never)
    expect(markSessionViewed).toHaveBeenCalledWith('s-1')
    expect(markSessionViewed).toHaveBeenCalledTimes(1)
    // 记录不改变 switch 既有回复语义
    expect(cap.errors).toHaveLength(0)
    expect(cap.replies[0]?.type).toBe('session.switched')
  })

  it('getSummary 未命中（ensureActive 恢复分支）同样记录——入口挂点覆盖两条分支', async () => {
    const markSessionViewed = vi.fn()
    let call = 0
    const { cap, handler } = makeHandler({
      // 首次 getSummary（handler 内）返回 undefined → 恢复后再取返回 summary
      getSummary: vi.fn(() => {
        call++
        return call === 1 ? undefined : SUMMARY
      }),
      ensureActive: vi.fn().mockResolvedValue(undefined),
      markSessionViewed,
    })
    await handler.handleSessionMessage(switchMsg('s-restore'), {} as never)
    expect(markSessionViewed).toHaveBeenCalledWith('s-restore')
    expect(cap.replies[0]?.type).toBe('session.switched')
  })

  it('记录失败（markSessionViewed 抛错）不影响 switch 主流程：仍正常 reply，不产生 error envelope', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { cap, handler } = makeHandler({
        getSummary: vi.fn(() => SUMMARY),
        ensureActive: vi.fn(),
        markSessionViewed: vi.fn(() => { throw new Error('boom') }),
      })
      // 修复前若记录异常向上传播，handleSessionMessage reject / reply 丢失；
      // 修复后 try/catch 隔离，主流程照常
      await expect(handler.handleSessionMessage(switchMsg('s-1'), {} as never)).resolves.toBeUndefined()
      expect(cap.replies).toHaveLength(1)
      expect(cap.replies[0]?.type).toBe('session.switched')
      expect(cap.errors).toHaveLength(0)
      // 失败落 warn 留排查线索（非静默吞）
      expect(warnSpy).toHaveBeenCalledWith('[runtime] session.switch markSessionViewed failed:', expect.any(String))
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('sessionService 缺省 markSessionViewed 成员（最小 mock 兼容）→ 静默跳过，主流程不受影响', async () => {
    const { cap, handler } = makeHandler({
      getSummary: vi.fn(() => SUMMARY),
      ensureActive: vi.fn(),
      // 刻意不提供 markSessionViewed：可选成员契约（backgroundTasks 同款形态）
    })
    await expect(handler.handleSessionMessage(switchMsg('s-1'), {} as never)).resolves.toBeUndefined()
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]?.type).toBe('session.switched')
    expect(cap.errors).toHaveLength(0)
  })
})
