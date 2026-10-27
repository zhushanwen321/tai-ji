import { createMobileStaticHandler, resolveMobileStaticPath, resolveMobileStaticRoot } from '../../infra/mobile-static.js';
import { _resetRemoteReadGateForTest, parseRemoteAccessToken, readRemoteAccessToken } from '../../infra/remote-access.js';
import { unbindCanvasOnSessionDeleted } from '../../services/canvas/canvas-service.js';
import { ExtensionTimeoutManager } from '../../services/extension-timeout-manager.js';
import { MessageBus } from '../../services/message-bus/message-bus.js';
import type { BusClient } from '../../services/message-bus/types.js';
import type { IPiEngine } from '../../services/ports/pi-engine.js';
import { BtwError } from '../../services/session/btw-service.js';
import { BtwMessageHandler } from '../btw-message-handler.js';
import { ConnectionManager, type ConnectionManagerOptions } from '../connection-manager.js';
import { ExtensionMessageHandler, type ExtensionHandlerContext } from '../extension-message-handler.js';
import { ServerMessageBroker } from '../message-broker.js';
import type { ArchiveRpcPort } from '../session-message-handler.js';
import { REMOTE_ACCESS_FILENAME } from '@taiji/shared';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocket as WsType } from 'ws';

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← src/transport/__tests__/btw-message-handler.test.ts
// ======================================================================

// ── canvas 绑定解绑 spy（btw.remove = 线 session 真删除 → 解绑，F1-11 同族）──

import type { BtwLineRecord } from '../../services/session/btw-service.js';
import type { BtwHandlerContext } from '../btw-message-handler.js';
import type { BrokerServices, ClientPool } from '../message-broker.js';
import type { ArchiveSummary, ClientMessage, ServerMessage } from '@taiji/shared';
import * as fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
vi.mock('../../services/canvas/canvas-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/canvas/canvas-service.js')>()
  return { ...actual, unbindCanvasOnSessionDeleted: vi.fn() }
})

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

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('btw-message-handler', () => {
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
});

// ======================================================================
// ← src/transport/__tests__/btw-p-isolation.test.ts
// ======================================================================

/** 内存 BusClient（types.ts 文档形态：{ readyState: 1, send }），帧原文累积。 */
function makeClient() {
  const received: string[] = []
  const client: BusClient = {
    readyState: 1,
    send: (data: string) => { received.push(data) },
  }
  return {
    client,
    frames: (): ServerMessage[] => received.map(raw => JSON.parse(raw) as ServerMessage),
  }
}


/** payload 索引访问收窄（文本_delta 未契约化具名字段——Record 形状经索引读取）。 */
function payload(m: ServerMessage): Record<string, unknown> {
  return m.payload as Record<string, unknown>
}


function sidOf(m: ServerMessage): unknown {
  return payload(m).sessionId
}


/** transient 直传帧载体（分区语义与帧类型无关；payload 形状任意 Record）。 */
const transientDelta = (sessionId: string, i: number): ServerMessage => ({
  type: 'message.text_delta',
  payload: { sessionId, content: `${sessionId}#${i}` },
})


/** stream 类帧载体（入 ring + 分配 seq；payload {sessionId,content} 精确契约）。 */
const streamFrame = (sessionId: string, i: number): ServerMessage => ({
  type: 'message.stream_error',
  payload: { sessionId, content: `${sessionId}#${i}` },
})


const VID_A = 'thread-alpha'

const VID_B = 'thread-beta'

const VID_C = 'thread-gamma'

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('btw-p-isolation', () => {
describe('P-isolation：两线并发流式分区无串扰（runtime MessageBus 半边，fixture 层）', () => {
  it('并发交错 100+100 帧（transient 直传面）：各自订阅者零串扰 + 无关会话零帧', async () => {
    const bus = new MessageBus()
    const a = makeClient()
    const b = makeClient()
    const c = makeClient()
    bus.subscribe(VID_A, a.client)
    bus.subscribe(VID_B, b.client)
    bus.subscribe(VID_C, c.client)

    // 微任务让步制造真实交错（两路发布并发推进，而非先 A 后 B 的顺序写）
    const stream = async (sessionId: string, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        bus.publish(sessionId, transientDelta(sessionId, i))
        if (i % 16 === 0) await Promise.resolve()
      }
    }
    await Promise.all([stream(VID_A, 100), stream(VID_B, 100)])

    const fa = a.frames()
    const fb = b.frames()
    expect(fa).toHaveLength(100)
    expect(fb).toHaveLength(100)

    // 分区断言①：sessionId 恒为订阅方自己
    expect(fa.every(m => sidOf(m) === VID_A)).toBe(true)
    expect(fb.every(m => sidOf(m) === VID_B)).toBe(true)
    // 分区断言②：内容标记零泄漏（对方线 id 的标记不出现在本方任何帧）
    expect(fa.some(m => JSON.stringify(m).includes(VID_B))).toBe(false)
    expect(fb.some(m => JSON.stringify(m).includes(VID_A))).toBe(false)
    // 分区断言③：transient 不分配 seq（直传语义）——两线均无 seq 字段
    expect(fa.every(m => m.seq === undefined)).toBe(true)
    expect(fb.every(m => m.seq === undefined)).toBe(true)
    // 分区断言④：无关会话订阅者收不到任何线的帧
    expect(c.frames()).toHaveLength(0)
  })

  it('stream 类帧并发分区：per-session seq 1..N 独立计数无缺口 + ring 快照只含本线帧', async () => {
    const bus = new MessageBus()
    const a = makeClient()
    const b = makeClient()
    bus.subscribe(VID_A, a.client)
    bus.subscribe(VID_B, b.client)

    const stream = async (sessionId: string, n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        bus.publish(sessionId, streamFrame(sessionId, i))
        if (i % 4 === 0) await Promise.resolve()
      }
    }
    await Promise.all([stream(VID_A, 5), stream(VID_B, 5)])

    const fa = a.frames()
    const fb = b.frames()
    expect(fa).toHaveLength(5)
    expect(fb).toHaveLength(5)
    // per-session seq 独立计数、单调无缺口（1..5），分区互不推高对方水位
    expect(fa.map(m => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(fb.map(m => m.seq)).toEqual([1, 2, 3, 4, 5])
    expect(fa.every(m => sidOf(m) === VID_A)).toBe(true)
    expect(fb.every(m => sidOf(m) === VID_B)).toBe(true)

    // ring 快照（重放侧）同分区：迟到订阅者只回放本线帧，lastSeq 为本线水位
    const late = makeClient()
    const sub = bus.subscribe(VID_A, late.client)
    expect(sub.snapshot).toHaveLength(5)
    expect(sub.snapshot.every(m => sidOf(m) === VID_A)).toBe(true)
    expect(sub.snapshot.some(m => JSON.stringify(m).includes(VID_B))).toBe(false)
    expect(sub.stateSnapshot).toHaveLength(0) // stream 类不写 state 快照
    expect(sub.lastSeq).toBe(5)
  })

  it('transient 不入 ring：只发 transient 的会话，迟到订阅者快照为空（重放侧分区构造性成立）', () => {
    const bus = new MessageBus()
    bus.publish(VID_A, transientDelta(VID_A, 0))
    bus.publish(VID_A, transientDelta(VID_A, 1))

    const late = makeClient()
    const sub = bus.subscribe(VID_A, late.client)
    expect(sub.snapshot).toHaveLength(0)
    expect(sub.lastSeq).toBe(0)
  })

})
});

