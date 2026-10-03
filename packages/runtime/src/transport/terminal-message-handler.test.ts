/**
 * TerminalMessageHandler 单元测试（terminal-multi-instance u1）。
 *
 * 覆盖验收条款：缺 terminalId 的 write / resize / kill / attach 四帧各自被拒（T6 语义；
 * 独立码 terminal_id_required，≠ unknown_terminal_id——后者是 renderer 回收幽灵条目的唯一判据）；
 * spawn 缺编号是合法新建形态（走新建路径，不拒）；terminal.list 路由 + ack 携实例清单；
 * 交叉校验独立码经既有错误通道透传（不触发回收的码不被 handler 改写）。
 *
 * 运行：cd packages/runtime && npx vitest run src/transport/terminal-message-handler.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { TerminalMessageHandler, type TerminalHandlerContext } from './terminal-message-handler.js'
import type { ITerminalService } from '../services/ports/terminal-service.js'
import type { ClientMessage } from '@taiji/shared'

function mockWs() {
  return { send: vi.fn(), readyState: 1 } as never
}

function mockService(overrides?: Partial<ITerminalService>): ITerminalService {
  const base: ITerminalService = {
    spawn: async (_sid: string, _cwd: string | undefined, _cols: number, _rows: number, terminalId?: string) =>
      terminalId ?? 'term:s1:1',
    write: () => {},
    resize: () => {},
    kill: () => {},
    attach: () => {},
    listInstances: () => [],
    destroySessionPties: () => {},
    destroyAllPties: () => {},
    ...overrides,
  }
  // 包一层 vi.fn 便于断言（保留 ITerminalService 类型的形参/返回）
  return {
    ...base,
    spawn: vi.fn(base.spawn),
    write: vi.fn(base.write),
    resize: vi.fn(base.resize),
    kill: vi.fn(base.kill),
    attach: vi.fn(base.attach),
    listInstances: vi.fn(base.listInstances),
  }
}

function mockContext(terminalService: ITerminalService): TerminalHandlerContext {
  return {
    send: vi.fn(),
    sendError: vi.fn(),
    reply: vi.fn(),
    terminalService,
  }
}

function msg(type: string, payload: Record<string, unknown> = {}, id = 'msg-1'): ClientMessage {
  return { type, payload, id } as unknown as ClientMessage
}

describe('TerminalMessageHandler.handles', () => {
  it('认领 terminal.list（新增查询帧）与五个既有请求帧', () => {
    const handler = new TerminalMessageHandler(mockContext(mockService()))
    expect(handler.handles).toEqual([
      'terminal.spawn',
      'terminal.write',
      'terminal.resize',
      'terminal.kill',
      'terminal.attach',
      'terminal.list',
    ])
  })
})

describe('TerminalMessageHandler 缺编号防御（write/resize/kill/attach 逐帧拒）', () => {
  const missingFrames: Array<{ type: string; payload: Record<string, unknown> }> = [
    { type: 'terminal.write', payload: { sessionId: 's1', data: 'x' } },
    { type: 'terminal.resize', payload: { sessionId: 's1', cols: 80, rows: 24 } },
    { type: 'terminal.kill', payload: { sessionId: 's1' } },
    { type: 'terminal.attach', payload: { sessionId: 's1' } },
  ]

  for (const { type, payload } of missingFrames) {
    it(`${type} 缺 terminalId → sendError（terminal_id_required，独立于否定回执），不调 service`, async () => {
      const service = mockService()
      const ctx = mockContext(service)
      const handler = new TerminalMessageHandler(ctx)
      const ws = mockWs()

      await handler.handleTerminalMessage(msg(type, payload), ws)

      expect(ctx.sendError).toHaveBeenCalledTimes(1)
      expect(ctx.sendError).toHaveBeenCalledWith(
        ws,
        'terminal_id_required',
        expect.stringContaining('缺少 terminalId'),
        'msg-1',
      )
      // 缺编号不是「注册成员资格的否定回执」——不得复用 unknown_terminal_id（后者是 renderer
      // 关闭沿三腿回收的唯一判据，设计 §3.3）
      expect(ctx.sendError).not.toHaveBeenCalledWith(ws, 'unknown_terminal_id', expect.any(String), 'msg-1')
      expect(ctx.reply).not.toHaveBeenCalled()
    })
  }

  it('空串 terminalId 同样被拒（非 undefined 但无归属）', async () => {
    const ctx = mockContext(mockService())
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.write', { sessionId: 's1', terminalId: '', data: 'x' }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(
      ws,
      'terminal_id_required',
      expect.any(String),
      'msg-1',
    )
    expect(ctx.sendError).not.toHaveBeenCalledWith(ws, 'unknown_terminal_id', expect.any(String), 'msg-1')
  })

  it('带 terminalId 的四帧正常转发', async () => {
    const service = mockService()
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.write', { sessionId: 's1', terminalId: 'term:s1:1', data: 'ls' }, 'w'), ws)
    await handler.handleTerminalMessage(msg('terminal.resize', { sessionId: 's1', terminalId: 'term:s1:1', cols: 1, rows: 2 }, 'r'), ws)
    await handler.handleTerminalMessage(msg('terminal.kill', { sessionId: 's1', terminalId: 'term:s1:1' }, 'k'), ws)
    await handler.handleTerminalMessage(msg('terminal.attach', { sessionId: 's1', terminalId: 'term:s1:1' }, 'a'), ws)

    expect(service.write).toHaveBeenCalledWith('s1', 'term:s1:1', 'ls')
    expect(service.resize).toHaveBeenCalledWith('s1', 'term:s1:1', 1, 2)
    expect(service.kill).toHaveBeenCalledWith('s1', 'term:s1:1')
    expect(service.attach).toHaveBeenCalledWith('s1', 'term:s1:1')
    expect(ctx.sendError).not.toHaveBeenCalled()
  })
})

describe('TerminalMessageHandler terminal.spawn 双形态', () => {
  it('缺 terminalId = 合法新建：ack 回传分配的编号', async () => {
    const service = mockService({ spawn: vi.fn(async () => 'term:s1:1') })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.spawn', { sessionId: 's1', cols: 80, rows: 24 }), ws)

    expect(service.spawn).toHaveBeenCalledWith('s1', undefined, 80, 24, undefined)
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { terminalId: 'term:s1:1' })
    expect(ctx.sendError).not.toHaveBeenCalled()
  })

  it('带 terminalId = 指定形态：透传并 ack 原编号', async () => {
    const service = mockService({ spawn: vi.fn(async (_sid, _cwd, _cols, _rows, id?: string) => id ?? 'x') })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.spawn', { sessionId: 's1', terminalId: 'term:s1:2', cwd: '/tmp', cols: 80, rows: 24 }),
      ws,
    )

    expect(service.spawn).toHaveBeenCalledWith('s1', '/tmp', 80, 24, 'term:s1:2')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { terminalId: 'term:s1:2' })
  })

  it('spawn 失败透传 spawn_failed', async () => {
    const service = mockService({
      spawn: vi.fn(async () => {
        throw Object.assign(new Error('shell missing'), { code: 'spawn_failed' })
      }),
    })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.spawn', { sessionId: 's1', cols: 80, rows: 24 }), ws)

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'spawn_failed', 'shell missing', 'msg-1')
  })
})

describe('TerminalMessageHandler 错误码透传（交叉校验独立码不被改写）', () => {
  it('service 抛 terminal_id_session_mismatch → 原码透传', async () => {
    const service = mockService({
      write: vi.fn(() => {
        throw Object.assign(new Error('terminalId session segment mismatch'), { code: 'terminal_id_session_mismatch' })
      }),
    })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.write', { sessionId: 's1', terminalId: 'term:s2:1', data: 'x' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'terminal_id_session_mismatch', expect.any(String), 'msg-1')
  })

  it('service 抛 unknown_terminal_id → 原码透传', async () => {
    const service = mockService({
      kill: vi.fn(() => {
        throw Object.assign(new Error('no such instance'), { code: 'unknown_terminal_id' })
      }),
    })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(
      msg('terminal.kill', { sessionId: 's1', terminalId: 'term:s1:9' }),
      ws,
    )

    expect(ctx.sendError).toHaveBeenCalledWith(ws, 'unknown_terminal_id', 'no such instance', 'msg-1')
  })
})

describe('TerminalMessageHandler terminal.list', () => {
  it('ack 携被查询会话实例清单', async () => {
    const instances = [
      { terminalId: 'term:s1:1', alive: true },
      { terminalId: 'term:s1:2', alive: true },
    ]
    const service = mockService({ listInstances: vi.fn(() => instances) })
    const ctx = mockContext(service)
    const handler = new TerminalMessageHandler(ctx)
    const ws = mockWs()

    await handler.handleTerminalMessage(msg('terminal.list', { sessionId: 's1' }), ws)

    expect(service.listInstances).toHaveBeenCalledWith('s1')
    expect(ctx.reply).toHaveBeenCalledWith(ws, 'msg-1', 'terminal.ack', { instances })
  })
})
