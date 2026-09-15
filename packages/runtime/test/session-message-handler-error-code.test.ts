/**
 * W1 / L4: session.create/fork model 未配置时返回差异化 error code（MODEL_NOT_CONFIGURED）。
 *
 * 背景：原实现 session.create/fork 失败走 server.ts 统一 catch → 'handler_error'，
 * 前端无法区分「model 未配置」和「其他错误」，无法引导用户去 Settings 配置。
 * 修复：lifecycle 层用 errorWithCode 抛带 .code 的 Error；handler 层 try/catch
 * 捕获 MODEL_NOT_CONFIGURED 并 sendError(MODEL_NOT_CONFIGURED)，让前端据此引导。
 *
 * 运行：cd packages/runtime && npx vitest run test/session-message-handler-error-code.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../src/transport/session-message-handler.js'
import { errorWithCode, MODEL_NOT_CONFIGURED } from '../src/utils/errors.js'
import type { ClientMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(createImpl: ReturnType<typeof vi.fn>, forkImpl?: ReturnType<typeof vi.fn>, deleteImpl?: ReturnType<typeof vi.fn>) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    create: createImpl,
    forkSession: forkImpl ?? vi.fn().mockResolvedValue({ id: 'forked' }),
    delete: deleteImpl ?? vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    steerMessage: vi.fn().mockResolvedValue(undefined),
    followUpMessage: vi.fn().mockResolvedValue(undefined),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    compact: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    getHistory: vi.fn().mockResolvedValue([]),
    getSummary: vi.fn().mockReturnValue(undefined),
    restoreSession: vi.fn().mockResolvedValue({ id: 's1' }),
  }
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string, details?: Record<string, unknown>) => {
      cap.errors.push({ id, code, message, details })
    }),
    sessionService,
    nextPushId: vi.fn().mockReturnValue('p1'),
    broadcastSessionList: vi.fn(),
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { ctx, cap, handler }
}

function msg(type: string, payload: Record<string, unknown>, id = 'm1'): ClientMessage {
  return { type, id, payload } as unknown as ClientMessage
}

const WS = {} as never

describe('W1/L4: session.create/fork model 未配置返回 MODEL_NOT_CONFIGURED', () => {
  it('create: model 未配置 → sendError(MODEL_NOT_CONFIGURED)，不 reply success', async () => {
    const createError = errorWithCode(
      'No model configured. Please configure a provider and model in Settings before starting a session.',
      MODEL_NOT_CONFIGURED,
    )
    const { cap, handler } = makeHandler(vi.fn().mockRejectedValue(createError))
    await handler.handleSessionMessage(
      msg('session.create', { cwd: '/repo', label: 'repo' }),
      WS,
    )
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: MODEL_NOT_CONFIGURED,
      message: expect.stringContaining('No model configured'),
    })
    // 关键：不 reply success（否则前端误判 session 已创建）
    expect(cap.replies).toHaveLength(0)
  })

  it('fork: model 未配置 → sendError(MODEL_NOT_CONFIGURED)，不 reply success', async () => {
    const forkError = errorWithCode(
      'No model configured. Please configure a provider and model in Settings before forking a session.',
      MODEL_NOT_CONFIGURED,
    )
    const { cap, handler } = makeHandler(
      vi.fn().mockResolvedValue({ id: 's1' }),
      vi.fn().mockRejectedValue(forkError),
    )
    await handler.handleSessionMessage(
      msg('session.fork', { srcSessionId: 'src1', fromPiEntryId: 'entry1', includeFrom: true }),
      WS,
    )
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({ id: 'm1', code: MODEL_NOT_CONFIGURED })
    expect(cap.replies).toHaveLength(0)
  })

  it('create: 非 MODEL_NOT_CONFIGURED 错误 → rethrow（走 server.ts 统一 handler_error）', async () => {
    const otherError = new Error('pi spawn failed')
    const { cap, handler } = makeHandler(vi.fn().mockRejectedValue(otherError))
    // 非 MODEL_NOT_CONFIGURED 错误应向上抛出（不被 handler 吞掉）
    await expect(
      handler.handleSessionMessage(
        msg('session.create', { cwd: '/repo', label: 'repo' }),
        WS,
      ),
    ).rejects.toThrow('pi spawn failed')
    // handler 自身不 sendError（由 server.ts 统一 catch 处理）
    expect(cap.errors).toHaveLength(0)
  })
})

// u-h4/P4-1 回归锁（timeout-audit-hygiene-batch §3.4）：trash 失败时 delete case 不吞错误、
// 不 reply 成功——错误向上抛给 server.ts handleMessage 外层统一 catch → sendError
//（e.code ?? 'handler_error'），handler 内不加 try/catch（设计 P4-1 判定：外层收口已存在）。
describe('u-h4: session.delete trash 失败错误通道', () => {
  it('delete: sessionService.delete throw（移废纸篓失败）→ rethrow 不吞、不 reply session.deleted', async () => {
    const trashError = new Error(
      '移入废纸篓失败（Finder 未在 5s 内响应或命令失败）。文件已保留在原位置，未做任何删除：/s/abc.jsonl。👉 稍后重试删除；或手动在访达中将该文件拖入废纸篓。',
    )
    const { cap, handler } = makeHandler(
      vi.fn().mockResolvedValue({ id: 's1' }),
      undefined,
      vi.fn().mockRejectedValue(trashError),
    )
    await expect(
      handler.handleSessionMessage(msg('session.delete', { sessionId: 'del-1' }), WS),
    ).rejects.toThrow('移入废纸篓失败')
    // 关键：失败时绝不 reply session.deleted（否则前端误判删除成功）
    expect(cap.replies).toHaveLength(0)
    // handler 自身不 sendError——sendError 由 server.ts 外层统一收口负责
    expect(cap.errors).toHaveLength(0)
  })
})
