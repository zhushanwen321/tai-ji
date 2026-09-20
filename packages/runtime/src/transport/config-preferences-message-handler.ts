/**
 * Workspace 偏好组 config.* message handler（worktree 目录/脚本/超时 + 默认基分支
 * + UI 语言，11 条简单读写转发 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * 「Extracted from RuntimeServer to reduce file size」；本组 case 全部仅消费
 * ctx.configService + ctx.reply，迁移零行为变化）。
 *
 * [M4/RT-7#1] 写 case 的落盘失败（config.json 损坏降级态拒绝覆写 / IO 失败）按 D10
 * 错误信封回复（code 透传 SaveAppConfigResult.code），不 reply 成功——对齐
 * system-prompt-terminal-message-handler 的 set 失败形态。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import { writeUiPreferences } from '../services/ui-preferences-helper.js'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class ConfigPreferencesMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理偏好组消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.setWorktreeRootDir': {
        const result = this.ctx.configService.setWorktreeRootDir(msg.payload.dir)
        if (!this.replySaveResult(ws, msg.id, result)) return true
        this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })
        return true
      }
      case 'config.getWorktreeRootDir': {
        this.ctx.reply(ws, msg.id, 'config.worktreeRootDir', { dir: this.ctx.configService.getWorktreeRootDir() })
        return true
      }
      case 'config.setSetupScript': {
        const result = this.ctx.configService.setSetupScript(msg.payload.script)
        if (!this.replySaveResult(ws, msg.id, result)) return true
        this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })
        return true
      }
      case 'config.getSetupScript': {
        this.ctx.reply(ws, msg.id, 'config.setupScript', { script: this.ctx.configService.getSetupScript() })
        return true
      }
      case 'config.setBareSetupScript': {
        const result = this.ctx.configService.setBareSetupScript(msg.payload.script)
        if (!this.replySaveResult(ws, msg.id, result)) return true
        this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })
        return true
      }
      case 'config.getBareSetupScript': {
        this.ctx.reply(ws, msg.id, 'config.bareSetupScript', { script: this.ctx.configService.getBareSetupScript() })
        return true
      }
      case 'config.setTimeout': {
        const result = this.ctx.configService.setTimeout(msg.payload.timeout)
        if (!this.replySaveResult(ws, msg.id, result)) return true
        this.ctx.reply(ws, msg.id, 'config.worktreeTimeout', { timeout: this.ctx.configService.getTimeout() })
        return true
      }
      case 'config.getTimeout': {
        this.ctx.reply(ws, msg.id, 'config.worktreeTimeout', { timeout: this.ctx.configService.getTimeout() })
        return true
      }
      case 'config.setDefaultBaseBranch': {
        const result = this.ctx.configService.setDefaultBaseBranch(msg.payload.baseBranch)
        if (!this.replySaveResult(ws, msg.id, result)) return true
        this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })
        return true
      }
      case 'config.getDefaultBaseBranch': {
        this.ctx.reply(ws, msg.id, 'config.defaultBaseBranch', { baseBranch: this.ctx.configService.getDefaultBaseBranch() })
        return true
      }
      // u-locale-channel：写 <dataDir>/ui-preferences.json（tmp+rename 原子写，extension 侧只读热生效）。
      // 无读回 RPC，成功只回 ack（config.uiLocaleSet）；写盘失败经 replySaveResult 走 D10 错误信封。
      case 'config.setUiLocale': {
        const result = writeUiPreferences(this.ctx.configService.getConfigDir(), msg.payload.locale)
        if (!this.replySaveResult(ws, msg.id, result)) return true
        this.ctx.reply(ws, msg.id, 'config.uiLocaleSet', {} as Record<string, never>)
        return true
      }
      default:
        return false
    }
  }

  /**
   * set case 的落盘结果回包：成功返回 true（调用方继续 reply 读回值）；失败发 D10
   * 错误信封并返回 false（调用方直接 return true 结束本 case，不 reply 成功）。
   */
  private replySaveResult(ws: WsType, msgId: string | undefined, result: { ok: boolean; code?: string; error?: string }): boolean {
    if (result.ok) return true
    this.ctx.sendError(ws, result.code ?? 'app_config_io_error', result.error ?? 'unknown error', msgId)
    return false
  }
}
