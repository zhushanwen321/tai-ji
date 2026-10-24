/**
 * BtwMessageHandler 测试（btw-question M2-b 验收④；W4b 线枚举帧退役后收缩）。
 *
 * 覆盖：两帧 happy path + 失败 ack（ack 必回不变量）+ 检查 success（closeLine false 不
 * 回成功 ack）+ 入参校验。原 btw.list 帧用例与「create/remove 后广播全量线列表」断言随
 * 该消息及其 state 广播面退役删除——线列表读取入口 = session.list 通用查询
 * （session-list-query.ts 单测覆盖，设计 §3.3.1 / §5-W4b）。
 *
 * 测试框架：vitest（从 vitest 导入）。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/btw-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import { BtwMessageHandler } from '../btw-message-handler.js'
import type { BtwHandlerContext } from '../btw-message-handler.js'
import { BtwError } from '../../services/session/btw-service.js'
import type { BtwLineRecord } from '../../services/session/btw-service.js'

// ── canvas 绑定解绑 spy（btw.remove = 线 session 真删除 → 解绑，F1-11 同族）──

vi.mock('../../services/canvas/canvas-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/canvas/canvas-service.js')>()
  return { ...actual, unbindCanvasOnSessionDeleted: vi.fn() }
})
import { unbindCanvasOnSessionDeleted } from '../../services/canvas/canvas-service.js'

// ── mock helpers ─────────────────────────────────────────────

function mockWs(): WsType {
  return {} as WsType
}

function msg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

/** 线注册表条目最小工厂（handler 只消费 piSessionId/mainSid，其余字段占位——无 fs 接触）。
 *  W4a 键统一：BtwLineRecord.vid 已删，线 id = piSessionId（入参即 pi 真实 id）。 */
function lineRec(sessionId: string, mainSid: string): BtwLineRecord {
  return {
    piSessionId: sessionId,
    mainSid,
    cwd: '/w/main',
    label: 'main',
    threadDir: '/btw/enc/main/1',
    sessionFilePath: '/btw/enc/main/1/thread.jsonl',
    snapshotKind: 'forked',
    surface: 'btw',
    createdAt: 1,
    pendingInteraction: false,
    contractRounds: 1,
  }
}

/**
 * 组装 ctx：messaging 三方法 vi.fn + BtwService 三原语 fake（BtwServiceFace 结构化窄接口，
 * 无 cast）。W4b 后 handler 无 publish 面（线枚举帧退役），ctx 不再持 messageBus /
 * nextPushId。
 */
function mockCtx(overrides?: Partial<BtwHandlerContext>) {
  const createLine = vi.fn()
  const closeLine = vi.fn(async () => true)
  const getLine = vi.fn(() => undefined as BtwLineRecord | undefined)
  const resolveMain = vi.fn(() => ({ cwd: '/w/main', mainTurnActive: false }) as { cwd: string; mainTurnActive: boolean } | undefined)
  const ctx: BtwHandlerContext = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    btwService: { createLine, closeLine, getLine },
    resolveMain,
    ...overrides,
  }
  return { ctx, createLine, closeLine, getLine, resolveMain }
}

/** reply/sendError 调用读取（ack 必回断言用）。 */
function replyCalls(ctx: BtwHandlerContext) { return vi.mocked(ctx.reply).mock.calls }
function errorCalls(ctx: BtwHandlerContext) { return vi.mocked(ctx.sendError).mock.calls }

beforeEach(() => {
  vi.clearAllMocks()
})

// ── handles 清单 ─────────────────────────────────────────────

describe('BtwMessageHandler.handles', () => {
  it('认领 btw 两帧（D6 全集减 W4b 退役的线枚举帧），不认领 message.*（验收③：message.send 帧族复用不动）', () => {
    const handler = new BtwMessageHandler(mockCtx().ctx)
    expect(handler.handles).toEqual(['btw.create', 'btw.remove'])
    expect(handler.handles).not.toContain('btw.list')
    expect(handler.handles).not.toContain('message.send')
  })
})

// ── btw.create ──────────────────────────────────────────────

