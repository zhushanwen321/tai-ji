/**
 * 终端多实例共享契约测试（terminal-multi-instance 设计 §3.3「网络消息」，u-foundation）。
 *
 * 覆盖：
 * - 帧清单逐帧对齐（client→server: spawn/write/resize/kill/attach + list；
 *   server→client: data/exit/alive/writeFailed + ack 回包）
 * - 全部业务帧带 terminalId；spawn 双形态（新建缺编号合法 / 指定带编号）
 * - 缺编号防御帧集合 = {write, resize, kill, attach}（类型上不可构造合法载荷，见 @ts-expect-error，
 *   由 `pnpm -C packages/shared typecheck`（tsc --noEmit）实检）
 * - spawn ack 回包携分配/复用的 terminalId；list ack 携实例清单；ack 无 terminalId 路由字段
 * - 两个路由错误码互斥；TerminalInstanceSummary 必填字段齐全
 *
 * 运行：pnpm -C packages/shared test
 */
import { describe, it, expect } from 'vitest'
import type {
  ClientMessage,
  ClientMessageMap,
  ClientMessageType,
  ServerMessageMap,
  ServerMessageType,
  TerminalInstanceSummary,
  TerminalRoutingErrorCode,
} from '../protocol'

describe('terminal 多实例帧清单（设计 §3.3）', () => {
  it('client→server 请求帧清单 = spawn/write/resize/kill/attach + list', () => {
    const frames: ClientMessageType[] = [
      'terminal.spawn', 'terminal.write', 'terminal.resize', 'terminal.kill', 'terminal.attach', 'terminal.list',
    ]
    expect(frames).toHaveLength(6)
    expect(new Set(frames).size).toBe(6)
  })

  it('server→client 帧清单 = data/exit/alive/writeFailed + ack', () => {
    const frames: ServerMessageType[] = [
      'terminal.data', 'terminal.exit', 'terminal.alive', 'terminal.writeFailed', 'terminal.ack',
    ]
    expect(frames).toHaveLength(5)
    expect(new Set(frames).size).toBe(5)
  })

  it('client→server 对既有实例操作的帧均带 terminalId', () => {
    const write: ClientMessageMap['terminal.write'] = { sessionId: 's1', terminalId: 'term:s1:1', data: 'ls\n' }
    const resize: ClientMessageMap['terminal.resize'] = { sessionId: 's1', terminalId: 'term:s1:1', cols: 80, rows: 24 }
    const kill: ClientMessageMap['terminal.kill'] = { sessionId: 's1', terminalId: 'term:s1:1' }
    const attach: ClientMessageMap['terminal.attach'] = { sessionId: 's1', terminalId: 'term:s1:1' }
    expect([write.terminalId, resize.terminalId, kill.terminalId, attach.terminalId]).toEqual([
      'term:s1:1', 'term:s1:1', 'term:s1:1', 'term:s1:1',
    ])
  })

  it('server→client 四个业务帧均带 terminalId', () => {
    const data: ServerMessageMap['terminal.data'] = { sessionId: 's1', terminalId: 'term:s1:2', data: 'x' }
    const exit: ServerMessageMap['terminal.exit'] = { sessionId: 's1', terminalId: 'term:s1:2', exitCode: 1 }
    const alive: ServerMessageMap['terminal.alive'] = { sessionId: 's1', terminalId: 'term:s1:2' }
    const failed: ServerMessageMap['terminal.writeFailed'] = { sessionId: 's1', terminalId: 'term:s1:2', message: 'gone' }
    expect([data.terminalId, exit.terminalId, alive.terminalId, failed.terminalId]).toEqual([
      'term:s1:2', 'term:s1:2', 'term:s1:2', 'term:s1:2',
    ])
  })

  it('terminal.spawn 新建形态不带 terminalId（编号由 runtime 分配、经 ack 回传）', () => {
    const msg: ClientMessage = {
      type: 'terminal.spawn',
      id: '1',
      payload: { sessionId: 's1', cols: 80, rows: 24 },
    }
    expect(msg.type).toBe('terminal.spawn')
    expect(msg.payload).not.toHaveProperty('terminalId')
  })

  it('terminal.spawn 指定形态带 terminalId（幂等复用/重连）', () => {
    const spawn: ClientMessageMap['terminal.spawn'] = {
      sessionId: 's1', terminalId: 'term:s1:3', cols: 80, rows: 24,
    }
    expect(spawn.terminalId).toBe('term:s1:3')
  })

  it('缺编号的既有实例操作帧类型上不可构造合法载荷（防御帧集合 = write/resize/kill/attach）', () => {
    // @ts-expect-error terminal.write 缺 terminalId
    const write: ClientMessageMap['terminal.write'] = { sessionId: 's1', data: 'x' }
    // @ts-expect-error terminal.resize 缺 terminalId
    const resize: ClientMessageMap['terminal.resize'] = { sessionId: 's1', cols: 80, rows: 24 }
    // @ts-expect-error terminal.kill 缺 terminalId
    const kill: ClientMessageMap['terminal.kill'] = { sessionId: 's1' }
    // @ts-expect-error terminal.attach 缺 terminalId
    const attach: ClientMessageMap['terminal.attach'] = { sessionId: 's1' }
    // spawn 新建形态显式豁免：缺编号合法（不是旧格式残缺）
    const spawn: ClientMessageMap['terminal.spawn'] = { sessionId: 's1', cols: 80, rows: 24 }
    // terminal.list 是会话级查询帧，不带实例编号
    const list: ClientMessageMap['terminal.list'] = { sessionId: 's1' }
    expect([write, resize, kill, attach, spawn, list].every((p) => p.sessionId === 's1')).toBe(true)
  })
})

describe('terminal ack 回包与实例清单（设计 §3.3）', () => {
  it('terminal.ack 无 terminalId 路由字段（按 msg.id 关联请求），但 spawn 回包携 terminalId', () => {
    const ack: ServerMessageMap['terminal.ack'] = { terminalId: 'term:s1:1' }
    expect(ack.terminalId).toBe('term:s1:1')
    expect(ack).not.toHaveProperty('sessionId')
  })

  it('terminal.list 的 ack 携被查询会话的实例清单', () => {
    const instances: TerminalInstanceSummary[] = [
      { terminalId: 'term:s1:1', alive: true },
      { terminalId: 'term:s1:2', alive: true },
    ]
    const ack: ServerMessageMap['terminal.ack'] = { instances }
    expect(ack.instances).toHaveLength(2)
    expect(ack.instances?.[0]?.terminalId).toBe('term:s1:1')
  })

  it('TerminalInstanceSummary 必填字段齐全（terminalId + alive）', () => {
    const summary: TerminalInstanceSummary = { terminalId: 'term:s1:1', alive: true }
    expect(summary.terminalId).toBe('term:s1:1')
    expect(summary.alive).toBe(true)
    // @ts-expect-error TerminalInstanceSummary 缺 alive 不可构造
    const missingAlive: TerminalInstanceSummary = { terminalId: 'term:s1:1' }
    expect(missingAlive.terminalId).toBe('term:s1:1')
  })
})

describe('terminal 路由错误码（设计 §3.3）', () => {
  it('两个路由错误码互斥（值不等、集合恰两码）', () => {
    const unknown: TerminalRoutingErrorCode = 'unknown_terminal_id'
    const mismatch: TerminalRoutingErrorCode = 'terminal_id_session_mismatch'
    expect(unknown).not.toBe(mismatch)
    const all: TerminalRoutingErrorCode[] = ['unknown_terminal_id', 'terminal_id_session_mismatch']
    expect(new Set(all).size).toBe(2)
  })
})
