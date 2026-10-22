/**
 * SessionMessageHandler 归档域四 RPC 分发测试（session-archive 设计 D5，u-rpc-wiring）。
 *
 * 覆盖（验收条款：三 RPC 路由 / 错误码 envelope / archiveCount 进 config.sessions 响应）：
 * - handles 认领 session.archive / session.unarchive / session.purgeArchive / config.archives
 * - 三 RPC 成功 reply 形状（payload 消费型：archive ack / unarchive 携带恢复后 SessionSummary /
 *   purgeArchive 按 keep-all 分支携带 keptSubagentsDir）
 * - 领域错误（ArchiveError，code ∈ ARCHIVE_ERROR_CODES 六值闭集）→ 统一 error envelope
 *   （code 透传 + sessionId 随 envelope 携带）；词表外 string code（fs ENOENT 等系统码）
 *   与无 code 意外 throw → archive_failed 兜底
 * - invalid_payload：sessionId 非空 string wire 预检（JSON 层可写任意形态）
 * - 端口缺省（组合根未注入，仅测试最小 mock 形态）→ archive_unsupported 防御分支
 * - config.sessions 响应携带 archiveCount（= listArchiveEntries 条目数）；未注入时字段缺省
 * - handler 不重复广播（广播由 service 步骤内经 deps.broadcastSessionList 自理，D5）
 *
 * 广播帧侧的 archiveCount 断言在 message-broker-archive.test.ts（buildSessionListMsg）。
 * service 行为（搬移/压缩/串行化）由 services/archive/archive-service.test.ts 覆盖，此处
 * archiveService 为 vi.fn 桩。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/session-message-handler-archive.test.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { SessionMessageHandler, type SessionHandlerContext, type ArchiveRpcPort } from '../session-message-handler.js'
import { ArchiveError } from '../../services/archive/archive-service.js'
import type { ISessionService } from '../../interfaces.js'
import type { ArchiveSummary, ClientMessage, SessionSummary } from '@taiji/shared'

const SID = 'sess-archive-1'

/** unarchive reply 的恢复后 SessionSummary 桩（handler 只透传不解读字段）。 */
const RESTORED_SUMMARY = { id: SID, label: 'restored' } as unknown as SessionSummary

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as import('ws').WebSocket
}

function mockContext(sessionService: ISessionService, archiveService?: ArchiveRpcPort): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    archiveService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}

/** sessionService 桩：归档域 case 只读 listPersistedSessions（config.sessions 响应用）。 */
function fakeSessionService(listPersistedSessions: () => unknown[] = () => []): ISessionService {
  return { listPersistedSessions } as unknown as ISessionService
}

/** archiveService 桩：vi.fn 默认值可被单测 mockResolvedValueOnce/mockRejectedValueOnce 覆写。 */
function fakeArchiveService(archives: ArchiveSummary[] = []): ArchiveRpcPort {
  return {
    archive: vi.fn(async (sessionId: string) => ({ sessionId })),
    unarchive: vi.fn(async (sessionId: string) => ({ sessionId, session: RESTORED_SUMMARY })),
    purgeArchive: vi.fn(async (sessionId: string) => ({ sessionId })),
    listArchiveEntries: vi.fn(() => archives),
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（归档域）', () => {
  it('认领 session.archive / session.unarchive / session.purgeArchive / config.archives 四消息', () => {
    const handler = new SessionMessageHandler(mockContext(fakeSessionService()))
    expect(handler.handles).toContain('session.archive')
    expect(handler.handles).toContain('session.unarchive')
    expect(handler.handles).toContain('session.purgeArchive')
    expect(handler.handles).toContain('config.archives')
  })
})

// ── 端口缺省防御分支 ────────────────────────────────────────────

