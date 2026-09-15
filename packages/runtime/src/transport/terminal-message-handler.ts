/**
 * Terminal message handler —— 路由 terminal.* 消息（Phase 2）。
 *
 * 结构对称 worktree-message-handler：handles 清单 + switch + 领域逻辑。
 *
 * 路由：
 * - terminal.spawn  → terminalService.spawn  → ack（PTY 就绪由 terminal.alive 广播通知）
 * - terminal.write  → terminalService.write  → ack
 * - terminal.resize → terminalService.resize → ack
 * - terminal.kill   → terminalService.kill   → ack（结果由 terminal.exit 广播）
 * - terminal.attach → terminalService.attach → ack
 *
 * 错误：TerminalService 用扁平错误模式（code 为 TerminalErrorCode）。
 * spawn 失败透传 spawn_failed；其余操作对不存在 sid 是 no-op（service 层已处理，不抛错）。
 *
 * 注：terminal.data/exit/alive 是 service 层主动广播（不经 handler），handler 只处理 client→server 请求。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType, TerminalEnvelopeCode } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { ITerminalService } from '../services/ports/terminal-service.js'

/** Terminal handler 依赖的 context（messaging + terminalService）。 */
export interface TerminalHandlerContext extends MessageHandlerContext {
  terminalService: ITerminalService
}

/** 具有 code 字段的业务错误形状（TerminalService 抛出的扁平错误）。 */
interface CodedError {
  code?: string
  message: string
}

export class TerminalMessageHandler {
  constructor(private ctx: TerminalHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'terminal.spawn',
    'terminal.write',
    'terminal.resize',
    'terminal.kill',
    'terminal.attach',
  ]

  async handleTerminalMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'terminal.spawn': {
        const { sessionId, cwd, cols, rows } = msg.payload
        try {
          await this.ctx.terminalService.spawn(sessionId, cwd, cols, rows)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.write': {
        const { sessionId, data } = msg.payload
        try {
          this.ctx.terminalService.write(sessionId, data)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.resize': {
        const { sessionId, cols, rows } = msg.payload
        try {
          this.ctx.terminalService.resize(sessionId, cols, rows)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.kill': {
        const { sessionId } = msg.payload
        try {
          this.ctx.terminalService.kill(sessionId)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.attach': {
        const { sessionId } = msg.payload
        try {
          this.ctx.terminalService.attach(sessionId)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
    }
  }

  /**
   * 统一 terminal 错误回复。
   * - 有 code（spawn_failed / not_found / ...）→ 透传作 error.code
   * - 无 code → 归为 'terminal_failed'
   */
  private sendTerminalError(ws: WsType, id: string | undefined, e: unknown): void {
    const err = e as CodedError & Error
    const code: TerminalEnvelopeCode = (err && typeof err.code === 'string')
      ? (err.code as TerminalEnvelopeCode)
      : 'terminal_failed'
    const message = (err && err.message) ? err.message : 'terminal 操作失败'
    this.ctx.sendError(ws, code, message, id)
  }
}
