import type { ISessionService } from '../../interfaces.js';
import { ArchiveError } from '../../services/archive/archive-service.js';
import { BackgroundTaskService, type BackgroundTaskServiceDeps } from '../../services/background-task/background-task-service.js';
import { ImportServiceError, type ImportService } from '../../services/session/import-service.js';
import { SessionNotFoundError, SessionStateQuery, _resetSessionStateQueryForTest, bindSessionStateQuery, type SessionStateQueryDeps } from '../../services/session/session-state-query.js';
import { OUTPUT_TAIL_MAX_REQUEST_BYTES, SessionMessageHandler, type ArchiveRpcPort, type SessionHandlerContext } from '../session-message-handler.js';
import { SubagentMessageHandler } from '../subagent-message-handler.js';
import type { ArchiveSummary, ClientMessage, SessionSummary } from '@taiji/shared';
import { getDataDir } from '@taiji/shared/paths';
import type { BackgroundTaskRegistryEntry } from '@zhushanwen/extension-protocol';
import { zcodeImportDbAllowlist } from '@zhushanwen/zcode-session-source';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket as WsType } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/transport/__tests__/session-message-handler-archive.test.ts
// ======================================================================

import type { SubagentModelSwitchGateway } from '../../interfaces.js';
import type { SubagentHandlerContext } from '../subagent-message-handler.js';
import type { ImportCandidatesReply, ImportReply, PlanStateView, SubagentSetModelAggregateReply, SubagentSetModelReply, WorkflowDagReply, WorkflowRunEventsReply } from '@taiji/shared';
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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-archive', () => {
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
});

// ======================================================================
// ← src/transport/__tests__/session-message-handler-background-task.test.ts
// ======================================================================

// ── fixtures / 装置（对齐 background-task-service.test.ts 形状）──────

const SID_m2 = 'sess-bg-1'

const SID_OTHER = 'sess-bg-2'

const TASK_ID = 'bt-1789-test'

const TASK_PID = 53241

const OWNER_PID = 40001

const STARTED_AT = 1_700_000_000_000


let dataDir: string

let agentDir: string


// [session-store-layout-inversion 域 5] registry 布局 = <dataDir>/ext-sessions/<sid>/
// background-tasks/registry.json；agentDir（pi agentDir，service 注入基址）= <dataDir>/agent
// ——fixture 与 BackgroundTaskService 经同一 dirname 换算推导，树随 dataDir 整体清理。
function registryPath(sessionId: string = SID_m2): string {
  return join(dataDir, 'ext-sessions', sessionId, 'background-tasks', 'registry.json')
}


function makeEntry(overrides: Partial<BackgroundTaskRegistryEntry> = {}): BackgroundTaskRegistryEntry {
  return {
    taskId: TASK_ID,
    pid: TASK_PID,
    command: 'pnpm test',
    outputFile: join(dataDir, 'ext-sessions', SID_m2, 'background-tasks', `${TASK_ID}.log`),
    startedAt: STARTED_AT,
    state: 'running',
    ownerPiPid: OWNER_PID,
    sessionId: SID_m2,
    ...overrides,
  }
}


/** 按契约形状写 registry（JSON indent 2 + 尾部换行；tmp 自建自删）。 */
function writeRegistry(entries: BackgroundTaskRegistryEntry[], sessionId: string = SID_m2): void {
  mkdirSync(dirname(registryPath(sessionId)), { recursive: true })
  writeFileSync(registryPath(sessionId), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
}


/** deps：按 pid 路由判活 + 探测/处置 spy（降级档恒过，对齐 svc 测试 makeDeps 缺省）。 */
function makeDeps(): BackgroundTaskServiceDeps {
  return {
    isPidAlive: vi.fn((pid: number) => pid === TASK_PID || pid === OWNER_PID),
    killProcessTree: vi.fn(),
    probeProcessStartTimeMs: vi.fn(async () => STARTED_AT),
  }
}


/** 真实 BackgroundTaskService（tmp piAgentDir + 注入原语；不 start 轮询）。 */
function makeService(onTasksChanged = vi.fn(), deps: BackgroundTaskServiceDeps = makeDeps()): BackgroundTaskService {
  return new BackgroundTaskService({ onTasksChanged, piAgentDir: agentDir, deps })
}


// ── handler ctx 装置（仿 session-message-handler-import.test.ts）────

function mockWs_m2() {
  return { send: vi.fn(), readyState: 1 } as any
}


function mockContext_m2(sessionService: ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}


/** sessionService 桩：仅 backgroundTasks 端口被本域 case 消费（交叉可选属性缺失即防御分支形态）。 */
function fakeSessionService_m2(backgroundTasks?: BackgroundTaskService): ISessionService {
  return (backgroundTasks ? { backgroundTasks } : {}) as unknown as ISessionService
}


function msg_m2(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-background-task', () => {
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'bg-task-rpc-'))
  agentDir = join(dataDir, 'agent')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})
// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（backgroundTask 域）', () => {
  it('认领 backgroundTask.list / output / kill 三消息', () => {
    const handler = new SessionMessageHandler(mockContext_m2(fakeSessionService_m2()))
    expect(handler.handles).toContain('backgroundTask.list')
    expect(handler.handles).toContain('backgroundTask.output')
    expect(handler.handles).toContain('backgroundTask.kill')
  })
})
// ── 端口缺省防御分支 ────────────────────────────────────────────

