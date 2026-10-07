/**
 * session.getSubagentStreamState RPC handler 测试（B2 subagent-stream-chunk §4.1，
 * u-runtime-rpc）：
 *
 * - 注册面：SessionMessageHandler routes 认领 session.getSubagentStreamState
 * - found true 分支：进行中 record → reply 原样透传 tee 三元组（found/msgSeq/lastDeltaSeq/lines）
 * - record 路由：record-a / record-b 交替请求各自返回，非本 record 请求不串；
 *   跨 sessionId 请求（recordId 在管但归属不一致）→ found:false
 * - found false 分支：未知 record（无在管 tee）→ 缺省形态 0/0/[]；
 *   已定稿 record（source 报 found:false）→ 原样透传；
 *   数据源未注入（存量测试构造形态）→ found:false 且不抛
 *
 * 装置：真实 SessionService（桩集仿 session-service-background-task.test.ts createSetup
 * 最小集，构造期零 fs 触点）+ 真实 SessionMessageHandler 直调 handleSessionMessage
 * （mockContext 范式仿 transport/__tests__/session-message-handler-workflow-viz.test.ts）。
 * 数据源以假 source 替身注入（复刻组合根 index.ts 的闭包形态——relay registry 句柄归
 * 组合根，registry 半的 tee 存在性路由在 relay-registry 单测面，此处覆盖 service/handler
 * 链的路由与分支语义）。
 *
 * 运行：cd packages/runtime && npx vitest run src/services/session/__tests__/session-service-subagent-stream-state.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// pi-paths 动态指向 tmp（构造期 BackgroundTaskService 域读取，同 bg-task 测试的 mock 理由）。
const paths = vi.hoisted(() => ({ agentDir: '' }))
vi.mock('../../../infra/pi/pi-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../infra/pi/pi-paths.js')>()
  return {
    ...actual,
    getPiAgentDir: () => paths.agentDir,
  }
})

import { SessionService, type SubagentStreamStateSource } from '../session-service.js'
import { PiConfigStore } from '../../../infra/pi/pi-config-store.js'
import { PiSessionStore } from '../../../infra/pi/session-store.js'
import { SessionMessageHandler, type SessionHandlerContext } from '../../../transport/session-message-handler.js'
import type { IProcessManager } from '../../../services/ports/pi-engine.js'
import type { IExtensionService, ISessionService } from '../../../interfaces.js'
import type { WorkspaceService } from '../../workspace/workspace-service.js'
import type { ClientMessage } from '@taiji/shared'

// ── fixtures ──────────────────────────────────────────────────────

const SID = 'sess-main'
const OTHER_SID = 'sess-other'

/** record-a：进行中、多行累积全文（found true 分支的代表性三元组）。 */
const STATE_A = { found: true, msgSeq: 1, lastDeltaSeq: 4, lines: ['# Title', 'body line', ''] }
/** record-b：另一 record 的进行中流（跨消息边界形态——msgSeq=2、零 delta）。 */
const STATE_B = { found: true, msgSeq: 2, lastDeltaSeq: -1, lines: [''] }
/** record-sealed：已定稿（tee 侧归一的 found false 形态，其余字段恒 0/0/[]）。 */
const STATE_SEALED = { found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] }

/** 假数据源：recordId 路由 + sessionId 归属校验（复刻 registry 查询半的语义）。 */
const fakeSource: SubagentStreamStateSource = (sessionId, recordId) => {
  if (sessionId !== SID) return undefined
  if (recordId === 'rec-a') return STATE_A
  if (recordId === 'rec-b') return STATE_B
  if (recordId === 'rec-sealed') return STATE_SEALED
  return undefined
}

let agentDir: string

// ── SessionService 最小装置（桩集仿 session-service-background-task.test.ts）──

function createService(): SessionService {
  return new SessionService(
    // pm：构造期只注册 onSessionExit 回调（其余 IProcessManager 成员本域不触达，桩收窄）
    { onSessionExit: vi.fn(), getClient: vi.fn(), hasClient: vi.fn(() => false), destroyAll: vi.fn() } as unknown as IProcessManager,
    // broker
    { send: vi.fn(), broadcast: vi.fn(), sendError: vi.fn() },
    // adapterFactory：桩（本域不附着 session）
    () => ({ attach: vi.fn(), detach: vi.fn() }),
    tmpdir(),
    { getExtensionPaths: vi.fn().mockResolvedValue([]) } as unknown as IExtensionService,
    // configStore / sessionStore：真实实例（构造期零 IO，同既有 session-service 测试范式）
    new PiConfigStore(),
    new PiSessionStore(),
    { readGitInfo: vi.fn(() => undefined), pruneStaleCache: vi.fn() },
    { record: vi.fn(), list: vi.fn(() => []) } as unknown as WorkspaceService,
    undefined,
  )
}