// ======================================================================
// ← src/transport/__tests__/connection-manager-mobile-static.test.ts
// ======================================================================

const SPAWN_TOKEN = 'spawn-token'

const REMOTE_TOKEN_A = 'a'.repeat(64)

const INDEX_MARK = 'mobile-shell-index-marker'


interface Harness {
  port: number
  conn: ConnectionManager
}


interface RawResponse {  // oe-exempt:20261027:test:
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}


/** 原始 HTTP 请求：path 原样上送（不 normalize），可发字面 `..` 与 query。 */
function rawRequest(port: number, path: string, method = 'GET'): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}


async function startManager_z2(authToken: string | null, options: ConnectionManagerOptions = {}): Promise<Harness> {
  const conn = new ConnectionManager(0, {
    onConnect: () => {},
    onMessage: async () => {},
    sendError: () => {},
  }, authToken, options)
  await conn.start()
  const httpServer = (conn as unknown as { httpServer: { address: () => { port: number } } }).httpServer
  const addr = httpServer.address()
  if (!addr) throw new Error('httpServer has no address after start()')
  return { port: addr.port, conn }
}


/**
 * 组合根开态装配形态（S3 上移后）：remoteAccess=true 判据 → resolveMobileStaticRoot
 * 探测（E5 日志在此发出）→ 探测通过才构造 handler 注入；探测失败（null）不注入
 * （CM 关态分派 = 404）。与 index.ts Transport layer 装配段同构。
 */