describe('BtwMessageHandler · btw.create', () => {
  it('happy path：转发 createLine（cwd + 主 turn 信号）→ reply forkState=full', async () => {
    const { ctx, createLine } = mockCtx()
    createLine.mockResolvedValue({ sessionId: 't1', mainSid: 'main-1', snapshotKind: 'forked', sessionFilePath: '/btw/t1.jsonl' })
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), ws)

    expect(createLine).toHaveBeenCalledTimes(1)
    expect(createLine).toHaveBeenCalledWith({ mainSid: 'main-1', cwd: '/w/main', mainTurnActive: false })
    // ack 必回：reply 带 msg.id + forkState 映射（forked → full）
    expect(replyCalls(ctx)).toEqual([[
      ws, 'req-1', 'btw.create',
      { sessionId: 't1', mainSid: 'main-1', forkState: 'full' },
    ]])
    expect(errorCalls(ctx)).toHaveLength(0)
  })

  it('snapshotKind → forkState 映射：no-source → none / truncated → truncated，mainTurnActive 透传', async () => {
    for (const [kind, expected] of [['no-source', 'none'], ['truncated', 'truncated']] as const) {
      vi.clearAllMocks()
      const { ctx, createLine } = mockCtx({
        resolveMain: () => ({ cwd: '/w/main', mainTurnActive: true }),
      })
      createLine.mockResolvedValue({ sessionId: 't2', mainSid: 'main-1', snapshotKind: kind, sessionFilePath: '/x' })
      const handler = new BtwMessageHandler(ctx)

      await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), mockWs())

      expect(createLine).toHaveBeenCalledWith({ mainSid: 'main-1', cwd: '/w/main', mainTurnActive: true })
      expect(replyCalls(ctx)[0]?.[3]).toEqual({ sessionId: 't2', mainSid: 'main-1', forkState: expected })
    }
  })

  it('主会话不可解析 → error ack main_session_not_found（带恢复指引 + sessionId），不调 createLine', async () => {
    const resolveMain = vi.fn(() => undefined)
    const { ctx, createLine } = mockCtx({ resolveMain })
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'ghost' }), ws)

    expect(resolveMain).toHaveBeenCalledWith('ghost')
    expect(createLine).not.toHaveBeenCalled()
    expect(replyCalls(ctx)).toHaveLength(0)
    expect(errorCalls(ctx)).toEqual([[
      ws, 'main_session_not_found',
      expect.stringContaining('open it first'), 'req-1', { sessionId: 'ghost' },
    ]])
  })

  it('createLine 抛 BtwError → error ack 透传领域 code（fork_failed），不 reply', async () => {
    const { ctx, createLine } = mockCtx()
    createLine.mockRejectedValue(new BtwError('fork_failed', '[btw] pi fork bootstrap exited (code 1)'))
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), ws)

    expect(errorCalls(ctx)).toEqual([[
      ws, 'fork_failed', '[btw] pi fork bootstrap exited (code 1)', 'req-1', { sessionId: 'main-1' },
    ]])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('createLine 抛未知错误 → 兜底 code btw_failed（envelope 契约 D10）', async () => {
    const { ctx, createLine } = mockCtx()
    createLine.mockRejectedValue(new Error('boom'))
    const handler = new BtwMessageHandler(ctx)

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), mockWs())

    expect(errorCalls(ctx)[0]?.[1]).toBe('btw_failed')
    expect(errorCalls(ctx)[0]?.[2]).toBe('boom')
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('mainSid 缺失/空 → error ack，不触达 resolveMain/createLine', async () => {
    const { ctx, createLine, resolveMain } = mockCtx()
    const handler = new BtwMessageHandler(ctx)

    await handler.handleBtwMessage(msg('btw.create', { mainSid: '' }), mockWs())

    expect(resolveMain).not.toHaveBeenCalled()
    expect(createLine).not.toHaveBeenCalled()
    expect(errorCalls(ctx)[0]?.[1]).toBe('btw_failed')
    expect(replyCalls(ctx)).toHaveLength(0)
  })
})

// ── btw.remove ──────────────────────────────────────────────

