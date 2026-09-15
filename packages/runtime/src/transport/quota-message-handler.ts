/**
 * Quota message handler — Coding Plan 额度查询 RPC 处理。
 *
 * 处理 4 个 RPC（与 handles / switch 分支一一对应）：
 * - quota.fetch：hover 触发主动查询
 * - quota.getCached：读缓存不请求（浮层首屏即时填充）
 * - quota.refresh：强制刷新（绕过 throttle），Settings 保存并测试用
 * - quota.configure：Settings 保存额度配置（payload 单对象整对象透传：providerId / enabled /
 *   fetcher / credentialSource / cookie / apiKey / workspace；后续 payload 加字段 handler 零改动）
 */

import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { QuotaService } from '../services/quota-service.js'

/** Quota handler 的上下文（共享发消息契约 + QuotaService + provider 列表广播） */
export interface QuotaHandlerContext extends MessageHandlerContext {
  quotaService: QuotaService
  /**
   * 广播最新 provider 列表（config.providers）。quota.configure 成功后必调——
   * quota 配置落在 providers.json 的 extras，renderer 侧 matchedProviderId（容量浮层
   * coding-plan 区的显隐依据）读 settingsStore.providers 快照；不广播则快照停留在
   * 旧值（无 quota 字段），配置后须重启（sendInitialState 首推）才生效。
   */
  broadcastProviderList: () => void
}

export class QuotaMessageHandler {
  constructor(private ctx: QuotaHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = ['quota.fetch', 'quota.getCached', 'quota.configure', 'quota.refresh']

  async handleQuotaMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'quota.fetch': {
        const { providerId } = msg.payload
        // [W3] 防御 undefined/非 string providerId，避免下游 quotaService.fetch(undefined) 静默返回缓存
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        const result = await this.ctx.quotaService.fetch(providerId)
        this.ctx.reply(ws, msg.id, 'quota.fetch:result', result)
        return
      }
      case 'quota.refresh': {
        const { providerId } = msg.payload
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        // 强制刷新（绕过 throttle），用于 Settings 测试查询
        const result = await this.ctx.quotaService.refresh(providerId)
        this.ctx.reply(ws, msg.id, 'quota.refresh:result', result)
        return
      }
      case 'quota.getCached': {
        const { providerId } = msg.payload
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        const result = this.ctx.quotaService.getCached(providerId)
        this.ctx.reply(ws, msg.id, 'quota.getCached:result', result)
        return
      }
      case 'quota.configure': {
        const { providerId } = msg.payload
        // [W3] 防御 undefined/非 string providerId，避免下游静默失败——修过的真实 bug
        // 类校验，整对象透传不豁免它（透传解耦的是字段增减，不是入口合法性）
        if (!providerId || typeof providerId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'providerId required', msg.id)
          return
        }
        // A1-5：configure 持久化走 providers.json（统一 mkdir 锁 RMW），await 防止
        // reply 先于落盘（handler 返回时配置已持久，broadcast/后续读不拿 stale）。
        // §7.1 契约收敛：整对象透传（无逐参解构，后续 payload 加字段 handler 零改动；
        // 实施者漏切调用方对新单参签名必是参数数编译错，不可能静默丢字段）
        const result = await this.ctx.quotaService.configure(msg.payload)
        // 成功后广播 provider 列表：quota 配置进 providers.json extras，renderer 的
        // matchedProviderId 消费 providers 快照——不广播则须重启才生效（同
        // setProvider/toggleProviderEnabled 等 provider 变更 RPC 的广播惯例）
        if (result.ok) this.ctx.broadcastProviderList()
        this.ctx.reply(ws, msg.id, 'quota.configure:result', result)
        return
      }
    }
  }
}