// ── SessionMessageHandler 装置（mockContext 范式仿 workflow-viz 测试）──

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as unknown as import('ws').WebSocket
}

function mockContext(sessionService: ISessionService): SessionHandlerContext {
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

function streamStateMsg(sessionId: string, recordId: string, id = 'msg-1'): ClientMessage {
  return { type: 'session.getSubagentStreamState', payload: { sessionId, recordId }, id } as unknown as ClientMessage
}

/** 经真实 handler 分发并取回 reply 的第四参（payload）。 */
async function replyPayloadOf(ctx: SessionHandlerContext, handler: SessionMessageHandler, sessionId: string, recordId: string, id?: string): Promise<unknown> {
  const ws = mockWs()
  await handler.handleSessionMessage(streamStateMsg(sessionId, recordId, id), ws)
  expect(ctx.sendError).not.toHaveBeenCalled()
  const calls = vi.mocked(ctx.reply).mock.calls
  const last = calls[calls.length - 1]
  expect(last[0]).toBe(ws)
  expect(last[1]).toBe(id ?? 'msg-1')
  expect(last[2]).toBe('session.getSubagentStreamState')
  return last[3]
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'stream-state-rpc-'))
  paths.agentDir = agentDir
  // 构造期 backgroundTasks 域启动 mtime 轮询 interval——fake timers 拦截（同 bg-task 测试）
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

// ── 注册面 ────────────────────────────────────────────────────────

describe('SessionMessageHandler.handles（subagent-stream-state 域）', () => {
  it('认领 session.getSubagentStreamState', () => {
    const handler = new SessionMessageHandler(mockContext(createService()))
    expect(handler.handles).toContain('session.getSubagentStreamState')
  })
})

// ── found true 分支 + record 路由 ─────────────────────────────────

describe('session.getSubagentStreamState：found true 与 record 路由', () => {
  it('进行中 record → tee 三元组原样透传（found true 分支）', async () => {
    const service = createService()
    service.setSubagentStreamStateSource(fakeSource)
    const ctx = mockContext(service)
    const handler = new SessionMessageHandler(ctx)

    const payload = await replyPayloadOf(ctx, handler, SID, 'rec-a')
    expect(payload).toEqual(STATE_A)
  })

  it('record-a / record-b 交替请求各自返回（非本 record 请求不串）', async () => {
    const service = createService()
    service.setSubagentStreamStateSource(fakeSource)
    const ctx = mockContext(service)
    const handler = new SessionMessageHandler(ctx)

    const first = await replyPayloadOf(ctx, handler, SID, 'rec-a', 'm1')
    expect(first).toEqual(STATE_A)
    const second = await replyPayloadOf(ctx, handler, SID, 'rec-b', 'm2')
    expect(second).toEqual(STATE_B)
    const third = await replyPayloadOf(ctx, handler, SID, 'rec-a', 'm3')
    expect(third).toEqual(STATE_A)
    expect(third).not.toEqual(STATE_B)
  })

  it('跨 sessionId 请求（recordId 在管但归属不一致）→ found:false（不串到别的 session）', async () => {
    const service = createService()
    service.setSubagentStreamStateSource(fakeSource)
    const ctx = mockContext(service)
    const handler = new SessionMessageHandler(ctx)

    const payload = await replyPayloadOf(ctx, handler, OTHER_SID, 'rec-a')
    expect(payload).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
  })
})

// ── found false 分支 ──────────────────────────────────────────────

describe('session.getSubagentStreamState：found false', () => {
  it('未知 record（无在管 tee，source undefined）→ 缺省形态 0/0/[]', async () => {
    const service = createService()
    service.setSubagentStreamStateSource(fakeSource)
    const ctx = mockContext(service)
    const handler = new SessionMessageHandler(ctx)

    const payload = await replyPayloadOf(ctx, handler, SID, 'rec-unknown')
    expect(payload).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
  })

  it('已定稿 record（source 报 found:false）→ 原样透传不加工', async () => {
    const service = createService()
    service.setSubagentStreamStateSource(fakeSource)
    const ctx = mockContext(service)
    const handler = new SessionMessageHandler(ctx)

    const payload = await replyPayloadOf(ctx, handler, SID, 'rec-sealed')
    expect(payload).toEqual(STATE_SEALED)
  })

  it('数据源未注入（存量测试构造形态）→ found:false 且不抛', async () => {
    const service = createService()
    const ctx = mockContext(service)
    const handler = new SessionMessageHandler(ctx)

    const payload = await replyPayloadOf(ctx, handler, SID, 'rec-a')
    expect(payload).toEqual({ found: false, msgSeq: 0, lastDeltaSeq: 0, lines: [] })
  })
})
