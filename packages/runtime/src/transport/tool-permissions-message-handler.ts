/**
 * 声明式工具权限域 config.* message handler（config.setToolPermissions，1 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件原样迁移，行为保持）。本域与「总是允许」工具审批语义对应（工具审批实际路径是
 * pi extension_ui_request 流，声明式 toolPermissions 配置覆盖「总是允许」）。
 * 注：自然归属本可并入 config-preferences（同款简单读写转发），但该文件不在本次
 * 重构领地，独立成文件保持域边界。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class ToolPermissionsMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理工具权限域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.setToolPermissions': {
        this.ctx.configService.updateToolPermissions(msg.payload.permissions)
        this.ctx.reply(ws, msg.id, 'config.providerUpdated', { saved: true })
        return true
      }
      default:
        return false
    }
  }
}