function openStateOptions(mobileDist?: string): ConnectionManagerOptions {
  const root = resolveMobileStaticRoot({ remoteAccess: true, mobileDist })
  return {
    remoteTokenProvider: () => REMOTE_TOKEN_A,
    mobileStaticHandler: root !== null ? createMobileStaticHandler(root) : undefined,
  }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('connection-manager-mobile-static', () => {
describe('ConnectionManager mobile static hosting (U1.1)', () => {
  let dataDir: string
  let distDir: string
  const opened: Harness[] = []
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'taiji-mobile-static-test-'))
    distDir = join(dataDir, 'mobile-dist')
    fs.mkdirSync(join(distDir, 'assets'), { recursive: true })
    fs.mkdirSync(join(distDir, 'sub'), { recursive: true })
    fs.writeFileSync(join(distDir, 'index.html'), `<!DOCTYPE html><html>${INDEX_MARK}</html>`, 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")', 'utf-8')
    // 穿越目标：dist 外的「秘密」文件——穿越防护失败的信号是它被 200 读出。
    fs.writeFileSync(join(dataDir, 'secret.txt'), 'TOP_SECRET_OUTSIDE_DIST', 'utf-8')
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
  })

  afterEach(async () => {
    for (const harness of opened.reverse()) await harness.conn.stop()
    opened.length = 0
    for (const spy of consoleSpies.reverse()) spy.mockRestore()
    consoleSpies.length = 0
    vi.unstubAllEnvs()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function spyConsole(method: 'error' | 'warn' | 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    consoleSpies.push(spy)
    return spy
  }

  /** 汇总已捕获的 console 输出为单个字符串（日志纪律断言用）。 */
  function allConsoleOutput(): string {
    return consoleSpies
      .map((spy) => spy.mock.calls.map((call: unknown[]) => call.map(String).join(' ')).join('\n'))
      .join('\n')
  }

  // ── D3：开态正常服务 ─────────────────────────────────────────────────────

  describe('开态静态服务（mobileDist 有效）', () => {
    it('GET / 回退 index.html（目录请求 → index.html 兜底）', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/')
      expect(res.status).toBe(200)
      expect(res.body.toString('utf-8')).toContain(INDEX_MARK)
      expect(res.headers['content-type']).toContain('text/html')
    })

    it('GET /assets/app.js 返回文件内容 + JS Content-Type（产物资产形态）', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/assets/app.js')
      expect(res.status).toBe(200)
      expect(res.body.toString('utf-8')).toBe('console.log("app")')
      expect(res.headers['content-type']).toContain('text/javascript')
    })

    // Content-Type 映射矩阵与 octet-stream 兜底归属裸 handler 面（mobile-static.test.ts
    // 的 it.each 与映射外扩展名用例），集成测试侧不重复。

    it('子目录请求（/sub/）也回退顶层 index.html；不存在的资产路径 404 兜底', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const dirRes = await rawRequest(opened[0].port, '/sub/')
      expect(dirRes.status).toBe(200)
      expect(dirRes.body.toString('utf-8')).toContain(INDEX_MARK)
      const missingRes = await rawRequest(opened[0].port, '/assets/no-such-chunk.js')
      expect(missingRes.status).toBe(404)
      expect(missingRes.body).toHaveLength(0)
    })

    it('HEAD 返回与 GET 相同的头（Content-Type/Content-Length）但 body 为空', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const head = await rawRequest(opened[0].port, '/assets/app.js', 'HEAD')
      expect(head.status).toBe(200)
      expect(head.headers['content-type']).toContain('text/javascript')
      expect(Number(head.headers['content-length'])).toBe('console.log("app")'.length)
      expect(head.body).toHaveLength(0)
    })

    it('非 GET/HEAD（POST）→ 405 + Allow: GET, HEAD', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/', 'POST')
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, HEAD')
    })

    it('/health 先于静态分支：开态下探针行为不变', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const res = await rawRequest(opened[0].port, '/health')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body.toString('utf-8'))).toMatchObject({ status: 'ok' })
    })
  })

  // ── E4：穿越防护 ─────────────────────────────────────────────────────────

  describe('E4 路径穿越防护（字面与编码变体全部 400，白名单外零 fs 读取）', () => {
    it.each([
      ['字面 .. 段', '/../secret.txt'],
      ['编码 %2e%2e 段', '/%2e%2e/secret.txt'],
      ['编码 ..%2f 混合', '/..%2fsecret.txt'],
      ['全编码 %2e%2e%2f', '/%2e%2e%2fsecret.txt'],
      ['嵌套深穿越', '/assets/%2e%2e/%2e%2e/secret.txt'],
      ['字面多级 .. 段', '/a/b/../../../x'],
      ['畸形百分号序列', '/%zzsecret'],
      ['非法 UTF-8 百分号编码', '/%ffx'],
      ['NUL 字节', '/%00secret.txt'],
    ])('%s → 400 且不泄 dist 外内容', async (_label, path) => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      const warnSpy = spyConsole('warn')
      const res = await rawRequest(opened[0].port, path)
      expect(res.status).toBe(400)
      expect(res.body.toString('utf-8')).not.toContain('TOP_SECRET_OUTSIDE_DIST')
      // 拒绝日志只记 pathname（D3）——服务端路径与文件内容不落盘。
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain('TOP_SECRET')
      expect(String(warnSpy.mock.calls[0]?.[0])).not.toContain(distDir)
    })
  })

  // ── D3：日志纪律（query 剥除）────────────────────────────────────────────

  describe('日志只记规范化路径（query 剥除，token 不落盘）', () => {
    it.each([
      ['目录回退路径', '/'],
      ['资产路径', '/assets/app.js'],
      ['穿越拒绝路径', '/../secret.txt'],
      ['404 路径', '/assets/no-such.js'],
    ])('%s 的访问/拒绝日志不含 query string', async (_label, path) => {
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions(distDir)))
      spyConsole('log')
      spyConsole('warn')
      spyConsole('error')
      await rawRequest(opened[0].port, `${path}?token=SECRETTOKEN123`)
      expect(allConsoleOutput()).not.toContain('SECRETTOKEN123')
      expect(allConsoleOutput()).not.toContain('token=')
    })
  })

  // ── D3：handler 未注入 = 不挂载（行为与远程访问引入前逐字节一致）───────────────
  // 开态检查（mobileDist 单独出现不构成开态）已随挂载裁决上移组合根，归属
  // mobile-static.test.ts 的 resolveMobileStaticRoot 关态用例。

  describe('handler 未注入（关态 / E5 禁用）不挂载', () => {
    it('无 mobileStaticHandler：GET / → 404 空 body（现状形态），无 E5 error', async () => {
      const errorSpy = spyConsole('error')
      opened.push(await startManager_z2(SPAWN_TOKEN))
      const res = await rawRequest(opened[0].port, '/')
      expect(res.status).toBe(404)
      expect(res.body).toHaveLength(0)
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('关态 /health 行为不变', async () => {
      opened.push(await startManager_z2(SPAWN_TOKEN))
      const res = await rawRequest(opened[0].port, '/health')
      expect(res.status).toBe(200)
      expect(JSON.parse(res.body.toString('utf-8'))).toMatchObject({ status: 'ok' })
    })
  })

  // ── E5：开态 dist 缺失 → 静态托管禁用 + 响亮日志 + WS 不受影响 ────────────────
  // 变体判定差异（未传 / 目录不存在 / 指向普通文件）与文案归属纯函数部分
  // resolveMobileStaticRoot（mobile-static.test.ts 的 E5 探测用例），集成测试侧只锚降级行为。

  describe('E5：开态但 mobileDist 缺失（集成降级行为）', () => {
    it('未传 --mobile-dist → 响亮 error 日志（计数 1）；GET / 404；WS auth 正常', async () => {
      const errorSpy = spyConsole('error')
      // 开态形态但 mobileDist 缺失（组合根装配链：探测在 handler 构造前发出 E5 日志）
      opened.push(await startManager_z2(SPAWN_TOKEN, openStateOptions()))
      expect(errorSpy).toHaveBeenCalledTimes(1)
      // 静态托管禁用，不拒启：HTTP 静态路径 404、WS auth 照常。
      const res = await rawRequest(opened[0].port, '/')
      expect(res.status).toBe(404)
      const ws = new WebSocket(`ws://127.0.0.1:${opened[0].port}`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve)
        ws.on('error', reject)
      })
      ws.send(JSON.stringify({ type: 'auth', payload: { token: REMOTE_TOKEN_A } }))
      const authOk = await new Promise<boolean>((resolve) => {
        ws.once('message', (data) => {
          const msg = JSON.parse(String(data)) as { type: string; payload?: { ok?: boolean } }
          resolve(msg.type === 'auth.result' && msg.payload?.ok === true)
        })
      })
      ws.terminate()
      expect(authOk).toBe(true)
    })
  })

  // ── resolveMobileStaticPath 纯函数白盒（正向解析锚定；负向矩阵归上方 E4 集成测试侧）───

  describe('resolveMobileStaticPath（纯函数）', () => {
    it('dist 内路径 → 绝对路径；根路径 → distRoot 本身（目录判定入口）', () => {
      expect(resolveMobileStaticPath(distDir, '/index.html')).toBe(join(distDir, 'index.html'))
      expect(resolveMobileStaticPath(distDir, '/assets/app.js')).toBe(join(distDir, 'assets', 'app.js'))
      expect(resolveMobileStaticPath(distDir, '/')).toBe(distDir)
    })
  })
})
});

