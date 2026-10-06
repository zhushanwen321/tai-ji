/**
 * Subagent 域 message handler（subagent.setModel，subagent-model-switch §7.1 入口层）。
 *
 * 处理形态照 model-message-handler.ts 现役形态（command 类型化 RPC + 回执消费）：
 * 请求 → 宿主 setModel（SubagentModelSwitchGateway，宿主编排由 U2/U5 实装——本单元
 * 面向端口编程 + mock 注入验收回执范式，真实链路联调挂 U2/U5 commit 门补跑）→ 应答
 * → 前端以回执写状态（禁乐观写，useModel.ts 现役范式）。
 *
 * 错误按设计 §5.2 分型：gateway 分型错误（e.code 透传）经本 handler catch →
 * ctx.sendError 显式带 sessionId（gateway.resolveSessionId 解析——subagent.setModel
 * payload 无 sessionId 字段，而会话隔离红线要求错误信封必带；全局 catch 只透传
 * payload.sessionId，覆盖不了本域，故 catch 收口在本 handler）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { SubagentModelSwitchGateway } from '../interfaces.js'
import { toErrorMessage } from '../utils/errors.js'

/** Subagent handler 的上下文（共享发消息契约 + 宿主模型切换端口）。 */
export interface SubagentHandlerContext extends MessageHandlerContext { // oe-exempt:20261006:framework:消息 handler 上下文契约（组合根注入端口，单实现常态）
  /**
   * 宿主模型切换端口（生产组合根注入，U2/U5 接线）。可选：未注入时 case 内回
   * subagent_model_switch_unwired 可操作错误（不落 unknown_type——前端入口已在，
   * 错误必须指向恢复动作而非路由失败）。
   */
  modelSwitchGateway?: SubagentModelSwitchGateway
}

export class SubagentMessageHandler {
  constructor(private ctx: SubagentHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['subagent.setModel']

  async handleSubagentMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'subagent.setModel':
        return this.handleSetModel(msg, ws)
    }
  }

  /**
   * subagent.setModel：目标二选一守卫 → 宿主 setModel → reply 回执（应答三形态
   * 原样透传——应答值是唯一权威，handler 不改写）；失败经 catch → sendError 带
   * sessionId。回执写状态在前端（禁乐观写），handler 不广播显示态。
   */
  private async handleSetModel(
    msg: Extract<ClientMessage, { type: 'subagent.setModel' }>,
    ws: WsType,
  ): Promise<void> {
    const gateway = this.ctx.modelSwitchGateway
    if (!gateway) {
      // U2/U5 未接线（组合根未注入 gateway）：可操作错误指向接线单元，不静默。
      this.ctx.sendError(
        ws,
        'subagent_model_switch_unwired',
        'subagent.setModel 尚未接线（宿主模型切换编排未注入）——等待 U2/U5 宿主编排单元合入后由组合根注入 SubagentModelSwitchGateway',
        msg.id,
      )
      return
    }
    const { recordId, runId } = msg.payload
    // 目标二选一（wire 契约：recordId 与 runId 二选一，双缺/双给均为畸形帧）
    if ((recordId === undefined) === (runId === undefined)) {
      const malformedTarget = recordId !== undefined ? { recordId } : { runId }
      const malformedSessionId = gateway.resolveSessionId(malformedTarget)
      this.ctx.sendError(
        ws,
        'invalid_payload',
        'subagent.setModel 需要 recordId（chat 域）或 runId（workflow run 级）二选一',
        msg.id,
        malformedSessionId !== undefined ? { sessionId: malformedSessionId } : undefined,
      )
      return
    }
    try {
      const reply = await gateway.setModel(msg.payload)
      this.ctx.reply(ws, msg.id, 'subagent.modelSet', reply)
    } catch (e) {
      // §5.2 分型错误透传（canonical ref 非法 / 凭据缺失 / 回读失败等，code 由宿主
      // 编排定形）；未知错误回退域内 code。sessionId 经 gateway 解析（会话隔离红线）。
      const code = (e as Error & { code?: string }).code ?? 'subagent_model_switch_failed'
      const sessionId = gateway.resolveSessionId(recordId !== undefined ? { recordId } : { runId })
      this.ctx.sendError(ws, code, toErrorMessage(e), msg.id, sessionId !== undefined ? { sessionId } : undefined)
    }
  }
}
