/**
 * SessionMessageHandler 业务持久化写 WS 路由测试（ipc-converge-a3 W2）。
 *
 * 锁定 session.writeImage / session.migrateImage / session.writeSegments 的 ack 路由：
 * - 正常 → 调 sessionService.writeImage/migrateImage/writeSegmentsMetadata → reply
 *   session.writeImage:result / session.migrateImage:result / session.writeSegments:result
 * - 失败 → sendError（write_image_failed / migrate_image_failed / write_segments_failed）
 *   带 msg.id + payload.sessionId（缺失 sessionId 的消息前端忽略，见 AGENTS.md 规则 7）
 *
 * 安全守卫本身（20MB 上限 / mimeType image/* / name sanitize 防目录穿越 / fromPath 白名单 /
 * segments.json 原子写）在 test/session-service.test.ts「业务持久化写安全守卫」覆盖，
 * 本文件只测 WS 路由分支（reply/error 分叉）。
 *
 * mock 模式参考 src/__tests__/session-message-handler-bash.test.ts（makeHandler + Captured reply/error）。
 *
 * 运行：npx vitest run src/__tests__/session-message-handler-image-routes.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { SessionMessageHandler } from '../transport/session-message-handler.js'
import type { ClientMessage } from '@taiji/shared'

interface Captured {
  replies: { id: string | undefined; type: string; payload: Record<string, unknown> }[]
  errors: { id: string | undefined; code: string; message: string; details?: Record<string, unknown> }[]
}

function makeHandler(sessionOverrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
  const cap: Captured = { replies: [], errors: [] }
  const sessionService = {
    writeImage: vi.fn().mockResolvedValue({ path: '/att/x.png', persisted: true }),
    migrateImage: vi.fn().mockResolvedValue({ path: '/att/y.png' }),
    writeSegmentsMetadata: vi.fn().mockResolvedValue(undefined),
    // 其他方法 stub（handler 构造可能引用，保留最小实现避免 NPE）
    sendMessage: vi.fn().mockResolvedValue({ blocked: false }),
    ensureActive: vi.fn().mockResolvedValue(undefined),
    ...sessionOverrides,
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

describe('SessionMessageHandler —— session.writeImage 路由', () => {
  it('正常 → 调 writeImage(sessionId, base64, mimeType, name) + reply session.writeImage:result', async () => {
    const { ctx, cap, handler } = makeHandler()
    const payload = { sessionId: 's1', base64: 'AQ==', mimeType: 'image/png', name: 'x.png' }
    await handler.handleSessionMessage(msg('session.writeImage', payload), WS)

    // 参数透传
    expect(ctx.sessionService.writeImage).toHaveBeenCalledWith('s1', 'AQ==', 'image/png', 'x.png')
    // reply result（含 persisted）
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'session.writeImage:result',
      payload: { path: '/att/x.png', persisted: true },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('失败（如超 20MB）→ sendError(write_image_failed) 带 msg.id + sessionId，不 reply', async () => {
    const { cap, handler } = makeHandler({
      writeImage: vi.fn().mockRejectedValue(new Error('图片过大（21MB），上限 20MB')),
    })
    await handler.handleSessionMessage(
      msg('session.writeImage', { sessionId: 's1', base64: 'x', mimeType: 'image/png', name: 'big.png' }),
      WS,
    )

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'write_image_failed',
      message: '图片过大（21MB），上限 20MB',
      details: { sessionId: 's1' },
    })
    // 失败不得 reply result
    expect(cap.replies).toHaveLength(0)
  })
})

describe('SessionMessageHandler —— session.migrateImage 路由', () => {
  it('正常 → 调 migrateImage(fromPath, sessionId, fileName) + reply session.migrateImage:result', async () => {
    const { ctx, cap, handler } = makeHandler()
    await handler.handleSessionMessage(
      msg('session.migrateImage', { fromPath: '/tmp/a.png', sessionId: 's1', fileName: 'a.png' }),
      WS,
    )

    // 参数透传
    expect(ctx.sessionService.migrateImage).toHaveBeenCalledWith('/tmp/a.png', 's1', 'a.png')
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({
      id: 'm1',
      type: 'session.migrateImage:result',
      payload: { path: '/att/y.png' },
    })
    expect(cap.errors).toHaveLength(0)
  })

  it('失败（fromPath 在白名单外）→ sendError(migrate_image_failed) 带 msg.id + sessionId', async () => {
    const { cap, handler } = makeHandler({
      migrateImage: vi.fn().mockRejectedValue(new Error('migrate-session-image failed')),
    })
    await handler.handleSessionMessage(
      msg('session.migrateImage', { fromPath: '/Users/x/evil.txt', sessionId: 's1', fileName: 'x.txt' }),
      WS,
    )

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'migrate_image_failed',
      message: 'migrate-session-image failed',
      details: { sessionId: 's1' },
    })
    expect(cap.replies).toHaveLength(0)
  })
})

describe('SessionMessageHandler —— session.writeSegments 路由', () => {
  it('正常 → 调 writeSegmentsMetadata(sessionId, entry) + reply session.writeSegments:result {}', async () => {
    const { ctx, cap, handler } = makeHandler()
    const entry = { clientUuid: 'u-1', segments: [{ type: 'text', text: 'hi' }], timestamp: 123 }
    await handler.handleSessionMessage(msg('session.writeSegments', { sessionId: 's1', entry }), WS)

    // 参数透传（entry 原样）
    expect(ctx.sessionService.writeSegmentsMetadata).toHaveBeenCalledWith('s1', entry)
    expect(cap.replies).toHaveLength(1)
    expect(cap.replies[0]).toMatchObject({ id: 'm1', type: 'session.writeSegments:result', payload: {} })
    expect(cap.errors).toHaveLength(0)
  })

  it('失败（sessionId 为空）→ sendError(write_segments_failed) 带 msg.id + sessionId', async () => {
    const { cap, handler } = makeHandler({
      writeSegmentsMetadata: vi.fn().mockRejectedValue(new Error('write-segments-metadata requires non-empty sessionId')),
    })
    await handler.handleSessionMessage(msg('session.writeSegments', { sessionId: '', entry: {} }), WS)

    expect(cap.errors).toHaveLength(1)
    expect(cap.errors[0]).toMatchObject({
      id: 'm1',
      code: 'write_segments_failed',
      message: 'write-segments-metadata requires non-empty sessionId',
      details: { sessionId: '' },
    })
    expect(cap.replies).toHaveLength(0)
  })
})