// ======================================================================
// ← src/transport/__tests__/connection-manager-remote-access.test.ts
// ======================================================================

const SPAWN_TOKEN_m2 = 'spawn-token'

const REMOTE_TOKEN_A_m2 = 'a'.repeat(64)

const REMOTE_TOKEN_B = 'b'.repeat(64)


interface Harness_m2 {  // oe-exempt:20261027:test:
  port: number
  conn: ConnectionManager
  httpServer: HttpServer
}


async function startManager_z3(authToken: string | null, options: ConnectionManagerOptions = {}, host?: string): Promise<Harness_m2> {
  const conn = new ConnectionManager(0, {
    onConnect: () => {},
    onMessage: async () => {},
    sendError: () => {},
  }, authToken, options)
  await conn.start(host)
  const httpServer = (conn as unknown as { httpServer: HttpServer }).httpServer
  const addr = httpServer.address() as AddressInfo | null
  if (!addr) throw new Error('httpServer has no address after start()')
  return { port: addr.port, conn, httpServer }
}


/** 建立连接并完成一次 auth 尝试，返回握手结果与 close 码（不改变量状态，供负面/正面共用）。 */
async function tryAuth(port: number, token: string): Promise<{ ok: boolean; closeCode: number | null }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  const authResult = new Promise<boolean>((resolve, reject) => {
    ws.once('message', (data) => {
      try {
        const msg = JSON.parse(String(data)) as { type: string; payload?: { ok?: boolean } }
        if (msg.type === 'auth.result') resolve(msg.payload?.ok === true)
        else reject(new Error(`expected auth.result, got ${msg.type}`))
      } catch (e) { reject(e) }
    })
  })
  const closed = new Promise<number | null>((resolve) => {
    ws.once('close', (code) => resolve(code ?? null))
  })
  await opened
  ws.send(JSON.stringify({ type: 'auth', payload: { token } }))
  const ok = await authResult
  // 成功路径连接保持存活（无 close 帧）；close 码断言只对拒绝路径（rejectAuth 主动 close）有意义。
  if (ok) {
    ws.terminate()
    return { ok, closeCode: null }
  }
  const closeCode = await closed
  ws.terminate()
  return { ok, closeCode }
}


function writeRemoteAccessFile(dir: string, content: string): string {
  const filePath = join(dir, REMOTE_ACCESS_FILENAME)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}


