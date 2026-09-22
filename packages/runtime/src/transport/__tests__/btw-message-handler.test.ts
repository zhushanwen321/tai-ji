/**
 * BtwMessageHandler 测试（btw-question M2-b 验收④）。
 *
 * 覆盖：三帧 happy path + 失败 ack（ack 必回不变量）+ 广播断言（M2-a 登记的
 * btw.list publish/stateSnapshot 面）+ 检查 success（closeLine false 不回成功 ack）
 * + 入参校验 + 广播 best-effort（失败不吞 ack）。
 *
 * 测试框架：vitest（从 vitest 导入）。
 * 运行：cd packages/runtime && npx vitest run src/transport/__tests__/btw-message-handler.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import { BtwMessageHandler } from '../btw-message-handler.js'
import type { BtwHandlerContext } from '../btw-message-handler.js'
import { BtwError } from '../../services/session/btw-service.js'
import type { BtwLineRecord } from '../../services/session/btw-service.js'

// ── mock helpers ─────────────────────────────────────────────

function mockWs(): WsType {
  return {} as WsType
}

function msg(type: string, payload: Record<string, unknown>, id = 'req-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

/** 线注册表条目最小工厂（handler 只消费 vid/mainSid，其余字段占位——无 fs 接触）。 */
function lineRec(vid: string, mainSid: string): BtwLineRecord {
  return {
    vid,
    piSessionId: vid.slice('btw:'.length),
    mainSid,
    cwd: '/w/main',
    label: 'main',
    threadDir: '/btw/enc/main/1',
    sessionFilePath: '/btw/enc/main/1/thread.jsonl',
    snapshotKind: 'forked',
    hidden: true,
    createdAt: 1,
    lastActivityAt: 1,
    pendingInteraction: false,
    contractRounds: 1,
  }
}

/**
 * 组装 ctx：messaging 三方法 vi.fn + BtwService 四原语 fake（BtwServiceFace 结构化窄面，
 * 无 cast）+ messageBus 全接口 fake（publish 计数单独外提便于断言）。
 */
function mockCtx(overrides?: Partial<BtwHandlerContext>) {
  const publish = vi.fn()
  const createLine = vi.fn()
  const listLines = vi.fn(() => [] as BtwLineRecord[])
  const closeLine = vi.fn(async () => true)
  const getLine = vi.fn(() => undefined as BtwLineRecord | undefined)
  const resolveMain = vi.fn(() => ({ cwd: '/w/main', mainTurnActive: false }) as { cwd: string; mainTurnActive: boolean } | undefined)
  const ctx: BtwHandlerContext = {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    btwService: { createLine, listLines, closeLine, getLine },
    resolveMain,
    messageBus: {
      publish,
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      unsubscribeAll: vi.fn(),
      clearSession: vi.fn(),
    },
    nextPushId: () => 'push_t1',
    ...overrides,
  }
  return { ctx, publish, createLine, listLines, closeLine, getLine, resolveMain }
}

/** reply/sendError 调用面读取（ack 必回断言用）。 */
function replyCalls(ctx: BtwHandlerContext) { return vi.mocked(ctx.reply).mock.calls }
function errorCalls(ctx: BtwHandlerContext) { return vi.mocked(ctx.sendError).mock.calls }

beforeEach(() => {
  vi.clearAllMocks()
})

// ── handles 清单 ─────────────────────────────────────────────

describe('BtwMessageHandler.handles', () => {
  it('认领 btw 三帧（D6 全集），不认领 message.*（验收③：message.send 帧族复用不动）', () => {
    const handler = new BtwMessageHandler(mockCtx().ctx)
    expect(handler.handles).toEqual(['btw.create', 'btw.list', 'btw.remove'])
    expect(handler.handles).not.toContain('message.send')
  })
})

// ── btw.create ──────────────────────────────────────────────