describe('SessionMessageHandler backgroundTask 端口缺省', () => {
  it('backgroundTasks 未组装 → background_task_unsupported error envelope（sessionId 必带）', async () => {
    const ctx = mockContext_m2(fakeSessionService_m2(undefined))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }), ws)
    await handler.handleSessionMessage(msg_m2('backgroundTask.output', { sessionId: SID_m2, taskId: TASK_ID }), ws)
    await handler.handleSessionMessage(msg_m2('backgroundTask.kill', { sessionId: SID_m2, taskId: TASK_ID }), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(ctx.sendError).mock.calls) {
      expect(call[1]).toBe('background_task_unsupported')
      expect(call[4]).toEqual({ sessionId: SID_m2 })
    }
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
// ── backgroundTask.list ─────────────────────────────────────────

describe('SessionMessageHandler backgroundTask.list', () => {
  it('reply backgroundTask.tasks 形状：sessionId 必带 + registry 全量派生视图 + corrupted:false 正常拍；markWatched 基线不广播', async () => {
    writeRegistry([makeEntry(), makeEntry({ taskId: 'bt-1789-other', state: 'exited', exitCode: 0 })])
    const onTasksChanged = vi.fn()
    const svc = makeService(onTasksChanged)
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }), ws)

    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', {
      sessionId: SID_m2,
      tasks: [
        expect.objectContaining({ taskId: TASK_ID, state: 'running' }),
        expect.objectContaining({ taskId: 'bt-1789-other', state: 'exited', exitCode: 0 }),
      ],
      corrupted: false,
    })
    // markWatched 基线语义：拉取时点即已见状态，list 本身不触发变更回调
    expect(onTasksChanged).not.toHaveBeenCalled()
  })

  it('list 拉取加入 watched（D8③）：list 后 registry 变更 → checkForChanges 触发 onTasksChanged', async () => {
    writeRegistry([makeEntry()])
    const onTasksChanged = vi.fn()
    const svc = makeService(onTasksChanged)
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }), ws)
    expect(onTasksChanged).not.toHaveBeenCalled()

    // list 之后的状态迁移（running → exited）：watched 集合命中，变更检测回调触发
    writeRegistry([makeEntry({ state: 'exited', exitCode: 1 })])
    svc.checkForChanges()
    expect(onTasksChanged).toHaveBeenCalledTimes(1)
    expect(onTasksChanged).toHaveBeenCalledWith(SID_m2)
  })

  it('损坏 registry（非法 JSON）→ reply corrupted=true + 空表（S7 错误条依据，.corrupt 隔离保留现场）', async () => {
    mkdirSync(dirname(registryPath()), { recursive: true })
    writeFileSync(registryPath(), '{ broken json', 'utf8')
    const svc = makeService()
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', {
      sessionId: SID_m2,
      tasks: [],
      corrupted: true,
    })
    // D1 语义：损坏现场隔离为 .corrupt（人工恢复入口）
    expect(existsSync(`${registryPath()}.corrupt`)).toBe(true)
  })

  it('损坏后自愈（重新写入合法 registry）→ 后续 list 拍 corrupted=false（审查修复验收②）', async () => {
    mkdirSync(dirname(registryPath()), { recursive: true })
    writeFileSync(registryPath(), '{ broken json', 'utf8')
    const svc = makeService()
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    // 损坏拍
    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }, 'msg-corrupt'), ws)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-corrupt', 'backgroundTask.tasks', {
      sessionId: SID_m2,
      tasks: [],
      corrupted: true,
    })

    // 自愈：合法 registry 重新落盘（extension 空表重建/AI 新任务路径）→ 后续拍恢复
    writeRegistry([makeEntry()])
    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }, 'msg-healed'), ws)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-healed', 'backgroundTask.tasks', {
      sessionId: SID_m2,
      tasks: [expect.objectContaining({ taskId: TASK_ID, state: 'running' })],
      corrupted: false,
    })
  })

  it('目录/文件不存在（垃圾 sid）→ 空数组回执 + corrupted:false（非损坏，常态空表），不抛错', async () => {
    const svc = makeService()
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: 'nonexistent-sid' }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', {
      sessionId: 'nonexistent-sid',
      tasks: [],
      corrupted: false,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})
// ── backgroundTask.output ───────────────────────────────────────