function remoteAccessJson(token: string, enabled = true): string {
  return JSON.stringify({ enabled, token, createdAt: '2026-09-19T00:00:00.000Z' })
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('connection-manager-remote-access', () => {
describe('ConnectionManager remote-access (U0.1)', () => {
  let dataDir: string
  const opened: Harness_m2[] = []
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'taiji-remote-access-test-'))
    vi.stubEnv('TAIJI_AGENT_DATA_DIR', dataDir)
  })

  afterEach(async () => {
    for (const harness of opened.reverse()) await harness.conn.stop()
    opened.length = 0
    for (const spy of consoleSpies.reverse()) spy.mockRestore()
    consoleSpies.length = 0
    // 频控是 connection-manager 模块级状态：逐测重置防「首个响亮已被前测消耗」跨测泄漏。
    _resetRemoteReadGateForTest()
    vi.unstubAllEnvs()
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function spyConsole(method: 'error' | 'warn' | 'debug' | 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    consoleSpies.push(spy)
    return spy
  }

  // ── D1：listen host 参数化 ──────────────────────────────────────────────
  // 默认绑定 127.0.0.1 的断言归属 ws-listen-hardening.test.ts 的 SEC-U2（更强防线），
  // 此处只锚参数化开态 0.0.0.0。

  describe('listen host 参数化（D1）', () => {
    it("start('0.0.0.0') 绑定全网卡（远程访问开态）", async () => {
      const harness = await startManager_z3(SPAWN_TOKEN_m2, {}, '0.0.0.0')
      opened.push(harness)
      expect((harness.httpServer.address() as AddressInfo).address).toBe('0.0.0.0')
    })
  })

  // ── 关态：默认行为等价（G2/S1）────────────────────────────────────────────
  // 「auth 仅认 spawn token（正确值通过/错误值 1008）」归属 ws-listen-hardening.test.ts
  // 的 SEC-U2（错 token 1008 + bad_token、正确 token 放行，真超集），此处只锚关态零 IO。

  describe('关态（无 remoteTokenProvider）——默认行为等价', () => {
    it('remote-access.json 存在也不被读取：文件内 token 不被认证 + fs 零读取', async () => {
      // 文件里放一个合法 remote token——若被读取入集合，该 token 将通过 auth。
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A_m2))
      const harness = await startManager_z3(SPAWN_TOKEN_m2)
      opened.push(harness)
      const readSpy = vi.spyOn(fs, 'readFileSync')
      try {
        const fileToken = await tryAuth(harness.port, REMOTE_TOKEN_A_m2)
        expect(fileToken.ok).toBe(false)
        expect((await tryAuth(harness.port, SPAWN_TOKEN_m2)).ok).toBe(true)
        // fs spy 复核「关态零 IO」：readFileSync 无任何以 remote-access.json 结尾的调用。
        const remoteReads = readSpy.mock.calls.filter((call) => String(call[0]).endsWith(REMOTE_ACCESS_FILENAME))
        expect(remoteReads).toHaveLength(0)
      } finally {
        readSpy.mockRestore()
      }
    })
  })

  // ── 开态：集合校验 + 握手热读（D2）────────────────────────────────────────

  describe('开态（remoteTokenProvider 装配）——集合校验 + 文件热读', () => {
    it('有效 remote token 握手通过（集合 = spawn ∪ remote）', async () => {
      const harness = await startManager_z3(SPAWN_TOKEN_m2, { remoteTokenProvider: () => REMOTE_TOKEN_A_m2 })
      opened.push(harness)
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A_m2)).ok).toBe(true)
      expect((await tryAuth(harness.port, SPAWN_TOKEN_m2)).ok).toBe(true)
    })

    it('文件热读：轮换 remote-access.json 后新握手认新值、旧值被拒', async () => {
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A_m2))
      const harness = await startManager_z3(SPAWN_TOKEN_m2, { remoteTokenProvider: readRemoteAccessToken })
      opened.push(harness)
      // 轮换前：旧 token A 通过。
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A_m2)).ok).toBe(true)
      // 轮换 = 重写文件（main 侧原子写语义，此处直接覆盖验证读侧热读）。
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_B))
      // 轮换后：新 token B 通过（每次握手热读，无重启）、旧 token A 被拒。
      expect((await tryAuth(harness.port, REMOTE_TOKEN_B)).ok).toBe(true)
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A_m2)).ok).toBe(false)
    })
  })

  // ── E10：开态文件缺失/损坏 → fail-closed 空集合 + 响亮日志 ──────────────────

  describe('E10：开态文件缺失/损坏处置', () => {
    it('文件缺失 → readRemoteAccessToken 返回 null + error 日志含恢复指引；spawn token 仍通过', async () => {
      const errorSpy = spyConsole('error')
      const harness = await startManager_z3(SPAWN_TOKEN_m2, { remoteTokenProvider: readRemoteAccessToken })
      opened.push(harness)
      expect(readRemoteAccessToken()).toBeNull()
      // S3 拆分后 CM 构造零探测副作用（dist 探测归组合根 resolveMobileStaticRoot），
      // provider 装配不再触发 E5 静态日志——本测试只锚定 remote 文件读侧：按内容
      // 过滤后恰一条（过滤防御未来无关 error 干扰断言语义）。
      const remoteFileErrors = errorSpy.mock.calls.filter((call: unknown[]) => String(call[0]).includes(REMOTE_ACCESS_FILENAME))
      expect(remoteFileErrors).toHaveLength(1)
      expect(String(remoteFileErrors[0]?.[0])).toContain('恢复')
      // fail-closed 语义：remote 通道空，spawn 通道不受影响。
      expect((await tryAuth(harness.port, REMOTE_TOKEN_A_m2)).ok).toBe(false)
      expect((await tryAuth(harness.port, SPAWN_TOKEN_m2)).ok).toBe(true)
    })

    it('坏 JSON → null + error 日志', () => {
      const errorSpy = spyConsole('error')
      writeRemoteAccessFile(dataDir, '{broken json')
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('JSON')
    })

    it('token 字段不符合 64hex 契约 → null + error 日志', () => {
      const errorSpy = spyConsole('error')
      writeRemoteAccessFile(dataDir, remoteAccessJson('not-a-hex-token'))
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('64 位 hex')
    })

    it('enabled=false（关态文件留存，设计内合法产出）→ null，不触发 error；console.log 可观测（code-harden P2）', () => {
      const errorSpy = spyConsole('error')
      const logSpy = spyConsole('log')
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A_m2, false))
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).not.toHaveBeenCalled()
      // 非 debug 级：关态不入集合是安全相关事实，prod 日志可见（消息内自注明 debug 性质）。
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(String(logSpy.mock.calls[0]?.[0])).toContain('enabled=false')
    })
  })

  // ── 热读失败频控（code-harden P2：重连风暴降噪）────────────────────────────
  // 语义：每进程同因首次失败响亮 error，此后同因降 debug；读取成功重置回「首次响亮」。
  // 频控状态是模块级单例，测试间隔离靠 afterEach 的 _resetRemoteReadGateForTest()。

  describe('热读失败频控', () => {
    it('同因连续失败：首次响亮 error，此后降 debug 不再刷 error', () => {
      const errorSpy = spyConsole('error')
      const debugSpy = spyConsole('debug')
      // 文件缺失（read-ENOENT）连续 3 次热读（对应客户端重连风暴的逐握手调用）。
      expect(readRemoteAccessToken()).toBeNull()
      expect(readRemoteAccessToken()).toBeNull()
      expect(readRemoteAccessToken()).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(debugSpy).toHaveBeenCalledTimes(2)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('恢复')
    })

    it('因变化重新响亮：文件缺失(ENOENT) → 坏 JSON，各自首次 error', () => {
      const errorSpy = spyConsole('error')
      const debugSpy = spyConsole('debug')
      expect(readRemoteAccessToken()).toBeNull() // read-ENOENT 响亮
      writeRemoteAccessFile(dataDir, '{broken json')
      expect(readRemoteAccessToken()).toBeNull() // bad-json 因变化 → 响亮
      expect(readRemoteAccessToken()).toBeNull() // bad-json 重复 → 降 debug
      expect(errorSpy).toHaveBeenCalledTimes(2)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('读取')
      expect(String(errorSpy.mock.calls[1]?.[0])).toContain('JSON')
      expect(debugSpy).toHaveBeenCalledTimes(1)
    })

    it('读取成功重置：失败(响亮) → 同因降级 → 成功 → 复发重新响亮', () => {
      const errorSpy = spyConsole('error')
      const filePath = join(dataDir, REMOTE_ACCESS_FILENAME)
      expect(readRemoteAccessToken()).toBeNull() // 首次失败响亮
      expect(readRemoteAccessToken()).toBeNull() // 同因降 debug
      writeRemoteAccessFile(dataDir, remoteAccessJson(REMOTE_TOKEN_A_m2))
      expect(readRemoteAccessToken()).toBe(REMOTE_TOKEN_A_m2) // 成功 → 频控重置
      fs.rmSync(filePath)
      expect(readRemoteAccessToken()).toBeNull() // 复发 → 重新响亮（防长期降级掩盖复发）
      expect(errorSpy).toHaveBeenCalledTimes(2)
    })
  })

  // ── D2 配套规格②：集合逐成员 timingSafeEqual，近似 token 一律拒绝 ───────────
  describe('集合成员比较（近似 token 拒绝）', () => {
    it.each([
      ['remote token 等长不同值', `${'a'.repeat(63)}b`],
      ['remote token 前缀（长度不等）', 'a'.repeat(32)],
      ['spawn token 后缀扩展', `${SPAWN_TOKEN}x`],
    ])('%s → 拒绝', async (_label, nearToken) => {
      const harness = await startManager_z3(SPAWN_TOKEN_m2, { remoteTokenProvider: () => REMOTE_TOKEN_A_m2 })
      opened.push(harness)
      const result = await tryAuth(harness.port, nearToken)
      expect(result.ok).toBe(false)
      expect(result.closeCode).toBe(1008)
    })
  })

  // ── parseRemoteAccessToken 纯解析三态（E10 读侧语义直接锚定）────────────────

  describe('parseRemoteAccessToken（纯函数）', () => {
    it('合法开态配置 → 返回 token', () => {
      expect(parseRemoteAccessToken(remoteAccessJson(REMOTE_TOKEN_A_m2))).toBe(REMOTE_TOKEN_A_m2)
    })
    it('非对象 JSON（如数组/标量）→ null + error 日志含 shape 分支特有文案', () => {
      const errorSpy = spyConsole('error')
      expect(parseRemoteAccessToken('["not","an","object"]')).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      // 「字段不合法」是 bad-shape 分支特有文案（token hex 失败分支是「token 字段不符
      // 合契约」）——区分两条失败路径，防 shape 检查被移除后数组输入经 hex 失败路径
      // 同样 null + error 造成假绿。
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('字段不合法')
    })
    it('缺 token 字段 → null + error 日志含 shape 分支特有文案', () => {
      const errorSpy = spyConsole('error')
      expect(parseRemoteAccessToken(JSON.stringify({ enabled: true }))).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('字段不合法')
    })
  })
})
});

