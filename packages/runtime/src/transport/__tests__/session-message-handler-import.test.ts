/**
 * SessionMessageHandler 导入会话 case 分发测试（import-session u3 / D5 + 多源 §3.7）。
 *
 * 覆盖：
 * - payload→reply 映射：session.importCandidates / session.import 两命令（reply 与 request
 *   同名，payload/reply 类型 SSOT = shared import-session.ts，handler 只透传不裁剪——
 *   含 source/sessionId/dbPath 多源字段随 payload 整体透传，路由在 ImportService 的
 *   source 注册表内，handler 对源零分支）
 * - 错误 envelope：ImportServiceError.code 透传；非预期无 code 错误归 import_failed
 * - import 成功后 broadcastSessionList 被调（P-broadcast，reply 先于广播）
 * - importService 缺席 → import_unsupported（对齐 handoffService 可选服务惯例）
 *
 * 运行命令：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-import.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SessionMessageHandler, type SessionHandlerContext } from '../session-message-handler.js'
import { ImportServiceError, type ImportService } from '../../services/session/import-service.js'
import type { ISessionService } from '../../interfaces.js'
import type { ClientMessage, ImportCandidatesReply, ImportReply } from '@taiji/shared'

// ── mock helpers（对齐 worktree-message-handler.test.ts 风格）──────────────

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as any
}

/** import case 不触碰 sessionService，最小占位（不为未覆盖方法造无断言价值的 mock）。 */
function mockContext(overrides?: Partial<SessionHandlerContext>): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService: {} as ISessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    ...overrides,
  }
}

