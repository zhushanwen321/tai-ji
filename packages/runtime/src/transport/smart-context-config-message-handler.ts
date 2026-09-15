/**
 * Smart context 配置域 config.* message handler（getSmartContextConfig + 4 个 setter，
 * 5 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。smart-context 特性域（agent 自决上下文压缩，
 * extensions/universal/smart-context）的 runtime 配置端；setter 均 reply 读回
 * getSmartContextConfig 对应键的生效值。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class SmartContextConfigMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理 smart context 配置域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getSmartContextConfig': {
        this.ctx.reply(ws, msg.id, 'config.smartContextConfig', this.ctx.configService.getSmartContextConfig())
        return true
      }
      case 'config.setSmartContextEnabled': {
        this.ctx.configService.setSmartContextEnabled(msg.payload.enabled)
        this.ctx.reply(ws, msg.id, 'config.smartContextEnabled', { enabled: this.ctx.configService.getSmartContextConfig().enabled })
        return true
      }
      case 'config.setSmartContextCompactModel': {
        this.ctx.configService.setSmartContextCompactModel(msg.payload.model)
        this.ctx.reply(ws, msg.id, 'config.smartContextCompactModel', { model: this.ctx.configService.getSmartContextConfig().compactModel })
        return true
      }
      case 'config.setSmartContextThresholds': {
        this.ctx.configService.setSmartContextThresholds(msg.payload.thresholds)
        this.ctx.reply(ws, msg.id, 'config.smartContextThresholds', { thresholds: this.ctx.configService.getSmartContextConfig().reminderThresholds })
        return true
      }
      case 'config.setSmartContextExcludedModels': {
        this.ctx.configService.setSmartContextExcludedModels(msg.payload.models)
        this.ctx.reply(ws, msg.id, 'config.smartContextExcludedModels', { models: this.ctx.configService.getSmartContextConfig().excludedModels })
        return true
      }
      default:
        return false
    }
  }
}
