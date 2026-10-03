/**
 * Codemode 开关域 config.* message handler（config.getCodemodeEnabled /
 * config.setCodemodeEnabled，2 条 case）。
 *
 * codemode 设计 D1/A1 的 runtime 端（先例：retry-config-message-handler.ts 同款
 * class + handle() switch 形态）。错误语义与 retry 不同（shared codemode.ts 协议
 * 定死）：损坏拒入的数据（error + corruption）在 reply 两态信封内返回而非 error
 * envelope——renderer 的 D3 错误态渲染（路径 + 隔离副本提示）直接消费信封字段。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class CodemodeMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理 codemode 开关域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getCodemodeEnabled': {
        // codemode 开关读（A1 读侧）：损坏 → enabled=false + corruption 有值（错误态），
        // 未损坏 → pi 解析语义激活判定；payload 形状 = CodemodeEnabledResult。
        const result = this.ctx.configService.getCodemodeEnabled()
        this.ctx.reply(ws, msg.id, 'config.codemodeEnabled', result)
        return true
      }
      case 'config.setCodemodeEnabled': {
        // codemode 开关写（D2 语义表 + A1 写点拒入）：损坏拒入走 ok:false 信封
        // （error 含拒绝原因与恢复指引，corruption 含路径与隔离副本提示），不 sendError
        // 不广播；成功 reply + 广播 config.codemodeEnabled（多窗口同步，同 retry 域
        // terminal 范式；payload 为写后落盘终态，corruption 恒 null）。
        const { enabled } = msg.payload
        const result = this.ctx.configService.setCodemodeEnabled(enabled)
        this.ctx.reply(ws, msg.id, 'config.codemodeSetEnabled', result)
        if (result.ok) {
          this.ctx.broadcast({
            type: 'config.codemodeEnabled',
            id: this.ctx.nextPushId(),
            payload: { enabled: result.enabled, corruption: null },
          })
        }
        return true
      }
      default:
        return false
    }
  }
}
