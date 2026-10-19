/**
 * Provider OAuth 凭据域 config.* message handler（login/cancel/hasOAuth/logout，4 条 case）。
 *
 * Extracted from settings-message-handler.ts to reduce file size（该文件同类先例：
 * config-preferences-message-handler.ts 同款 class + handle() switch 形态；case 体自
 * 原文件逐一原样迁移，行为保持）。本域是 authService 的唯一消息消费方：
 * config.oauthLogin/oauthCancel RPC 路由 + auth.* 事件由 AuthService 推 broadcast。
 *
 * 凭据域变更联动（MF-2）：登录成功 / 退出登录都改变 auth.json 凭据域事实 → 触发 zcode
 * provider 镜像同步重跑（与 settings 域 provider 变更同一 write-through 通道）。OAuth 凭据
 * 本身不进镜像（短时 token 不可当静态 api-key，见 zcode-provider-sync 的 oauth-credential
 * skip），但登录/退出会改变该 provider 的「可映射凭据」判定与 models.json apiKey 状态，
 * 副本必须跟随——事件驱动，不做时间轮询（ADR-0122）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'
import { toErrorMessage } from '../utils/errors.js'

export class OauthMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理 OAuth 域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.oauthLogin': {
        const result = this.ctx.authService.login(
          msg.payload.providerId,
          () => this.mirrorAfterCredentialMutation(),
        )
        this.ctx.reply(ws, msg.id, 'config.oauthLoginReply', result.started
          ? { started: true }
          : { started: false, error: result.error })
        return true
      }
      case 'config.oauthCancel': {
        const result = this.ctx.authService.cancel(msg.payload.providerId)
        this.ctx.reply(ws, msg.id, 'config.oauthCancelReply', result)
        return true
      }
      case 'config.hasOAuth': {
        // MF-1：查询 auth.json 是否已有该 provider 的 oauth 凭据（QuickSetup 重开时据此默认
        // oauth radio，防 env 盲保存触发 I9 清理①静默删凭据）。只返回布尔——token 永不出现在协议中。
        const hasOAuth = await this.ctx.authService.hasOAuth(msg.payload.providerId)
        this.ctx.reply(ws, msg.id, 'config.hasOAuthReply', { hasOAuth })
        return true
      }
      case 'config.oauthLogout': {
        // B-1 场景 C：退出登录——移除 auth.json 中该 provider 的凭证（先中止进行中 flow）。
        // 幂等（无凭证 no-op）；失败转 ok:false + error（错误消息指向重试动作）。
        try {
          await this.ctx.authService.logout(msg.payload.providerId)
          this.ctx.reply(ws, msg.id, 'config.oauthLogoutReply', { ok: true })
          // 凭据域变更（auth.json 该 provider 条目已删除）→ 镜像重跑：副本里不得残留
          // 已退出登录 provider 的映射条目（短时 token 不再进副本，但可映射凭据判定变了）。
          this.mirrorAfterCredentialMutation()
        } catch (error) {
          this.ctx.reply(ws, msg.id, 'config.oauthLogoutReply', {
            ok: false,
            error: `退出登录失败（凭证可能仍在）：${toErrorMessage(error)}。请重试；持续失败请检查磁盘后重启应用`,
          })
        }
        return true
      }
      default:
        return false
    }
  }

  /**
   * 凭据变更后的 write-through 镜像（与 provider-message-handler.mirrorAfterMutation 同通道
   * 同语义：fire-and-forget，实现内部自捕获错误只 warn，失败不阻断 OAuth 应答）。
   */
  private mirrorAfterCredentialMutation(): void {
    this.ctx.providersMutatedSync?.().catch(err => {
      console.warn('[oauth-message-handler] zcode provider mirror sync failed:', err instanceof Error ? err.message : String(err))
    })
  }
}
