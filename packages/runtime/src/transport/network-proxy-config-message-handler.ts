/**
 * LLM 网络代理配置域 config.* message handler（get/set/test/stats/reset，5 条 case）。
 *
 * Extracted-from-settings 先例同款 class + handle() switch 形态（retry-config-message-handler.ts
 * / smart-context-config-message-handler.ts 同款；不匹配返回 false 由 SettingsMessageHandler
 * 继续路由）。llm-network-proxy 特性域（extensions/universal/network-proxy）的 runtime 端
 * （独立测试文件 network-proxy-message-handler.test.ts 锁定）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage } from '@taiji/shared'
import type { SettingsHandlerContext } from './settings-message-handler.js'

export class NetworkProxyConfigMessageHandler {
  constructor(private ctx: SettingsHandlerContext) {}

  /** 处理网络代理配置域消息；不匹配返回 false（由 SettingsMessageHandler 继续路由）。 */
  async handle(msg: ClientMessage, ws: WsType): Promise<boolean> {
    switch (msg.type) {
      case 'config.getNetworkProxy': {
        // 读当前生效配置（文件缺失/坏 JSON 字段级回默认，读侧不抛错）。
        this.ctx.reply(ws, msg.id, 'config.networkProxy', { config: this.ctx.configService.getNetworkProxyConfig() })
        return true
      }
      case 'config.setNetworkProxy': {
        // 写整份配置。校验失败（shared validateNetworkProxyConfig 逐项错误清单）按 D10 错误
        // 信封回复，不落盘不广播；成功 reply + 广播 config.networkProxy（多窗口同步，retry 范式）。
        // reply/broadcast = 落盘终态（getNetworkProxyConfig() 读回）：写侧 dedupeHostList 是
        // 确定性变换（ADR-0065 分支一生效值语义）——请求含重复/
        // 变体条目时请求值 ≠ 生效值，消费侧必须拿服务端终态校准而非乐观写请求值。
        const { config } = msg.payload
        const result = this.ctx.configService.setNetworkProxyConfig(config)
        if (!result.ok) {
          this.ctx.sendError(ws, 'set_network_proxy_failed', result.errors.join('；'), msg.id)
          return true
        }
        const effective = this.ctx.configService.getNetworkProxyConfig()
        this.ctx.reply(ws, msg.id, 'config.networkProxy', { config: effective })
        this.ctx.broadcast({
          type: 'config.networkProxy',
          id: this.ctx.nextPushId(),
          payload: { config: effective },
        })
        return true
      }
      case 'config.testNetworkProxy': {
        // 测试连接两段探测（对表单当前草稿配置探测，不要求先落盘）；失败也走 reply
        // （结果信封自带 ok/stage/message 归因，非请求级操作失败——UI 按结果渲染归因文案）。
        // 回执键 config.networkProxyTest（quota.fetch:result 同族 request/reply 键对形态）。
        const result = await this.ctx.configService.testNetworkProxyConnection(msg.payload.config)
        this.ctx.reply(ws, msg.id, 'config.networkProxyTest', result)
        return true
      }
      case 'config.getNetworkProxyStats': {
        // 统计读聚合（24h/7d 时间过滤提前终止；all = 截断保尾窗口累计）。
        this.ctx.reply(ws, msg.id, 'config.networkProxyStats', this.ctx.configService.getNetworkProxyStats(msg.payload.range))
        return true
      }
      case 'config.resetNetworkProxyStats': {
        // 追加重置水位行后 reply 清零后的统计（消费侧直接刷新视图，协议注释契约）。
        this.ctx.configService.resetNetworkProxyStats()
        this.ctx.reply(ws, msg.id, 'config.networkProxyStats', this.ctx.configService.getNetworkProxyStats('all'))
        return true
      }
      default:
        return false
    }
  }
}
