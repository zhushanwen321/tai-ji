/**
 * session 激活 relay 全链单测（plugin-header-action-modal-points AP-4/u5a）。
 *
 * 覆盖（u5a 验收：追加式回调 + relay 集成）：
 * - session-service.notifySessionActivated：追加式多回调都收到（二次注册不覆盖——
 *   setOnSessionCreated 单槽是反面教材，回归锁）；单回调异常被隔离；无回调 no-op
 * - relay ①（transport）：session.switch 成功分支（summary 命中）与自动 restore 分支
 *   都触发 ctx.sessionService.notifySessionActivated 且收到该 summary；restore 失败
 *   不投递；最小 mock 缺 notifySessionActivated 成员时 switch 照常成功（可选链防御）
 * - relay ③ 消费侧（SessionEventDispatch.didActivate）：无注册者（u5b 落地
 *   registerActivate 前表恒空）时零 notify（no-op 不抛）
 *
 * 运行：cd packages/runtime && npx vitest run test/session-activate-relay.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionService } from '../src/services/session/session-service.js'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { SessionEventDispatch } from '../src/services/plugin-service/api/session-api.js'
import type { IExtensionService, IMessageBroker } from '../src/interfaces.js'
import type { IConfigStore } from '../src/services/ports/config.js'
import type { ISessionStore } from '../src/services/ports/session.js'
import type { IProcessManager } from '../src/services/ports/pi-engine.js'
import type { WorkspaceService } from '../src/services/workspace/workspace-service.js'
import type { ClientMessage, SessionSummary } from '@taiji/shared'

// ── session-service 侧（追加式回调列表语义，contract-hardening removeSessionEntry 用例同款最小装配）──

function makeSessionService(): SessionService {
  const pm = {
    onSessionExit: vi.fn(),
    getClient: vi.fn(() => undefined),
    destroySession: vi.fn(async () => {}),
    destroyAll: vi.fn(async () => {}),
  } as unknown as ConstructorParameters<typeof SessionService>[0] as IProcessManager
  const broker = { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() } as unknown as IMessageBroker
  return new SessionService(
    pm,
    broker,
    vi.fn(),
    '/project-root',
    {} as unknown as IExtensionService,
    {} as unknown as IConfigStore,
    {} as unknown as ISessionStore,
    {} as unknown as ConstructorParameters<typeof SessionService>[7],
    {} as unknown as WorkspaceService,
  )
}

const summaryOf = (id: string): SessionSummary =>
  ({ id, label: `L-${id}`, cwd: '/p', status: 'active', lastActiveAt: 1 }) as SessionSummary

describe('session-service.notifySessionActivated 追加式回调（u5a：禁单槽回归锁）', () => {
  it('多个回调都收到（二次注册不覆盖——setOnSessionCreated 式单槽的反面教材不再现）', () => {
    const svc = makeSessionService()
    const seen1: string[] = []
    const seen2: string[] = []
    const seen3: string[] = []
    svc.onSessionActivated(s => seen1.push(s.id))
    svc.onSessionActivated(s => seen2.push(s.id))
    svc.onSessionActivated(s => seen3.push(s.id))

    svc.notifySessionActivated(summaryOf('s-a'))
    svc.notifySessionActivated(summaryOf('s-b'))

    expect(seen1).toEqual(['s-a', 's-b'])
    expect(seen2).toEqual(['s-a', 's-b'])
    expect(seen3).toEqual(['s-a', 's-b'])
  })

  it('单回调异常被隔离：其余回调照常收到，异常不外抛（notifySessionCreated 同款 best-effort）', () => {
    const svc = makeSessionService()
    const seen: string[] = []
    svc.onSessionActivated(() => { throw new Error('listener boom') })
    svc.onSessionActivated(s => seen.push(s.id))

    expect(() => svc.notifySessionActivated(summaryOf('s-x'))).not.toThrow()
    expect(seen).toEqual(['s-x'])
  })

  it('无回调时 no-op 不抛', () => {
    const svc = makeSessionService()
    expect(() => svc.notifySessionActivated(summaryOf('s-y'))).not.toThrow()
  })
})

// ── transport relay ①（session.switch 成功分支 → notifySessionActivated）──

type SwitchCtx = {
  replies: Array<{ id: string | undefined; type: string; payload: Record<string, unknown> }>
  errors: Array<{ code: string; message: string }>
  notifySpy: ReturnType<typeof vi.fn> | undefined
  summaries: Array<SessionSummary | undefined>
  restoredSummary: SessionSummary | undefined
  ensureActiveError: Error | undefined
}

function makeSwitchHarness(opts: { notify?: boolean } = {}) {
  const cap: SwitchCtx = {
    replies: [],
    errors: [],
    notifySpy: opts.notify === false ? undefined : vi.fn(),
    summaries: [],
    restoredSummary: undefined,
    ensureActiveError: undefined,
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string) => {
      cap.errors.push({ code, message })
    }),
    sessionService: {
      markSessionViewed: vi.fn(),
      getSummary: vi.fn((_sid: string) => {
        // 首查（switch 入口）按队列返回（可为 undefined = 未命中走 restore）；restore 后
        // 再查返回 restoredSummary
        if (cap.summaries.length > 0) return cap.summaries.shift()
        return cap.restoredSummary ?? undefined
      }),
      ensureActive: vi.fn(async () => {
        if (cap.ensureActiveError) throw cap.ensureActiveError
        return { touchActivity: vi.fn() }
      }),
      ...(cap.notifySpy ? { notifySessionActivated: cap.notifySpy } : {}),
    },
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  const switchMsg = (sid: string): ClientMessage =>
    ({ type: 'session.switch', id: 'req-1', payload: { sessionId: sid } }) as unknown as ClientMessage
  return { handler, cap, switchMsg }
}

describe('relay ①：session.switch 成功 → notifySessionActivated 投递（mock ctx）', () => {
  it('summary 命中分支：注册的回调收到该 summary，switch reply 不变', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness()
    cap.summaries = [summaryOf('s-live')]

    await handler.handleSessionMessage(switchMsg('s-live'), {} as never)

    expect(cap.notifySpy).toHaveBeenCalledTimes(1)
    expect(cap.notifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 's-live' }))
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]!.type).toBe('session.switched')
    expect(cap.replies[0]!.payload).toMatchObject({ sessionId: 's-live' })
  })

  it('自动 restore 分支：restore 成功 → 回调收到 restored summary（冷启动/崩溃恢复补拉承接）', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness()
    cap.summaries = [undefined] // 入口首查未命中 → 走 ensureActive
    cap.restoredSummary = summaryOf('s-restored')

    await handler.handleSessionMessage(switchMsg('s-restored'), {} as never)

    expect(cap.notifySpy).toHaveBeenCalledTimes(1)
    expect(cap.notifySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 's-restored' }))
    expect(cap.replies[0]!.type).toBe('session.switched')
  })

  it('restore 失败：不投递（error envelope 路径），回调零调用', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness()
    cap.summaries = [undefined]
    cap.ensureActiveError = new Error('restore boom')

    await handler.handleSessionMessage(switchMsg('s-dead'), {} as never)

    expect(cap.notifySpy).not.toHaveBeenCalled()
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
  })

  it('最小 mock 缺 notifySessionActivated 成员：switch 照常成功（可选链防御，与 markSessionViewed 同款）', async () => {
    const { handler, cap, switchMsg } = makeSwitchHarness({ notify: false })
    cap.summaries = [summaryOf('s-min')]

    await expect(handler.handleSessionMessage(switchMsg('s-min'), {} as never)).resolves.toBeUndefined()
    expect(cap.replies[0]!.type).toBe('session.switched')
  })
})

// ── relay ③ 消费侧（SessionEventDispatch.didActivate：u5b 落地前表恒空 = no-op）──

describe('SessionEventDispatch.didActivate（u5a 最小接口）', () => {
  it('无注册者时零 notify、不抛（registerActivate 随 u5b 落地后此表才开始有条目）', () => {
    const notify = vi.fn()
    const dispatch = new SessionEventDispatch({ notify } as unknown as ConstructorParameters<typeof SessionEventDispatch>[0])

    expect(() => dispatch.didActivate({ id: 's1', label: 'l', cwd: '/p', status: 'active', createdAt: 0, lastActiveAt: 1 })).not.toThrow()
    expect(notify).not.toHaveBeenCalled()
  })
})