describe('SessionMessageHandler backgroundTask.output', () => {
  it('输出文件可读 → tail 形状 { sessionId, taskId, text, truncated:false, lost:false }', async () => {
    const entry = makeEntry()
    writeRegistry([entry])
    mkdirSync(dirname(entry.outputFile), { recursive: true })
    writeFileSync(entry.outputFile, 'line-1\nline-2\nline-3\n', 'utf8')
    const svc = makeService()
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.output', { sessionId: SID_m2, taskId: TASK_ID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.outputResult', {
      sessionId: SID_m2,
      taskId: TASK_ID,
      text: 'line-1\nline-2\nline-3\n',
      truncated: false,
      lost: false,
    })
  })

  it('条目不存在（registry 缺失）→ lost 降级：text 空串 + truncated false + lost true', async () => {
    const svc = makeService()
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.output', { sessionId: SID_m2, taskId: TASK_ID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.outputResult', {
      sessionId: SID_m2,
      taskId: TASK_ID,
      text: '',
      truncated: false,
      lost: true,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('maxBytes 超 1MB → clamp 到 OUTPUT_TAIL_MAX_REQUEST_BYTES（D6 #1/BG-4）；缺省不传透传 undefined（service 默认 32KB）', async () => {
    const entry = makeEntry()
    writeRegistry([entry])
    mkdirSync(dirname(entry.outputFile), { recursive: true })
    writeFileSync(entry.outputFile, 'x'.repeat(64), 'utf8')
    const svc = makeService()
    const tailSpy = vi.spyOn(svc, 'getOutputTail')
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)

    // 客户端声明 100MB 窗口 → 钳到 1MB（readOutputTail 按窗口 alloc，无上界即内存失控面）
    await handler.handleSessionMessage(
      msg_m2('backgroundTask.output', { sessionId: SID_m2, taskId: TASK_ID, maxBytes: 100 * 1024 * 1024 }),
      mockWs_m2(),
    )
    expect(tailSpy).toHaveBeenCalledWith(SID_m2, TASK_ID, OUTPUT_TAIL_MAX_REQUEST_BYTES)

    // 合法小窗口原样透传（clamp 只剪上界，不改写正常请求）
    await handler.handleSessionMessage(
      msg_m2('backgroundTask.output', { sessionId: SID_m2, taskId: TASK_ID, maxBytes: 1024 }, 'msg-2'),
      mockWs_m2(),
    )
    expect(tailSpy).toHaveBeenLastCalledWith(SID_m2, TASK_ID, 1024)

    // 缺省不传 → undefined 透传（service 层默认 32KB 生效，不被 clamp 改写为 1MB）
    await handler.handleSessionMessage(
      msg_m2('backgroundTask.output', { sessionId: SID_m2, taskId: TASK_ID }, 'msg-3'),
      mockWs_m2(),
    )
    expect(tailSpy).toHaveBeenLastCalledWith(SID_m2, TASK_ID, undefined)
  })
})
// ── backgroundTask.kill ─────────────────────────────────────────

describe('SessionMessageHandler backgroundTask.kill', () => {
  it('D6 分支①（pid 活 + 身份过 + 属主活）→ 回执 { killed:true, reason:"killed" }，registry 预写 killing', async () => {
    writeRegistry([makeEntry()])
    const deps = makeDeps()
    const svc = makeService(vi.fn(), deps)
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.kill', { sessionId: SID_m2, taskId: TASK_ID }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.killResult', {
      sessionId: SID_m2,
      taskId: TASK_ID,
      killed: true,
      reason: 'killed',
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
    // 锁内预写 killing + 发信号（D6 分支①动作序），service 侧矩阵细节由 svc 域单测覆盖
    expect(deps.killProcessTree).toHaveBeenCalledWith(TASK_PID)
  })

  it('条目不存在 → 回执 { killed:false, reason:"already-exited" }，无信号', async () => {
    const deps = makeDeps()
    const svc = makeService(vi.fn(), deps)
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    await handler.handleSessionMessage(msg_m2('backgroundTask.kill', { sessionId: SID_m2, taskId: 'bt-missing' }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.killResult', {
      sessionId: SID_m2,
      taskId: 'bt-missing',
      killed: false,
      reason: 'already-exited',
    })
    expect(deps.killProcessTree).not.toHaveBeenCalled()
  })
})
// ── P6 session 分区（handler 层：list 的 watched 按入参 sid 定向）──

describe('SessionMessageHandler backgroundTask 分区（P6 handler 侧）', () => {
  it('list(sid=A) 的 watched 与回执只含 A；B 的 registry 变更不触发 A 的变更回调', async () => {
    writeRegistry([makeEntry()], SID_m2)
    writeRegistry([makeEntry({ sessionId: SID_OTHER })], SID_OTHER)
    const onTasksChanged = vi.fn()
    const svc = makeService(onTasksChanged)
    const ctx = mockContext_m2(fakeSessionService_m2(svc))
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m2()

    // 只拉取 A
    await handler.handleSessionMessage(msg_m2('backgroundTask.list', { sessionId: SID_m2 }), ws)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'backgroundTask.tasks', expect.objectContaining({ sessionId: SID_m2 }))

    // B 变更：A/B 的 watched 集合独立——B 未被 list 过，不触发；A 的 mtime 未变也不触发
    writeRegistry([makeEntry({ sessionId: SID_OTHER, state: 'exited', exitCode: 0 })], SID_OTHER)
    svc.checkForChanges()
    expect(onTasksChanged).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← src/transport/__tests__/session-message-handler-get-state.test.ts
// ======================================================================

const SID_m3 = 'sess-state-1'


function mockWs_m3(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


function mockContext_m3(sessionService: ISessionService = {} as unknown as ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}


function msg_m3(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


/** 装配一个可操控 reply 的查询服务并绑进模块槽，返回 getState spy */
function bindQuery(reply: unknown): ReturnType<typeof vi.fn> {
  const getState = vi.fn(async () => reply)
  const deps: SessionStateQueryDeps = {
    getClient: () => undefined,
    getReplicatedStates: () => undefined,
    locateMainSessionFileFromCache: () => undefined,
    locateMainSessionFileFromDisk: () => ({ filePath: undefined, scannedDirCount: 0 }),
    locateBtwLineFile: () => undefined,
    locateBtwLineFileByLayout: () => ({ filePath: undefined, scannedDirCount: 0 }),
  }
  // 直接替换实例方法（查询服务本体行为由 session-state-query.test.ts 锁定，本文件只测接线）
  const query = new SessionStateQuery(deps)
  vi.spyOn(query, 'getState').mockImplementation(getState as never)
  bindSessionStateQuery(query)
  return getState
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-get-state', () => {
afterEach(() => {
  _resetSessionStateQueryForTest()
  vi.restoreAllMocks()
})
describe('SessionMessageHandler.handles（权威拉取与冷读）', () => {
  it('认领 session.getState', () => {
    const handler = new SessionMessageHandler(mockContext_m3())
    expect(handler.handles).toContain('session.getState')
  })
})
describe('SessionMessageHandler session.getState', () => {
  it('透传：调 SessionStateQuery.getState + reply 同名 { sessionId, modelId?, thinkingLevel? }', async () => {
    const getState = bindQuery({ sessionId: SID_m3, modelId: 'prov-a/model-a', thinkingLevel: 'high' })
    const ctx = mockContext_m3()
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m3('session.getState', { sessionId: SID_m3 }), mockWs_m3())

    expect(getState).toHaveBeenCalledTimes(1)
    expect(getState).toHaveBeenCalledWith(SID_m3)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getState', {
      sessionId: SID_m3,
      modelId: 'prov-a/model-a',
      thinkingLevel: 'high',
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('快照未就绪 / 冷文件无模型记录：字段缺省正常 reply 非错误（显式未知）', async () => {
    bindQuery({ sessionId: SID_m3 })
    const ctx = mockContext_m3()
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m3('session.getState', { sessionId: SID_m3 }), mockWs_m3())

    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getState', { sessionId: SID_m3 })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('会话不存在 → SESSION_NOT_FOUND 结构化错误 envelope（sessionId 必带，不 reply 空对象）', async () => {
    const getState = vi.fn(async () => {
      throw new SessionNotFoundError(SID_m3)
    })
    const deps: SessionStateQueryDeps = {
      getClient: () => undefined,
      getReplicatedStates: () => undefined,
      locateMainSessionFileFromCache: () => undefined,
      locateMainSessionFileFromDisk: () => ({ filePath: undefined, scannedDirCount: 0 }),
      locateBtwLineFile: () => undefined,
    locateBtwLineFileByLayout: () => ({ filePath: undefined, scannedDirCount: 0 }),
    }
    const query = new SessionStateQuery(deps)
    vi.spyOn(query, 'getState').mockImplementation(getState as never)
    bindSessionStateQuery(query)

    const ctx = mockContext_m3()
    const handler = new SessionMessageHandler(ctx)
    await handler.handleSessionMessage(msg_m3('session.getState', { sessionId: SID_m3 }), mockWs_m3())

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'SESSION_NOT_FOUND',
      expect.any(String),
      'msg-1',
      { sessionId: SID_m3 },
    )
  })

  it('读失败（非 SESSION_NOT_FOUND）→ session_get_state_failed envelope', async () => {
    const getState = vi.fn(async () => {
      throw new Error('EACCES: permission denied')
    })
    const deps: SessionStateQueryDeps = {
      getClient: () => undefined,
      getReplicatedStates: () => undefined,
      locateMainSessionFileFromCache: () => undefined,
      locateMainSessionFileFromDisk: () => ({ filePath: undefined, scannedDirCount: 0 }),
      locateBtwLineFile: () => undefined,
    locateBtwLineFileByLayout: () => ({ filePath: undefined, scannedDirCount: 0 }),
    }
    const query = new SessionStateQuery(deps)
    vi.spyOn(query, 'getState').mockImplementation(getState as never)
    bindSessionStateQuery(query)

    const ctx = mockContext_m3()
    const handler = new SessionMessageHandler(ctx)
    await handler.handleSessionMessage(msg_m3('session.getState', { sessionId: SID_m3 }), mockWs_m3())

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'session_get_state_failed',
      expect.any(String),
      'msg-1',
      { sessionId: SID_m3 },
    )
  })

  it('查询服务未装配（模块槽未绑定，仅测试最小 mock 形态）→ session_state_query_unavailable', async () => {
    const ctx = mockContext_m3()
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m3('session.getState', { sessionId: SID_m3 }), mockWs_m3())

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'session_state_query_unavailable',
      expect.any(String),
      'msg-1',
      { sessionId: SID_m3 },
    )
  })
})
});

// ======================================================================
// ← src/transport/__tests__/session-message-handler-import.test.ts
// ======================================================================

// ── mock helpers（对齐 worktree-message-handler.test.ts 风格）──────────────

function mockWs_m4() {
  return { send: vi.fn(), readyState: 1 } as any
}


/** import case 不触碰 sessionService，最小占位（不为未覆盖方法造无断言价值的 mock）。 */
function mockContext_m4(overrides?: Partial<SessionHandlerContext>): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService: {} as ISessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
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


function msg_m4(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-import', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
// ── handles 清单 ────────────────────────────────────────────

describe('SessionMessageHandler.handles（import）', () => {
  it('认领 session.importCandidates 与 session.import', () => {
    const handler = new SessionMessageHandler(mockContext_m4())
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
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const payload = { rootDir: '/ext/sessions', query: '01a020', limit: 100 }

    await handler.handleSessionMessage(msg_m4('session.importCandidates', payload), ws)

    expect(svc.listCandidates).toHaveBeenCalledWith(payload)
    expect(svc.listCandidates).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.importCandidates', reply)
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('ImportServiceError → code 透传 error envelope（import_dir_unreadable）', async () => {
    const svc = mockImportService()
    svc.listCandidates.mockRejectedValue(new ImportServiceError('import_dir_unreadable', '无法读取该目录：/ext'))
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg_m4('session.importCandidates', { rootDir: '/ext' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_dir_unreadable', '无法读取该目录：/ext', 'msg-1')
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledOnce()
  })

  it('importService 缺席 → sendError import_unsupported', async () => {
    const ctx = mockContext_m4()
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()

    await handler.handleSessionMessage(msg_m4('session.importCandidates', {}), ws)

    // candidates payload 契约无 sessionId 字段（ImportCandidatesRequest）→ envelope 无从带
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
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const payload = { source: 'zcode', query: 'refactor', dbPath: '/tmp/fixture/db.sqlite' }

    await handler.handleSessionMessage(msg_m4('session.importCandidates', payload), ws)

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
    const ctx = mockContext_m4({
      importService: svc as unknown as ImportService,
      reply: reply as unknown as SessionHandlerContext['reply'],
    })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const payload = { sourcePath: '/ext/sessions/--x--/2026-08-27_01a020.jsonl', projectId: 'proj-stock' }

    await handler.handleSessionMessage(msg_m4('session.import', payload), ws)

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
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()

    await handler.handleSessionMessage(msg_m4('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.import', result)
    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('ImportServiceError → code 透传 error envelope（import_invalid_session）', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(
      new ImportServiceError('import_invalid_session', '不是有效的 pi session 文件（首行缺少合法 session header）：/Users/x/notes.txt'),
    )
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg_m4('session.import', { sourcePath: '/Users/x/notes.txt', projectId: 'p1' }), ws)

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
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg_m4('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_already_imported', '该会话已在太极中', 'msg-1')
  })

  it('非预期无 code 错误 → 归 import_failed 兜底', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(new Error('unexpected'))
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg_m4('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_failed', 'unexpected', 'msg-1')
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
  })

  it('非 string code（number 形态）→ 不透传，归 import_failed 兜底', async () => {
    const svc = mockImportService()
    svc.importSession.mockRejectedValue(Object.assign(new Error('numeric code'), { code: 123 }))
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await handler.handleSessionMessage(msg_m4('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_failed', 'numeric code', 'msg-1')
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalledOnce()
  })

  it('importService 缺席 → sendError import_unsupported', async () => {
    const ctx = mockContext_m4()
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()

    await handler.handleSessionMessage(msg_m4('session.import', { sourcePath: '/ext/a.jsonl', projectId: 'p1' }), ws)

    // C-comm-05：error envelope 第 5 参 details.sessionId 条件传递（本用例 payload 无
    // sessionId——pi 源可不带 → 收到 undefined，与「有则必带」的实现形态锁定）
    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'import_unsupported', 'import service not available', 'msg-1', undefined)
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
  })

  it('payload 携带 source/sessionId/dbPath（白名单内）→ 原样透传（zcode 形态，handler 零分支）', async () => {
    const svc = mockImportService()
    const result: ImportReply = { sessionId: 'normalized-id', targetPath: '/taiji/sessions/--x--/2026-01-01_normalized-id.jsonl' }
    svc.importSession.mockResolvedValue(result)
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    // zcode 源形态：sourcePath 是 db 路径占位、以 sessionId + dbPath 定位（契约注释语义）；
    // dbPath 取白名单集合内值（隔离库，进程内同函数推导——测试 env 的 dataDir 被 test-guard
    // 固定为 tmp，不触真实数据目录）
    const allowedDbPath = zcodeImportDbAllowlist(getDataDir())[0]
    const payload = {
      sourcePath: allowedDbPath,
      projectId: 'p1',
      source: 'zcode',
      sessionId: 'sess_0199abc',
      dbPath: allowedDbPath,
    }

    await handler.handleSessionMessage(msg_m4('session.import', payload), ws)

    expect(svc.importSession).toHaveBeenCalledWith(payload)
    expect(svc.importSession).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'session.import', result)
    expect(ctx.broadcastSessionList).toHaveBeenCalledTimes(1)
  })

  it('dbPath 白名单集合外 → sendError import_db_path_forbidden，service 不被调不广播（MF-3-1）', async () => {
    const svc = mockImportService()
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const payload = {
      sourcePath: '/elsewhere/db.sqlite',
      projectId: 'p1',
      source: 'zcode',
      sessionId: 'sess_0199abc',
      dbPath: '/elsewhere/db.sqlite',
    }

    await handler.handleSessionMessage(msg_m4('session.import', payload), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'import_db_path_forbidden',
      expect.stringContaining('dbPath 不在允许的会话库路径集合内'),
      'msg-1',
      { sessionId: 'sess_0199abc' },
    )
    expect(svc.importSession).not.toHaveBeenCalled()
    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.broadcastSessionList).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('dbPath 非 string 形态（wire 不可信数据侧）→ sendError import_db_path_forbidden（MF-3-1）', async () => {
    const svc = mockImportService()
    const ctx = mockContext_m4({ importService: svc as unknown as ImportService })
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m4()
    const payload = {
      sourcePath: '/x/db.sqlite',
      projectId: 'p1',
      source: 'zcode',
      sessionId: 'sess_0199abc',
      dbPath: 42,
    }

    await handler.handleSessionMessage(msg_m4('session.import', payload as Record<string, unknown>), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'import_db_path_forbidden',
      expect.stringContaining('dbPath 不在允许的会话库路径集合内'),
      'msg-1',
      { sessionId: 'sess_0199abc' },
    )
    expect(svc.importSession).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← src/transport/__tests__/session-message-handler-message-count.test.ts
// ======================================================================

const SID_m4 = 'sess-count-1'


function mockWs_m5(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


function mockContext_m5(sessionService: ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}


function msg_m5(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


// ── session.getMessageCount（通道 2 按需拉取）────────────────────


/** getMessageCount 用例驱动单源：mockContext_m5 装配 + handler 挂端口 + 单条消息调用，返回 ctx。 */
async function handleGetMessageCount(getMessageCount: ReturnType<typeof vi.fn>) {
  const ctx = mockContext_m5({ getMessageCount } as unknown as ISessionService)
  const handler = new SessionMessageHandler(ctx)
  await handler.handleSessionMessage(msg_m5('session.getMessageCount', { sessionId: SID_m4 }), mockWs_m5())
  return ctx
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-message-count', () => {
// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（消息计数）', () => {
  it('认领 session.getMessageCount', () => {
    const handler = new SessionMessageHandler(mockContext_m5({} as unknown as ISessionService))
    expect(handler.handles).toContain('session.getMessageCount')
  })
})
describe('SessionMessageHandler session.getMessageCount', () => {
  it('透传：调 sessionService.getMessageCount + reply 同名 { sessionId, count } 形状', async () => {
    const getMessageCount = vi.fn(async () => 42)
    const ctx = await handleGetMessageCount(getMessageCount)

    expect(getMessageCount).toHaveBeenCalledTimes(1)
    expect(getMessageCount).toHaveBeenCalledWith(SID_m4)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getMessageCount', {
      sessionId: SID_m4,
      count: 42,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('count 0（文件缺失 pi 延迟写入窗口 / 空会话）正常 reply 非错误', async () => {
    const getMessageCount = vi.fn(async () => 0)
    const ctx = await handleGetMessageCount(getMessageCount)

    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.getMessageCount', {
      sessionId: SID_m4,
      count: 0,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('端口缺省（SessionService 未组装转发）→ message_count_unsupported error envelope（sessionId 必带）', async () => {
    const ctx = mockContext_m5({} as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m5('session.getMessageCount', { sessionId: SID_m4 }), mockWs_m5())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'message_count_unsupported',
      expect.any(String),
      'msg-1',
      { sessionId: SID_m4 },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  it('读失败（service throw，非 ENOENT 类）→ message_count_failed error envelope，不 reply', async () => {
    const getMessageCount = vi.fn(async () => {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    })
    const ctx = mockContext_m5({ getMessageCount } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(
      msg_m5('session.getMessageCount', { sessionId: SID_m4 }, 'msg-err'),
      mockWs_m5(),
    )

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'message_count_failed',
      expect.stringContaining('EACCES'),
      'msg-err',
      { sessionId: SID_m4 },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
});

// ======================================================================
// ← src/transport/__tests__/session-message-handler-plan.test.ts
// ======================================================================

const SID_m5 = 'sess-plan-1'


function mockWs_m6(): WsType {
  return { send: vi.fn(), readyState: 1 } as unknown as WsType
}


function mockContext_m6(sessionService: ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}


function msg_m6(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}


const ACTIVE_VIEW: PlanStateView = {
  isActive: true,
  planFilePath: '/tmp/.taiji-harness/some-slug/plan.md',
  requirement: '重构 auth 模块',
  templateName: null,
  skills: ['tech-design', 'dev-flow'],
  state: 'reviewing',
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-plan', () => {
// ── handles 清单 ────────────────────────────────────────────────

describe('SessionMessageHandler.handles（plan 域）', () => {
  it('认领 session.getPlanState / session.abortPlan', () => {
    const handler = new SessionMessageHandler(mockContext_m6({} as unknown as ISessionService))
    expect(handler.handles).toContain('session.getPlanState')
    expect(handler.handles).toContain('session.abortPlan')
  })
})
// ── session.getPlanState（D1⑥ 冷启动首次拉取）───────────────────────

describe('SessionMessageHandler session.getPlanState', () => {
  it('冷路径透传：调 sessionService.getPlanState（SessionRecords 冷路径消费口）+ reply session.planState 形状', async () => {
    const getPlanState = vi.fn(async () => ACTIVE_VIEW)
    const ctx = mockContext_m6({ getPlanState } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m6('session.getPlanState', { sessionId: SID_m5 }), mockWs_m6())

    expect(getPlanState).toHaveBeenCalledTimes(1)
    expect(getPlanState).toHaveBeenCalledWith(SID_m5)
    expect(ctx.reply).toHaveBeenCalledTimes(1)
    // reply 复用 session.planState 广播 payload（shared 协议同 getSubagents → session.subagents 复用形态）
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'session.planState', {
      sessionId: SID_m5,
      planState: ACTIVE_VIEW,
    })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('端口缺省（SessionService 未组装转发）→ plan_state_unsupported error envelope（sessionId 必带）', async () => {
    const ctx = mockContext_m6({} as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m6('session.getPlanState', { sessionId: SID_m5 }), mockWs_m6())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'plan_state_unsupported',
      expect.any(String),
      'msg-1',
      { sessionId: SID_m5 },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
// ── session.abortPlan（D5/E9 横幅退出命令）──────────────────────

describe('SessionMessageHandler session.abortPlan', () => {
  // MF-1-7 编排下沉后 handler 契约 = 纯透传：调 sessionService.abortPlan，resolve →
  // reply message.status ack；throw → abort_plan_failed error envelope。ensureActive→prompt
  // 顺序 / '/plan abort' 字面量 / 失效回调上抛等编排语义的断言迁 service 层
  // （src/services/session/__tests__/session-service-abort-plan.test.ts）。

  it('① abortPlan resolve → message.status ack + 失效链不经 handler（单一出口在 server.ts）', async () => {
    const abortPlan = vi.fn(async () => {})
    const ctx = mockContext_m6({ abortPlan } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m6('session.abortPlan', { sessionId: SID_m5 }), mockWs_m6())

    expect(abortPlan).toHaveBeenCalledTimes(1)
    expect(abortPlan).toHaveBeenCalledWith(SID_m5)
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID_m5,
      status: 'sent',
    })
    // 失效链消费已下沉（server.setServices 注册 setOnPlanAborted），handler ctx 不再触碰
    expect(ctx.invalidatePendingUiRequests).not.toHaveBeenCalled()
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('② abortPlan throw（恢复失败 / 直发失败，E9）→ abort_plan_failed error envelope，不 reply', async () => {
    const abortPlan = vi.fn(async () => {
      throw new Error('Session file corrupted')
    })
    const ctx = mockContext_m6({ abortPlan } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m6('session.abortPlan', { sessionId: SID_m5 }, 'msg-err'), mockWs_m6())

    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(
      expect.anything(),
      'abort_plan_failed',
      expect.stringContaining('Session file corrupted'),
      'msg-err',
      { sessionId: SID_m5 },
    )
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
// ── message.abort 失效链（D6，S15 锚定）────────────────────────

describe('SessionMessageHandler message.abort（D6 失效链：invalidate 前置 + try/finally）', () => {
  it('S15：invalidatePendingUiRequests 先于 sessionService.abort 调用', async () => {
    const callOrder: string[] = []
    const abort = vi.fn(async () => {
      callOrder.push('abort')
    })
    const ctx = mockContext_m6({ abort } as unknown as ISessionService)
    ctx.invalidatePendingUiRequests = vi.fn(() => {
      callOrder.push('invalidate')
    })
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m6('message.abort', { sessionId: SID_m5 }), mockWs_m6())

    expect(ctx.invalidatePendingUiRequests).toHaveBeenCalledWith(SID_m5, 'turn-aborted')
    expect(abort).toHaveBeenCalledWith(SID_m5)
    // 顺序断言：失效帧前置（旧序 abort→invalidate 时 callOrder[0]==='abort'，本断言即红）
    expect(callOrder[0]).toBe('invalidate')
    // ack 契约不变（D round5-must-fix-1）
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID_m5,
      status: 'aborted',
    })
  })

  it('S15：sessionService.abort 抛错时失效帧仍发布（必达 = 前置路径保证，finally 此时空转）', async () => {
    const abort = vi.fn(async () => {
      // F4① 实锤形态：pi 不在活跃表时 dispatcher getClientOrThrow 直接 throw（abort 的 try 之外）
      throw new Error('pi not in active table')
    })
    const ctx = mockContext_m6({ abort } as unknown as ISessionService)
    const handler = new SessionMessageHandler(ctx)

    // abort 极端失败行为不变（D6）：异常继续传播，不 reply ack
    await expect(
      handler.handleSessionMessage(msg_m6('message.abort', { sessionId: SID_m5 }), mockWs_m6()),
    ).rejects.toThrow('pi not in active table')

    // 失效帧仍必达（renderer 据此摘除挂起请求，不留僵尸 ready）——归因 = 前置路径
    // （同步先于 await abort 执行，抛错时帧已发布；finally 在本形态对帧无增量）。
    // 本用例锁前置序；finally 路径的独有行为由下方两条判别用例锁定（删 finally 本用例照绿）。
    expect(ctx.invalidatePendingUiRequests).toHaveBeenCalledWith(SID_m5, 'turn-aborted')
    expect(abort).toHaveBeenCalledWith(SID_m5)
    expect(ctx.reply).not.toHaveBeenCalled()
  })

  // ── finally 路径判别断言（无 finally 时以下用例即红，锁 finally 存在性）────────

  it('finally 路径判别：前置 invalidate 自身抛错时 finally 仍发布失效帧', async () => {
    let invalidateCalls = 0
    const invalidatePendingUiRequests = vi.fn(() => {
      invalidateCalls += 1
      if (invalidateCalls === 1) throw new Error('bus publish failed') // 前置路径自身失败
    })
    const abort = vi.fn(async () => {})
    const ctx = mockContext_m6({ abort } as unknown as ISessionService)
    ctx.invalidatePendingUiRequests = invalidatePendingUiRequests
    const handler = new SessionMessageHandler(ctx)

    // 前置路径异常传播（行为不变），abort 未被触达
    await expect(
      handler.handleSessionMessage(msg_m6('message.abort', { sessionId: SID_m5 }), mockWs_m6()),
    ).rejects.toThrow('bus publish failed')

    // finally 路径重试并发布失效帧——唯一来源 = finally（无 finally 时只有 1 次失败调用）
    expect(invalidatePendingUiRequests).toHaveBeenCalledTimes(2)
    expect(invalidatePendingUiRequests).toHaveBeenNthCalledWith(2, SID_m5, 'turn-aborted')
    expect(abort).not.toHaveBeenCalled()
  })

  it('finally 路径判别：abort 在途窗口内新到挂起被追加摘除（invalidate 在 abort 完成后再执行一次）', async () => {
    // 迷你 pending 注册表（仿 server.invalidatePendingUiRequests 摘除语义：摘空后再调
    // 空清单不发布，零成本）
    const pending = new Set<string>()
    const removedSnapshots: string[][] = []
    const invalidatePendingUiRequests = vi.fn(() => {
      removedSnapshots.push([...pending])
      pending.clear()
    })
    const abort = vi.fn(async () => {
      // abort 在途窗口（如 cascade 解散期间）新登记的挂起——前置路径已执行，管不到它
      pending.add('req-window-1')
    })
    const ctx = mockContext_m6({ abort } as unknown as ISessionService)
    ctx.invalidatePendingUiRequests = invalidatePendingUiRequests
    const handler = new SessionMessageHandler(ctx)

    await handler.handleSessionMessage(msg_m6('message.abort', { sessionId: SID_m5 }), mockWs_m6())

    // 第二次（finally）调用摘掉了窗口内新到挂起（无 finally 时 removedSnapshots=[[]]，
    // req-window-1 残留成挂起注册表孤儿）
    expect(removedSnapshots).toEqual([[], ['req-window-1']])
    expect(ctx.reply).toHaveBeenCalledWith(expect.anything(), 'msg-1', 'message.status', {
      sessionId: SID_m5,
      status: 'aborted',
    })
  })
})
});

// ======================================================================
// ← src/transport/__tests__/session-message-handler-workflow-viz.test.ts
// ======================================================================

const SID_m6 = 's1'

const RUN_ID = 'run-1'


function mockWs_m7() {
  return { send: vi.fn(), readyState: 1 } as unknown as import('ws').WebSocket
}


function mockContext_m7(sessionService: ISessionService): SessionHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    sessionService,
    nextPushId: vi.fn(() => 'push-1'),
    broadcastSessionList: vi.fn(),
    broadcast: vi.fn(),
    invalidatePendingUiRequests: vi.fn(),
  }
}


/** sessionService 桩：仅注入本域可选交叉成员（缺省形态 = 端口未组装防御分支）。 */
function fakeSessionService_m3(overrides: Partial<ISessionService & Record<string, unknown>> = {}): ISessionService {
  return overrides as unknown as ISessionService
}


function msg_m7(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('session-message-handler-workflow-viz', () => {
afterEach(() => {
  vi.restoreAllMocks()
})
describe('SessionMessageHandler.handles（workflow-viz 域）', () => {
  it('认领 session.getWorkflowRunEvents / session.getWorkflowDag 两消息', () => {
    const handler = new SessionMessageHandler(mockContext_m7(fakeSessionService_m3()))
    expect(handler.handles).toContain('session.getWorkflowRunEvents')
    expect(handler.handles).toContain('session.getWorkflowDag')
  })
})
describe('SessionMessageHandler workflow-viz 端口缺省', () => {
  it('转发未组装 → *_unsupported error envelope（sessionId 必带，防御分支）', async () => {
    const ctx = mockContext_m7(fakeSessionService_m3())
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m7()

    await handler.handleSessionMessage(msg_m7('session.getWorkflowRunEvents', { sessionId: SID_m6, runId: RUN_ID }), ws)
    await handler.handleSessionMessage(msg_m7('session.getWorkflowDag', { sessionId: SID_m6, runId: RUN_ID }), ws)

    expect(ctx.sendError).toHaveBeenCalledTimes(2)
    const codes = vi.mocked(ctx.sendError).mock.calls.map((call) => call[1])
    expect(codes).toEqual(['workflow_run_events_unsupported', 'workflow_dag_unsupported'])
    for (const call of vi.mocked(ctx.sendError).mock.calls) {
      expect(call[4]).toEqual({ sessionId: SID_m6 })
    }
    expect(ctx.reply).not.toHaveBeenCalled()
  })
})
describe('SessionMessageHandler session.getWorkflowRunEvents', () => {
  it('成功与结构化错误臂都经 reply 正常返回（领域回执不走 error envelope）', async () => {
    const eventsReply: WorkflowRunEventsReply = { sessionId: SID_m6, runId: RUN_ID, events: [] }
    const notFoundReply: WorkflowRunEventsReply = { sessionId: SID_m6, runId: RUN_ID, code: 'record_not_found', message: 'gone' }
    const svc = fakeSessionService_m3({
      getWorkflowRunEvents: vi.fn().mockResolvedValueOnce(eventsReply).mockResolvedValueOnce(notFoundReply),
    })
    const ctx = mockContext_m7(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m7()

    await handler.handleSessionMessage(msg_m7('session.getWorkflowRunEvents', { sessionId: SID_m6, runId: RUN_ID }, 'm1'), ws)
    await handler.handleSessionMessage(msg_m7('session.getWorkflowRunEvents', { sessionId: SID_m6, runId: RUN_ID }, 'm2'), ws)

    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenNthCalledWith(1, ws, 'm1', 'session.workflowRunEvents', eventsReply)
    expect(ctx.reply).toHaveBeenNthCalledWith(2, ws, 'm2', 'session.workflowRunEvents', notFoundReply)
  })

  it('通道错误：service throw → workflow_run_events_failed error envelope（sessionId 必带）', async () => {
    const svc = fakeSessionService_m3({
      getWorkflowRunEvents: vi.fn(async () => { throw new Error('disk unavailable') }),
    })
    const ctx = mockContext_m7(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m7()

    await handler.handleSessionMessage(msg_m7('session.getWorkflowRunEvents', { sessionId: SID_m6, runId: RUN_ID }), ws)

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'workflow_run_events_failed', expect.stringContaining('disk unavailable'), 'msg-1', { sessionId: SID_m6 })
  })
})
describe('SessionMessageHandler session.getWorkflowDag', () => {
  it('成功与结构化错误臂（四码闭集形态）都经 reply 正常返回', async () => {
    const dagReply: WorkflowDagReply = { sessionId: SID_m6, runId: RUN_ID, dag: { nodes: [], edges: [], phases: [], parallelGroups: [], loops: [] } }
    const parseFailedReply: WorkflowDagReply = { sessionId: SID_m6, runId: RUN_ID, code: 'parse_failed', message: 'unsupported syntax' }
    const svc = fakeSessionService_m3({
      getWorkflowDag: vi.fn().mockResolvedValueOnce(dagReply).mockResolvedValueOnce(parseFailedReply),
    })
    const ctx = mockContext_m7(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m7()

    await handler.handleSessionMessage(msg_m7('session.getWorkflowDag', { sessionId: SID_m6, runId: RUN_ID }, 'm1'), ws)
    await handler.handleSessionMessage(msg_m7('session.getWorkflowDag', { sessionId: SID_m6, runId: RUN_ID }, 'm2'), ws)

    expect(ctx.sendError).not.toHaveBeenCalled()
    expect(ctx.reply).toHaveBeenNthCalledWith(1, ws, 'm1', 'session.workflowDag', dagReply)
    expect(ctx.reply).toHaveBeenNthCalledWith(2, ws, 'm2', 'session.workflowDag', parseFailedReply)
  })

  it('通道错误：service throw → workflow_dag_failed error envelope（sessionId 必带）', async () => {
    const svc = fakeSessionService_m3({
      getWorkflowDag: vi.fn(async () => { throw new Error('unexpected fs failure') }),
    })
    const ctx = mockContext_m7(svc)
    const handler = new SessionMessageHandler(ctx)
    const ws = mockWs_m7()

    await handler.handleSessionMessage(msg_m7('session.getWorkflowDag', { sessionId: SID_m6, runId: RUN_ID }), ws)

    expect(ctx.reply).not.toHaveBeenCalled()
    expect(ctx.sendError).toHaveBeenCalledTimes(1)
    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'workflow_dag_failed', expect.stringContaining('unexpected fs failure'), 'msg-1', { sessionId: SID_m6 })
  })
})
});

// ======================================================================
// ← src/transport/__tests__/subagent-message-handler.test.ts
// ======================================================================

// ── mock helpers ─────────────────────────────────────────────

function mockWs_m8(): WsType {
  return {} as WsType
}


function setModelMsg(payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type: 'subagent.setModel', payload, id } as unknown as ClientMessage
}


/** mock 宿主网关：setModel 应答/拒绝与 sessionId 解析由测试注入。 */
function mockGateway(overrides?: Partial<SubagentModelSwitchGateway>): SubagentModelSwitchGateway {
  return {
    setModel: vi.fn(async () => ({ kind: 'recorded', note: '已记录，下次执行生效' }) satisfies SubagentSetModelReply),
    resolveSessionId: vi.fn(() => 'main-session-1'),
    ...overrides,
  }
}


function mockCtx(gateway: SubagentModelSwitchGateway | undefined): {
  ctx: SubagentHandlerContext
  reply: ReturnType<typeof vi.fn>
  sendError: ReturnType<typeof vi.fn>
} {
  const reply = vi.fn()
  const sendError = vi.fn()
  const ctx: SubagentHandlerContext = {
    send: vi.fn(),
    sendError,
    reply,
    ...(gateway !== undefined ? { modelSwitchGateway: gateway } : {}),
  }
  return { ctx, reply, sendError }
}


/** 断言助手：整个用例零 sendError 调用（显式失败信息优于隐式 toHaveBeenCalledTimes）。 */
function sendErrorNever(ctx: SubagentHandlerContext): Error | undefined {
  const calls = (ctx.sendError as ReturnType<typeof vi.fn>).mock.calls
  return calls.length > 0 ? new Error(`unexpected sendError: ${JSON.stringify(calls[0])}`) : undefined
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('subagent-message-handler', () => {
// ── 回执范式（应答到达才写状态，应答值原样透传）──────────────────

describe('SubagentMessageHandler — subagent.setModel 回执范式', () => {
  it('chat 域已生效型：reply 透传 mock 宿主应答的生效值（生效模型 + 生效档位）', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => ({
        kind: 'effective',
        effectiveModel: { provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' },
        effectiveThinkingLevel: 'high',
      }) satisfies SubagentSetModelReply),
    })
    const { ctx, reply } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'zai-coding-cn', modelId: 'glm-5.3-flash' }),
      mockWs_m8(),
    )

    expect(gateway.setModel).toHaveBeenCalledWith({
      recordId: 'sa-1',
      provider: 'zai-coding-cn',
      modelId: 'glm-5.3-flash',
    })
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      'req-1',
      'subagent.modelSet',
      expect.objectContaining({ kind: 'effective', effectiveThinkingLevel: 'high' }),
    )
    // 回执值 = 宿主应答值（handler 不改写——回执写状态范式的前端前提）
    const payload = reply.mock.calls[0]?.[3] as { effectiveModel: { modelId: string } }
    expect(payload.effectiveModel.modelId).toBe('glm-5.3-flash')
    expect(sendErrorNever(ctx)).toBeUndefined()
  })

  it('chat 域已记账型：不携带档位值的应答原样回执', async () => {
    const { ctx, reply } = mockCtx(mockGateway())
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )

    const payload = reply.mock.calls[0]?.[3] as { kind: string; note?: string; effectiveThinkingLevel?: string }
    expect(payload.kind).toBe('recorded')
    expect(payload.effectiveThinkingLevel).toBeUndefined()
  })

  it('run 级聚合应答：三组件（members/failures/summary）原样回执', async () => {
    const aggregate: SubagentSetModelAggregateReply = {
      members: [
        { runId: 'sa-a', state: 'switched', effectiveModel: { provider: 'p', modelId: 'm' }, effectiveThinkingLevel: 'high' },
        { runId: 'sa-b', state: 'not-active' },
      ],
      failures: [],
      summary: '已切换，未派发步骤生效',
    }
    const gateway = mockGateway({ setModel: vi.fn(async () => aggregate satisfies SubagentSetModelReply) })
    const { ctx, reply } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ runId: 'wf-1', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )

    expect(gateway.setModel).toHaveBeenCalledWith({ runId: 'wf-1', provider: 'p', modelId: 'm' })
    const payload = reply.mock.calls[0]?.[3] as SubagentSetModelAggregateReply
    expect(payload.members).toHaveLength(2)
    expect(payload.failures).toEqual([])
    expect(payload.summary).toContain('未派发步骤生效')
  })

  it('gateway 应答前不回执（无乐观回执——应答到达才写状态的 runtime 半边）', async () => {
    let resolveSetModel: (reply: SubagentSetModelReply) => void = () => {}
    const gateway = mockGateway({
      setModel: vi.fn(
        () =>
          new Promise<SubagentSetModelReply>((resolve) => {
            resolveSetModel = resolve
          }),
      ),
    })
    const { ctx, reply } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    const pending = handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )
    // 宿主应答未到达：零回执零错误（前端状态保持旧真值的前提）
    expect(reply).not.toHaveBeenCalled()
    resolveSetModel({ kind: 'effective', effectiveModel: { provider: 'p', modelId: 'm' }, effectiveThinkingLevel: 'low' })
    await pending
    expect(reply).toHaveBeenCalledTimes(1)
  })
})
// ── 错误分型 + 会话隔离红线 ───────────────────────────────────

describe('SubagentMessageHandler — 错误分型与 sessionId 信封', () => {
  it('gateway 分型错误：code 透传 + sendError 带 resolveSessionId 解析的 sessionId', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => {
        const err = new Error('模型 X 缺少 API key，切换未生效，当前执行未受影响') as Error & { code?: string }
        err.code = 'engine_credential_missing'
        throw err
      }),
    })
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )

    expect(sendError).toHaveBeenCalledTimes(1)
    const [ws, code, message, id, details] = sendError.mock.calls[0] as unknown as [
      WsType,
      string,
      string,
      string,
      { sessionId?: string },
    ]
    expect(code).toBe('engine_credential_missing')
    expect(message).toContain('API key')
    expect(id).toBe('req-1')
    // 会话隔离红线：payload 无 sessionId 的域消息，错误信封必须补齐 sessionId
    expect(details.sessionId).toBe('main-session-1')
    expect(ws).toBeDefined()
  })

  it('run 级目标的错误信封按 runId 解析 sessionId', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => {
        throw new Error('run 已终局，无后续步骤可应用')
      }),
      resolveSessionId: vi.fn(({ runId }) => (runId !== undefined ? `session-for-${String(runId)}` : undefined)),
    })
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(setModelMsg({ runId: 'wf-1', provider: 'p', modelId: 'm' }), mockWs_m8())

    expect(gateway.resolveSessionId).toHaveBeenCalledWith({ runId: 'wf-1' })
    const details = sendError.mock.calls[0]?.[4] as { sessionId?: string }
    expect(details.sessionId).toBe('session-for-wf-1')
  })

  it('resolveSessionId 解析不到（undefined）：信封缺省 details 而非带空 sessionId', async () => {
    const gateway = mockGateway({
      setModel: vi.fn(async () => {
        throw new Error('目标不存在')
      }),
      resolveSessionId: vi.fn(() => undefined),
    })
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-unknown', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )

    const details = sendError.mock.calls[0]?.[4]
    expect(details).toBeUndefined()
  })
})
// ── 检查与未接线形态 ─────────────────────────────────────────

describe('SubagentMessageHandler — 目标检查与未接线', () => {
  it('recordId 与 runId 双缺：invalid_payload，不触达 gateway', async () => {
    const gateway = mockGateway()
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(setModelMsg({ provider: 'p', modelId: 'm' }), mockWs_m8())

    expect(gateway.setModel).not.toHaveBeenCalled()
    expect(sendError.mock.calls[0]?.[1]).toBe('invalid_payload')
  })

  it('recordId 与 runId 双给：invalid_payload，不触达 gateway', async () => {
    const gateway = mockGateway()
    const { ctx, sendError } = mockCtx(gateway)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', runId: 'wf-1', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )

    expect(gateway.setModel).not.toHaveBeenCalled()
    expect(sendError.mock.calls[0]?.[1]).toBe('invalid_payload')
  })

  it('gateway 未注入（组合根未接线）：subagent_model_switch_unwired 可操作错误', async () => {
    const { ctx, sendError } = mockCtx(undefined)
    const handler = new SubagentMessageHandler(ctx)

    await handler.handleSubagentMessage(
      setModelMsg({ recordId: 'sa-1', provider: 'p', modelId: 'm' }),
      mockWs_m8(),
    )

    const [ws, code, message] = sendError.mock.calls[0] as unknown as [WsType, string, string]
    expect(code).toBe('subagent_model_switch_unwired')
    expect(message).toContain('U2/U5')
    expect(ws).toBeDefined()
  })

  it('handles 清单只认领 subagent.setModel（中央分发表 disjoint 约束）', () => {
    const { ctx } = mockCtx(undefined)
    const handler = new SubagentMessageHandler(ctx)
    expect(handler.handles).toEqual(['subagent.setModel'])
  })
})
});