/** 仅含被测两方法的 mock：listCandidates / importSession 由各用例注入实现。 */
function mockImportService(): { listCandidates: ReturnType<typeof vi.fn>; importSession: ReturnType<typeof vi.fn> } {
  return {
    listCandidates: vi.fn(),
    importSession: vi.fn(),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── handles 清单 ────────────────────────────────────────────

describe('SessionMessageHandler.handles（import）', () => {
  it('认领 session.importCandidates 与 session.import', () => {
    const handler = new SessionMessageHandler(mockContext())
    expect(handler.handles).toContain('session.importCandidates')
    expect(handler.handles).toContain('session.import')
  })
})

// ── session.importCandidates ────────────────────────────────

describe('SessionMessageHandler session.importCandidates', () => {
  it('成功 → listCandidates 收到完整 payload，reply 同名类型 + service 返回值原样透传', async () => {
    const svc = mockImportService()
    const reply: ImportCandidatesReply = {
      total: 2,
      items: [
        {
          sessionId: '01a020full-uuid',
          name: '日线数据迁移',
          cwd: '/Users/x/Stock',
          sourcePath: '/ext/sessions/--x--/2026-08-27_01a020.jsonl',
          lastModified: 1759300000000,
          size: 8100000,
          dirLabel: '--x--',
          alreadyImported: false,
          cwdExists: true,
        },
      ],
      dirs: [{ label: '--x--', count: 1 }],
    }
    svc.listCandidates.mockResolvedValue(reply)
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    const payload = { rootDir: '/ext/sessions', query: '01a020', limit: 100 }

    await handler.handleSessionMessage(msg('session.importCandidates', payload), ws)

    expect(svc.listCandidates).toHaveBeenCalledWith(payload)
    expect(svc.listCandidates).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.importCandidates', reply)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('ImportServiceError → code 透传 error envelope（import_dir_unreadable）', async () => {
    const svc = mockImportService()
    svc.listCandidates.mockRejectedValue(new ImportServiceError('import_dir_unreadable', '无法读取该目录：/ext'))
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg('session.importCandidates', { rootDir: '/ext' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_dir_unreadable', '无法读取该目录：/ext', 'msg-1')
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledOnce()
  })

  it('importService 缺席 → sendError import_unsupported', async () => {
    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.importCandidates', {}), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_unsupported', 'import service not available', 'msg-1')
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('payload 携带 source 等多源字段 → 原样透传（handler 对源零分支，路由在 ImportService）', async () => {
    // 多源 §3.7：source 在 ImportCandidatesRequest/ImportRequest 两契约内；sessionId/dbPath
    // 仅在 ImportRequest——candidates 用例塞 dbPath 是验证 handler 透传不裁剪的测试手段
    // 而非契约字段。本用例锁「新增源字段不经 handler 本地分支」的接线形态
    //（service mock 直接消费 payload，字段值用 zcode 形态验证透传不被吞/改）。
    const svc = mockImportService()
    svc.listCandidates.mockResolvedValue({ total: 0, items: [], dirs: [] })
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    const payload = { source: 'zcode', query: 'refactor', dbPath: '/tmp/fixture/db.sqlite' }

    await handler.handleSessionMessage(msg('session.importCandidates', payload), ws)

    expect(svc.listCandidates).toHaveBeenCalledWith(payload)
    expect(svc.listCandidates).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.importCandidates', { total: 0, items: [], dirs: [] })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})

// ── session.import ──────────────────────────────────────────

describe('SessionMessageHandler session.import', () => {
  it('成功 → importSession 收到完整 payload，reply session.import + broadcastSessionList 被调', async () => {
    const svc = mockImportService()
    const result: ImportReply = { sessionId: '01a020full-uuid', targetPath: '/taiji/sessions/--x--/2026-08-27_01a020.jsonl' }
    svc.importSession.mockResolvedValue(result)
    // 持有 reply 原始 mock（ctx 类型里 reply 是具体签名，.mock 不可达）——「reply 先于广播」
    // 用 vitest mock 的 invocationCallOrder 全局单调序断言（worktree 失效时序同法）。
    const reply = vi.fn()
    const ctx = mockContext({
      importService: svc as unknown as ImportService,
      reply: reply as unknown as SessionHandlerContext['reply'],
    })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    const payload = { sourcePath: '/ext/sessions/--x--/2026-08-27_01a020.jsonl', projectId: 'proj-stock' }

    await handler.handleSessionMessage(msg('session.import', payload), ws)

    expect(svc.importSession).toHaveBeenCalledWith(payload)
    expect(svc.importSession).toHaveBeenCalledTimes(1)
    expect(reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.import', result)
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
    // P-broadcast 时序：reply 先于广播（对齐 session.create/setProject 惯例——前端 pending
    // 先 resolve，随后列表刷新携带新会话）。
    const replyOrder = reply.mock.invocationCallOrder[0]
    const broadcastOrder = (ctx.broadcastSessionList as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
    expect(replyOrder).toBeDefined()
    expect(broadcastOrder).toBeDefined()
    expect(replyOrder).toBeLessThan(broadcastOrder)
  })

  it('成功带 warning（sidecar_failed）→ 仍走成功 reply 原样透传，不走 error envelope', async () => {
    const svc = mockImportService()
    const result: ImportReply = {
      sessionId: 's1',
      targetPath: '/taiji/sessions/--x--/a.jsonl',
      warning: 'sidecar_failed',
    }
    svc.importSession.mockResolvedValue(result)
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.import', result)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('ImportServiceError → code 透传 error envelope（import_invalid_session）', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(
      new ImportServiceError('import_invalid_session', '不是有效的 pi session 文件（首行缺少合法 session header）：/Users/x/notes.txt'),
    )
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg('session.import', { sourcePath: '/Users/x/notes.txt', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'import_invalid_session',
      '不是有效的 pi session 文件（首行缺少合法 session header）：/Users/x/notes.txt',
      'msg-1',
    )
    expect(ctx.reply).not.toHaveBeenCalled()
    // 失败路径不广播（列表未变）
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
  })

  it('ImportServiceError → code 透传 error envelope（import_already_imported）', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(new ImportServiceError('import_already_imported', '该会话已在太极中'))
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_already_imported', '该会话已在太极中', 'msg-1')
  })

  it('非预期无 code 错误 → 归 import_failed 兜底', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(new Error('unexpected'))
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_failed', 'unexpected', 'msg-1')
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
  })

  it('非 string code（number 形态）→ 不透传，归 import_failed 兜底', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(Object.assign(new Error('numeric code'), { code: 123 }))
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_failed', 'numeric code', 'msg-1')
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledOnce()
  })

  it('importService 缺席 → sendError import_unsupported', async () => {
    const ctx = mockContext()
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_unsupported', 'import service not available', 'msg-1')
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
  })

  it('payload 携带 source/sessionId/dbPath → 原样透传（zcode 形态，handler 零分支）', async () => {
    const svc = mockImportService()
    const result: ImportReply = { sessionId: 'normalized-id', targetPath: '/taiji/sessions/--x--/2026-01-01_normalized-id.jsonl' }
    svc.importSession.mockResolvedValue(result)
    const ctx = mockContext({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()
    // zcode 源形态：sourcePath 是 db 路径占位、以 sessionId + dbPath 定位（契约注释语义）
    const payload = {
      sourcePath: '/host/zcode/session-db/db.sqlite',
      projectId: 'p1',
      source: 'zcode',
      sessionId: 'sess_0199abc',
      dbPath: '/host/zcode/session-db/db.sqlite',
    }

    await handler.handleSessionMessage(msg('session.import', payload), ws)

    expect(svc.importSession).toHaveBeenCalledWith(payload)
    expect(svc.importSession).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.import', result)
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })
})
