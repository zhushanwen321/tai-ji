/**
 * System prompt / Terminal 配置域 config.* message handler（get/set 两对，4 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。两族同一写读范式：读取 corrupted 透传（提示用户
 * 文件已损坏并重置）；写入失败按 D10 错误信封回复不广播，成功 reply + 广播让所有
 * panel 同步。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class SystemPromptTerminalMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理 system prompt / terminal 配置域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getSystemPrompt': {
        // FR-6：读取 system-prompt 配置。corrupted 透传给前端（提示用户文件已损坏并重置）。
        const result = this.ctx.configService.getSystemPromptConfig()
        this.ctx.reply(ws, msg.id, 'config.systemPrompt', {
          config: result.config,
          corrupted: result.corrupted,
        })
        return true
      }
      case 'config.setSystemPrompt': {
        // FR-6：写入 system-prompt 配置。失败（超长等）按 D10 错误信封回复，不广播；
        // 成功 reply + 广播 config.systemPrompt（corrupted=false）让所有 panel 同步。
        const { config } = msg.payload
        const result = this.ctx.configService.setSystemPromptConfig(config)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_system_prompt_failed', result.error ?? 'unknown error', msg.id)
          return true
        }
        this.ctx.reply(ws, msg.id, 'config.systemPrompt', { config, corrupted: false })
        this.ctx.broadcast({
          type: 'config.systemPrompt',
          id: this.ctx.nextPushId(),
          payload: { config, corrupted: false },
        })
        return true
      }
      case 'config.getTerminalConfig': {
        // Phase 6：读取 terminal 配置。corrupted 透传给前端（提示用户文件已损坏并重置）。
        const result = this.ctx.configService.getTerminalConfig()
        this.ctx.reply(ws, msg.id, 'config.terminalConfig', {
          config: result.config,
          corrupted: result.corrupted,
        })
        return true
      }
      case 'config.setTerminalConfig': {
        // Phase 6：写入 terminal 配置。失败（超范围等）按 D10 错误信封回复，不广播；
        // 成功 reply + 广播 config.terminalConfig（corrupted=false）让所有 panel 同步。
        const { config } = msg.payload
        const result = this.ctx.configService.setTerminalConfig(config)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_terminal_config_failed', result.error ?? 'unknown error', msg.id)
          return true
        }
        this.ctx.reply(ws, msg.id, 'config.terminalConfig', { config, corrupted: false })
        this.ctx.broadcast({
          type: 'config.terminalConfig',
          id: this.ctx.nextPushId(),
          payload: { config, corrupted: false },
        })
        return true
      }
      default:
        return false
    }
  }
}
