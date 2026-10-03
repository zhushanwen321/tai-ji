/**
 * Terminal message handler —— 路由 terminal.* 消息（Phase 2；多实例改造）。
 *
 * 结构对称 worktree-message-handler：handles 清单 + switch + 领域逻辑。
 *
 * 路由：
 * - terminal.spawn  → terminalService.spawn（双形态）→ ack 携分配/复用的 terminalId
 * - terminal.write  → terminalService.write  → ack
 * - terminal.resize → terminalService.resize → ack
 * - terminal.kill   → terminalService.kill   → ack（结果由 terminal.exit 广播）
 * - terminal.attach → terminalService.attach → ack
 * - terminal.list   → terminalService.listInstances → ack 携实例清单（TerminalInstanceSummary[]）
 *
 * 缺编号防御（设计 §3.3「网络消息」）：对既有实例操作的帧（write / resize / kill / attach）
 * 缺 terminalId = 畸形请求，逐帧拒绝（fail-fast，不静默）；**唯一豁免 = spawn 新建形态**
 *（缺编号即「新建」语义，不是旧格式残缺）。
 *
 * 错误：TerminalService 用扁平错误模式（code 为 TerminalErrorCode）。
 * spawn 失败透传 spawn_failed；未知实例 = unknown_terminal_id；会话段不一致 =
 * terminal_id_session_mismatch（两码互斥，后者不触发 renderer 的幽灵回收）。
 *
 * 注：terminal.data/exit/alive/writeFailed 是 service 层主动广播（不经 handler），handler 只处理 client→server 请求。
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
    'terminal.list',
  ]

  async handleTerminalMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'terminal.spawn': {
        // 双形态：不带 terminalId = 新建（runtime 分配并经 ack 回传）；带 = 指定（存活幂等 / 不存在报错）
        const { sessionId, terminalId, cwd, cols, rows } = msg.payload
        try {
          const assigned = await this.ctx.terminalService.spawn(sessionId, cwd, cols, rows, terminalId)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', { terminalId: assigned })
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.write': {
        const { sessionId, terminalId, data } = msg.payload
        if (this.rejectIfMissingTerminalId(ws, msg.id, 'terminal.write', terminalId)) return
        try {
          this.ctx.terminalService.write(sessionId, terminalId, data)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.resize': {
        const { sessionId, terminalId, cols, rows } = msg.payload
        if (this.rejectIfMissingTerminalId(ws, msg.id, 'terminal.resize', terminalId)) return
        try {
          this.ctx.terminalService.resize(sessionId, terminalId, cols, rows)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.kill': {
        const { sessionId, terminalId } = msg.payload
        if (this.rejectIfMissingTerminalId(ws, msg.id, 'terminal.kill', terminalId)) return
        try {
          this.ctx.terminalService.kill(sessionId, terminalId)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.attach': {
        const { sessionId, terminalId } = msg.payload
        if (this.rejectIfMissingTerminalId(ws, msg.id, 'terminal.attach', terminalId)) return
        try {
          this.ctx.terminalService.attach(sessionId, terminalId)
          return this.ctx.reply(ws, msg.id, 'terminal.ack', {})
        } catch (e) {
          return this.sendTerminalError(ws, msg.id, e)
        }
      }
      case 'terminal.list': {
        // 查询帧无 terminalId（按会话查），范围 = 本次查询所属会话
        const { sessionId } = msg.payload
        return this.ctx.reply(ws, msg.id, 'terminal.ack', {
          instances: this.ctx.terminalService.listInstances(sessionId),
        })
      }
    }
  }

  /**
   * 缺编号防御：对既有实例操作的帧缺 terminalId 时发明确错误并返回 true（调用方直接 return）。
   *
   * 错误码取 `unknown_terminal_id`：缺编号的请求无法归属任何注册表成员（语义 = 「无此实例」的
   * 否定回执的同族）；不取 `terminal_id_session_mismatch`（那码专属「会话段与请求会话不一致」
   * 的交叉校验拒绝，语义不同）。
   */
  private rejectIfMissingTerminalId(
    ws: WsType,
    id: string | undefined,
    frame: string,
    terminalId: string | undefined,
  ): boolean {
    if (typeof terminalId === 'string' && terminalId !== '') return false
    this.ctx.sendError(ws, 'unknown_terminal_id', `${frame} 缺少 terminalId（既有实例操作帧必填；新建终端请用不带编号的 terminal.spawn）`, id)
    return true
  }

  /**
   * 统一 terminal 错误回复。
   * - 有 code（spawn_failed / unknown_terminal_id / terminal_id_session_mismatch / ...）→ 透传作 error.code
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
