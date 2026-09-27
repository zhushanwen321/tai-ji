/**
 * Usage message handler — 用量统计 RPC 处理。
 *
 * 处理 1 个 RPC：
 * - usage.getStats：拉取用量统计数据（session JSONL 扫描聚合）
 */

import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { UsageStatsService } from '../services/usage/usage-stats-service.js'
import { toErrorMessage } from '../utils/errors.js'

/** Usage handler 的上下文（共享发消息契约 + UsageStatsService） */
export interface UsageHandlerContext extends MessageHandlerContext {
  usageStatsService: UsageStatsService
}

export class UsageMessageHandler {
  constructor(private ctx: UsageHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['usage.getStats']

  async handleUsageMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'usage.getStats': {
        try {
          const result = await this.ctx.usageStatsService.getStats()
          this.ctx.reply(ws, msg.id, 'usage.getStats:result', result)
        } catch (e) {
          this.ctx.sendError(ws, 'usage_scan_failed', toErrorMessage(e), msg.id, {
            hint: '扫描失败，可重试；详情见 runtime 日志',
          })
        }
        return
      }
    }
  }
}
