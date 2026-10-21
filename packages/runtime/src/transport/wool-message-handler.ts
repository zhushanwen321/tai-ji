/**
 * Wool message handler —— 羊毛 provider 宿主编排 RPC（wool-provider 设计 D6）。
 *
 * 两帧（与 handles / switch 分支一一对应）：
 * - wool.getState：拉羊毛域全量运行态快照（family 安装/接入/账号/目录缓存视图；
 *   reply = wool.state，与状态变化广播同名同形——拉为主，广播是失效提示）。
 * - wool.action：触发宿主编排动作（install/detect/status/checkin/refresh/
 *   setAutoCheckin/authorize；payload = WoolActionRequest 信封，动作语义与错误
 *   分级在 wool-manager，handler 只做入口校验 + 转发）。
 *
 * 校验形态：payload 经 wool 域运行时守卫（isWoolFamilyId / WOOL_ACTION_TYPES）收窄，
 * 非法形态回 invalid_payload error envelope（请求级失败通道，不吞不猜）。
 */

import type { WebSocket as WsType } from 'ws'
import { isWoolFamilyId, WOOL_ACTION_TYPES, type ClientMessage, type ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { WoolManager } from '../services/wool-manager.js'

/** Wool handler 的上下文（共享发消息契约 + WoolManager）。 */
export type WoolHandlerContext = MessageHandlerContext & {
  woolManager: WoolManager
}

export class WoolMessageHandler {
  constructor(private ctx: WoolHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单（D1 模式）。 */
  readonly handles: ClientMessageType[] = ['wool.getState', 'wool.action']

  async handleWoolMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'wool.getState': {
        // 纯内存读（wool-manager getSnapshot 零 IO），reply 与广播同名同形。
        this.ctx.reply(ws, msg.id, 'wool.state', { snapshot: this.ctx.woolManager.getSnapshot() })
        return
      }
      case 'wool.action': {
        const { action, family, params } = msg.payload
        if (!isWoolFamilyId(family)) {
          this.ctx.sendError(ws, 'invalid_payload', `unknown wool family: ${String(family)}`, msg.id)
          return
        }
        if (!(WOOL_ACTION_TYPES as readonly string[]).includes(action)) {
          this.ctx.sendError(ws, 'invalid_payload', `unknown wool action: ${String(action)}`, msg.id)
          return
        }
        // 两态信封（ok/error.code+message）原样 reply——结构化错误是设计内领域回执，
        // 不是请求级失败（不占 error envelope 通道）；状态变化经 wool.state 广播推回。
        const reply = await this.ctx.woolManager.runAction({ action, family, params })
        this.ctx.reply(ws, msg.id, 'wool.action', reply)
        return
      }
    }
  }
}
