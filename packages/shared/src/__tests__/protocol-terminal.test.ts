/**
 * terminal 协议契约自洽测试（Phase 1 V1.2）。
 *
 * 验证 protocol.ts 新增的 terminal.* 消息类型与 TerminalConfig 类型可被正确构造与收窄。
 * 纯类型层验证，不涉及运行时（runtime service 在 Phase 2 实现）。
 *
 * 运行：cd packages/shared && npx vitest run --root . src/__tests__/protocol-terminal.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { ClientMessage, ServerMessage, TerminalConfig, TerminalEnvelopeCode } from '../protocol'

describe('terminal 协议契约', () => {
  it('terminal.spawn 作为 ClientMessage 可构造且 type 正确', () => {
    const msg: ClientMessage = {
      type: 'terminal.spawn',
      id: '1',
      payload: { sessionId: 's1', cwd: '/tmp', cols: 80, rows: 24 },
    }
    expect(msg.type).toBe('terminal.spawn')
    expect(msg.payload).toMatchObject({ sessionId: 's1', cols: 80, rows: 24 })
  })

  it('terminal.spawn 的 cwd 可选', () => {
    const msg: ClientMessage = {
      type: 'terminal.spawn',
      id: '2',
      payload: { sessionId: 's2', cols: 120, rows: 40 },
    }
    expect((msg.payload as { cwd?: string }).cwd).toBeUndefined()
  })

  it('terminal.data 广播含 sessionId + data', () => {
    const msg: ServerMessage<'terminal.data'> = {
      type: 'terminal.data',
      id: 'p1',
      payload: { sessionId: 's1', data: 'hello\r\n' },
    }
    expect(msg.payload.sessionId).toBe('s1')
    expect(msg.payload.data).toBe('hello\r\n')
  })

  it('terminal.alive 广播含 sessionId', () => {
    const msg: ServerMessage<'terminal.alive'> = {
      type: 'terminal.alive',
      id: 'p2',
      payload: { sessionId: 's1' },
    }
    expect(msg.payload).toEqual({ sessionId: 's1' })
  })

  it('terminal.exit 广播含 sessionId + exitCode', () => {
    const msg: ServerMessage<'terminal.exit'> = {
      type: 'terminal.exit',
      id: 'p3',
      payload: { sessionId: 's1', exitCode: 0 },
    }
    expect(msg.payload.exitCode).toBe(0)
  })

  it('TerminalConfig 含全部必填字段', () => {
    const cfg: TerminalConfig = {
      version: 1,
      shell: '/bin/zsh',
      shellArgs: ['-l'],
      fontSize: 14,
      fontFamily: '',
      scrollback: 5000,
      cursorStyle: 'block',
      bell: true,
    }
    expect(cfg.scrollback).toBe(5000)
    expect(cfg.cursorStyle).toBe('block')
  })

  it('TerminalConfig shell 空串表示用 fallback', () => {
    const cfg: TerminalConfig = {
      version: 1,
      shell: '',
      shellArgs: [],
      fontSize: 14,
      fontFamily: '',
      scrollback: 1000,
      cursorStyle: 'underline',
      bell: false,
    }
    expect(cfg.shell).toBe('')
  })

  it('config.setTerminalConfig 消息 payload 含 TerminalConfig', () => {
    const cfg: TerminalConfig = {
      version: 1, shell: '/bin/bash', shellArgs: [], fontSize: 14,
      fontFamily: '', scrollback: 5000, cursorStyle: 'block', bell: true,
    }
    const msg: ClientMessage = {
      type: 'config.setTerminalConfig',
      id: '3',
      payload: { config: cfg },
    }
    expect(msg.type).toBe('config.setTerminalConfig')
  })

  it('TerminalEnvelopeCode 覆盖业务码 + 兜底', () => {
    const codes: TerminalEnvelopeCode[] = [
      'spawn_failed', 'not_found', 'resize_failed', 'kill_failed', 'terminal_failed',
    ]
    expect(codes).toHaveLength(5)
  })
})