describe('BtwMessageHandler · btw.create', () => {
  it('happy path：转发 createLine（cwd + 主 turn 信号）→ reply forkState=full + 广播全量线列表', async () => {
    const { ctx, publish, createLine, listLines } = mockCtx()
    createLine.mockResolvedValue({ vid: 'btw:t1', mainSid: 'main-1', snapshotKind: 'forked', sessionFilePath: '/btw/t1.jsonl' })
    listLines.mockReturnValue([lineRec('btw:t1', 'main-1')])
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), ws)

    expect(createLine).toHaveBeenCalledTimes(1)
    expect(createLine).toHaveBeenCalledWith({ mainSid: 'main-1', cwd: '/w/main', mainTurnActive: false })
    // 广播：state topic 'btw'，publish 于 mainSid，payload = 同形全量线列表
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith('main-1', {
      type: 'btw.list',
      id: 'push_t1',
      payload: { mainSid: 'main-1', threads: [{ vid: 'btw:t1' }] },
    })
    // ack 必回：reply 带 msg.id + forkState 映射（forked → full）
    expect(replyCalls(ctx)).toEqual([[
      ws, 'req-1', 'btw.create',
      { vid: 'btw:t1', mainSid: 'main-1', forkState: 'full' },
    ]])
    expect(errorCalls(ctx)).toHaveLength(0)
  })

  it('snapshotKind → forkState 映射：no-source → none / truncated → truncated，mainTurnActive 透传', async () => {
    for (const [kind, expected] of [['no-source', 'none'], ['truncated', 'truncated']] as const) {
      vi.clearAllMocks()
      const { ctx, publish, createLine } = mockCtx({
        resolveMain: () => ({ cwd: '/w/main', mainTurnActive: true }),
      })
      createLine.mockResolvedValue({ vid: 'btw:t2', mainSid: 'main-1', snapshotKind: kind, sessionFilePath: '/x' })
      const handler = new BtwMessageHandler(ctx)

      await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), mockWs())

      expect(createLine).toHaveBeenCalledWith({ mainSid: 'main-1', cwd: '/w/main', mainTurnActive: true })
      expect(replyCalls(ctx)[0]?.[3]).toEqual({ vid: 'btw:t2', mainSid: 'main-1', forkState: expected })
      expect(publish).toHaveBeenCalledTimes(1)
    }
  })

  it('主会话不可解析 → error ack main_session_not_found（带恢复指引 + sessionId），不调 createLine、不广播', async () => {
    const resolveMain = vi.fn(() => undefined)
    const { ctx, publish, createLine } = mockCtx({ resolveMain })
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'ghost' }), ws)

    expect(resolveMain).toHaveBeenCalledWith('ghost')
    expect(createLine).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(replyCalls(ctx)).toHaveLength(0)
    expect(errorCalls(ctx)).toEqual([[
      ws, 'main_session_not_found',
      expect.stringContaining('open it first'), 'req-1', { sessionId: 'ghost' },
    ]])
  })

  it('createLine 抛 BtwError → error ack 透传领域 code（fork_failed），失败不广播不 reply', async () => {
    const { ctx, publish, createLine } = mockCtx()
    createLine.mockRejectedValue(new BtwError('fork_failed', '[btw] pi fork bootstrap exited (code 1)'))
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), ws)

    expect(errorCalls(ctx)).toEqual([[
      ws, 'fork_failed', '[btw] pi fork bootstrap exited (code 1)', 'req-1', { sessionId: 'main-1' },
    ]])
    expect(replyCalls(ctx)).toHaveLength(0)
    expect(publish).not.toHaveBeenCalled()
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

// ── btw.list ────────────────────────────────────────────────

describe('BtwMessageHandler · btw.list', () => {
  it('happy path：reply { mainSid, threads }（拉取兜底通道），纯 reply 不 publish', async () => {
    const { ctx, publish, listLines } = mockCtx()
    listLines.mockReturnValue([lineRec('btw:t1', 'main-1'), lineRec('btw:t2', 'main-1')])
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.list', { mainSid: 'main-1' }), ws)

    expect(listLines).toHaveBeenCalledWith('main-1')
    expect(replyCalls(ctx)).toEqual([[
      ws, 'req-1', 'btw.list',
      { mainSid: 'main-1', threads: [{ vid: 'btw:t1' }, { vid: 'btw:t2' }] },
    ]])
    // M2-a 契约：list 是纯 RPC reply（state 快照由 create/remove 广播维护），不入 publish 面
    expect(publish).not.toHaveBeenCalled()
    expect(errorCalls(ctx)).toHaveLength(0)
  })

  it('mainSid 缺失/空 → error ack，不触达注册表', async () => {
    const { ctx, listLines } = mockCtx()
    const handler = new BtwMessageHandler(ctx)

    await handler.handleBtwMessage(msg('btw.list', {}), mockWs())

    expect(listLines).not.toHaveBeenCalled()
    expect(errorCalls(ctx)[0]?.[1]).toBe('btw_failed')
    expect(replyCalls(ctx)).toHaveLength(0)
  })
})

// ── btw.remove ──────────────────────────────────────────────