// ======================================================================
// ← src/transport/__tests__/extension-message-handler-ui-response.test.ts
// ======================================================================

const SID = 'sid-ui-resp'

const REQUEST_ID = 'ui_req_1'


/** fake rpc client：sendExtensionUiResponse 返值可控（boolean = 是否写进 pi stdin） */
function makeClient_m2(delivered: boolean): IPiEngine {
  return {
    sendExtensionUiResponse: vi.fn(() => delivered),
  } as unknown as IPiEngine
}


function makeCtx(client: IPiEngine | undefined): { ctx: ExtensionHandlerContext; sendError: ReturnType<typeof vi.fn>; mgr: ExtensionTimeoutManager } {
  const mgr = new ExtensionTimeoutManager()
  // 预置 pending：模拟 ui_request 到达时 runtime 的挂起单表登记（getPendingRequests 据此回推）
  mgr.registerRequest(SID, REQUEST_ID, 'confirm', { title: 'confirm?' })
  const sendError = vi.fn()
  const ctx = {
    send: vi.fn(),
    sendError,
    reply: vi.fn(),
    sessionService: { getRpcClient: vi.fn(() => client) },
    extensionService: undefined,
    extensionTimeoutMgr: mgr,
  } as unknown as ExtensionHandlerContext
  return { ctx, sendError, mgr }
}