describe('BtwMessageHandler · btw.remove', () => {
  it('happy path：closeLine(deleteSessionFile) → ack reply 回显 sessionId', async () => {
    const { ctx, closeLine, getLine } = mockCtx()
    getLine.mockReturnValue(lineRec('t1', 'main-1'))
    closeLine.mockResolvedValue(true)
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 't1' }), ws)

    expect(getLine).toHaveBeenCalledWith('t1')
    expect(closeLine).toHaveBeenCalledWith('t1', { deleteSessionFile: true })
    expect(replyCalls(ctx)).toEqual([[ws, 'req-1', 'btw.remove', { sessionId: 't1' }]])
    expect(errorCalls(ctx)).toHaveLength(0)
  })

  it('sessionId 空串/非字符串 → error ack btw_failed（值域防线：先校验形态再查注册表）', async () => {
    const { ctx, getLine, closeLine } = mockCtx()
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: '' }), ws)
    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 42 }), ws)

    expect(getLine).not.toHaveBeenCalled()
    expect(closeLine).not.toHaveBeenCalled()
    expect(errorCalls(ctx)).toEqual([
      [ws, 'btw_failed', expect.stringContaining('non-empty thread sessionId'), 'req-1'],
      [ws, 'btw_failed', expect.stringContaining('non-empty thread sessionId'), 'req-1'],
    ])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('W4a：非线 session id（主会话 id）→ 成员查询 miss → line_not_found（不再有 btw: 前缀判别）', async () => {
    const { ctx, getLine, closeLine } = mockCtx() // getLine 默认 undefined
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 'plain-session' }), ws)

    expect(getLine).toHaveBeenCalledWith('plain-session') // 判别器 = 成员查询（键 = piId）
    expect(closeLine).not.toHaveBeenCalled()
    expect(errorCalls(ctx)).toEqual([[ws, 'line_not_found', '[btw] no such thread: plain-session', 'req-1']])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('注册表无此线 → error ack line_not_found（与 BtwError code 词汇表同源）', async () => {
    const { ctx, closeLine } = mockCtx() // getLine 默认 undefined
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 'no-such-line' }), ws)

    expect(closeLine).not.toHaveBeenCalled()
    expect(errorCalls(ctx)).toEqual([[ws, 'line_not_found', '[btw] no such thread: no-such-line', 'req-1']])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('检查 success：closeLine 返回 false（并发双删竞态）→ 不回成功 ack，走 line_not_found', async () => {
    const { ctx, getLine, closeLine } = mockCtx()
    getLine.mockReturnValue(lineRec('t1', 'main-1'))
    closeLine.mockResolvedValue(false)
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 't1' }), ws)

    expect(errorCalls(ctx)).toEqual([[ws, 'line_not_found', '[btw] thread already closed: t1', 'req-1', { sessionId: 'main-1' }]])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('btw.remove 成功即解绑该线画布绑定（解绑规则唯一化：线 session 真删除，F1-11 同族补齐）', async () => {
    const { ctx, getLine, closeLine } = mockCtx()
    getLine.mockReturnValue(lineRec('t1', 'main-1'))
    closeLine.mockResolvedValue(true)
    const handler = new BtwMessageHandler(ctx)

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 't1' }), mockWs())

    expect(vi.mocked(unbindCanvasOnSessionDeleted)).toHaveBeenCalledWith('t1')
  })

  it('btw.remove 竞态落空（closeLine false）不解绑——该线已由并发删除路径解绑', async () => {
    const { ctx, getLine, closeLine } = mockCtx()
    getLine.mockReturnValue(lineRec('t1', 'main-1'))
    closeLine.mockResolvedValue(false)
    const handler = new BtwMessageHandler(ctx)

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 't1' }), mockWs())

    expect(vi.mocked(unbindCanvasOnSessionDeleted)).not.toHaveBeenCalled()
  })

  it('closeLine 抛 BtwError → error ack 透传领域 code，不 reply', async () => {
    const { ctx, getLine, closeLine } = mockCtx()
    getLine.mockReturnValue(lineRec('t1', 'main-1'))
    closeLine.mockRejectedValue(new BtwError('thread_file_missing', '[btw] thread session file missing'))
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { sessionId: 't1' }), ws)

    expect(errorCalls(ctx)).toEqual([[
      ws, 'thread_file_missing', '[btw] thread session file missing', 'req-1', { sessionId: 'main-1' },
    ]])
    expect(replyCalls(ctx)).toHaveLength(0)
  })
})