describe('BtwMessageHandler · btw.remove', () => {
  it('happy path：closeLine(deleteSessionFile) → ack reply 回显 vid + 广播删后全量线列表', async () => {
    const { ctx, publish, closeLine, getLine, listLines } = mockCtx()
    getLine.mockReturnValue(lineRec('btw:t1', 'main-1'))
    closeLine.mockResolvedValue(true)
    listLines.mockReturnValue([]) // close 后注册表已空
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { vid: 'btw:t1' }), ws)

    expect(getLine).toHaveBeenCalledWith('btw:t1')
    expect(closeLine).toHaveBeenCalledWith('btw:t1', { deleteSessionFile: true })
    expect(publish).toHaveBeenCalledWith('main-1', {
      type: 'btw.list',
      id: 'push_t1',
      payload: { mainSid: 'main-1', threads: [] },
    })
    expect(replyCalls(ctx)).toEqual([[ws, 'req-1', 'btw.remove', { vid: 'btw:t1' }]])
    expect(errorCalls(ctx)).toHaveLength(0)
  })

  it('非 btw vid（含主 sid / subagent 键）→ error ack，不触达注册表（值域防线）', async () => {
    const { ctx, getLine, closeLine } = mockCtx()
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { vid: 'plain-session' }), ws)

    expect(getLine).not.toHaveBeenCalled()
    expect(closeLine).not.toHaveBeenCalled()
    expect(errorCalls(ctx)).toEqual([[ws, 'btw_failed', expect.stringContaining('btw:<piSessionId>'), 'req-1']])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('注册表无此线 → error ack line_not_found（与 BtwError code 词汇表同源）', async () => {
    const { ctx, closeLine } = mockCtx() // getLine 默认 undefined
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { vid: 'btw:none' }), ws)

    expect(closeLine).not.toHaveBeenCalled()
    expect(errorCalls(ctx)).toEqual([[ws, 'line_not_found', '[btw] no such thread: btw:none', 'req-1']])
    expect(replyCalls(ctx)).toHaveLength(0)
  })

  it('检查 success：closeLine 返回 false（并发双删竞态）→ 不回成功 ack，走 line_not_found 且不广播', async () => {
    const { ctx, publish, getLine, closeLine } = mockCtx()
    getLine.mockReturnValue(lineRec('btw:t1', 'main-1'))
    closeLine.mockResolvedValue(false)
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { vid: 'btw:t1' }), ws)

    expect(errorCalls(ctx)).toEqual([[ws, 'line_not_found', '[btw] thread already closed: btw:t1', 'req-1']])
    expect(replyCalls(ctx)).toHaveLength(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it('closeLine 抛 BtwError → error ack 透传领域 code，不 reply 不广播', async () => {
    const { ctx, publish, getLine, closeLine } = mockCtx()
    getLine.mockReturnValue(lineRec('btw:t1', 'main-1'))
    closeLine.mockRejectedValue(new BtwError('thread_file_missing', '[btw] thread session file missing'))
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.remove', { vid: 'btw:t1' }), ws)

    expect(errorCalls(ctx)).toEqual([[
      ws, 'thread_file_missing', '[btw] thread session file missing', 'req-1', { sessionId: 'main-1' },
    ]])
    expect(replyCalls(ctx)).toHaveLength(0)
    expect(publish).not.toHaveBeenCalled()
  })
})

// ── 广播 best-effort（ack 必回优先）──────────────────────────

describe('BtwMessageHandler · 广播失败不吞 ack', () => {
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  it('publish 抛错 → reply ack 照发（best-effort），console.error 留痕（拉取兜底仍在）', async () => {
    const publish = vi.fn(() => { throw new Error('bus down') })
    const { ctx, createLine, listLines } = mockCtx({
      messageBus: {
        publish,
        subscribe: vi.fn(),
        unsubscribe: vi.fn(),
        unsubscribeAll: vi.fn(),
        clearSession: vi.fn(),
      },
    })
    createLine.mockResolvedValue({ vid: 'btw:t1', mainSid: 'main-1', snapshotKind: 'forked', sessionFilePath: '/x' })
    listLines.mockReturnValue([lineRec('btw:t1', 'main-1')])
    const handler = new BtwMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleBtwMessage(msg('btw.create', { mainSid: 'main-1' }), ws)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalledTimes(1)
    // ack 必回：广播失败不阻断 reply
    expect(replyCalls(ctx)).toHaveLength(1)
    expect(replyCalls(ctx)[0]?.[2]).toBe('btw.create')
    expect(errorCalls(ctx)).toHaveLength(0)
  })
})