function makeMsg() {
  return {
    type: 'extension.ui_response',
    id: undefined,
    payload: { sessionId: SID, requestId: REQUEST_ID, method: 'confirm', result: true },
  } as never
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('extension-message-handler-ui-response', () => {
beforeEach(() => {
  vi.clearAllMocks()
})
describe('M1 环 1：extension.ui_response 写 pi 失败（RT-1#4）', () => {
  it('sendExtensionUiResponse 返 false → sendError 带 extension_response_send_failed 上行且含 sessionId', async () => {
    const { ctx, sendError } = makeCtx(makeClient_m2(false))
    await new ExtensionMessageHandler(ctx).handleExtensionMessage(makeMsg(), {} as WsType)

    expect(sendError).toHaveBeenCalledTimes(1)
    const [ws, code, message, id, details] = sendError.mock.calls[0] as unknown as [unknown, string, string, unknown, { sessionId?: string; hint?: string }]
    expect(code).toBe('extension_response_send_failed')
    expect(message).toContain(REQUEST_ID)
    expect(details?.sessionId).toBe(SID)
    expect(typeof details?.hint).toBe('string')
    expect(id).toBeUndefined() // fire-and-forget 无 msg.id，走 onSessionError 兜底而非 pending reject
  })

  it('写失败时 pending 即终结（removeRequest）——getPendingRequests 不再回推该请求', async () => {
    const { ctx, mgr } = makeCtx(makeClient_m2(false))
    expect(mgr.getPendingRequests(SID)).toHaveLength(1) // 前置：预置生效

    await new ExtensionMessageHandler(ctx).handleExtensionMessage(makeMsg(), {} as WsType)

    expect(mgr.getPendingRequests(SID)).toHaveLength(0)
    expect(mgr.sessionRequestCount(SID)).toBe(0)
  })

  it('送达成功（返 true）→ 无 sendError，pending 照常收缩（既有行为）', async () => {
    const { ctx, sendError, mgr } = makeCtx(makeClient_m2(true))
    await new ExtensionMessageHandler(ctx).handleExtensionMessage(makeMsg(), {} as WsType)

    expect(sendError).not.toHaveBeenCalled()
    expect(mgr.getPendingRequests(SID)).toHaveLength(0)
  })
})
});

// ======================================================================
// ← src/transport/__tests__/mobile-static.test.ts
// ======================================================================

const INDEX_MARK_m2 = 'mobile-shell-index-marker'


interface RawResponse_m2 {  // oe-exempt:20261027:test:
  status: number
  headers: IncomingMessage['headers']
  body: Buffer
}


/** 原始 HTTP 请求：path 原样上送（不 normalize），可发字面 `..` 与 query。 */
function rawRequest_m2(port: number, path: string, method = 'GET'): Promise<RawResponse_m2> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}


/** 裸静态 server：只挂 createMobileStaticHandler，无 WS / authToken（module 独立可测形态）。 */
async function startStaticServer(distRoot: string): Promise<{ port: number; server: Server }> {
  const server = createServer(createMobileStaticHandler(distRoot))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  return { port: addr.port, server }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('mobile-static', () => {
describe('mobile-static module (S3)', () => {
  let dataDir: string
  let distDir: string
  const openedServers: Server[] = []
  const consoleSpies: ReturnType<typeof vi.spyOn>[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(tmpdir(), 'taiji-mobile-static-module-test-'))
    distDir = join(dataDir, 'mobile-dist')
    fs.mkdirSync(join(distDir, 'assets'), { recursive: true })
    fs.writeFileSync(join(distDir, 'index.html'), `<!DOCTYPE html><html>${INDEX_MARK}</html>`, 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'app.js'), 'console.log("app")', 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'main.css'), 'body { margin: 0 }', 'utf-8')
    fs.writeFileSync(join(distDir, 'assets', 'font.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01]))
    fs.writeFileSync(join(distDir, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>', 'utf-8')
  })

  afterEach(async () => {
    for (const server of openedServers.reverse()) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    openedServers.length = 0
    for (const spy of consoleSpies.reverse()) spy.mockRestore()
    consoleSpies.length = 0
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })

  function spyConsole(method: 'error' | 'warn' | 'log'): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, method).mockImplementation(() => {})
    consoleSpies.push(spy)
    return spy
  }

  // ── 开态判定 + E5 探测（挂载裁决迁入组合根判据的 module 半边）────────────────

  describe('resolveMobileStaticRoot（开态判定 + E5 探测）', () => {
    it('关态检查（自 ConnectionManager 迁入）：remoteAccess=false 时 mobileDist 单独出现不构成开态——null + 零日志 + 零探测 IO', () => {
      const statSpy = vi.spyOn(fs, 'statSync')
      const errorSpy = spyConsole('error')
      const warnSpy = spyConsole('warn')
      const result = resolveMobileStaticRoot({ remoteAccess: false, mobileDist: distDir })
      expect(result).toBeNull()
      // 关态零探测副作用：不 statSync（E5 探测不发生）、无任何日志。
      expect(statSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
      statSpy.mockRestore()
    })

    it('开态未传 mobileDist → null + error 含 --mobile-dist 与 pnpm build / 打包配置指引（E5）', () => {
      const errorSpy = spyConsole('error')
      const result = resolveMobileStaticRoot({ remoteAccess: true })
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      const logged = String(errorSpy.mock.calls[0]?.[0])
      expect(logged).toContain('--mobile-dist')
      expect(logged).toContain('pnpm --filter @taiji/mobile-renderer build')
      expect(logged).toContain('extraResources')
    })

    it('开态目录不存在 → null + error 含缺失路径与 build 指引（E5）', () => {
      const errorSpy = spyConsole('error')
      const missingDir = join(dataDir, 'no-such-dist')
      const result = resolveMobileStaticRoot({ remoteAccess: true, mobileDist: missingDir })
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain(missingDir)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('pnpm --filter @taiji/mobile-renderer build')
    })

    it('开态指向普通文件（非目录）→ null + error（E5 同处置）', () => {
      const errorSpy = spyConsole('error')
      const filePath = join(dataDir, 'not-a-dir')
      fs.writeFileSync(filePath, 'x', 'utf-8')
      const result = resolveMobileStaticRoot({ remoteAccess: true, mobileDist: filePath })
      expect(result).toBeNull()
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it('开态有效目录 → resolve 后的绝对路径（白名单判定基准）', () => {
      const errorSpy = spyConsole('error')
      const result = resolveMobileStaticRoot({ remoteAccess: true, mobileDist: distDir })
      expect(result).toBe(join(distDir))
      expect(errorSpy).not.toHaveBeenCalled()
    })
  })

  // ── 裸 handler 服务行为（无需 ConnectionManager harness）────────────────────

  describe('createMobileStaticHandler（裸 httpServer 挂载）', () => {
    it('不存在路径 → 404 空 body', async () => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest_m2(port, '/assets/no-such-chunk.js')
      expect(res.status).toBe(404)
      expect(res.body).toHaveLength(0)
    })

    it('404 warn 日志纪律：只记 pathname 与 fs error code，不含 dist 绝对路径（code-harden P2）', async () => {
      const warnSpy = spyConsole('warn')
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest_m2(port, '/assets/no-such-chunk.js')
      expect(res.status).toBe(404)
      expect(warnSpy).toHaveBeenCalledTimes(1)
      const logged = String(warnSpy.mock.calls[0]?.[0])
      expect(logged).toContain('/assets/no-such-chunk.js')
      expect(logged).toContain('ENOENT')
      // fs error.message 内嵌的服务端 dist 绝对路径不落日志（模块头「日志只记 basename」纪律）。
      expect(logged).not.toContain(dataDir)
    })

    it.each([
      ['/assets/app.js', 'text/javascript'],
      ['/assets/main.css', 'text/css'],
      ['/assets/font.woff2', 'font/woff2'],
      ['/index.html', 'text/html'],
    ])('Content-Type 映射：%s → %s', async (path, expectedType) => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest_m2(port, path)
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain(expectedType)
    })

    it('映射外扩展名（.svg）→ octet-stream 兜底', async () => {
      const { port, server } = await startStaticServer(distDir)
      openedServers.push(server)
      const res = await rawRequest_m2(port, '/assets/icon.svg')
      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('application/octet-stream')
    })

    // 穿越防护矩阵归属集成测试侧（connection-manager-mobile-static.test.ts 的 E4 it.each，
    // 端到端 400 + 拒绝日志纪律是更强剩余证明），裸 handler 面不重复。
  })
})
});

