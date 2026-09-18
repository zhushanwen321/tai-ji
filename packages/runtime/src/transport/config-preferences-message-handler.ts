/**
 * Workspace 偏好组 config.* message handler（worktree 目录/脚本/超时 + 默认基分支，
 * 10 条简单读写转发 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * 「Extracted from RuntimeServer to reduce file size」；本组 case 全部仅消费
 * ctx.configService + ctx.reply，无广播/sendError 耦合，迁移零行为变化）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class ConfigPreferencesMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理偏好组消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.setWorktreeRootDir': {
        this.ctx.configService.setWorktreeRootDir(msg.payload.dir)
        this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })
        return true
      }
      case 'config.getWorktreeRootDir': {
        this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })
        return true
      }
      case 'config.setSetupScript': {
        this.ctx.configService.setSetupScript(msg.payload.script)
        this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })
        return true
      }
      case 'config.getSetupScript': {
        this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })
        return true
      }
      case 'config.setBareSetupScript': {
        this.ctx.configService.setBareSetupScript(msg.payload.script)
        this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })
        return true
      }
      case 'config.getBareSetupScript': {
        this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })
        return true
      }
      case 'config.setTimeout': {
        this.ctx.configService.setTimeout(msg.payload.timeout)
        this.ctx.reply(ws, msg.id, 'config.worktreeTimeout', { timeout: this.ctx.configService.getTimeout() })
        return true
      }
      case 'config.getTimeout': {
        this.ctx.reply(ws, msg.id, 'config.worktreeTimeout', { timeout: this.ctx.configService.getTimeout() })
        return true
      }
      case 'config.setDefaultBaseBranch': {
        this.ctx.configService.setDefaultBaseBranch(msg.payload.baseBranch)
        this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })
        return true
      }
      case 'config.getDefaultBaseBranch': {
        this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })
        return true
      }
      default:
        return false
    }
  }
}