describe('SessionMessageHandler archive 端口缺省', () => {
  it('archiveService 未注入 → 三 RPC + config.archives 均 archive_unsupported envelope', async () => {
    const ctx = mockContext(fakeSessionService(), undefined)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.archive', { sessionId: SID }), ws)
    await handler.handleSessionMessage(msg('session.unarchive', { sessionId: SID }), ws)
    await handler.handleSessionMessage(msg('session.purgeArchive', { sessionId: SID }), ws)
    await handler.handleSessionMessage(msg('config.archives', {}), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(4)
    for (const call of vi.mocked(ctx.sendError).mock.calls) {
      expect(call[1]).toBe('archive_unsupported')
    }
    // 带 sessionId 的三 RPC envelope 携带 sessionId；config.archives 无请求参数不带
    expect(vi.mocked(ctx.sendError).mock.calls[0][4]).toEqual({ sessionId: SID })
    expect(vi.mocked(ctx.sendError).mock.calls[3][4]).toBeUndefined()
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

// ── wire 预检 ──────────────────────────────────────────────────

describe('SessionMessageHandler archive invalid_payload', () => {
  it.each([
    ['空串', { sessionId: '' }],
    ['非 string', { sessionId: 42 }],
    ['缺失', {}],
  ])('session.archive sessionId %s → invalid_payload，不触达 service', async (_label, payload) => {
    const svc = fakeArchiveService()
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.archive', payload), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.sendError).mock.calls[0][1]).toBe('invalid_payload')
    expect(vi.mocked(ctx.sendError).mock.calls[0][2]).toContain('sessionId')
    expect(vi.mocked(ctx.sendError).mock.calls[0][3]).toBe('msg-1')
    expect(svc.archive).not.toHaveBeenCalled()
  })
})

// ── session.archive ────────────────────────────────────────────

describe('SessionMessageHandler session.archive', () => {
  it('成功 → reply session.archive { sessionId }（ack 型）；handler 不重复广播', async () => {
    const svc = fakeArchiveService()
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.archive', { sessionId: SID }), ws)

    expect(svc.archive).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.archive', { sessionId: SID })
    // 广播由 service 步骤 5 自理（fake service 不广播——断言 handler 层零重复广播）
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('前置三门领域码（archive_generating / archive_already_archived）→ envelope code 透传 + sessionId 携带', async () => {
    const svc = fakeArchiveService()
    vi.mocked(svc.archive)
      .mockRejectedValueOnce(new ArchiveError('archive_generating', '会话正在生成中'))
      .mockRejectedValueOnce(new ArchiveError('archive_already_archived', '已有归档记录'))
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.archive', { sessionId: SID }), ws)
    await handler.handleSessionMessage(msg('session.archive', { sessionId: SID }, 'msg-2'), ws)

    const calls = vi.mocked(ctx.sendError).mock.calls
    expect(calls.map((c) => c[1])).toEqual(['archive_generating', 'archive_already_archived'])
    expect(calls[0][2]).toBe('会话正在生成中')
    expect(calls[0][4]).toEqual({ sessionId: SID })
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})

// ── session.unarchive ──────────────────────────────────────────

describe('SessionMessageHandler session.unarchive', () => {
  it('成功 → reply session.unarchive { sessionId, session }（恢复后 SessionSummary 透传）', async () => {
    const svc = fakeArchiveService()
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.unarchive', { sessionId: SID }), ws)

    expect(svc.unarchive).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.unarchive', { sessionId: SID, session: RESTORED_SUMMARY })
  })

  it('冲突/损坏领域码（archive_restore_conflict / archive_corrupted）→ envelope 透传', async () => {
    const svc = fakeArchiveService()
    vi.mocked(svc.unarchive)
      .mockRejectedValueOnce(new ArchiveError('archive_restore_conflict', '原路径已存在同名主文件'))
      .mockRejectedValueOnce(new ArchiveError('archive_corrupted', 'sha256 校验不匹配'))
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.unarchive', { sessionId: SID }), ws)
    await handler.handleSessionMessage(msg('session.unarchive', { sessionId: SID }, 'msg-2'), ws)

    expect(vi.mocked(ctx.sendError).mock.calls.map((c) => c[1])).toEqual(['archive_restore_conflict', 'archive_corrupted'])
  })
})

// ── session.purgeArchive ───────────────────────────────────────

describe('SessionMessageHandler session.purgeArchive', () => {
  it('干净删除 → reply 不携带 keptSubagentsDir（缺省 = 无保留说明）', async () => {
    const svc = fakeArchiveService()
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.purgeArchive', { sessionId: SID }), ws)

    expect(svc.purgeArchive).toHaveBeenCalledWith(SID)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.purgeArchive', { sessionId: SID })
  })

  it('keep-all 保守分支 → reply 携带 keptSubagentsDir（失败显式上报，D5 步骤 7）', async () => {
    const svc = fakeArchiveService()
    vi.mocked(svc.purgeArchive).mockResolvedValueOnce({
      sessionId: SID,
      keptSubagentsDir: '/tmp/root/subagents',
    })
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.purgeArchive', { sessionId: SID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.purgeArchive', {
      sessionId: SID,
      keptSubagentsDir: '/tmp/root/subagents',
    })
  })

  it('簿记存在性门拒绝 → archive_not_found envelope（拒绝时零副作用语义由 service 承载）', async () => {
    const svc = fakeArchiveService()
    vi.mocked(svc.purgeArchive).mockRejectedValueOnce(new ArchiveError('archive_not_found', '归档记录不存在'))
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('session.purgeArchive', { sessionId: SID }), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'archive_not_found',
      '归档记录不存在',
      'msg-1',
      { sessionId: SID },
    )
  })
})

// ── 错误码词表守门（envelope code 不泄漏系统码）─────────────────

describe('SessionMessageHandler archive 错误码词表守门', () => {
  it('词表外 string code（fs 系统码 ENOENT）不透传 → archive_failed', async () => {
    const svc = fakeArchiveService()
    const enoent = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    vi.mocked(svc.archive).mockRejectedValueOnce(enoent)
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.archive', { sessionId: SID }), mockWs())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(vi.mocked(ctx.sendError).mock.calls[0][1]).toBe('archive_failed')
  })

  it('无 code 的意外 throw → archive_failed', async () => {
    const svc = fakeArchiveService()
    vi.mocked(svc.unarchive).mockRejectedValueOnce(new Error('unexpected'))
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg('session.unarchive', { sessionId: SID }), mockWs())

    expect(vi.mocked(ctx.sendError).mock.calls[0][1]).toBe('archive_failed')
  })
})

// ── config.archives ────────────────────────────────────────────

describe('SessionMessageHandler config.archives', () => {
  it('成功 → reply config.archives { archives } 全量透传（.restoring 过滤在 service）', async () => {
    const archives = [
      { sessionId: SID, status: 'staging', summary: null },
    ] as unknown as ArchiveSummary[]
    const svc = fakeArchiveService(archives)
    const ctx = mockContext(fakeSessionService(), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('config.archives', {}), ws)

    expect(svc.listArchiveEntries).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'config.archives', { archives })
  })
})

// ── archiveCount 进 config.sessions 响应 ───────────────────────

describe('SessionMessageHandler config.sessions archiveCount', () => {
  it('注入 archiveService → 响应携带 archiveCount = 归档条目数（角标与归档列表同数据源）', async () => {
    const archives = [
      { sessionId: 'a-1', status: 'staging', summary: null },
      { sessionId: 'a-2', status: 'archived', summary: { turns: [] } },
    ] as unknown as ArchiveSummary[]
    const svc = fakeArchiveService(archives)
    const ctx = mockContext(fakeSessionService(() => [{ id: 'g1' }]), svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('config.sessions', {}), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'config.sessions', {
      groups: [{ id: 'g1' }],
      archiveCount: 2,
    })
  })

  it('未注入 archiveService → archiveCount 字段缺省（协议 optional，消费方按 0 隐藏角标）', async () => {
    const ctx = mockContext(fakeSessionService(() => []), undefined)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleSessionMessage(msg('config.sessions', {}), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'config.sessions', { groups: [] })
  })
})