// ======================================================================
// ← src/transport/__tests__/message-broker-archive.test.ts
// ======================================================================

function makeBroker(archiveService?: Pick<ArchiveRpcPort, 'listArchiveEntries'>) {
  const sent: string[] = []
  const fakeWs = {
    readyState: 1,
    send: (payload: string) => { sent.push(payload) },
  }
  const pool = { clients: new Set([fakeWs]) } as unknown as ClientPool
  const services = {
    sessionService: { listPersistedSessions: vi.fn(() => []) },
    configService: {
      listProviders: vi.fn(() => []),
      isModelsStoreCorrupted: vi.fn(() => false),
      loadSkills: vi.fn(() => []),
      loadAgents: vi.fn(() => []),
      getSkillPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getAgentPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getExtensionPathScopes: vi.fn(() => ({ projectPaths: [], globalPaths: [] })),
      getDefaultModel: vi.fn(() => null),
      getSystemPromptConfig: vi.fn(() => ({ config: null, corrupted: false })),
      getTerminalConfig: vi.fn(() => ({ config: null, corrupted: false })),
    },
    modelService: { aggregateModels: vi.fn(() => []) },
    pluginService: undefined,
    extensionService: undefined,
    projectRoot: '/test',
    appInfo: { appVersion: '0.0.0-test', piVersion: 'unknown' },
    archiveService,
  } as unknown as BrokerServices
  const broker = new ServerMessageBroker(pool, services)
  return { broker, sent, fakeWs }
}


const ARCHIVES = [
  { sessionId: 'a-1', status: 'staging', summary: null },
  { sessionId: 'a-2', status: 'archived', summary: { turns: [] } },
  { sessionId: 'a-3', status: 'archived', summary: { turns: [] } },
] as unknown as ArchiveSummary[]


function archivePort(archives: ArchiveSummary[]): Pick<ArchiveRpcPort, 'listArchiveEntries'> {
  return { listArchiveEntries: () => archives }
}

// wave3 包装：本段原文件顶层语句收进 describe 作用域（顶层 hook 不再外溢到同文件其他来源的用例）
describe('message-broker-archive', () => {
describe('ServerMessageBroker config.sessions 帧 archiveCount（D5 协议变更点）', () => {
  it('broadcastSessionList 帧 payload 携带 archiveCount = 归档条目数（角标随广播即时）', () => {
    const { broker, sent } = makeBroker(archivePort(ARCHIVES))
    broker.broadcastSessionList()
    expect(sent).toHaveLength(1)
    const msg = JSON.parse(sent[0]) as ServerMessage<'config.sessions'>
    expect(msg.type).toBe('config.sessions')
    expect(msg.payload.archiveCount).toBe(3)
    expect(msg.payload.groups).toEqual([])
  })

  it('空归档目录 → archiveCount: 0（值照发——角标 0 隐藏是消费方呈现裁决，D10）', () => {
    const { broker, sent } = makeBroker(archivePort([]))
    broker.broadcastSessionList()
    const msg = JSON.parse(sent[0]) as ServerMessage<'config.sessions'>
    expect(msg.payload.archiveCount).toBe(0)
  })

  it('sendInitialState 首推的 config.sessions 段同携带（同一 buildSessionListMsg 构造）', () => {
    const { broker, sent, fakeWs } = makeBroker(archivePort(ARCHIVES))
    broker.sendInitialState(fakeWs as unknown as import('ws').WebSocket)
    const sessionMsgs = sent
      .map((s) => JSON.parse(s) as ServerMessage<'config.sessions'>)
      .filter((m) => m.type === 'config.sessions')
    expect(sessionMsgs).toHaveLength(1)
    expect(sessionMsgs[0].payload.archiveCount).toBe(3)
  })

  it('archiveService 未注入 → archiveCount 字段缺省（协议 optional，消费方按 0 隐藏角标）', () => {
    const { broker, sent } = makeBroker(undefined)
    broker.broadcastSessionList()
    const msg = JSON.parse(sent[0]) as ServerMessage<'config.sessions'>
    expect('archiveCount' in msg.payload).toBe(false)
  })
})
});
