/**
 * session.switch reply 瘦身测试（wave:perf-w20，R-11）。
 *
 * 锁定两条语义：
 * - switch reply 类型是 session.switched（payload { sessionId, session }），**无 messages 字段**——
 *   switch 不再无条件全量 getHistory 塞 reply（长 session 数 MB 的纯浪费序列化）
 * - handler 不调 getHistory（历史消费路径是 renderer selectSession 内显式 session.history RPC）
 *
 * renderer 兼容性佐证：renderer switchSession 返回 void 不读 reply payload（core
 * use-session.ts selectSession 在 switchSession 后显式 chat.getHistory 拉历史），
 * renderer 侧现有用例全绿（rpc-type-pairing.test.ts 已同步更新映射断言）。
 *
 * mock 模式参考 session-message-handler-subscribe.test.ts（makeHandler + Captured）。
 * 运行：cd packages/runtime && npx vitest run src/__tests__/session-message-handler-switch-reply.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import type { ClientMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string }[]
}

function makeHandler(getSummaryResult: Record<string, unknown> | undefined) {
  const cap: Captured = { replies: [], errors: [] }
  const getHistory = vi.fn(async () => ({ messages: [], truncated: false }))
  const ctx = {
    send: vi.fn(),
    reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
      cap.replies.push({ id, type, payload })
    }),
    sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
      cap.errors.push({ id, code, message })
    }),
    sessionService: {
      getSummary: vi.fn(() => getSummaryResult),
      ensureActive: vi.fn().mockResolvedValue(undefined),
      getHistory,
    },
  }
  const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
  return { cap, handler, getHistory, ctx }
}

function switchMsg(sessionId: string, id = 'req-1'): ClientMessage {
  return { type: 'session.switch', id, payload: { sessionId } } as unknown as ClientMessage
}

const SUMMARY = { id: 's-1', label: 'test', cwd: '/tmp' }

describe('session.switch reply 瘦身（R-11）', () => {
  it('getSummary 命中：reply session.switched { sessionId, session }，无 messages 字段且不调 getHistory', async () => {
    const { cap, handler, getHistory } = makeHandler(SUMMARY)
    await handler.handleSessionMessage(switchMsg('s-1'), {} as never)

    expect(cap.errors).toHaveLength(0)
    expect(cap.replies).toHaveLength(1)
    const reply = cap.replies[0]
    expect(reply.type).toBe('session.switched')
    expect(reply.payload).toEqual({ sessionId: 's-1', session: SUMMARY })
    // messages 字段不存在（reply 类型 session.switched 无此字段——R-11 瘦身的类型级锁定）
    expect('messages' in reply.payload).toBe(false)
    expect('historyTruncated' in reply.payload).toBe(false)
    // switch 不再拉历史（renderer 显式 session.history RPC 才是历史消费路径）
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('getSummary 未命中：ensureActive 后 reply session.switched，同样无 messages 且不调 getHistory', async () => {
    const { cap, handler, getHistory, ctx } = makeHandler(undefined)
    // 首次 getSummary（handler 内）返回 undefined，restore 后再取返回 summary
    let call = 0
    ;(ctx.sessionService as { getSummary: ReturnType<typeof vi.fn> }).getSummary.mockImplementation(() => {
      call++
      return call === 1 ? undefined : SUMMARY
    })

    await handler.handleSessionMessage(switchMsg('s-restore'), {} as never)
    expect(cap.errors).toHaveLength(0)
    expect(cap.replies[0]?.type).toBe('session.switched')
    expect(cap.replies[0]?.payload).toEqual({ sessionId: 's-restore', session: SUMMARY })
    expect('messages' in (cap.replies[0]?.payload ?? {})).toBe(false)
    expect(getHistory).not.toHaveBeenCalled()
  })

  it('restore 失败：仍走 error envelope（not_found），reply 不含历史 payload', async () => {
    const cap: Captured = { replies: [], errors: [] }
    const ctx = {
      send: vi.fn(),
      reply: vi.fn((_ws: unknown, id: string | undefined, type: string, payload: Record<string, unknown>) => {
        cap.replies.push({ id, type, payload })
      }),
      sendError: vi.fn((_ws: unknown, code: string, message: string, id?: string) => {
        cap.errors.push({ id, code, message })
      }),
      sessionService: {
        getSummary: vi.fn(() => undefined),
        ensureActive: vi.fn().mockRejectedValue(new Error('restore failed')),
        getHistory: vi.fn(),
      },
    }
    const handler = new SessionMessageHandler(ctx as unknown as ConstructorParameters<typeof SessionMessageHandler>[0])
    await handler.handleSessionMessage(switchMsg('s-missing'), {} as never)
    expect(cap.replies).toHaveLength(0)
    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]?.code).toBe('not_found')
  })
})
