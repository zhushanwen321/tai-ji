/**
 * LLM retry 配置域 config.* message handler（config.get/setRetryConfig，2 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。llm-retry-settings 特性域的 runtime 端（独立
 * 测试文件 settings-message-handler-llm-retry.test.ts 锁定）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@xyz-agent/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class RetryConfigMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理 retry 配置域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getRetryConfig': {
        // llm-retry-settings：读 retry 域。缺省键已合并为 pi 默认值；configured 区分
        // 「显式配置」与「未配置（显示默认）」（D7），坏文件由 store schema guard 兜底。
        const result = this.ctx.configService.getRetryConfig()
        this.ctx.reply(ws, msg.id, 'config.retryConfig', result)
        return true
      }
      case 'config.setRetryConfig': {
        // llm-retry-settings：写 retry 域。校验失败（D8 越界）按 D10 错误信封回复，
        // 不广播不落盘；成功 reply + 广播 config.retryConfig（多窗口同步，同 terminal 范式）。
        // configured=true 的依据：mergeRetryConfig 无条件落盘顶层必填三键（enabled/maxRetries/
        // baseDelayMs），读侧键存在判定恒成立；provider 三键未设时被 patchKey 删除（= 采纳
        // pi 默认语义，未写入），不影响 configured 判定。
        const { config } = msg.payload
        const result = this.ctx.configService.setRetryConfig(config)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_retry_config_failed', result.error ?? 'unknown error', msg.id)
          return true
        }
        this.ctx.reply(ws, msg.id, 'config.retryConfig', { config, configured: true })
        this.ctx.broadcast({
          type: 'config.retryConfig',
          id: this.ctx.nextPushId(),
          payload: { config, configured: true },
        })
        return true
      }
      default:
        return false
    }
  }
}
