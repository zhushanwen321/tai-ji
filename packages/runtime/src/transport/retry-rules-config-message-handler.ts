/**
 * 重试规则域 config.* message handler（config.get/setRetryRules，2 条 case）。
 *
 * 先例同款 class + handle() switch 形态（retry-config-message-handler.ts /
 * network-proxy-config-message-handler.ts 同款；不匹配返回 false 由
 * SettingsMessageHandler 继续路由）。subagent-observability §3.3.12 特性域的 runtime 端：
 * 服务函数 = services/remote-config/remote-retry-rules.ts（ext-config 唯一写方）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

import { getBuiltinRetryRules, readRetryRulesExtConfig, setRetryRulesCustom } from '../services/remote-config/remote-retry-rules.js'

export class RetryRulesConfigMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 读合并视图：内置层（基线 ⊕ 远程，source 标注）+ 用户盘上态（ext-config customRules 段）。 */
  private readView() {
    return { builtinRules: getBuiltinRetryRules(), customRules: readRetryRulesExtConfig().customRules }
  }

  /** 处理重试规则域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getRetryRules': {
        // 文件缺失/坏形状在读侧回落空集（warn 留痕），不抛错。
        const view = this.readView()
        this.ctx.reply(ws, msg.id, 'config.retryRules', view)
        return true
      }
      case 'config.setRetryRules': {
        // 写用户层（校验失败按 D10 错误信封回复，不落盘不广播）；成功后 reply + 广播读回
        // 终态（写侧确定性变换：source 归一 custom + effectiveRules 合并持久段重算——消费侧
        // 以服务端终态校准，network-proxy 同款）。
        const { customRules } = msg.payload
        const result = setRetryRulesCustom(customRules)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_retry_rules_failed', result.errors.join('；'), msg.id)
          return true
        }
        const view = this.readView()
        this.ctx.reply(ws, msg.id, 'config.retryRules', view)
        this.ctx.broadcast({
          type: 'config.retryRules',
          id: this.ctx.nextPushId(),
          payload: view,
        })
        return true
      }
      default:
        return false
    }
  }
}
