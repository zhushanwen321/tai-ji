/**
 * 会话自动重命名配置域 config.* message handler（autoRenameEnabled / renameModel /
 * renameMode 三键 get/set，6 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。会话自动重命名特性域的 runtime 端（独立测试文件
 * settings-message-handler-rename-mode.test.ts 锁定）；set 均 reply 读回生效值
 * （非法值归一在 config-service helper 层）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class RenameConfigMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理重命名配置域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.setAutoRenameEnabled': {
        this.ctx.configService.setAutoRenameEnabled(msg.payload.enabled)
        this.ctx.reply(ws, msg.id, 'config.autoRenameEnabled', { enabled: this.ctx.configService.getAutoRenameEnabled() })
        return true
      }
      case 'config.getAutoRenameEnabled': {
        this.ctx.reply(ws, msg.id, 'config.autoRenameEnabled', { enabled: this.ctx.configService.getAutoRenameEnabled() })
        return true
      }
      case 'config.setRenameModel': {
        this.ctx.configService.setRenameModel(msg.payload.model)
        this.ctx.reply(ws, msg.id, 'config.renameModel', { model: this.ctx.configService.getRenameModel() })
        return true
      }
      case 'config.getRenameModel': {
        this.ctx.reply(ws, msg.id, 'config.renameModel', { model: this.ctx.configService.getRenameModel() })
        return true
      }
      case 'config.setRenameMode': {
        // mode 非法值归一在 helper 层（与 setRenameModel 的归一纪律一致），reply 读回生效值。
        this.ctx.configService.setRenameMode(msg.payload.mode)
        this.ctx.reply(ws, msg.id, 'config.renameMode', { mode: this.ctx.configService.getRenameMode() })
        return true
      }
      case 'config.getRenameMode': {
        this.ctx.reply(ws, msg.id, 'config.renameMode', { mode: this.ctx.configService.getRenameMode() })
        return true
      }
      default:
        return false
    }
  }
}
