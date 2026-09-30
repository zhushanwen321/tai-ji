/**
 * TTS message handler —— 语音合成朗读四 RPC（ai-voice-tts 设计 §7.1）。
 *
 * 处理 4 个 RPC（与 handles / switch 分支一一对应，照 quota-message-handler 最小参照）：
 * - tts.getConfig：设置页首屏拉脱敏配置投影
 * - tts.configure：保存单家表单值 + apiKeys 三态（写入/清除/供应商联动带入）
 * - tts.speak：朗读合成（reply 只回 filePath；fromCache/chars/chunks 只进 runtime 日志）
 * - tts.getCapabilities：三家表单投影（设置页表单渲染唯一数据源）
 *
 * 错误契约（D8/§7.1）：结构非法 payload → invalid_payload error envelope（quota handler
 * 先例）；领域失败（未配置/空文本/超长/厂商错误等）由 TtsServiceError 携带 §7.1 错误码
 * 抛出，经 server handleMessage 顶层 catch 透传 code 进 error envelope——本 handler 不做
 * 二次 try/catch（quota 同款最小形态；service 失败点已各自记日志）。
 *
 * tts.* 域不触发 mutation 登记门禁（MUTATION_DOMAINS 只含 session/model/preset/config，
 * 已核实 mutation-reply-contract.test.ts）。
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { MessageHandlerContext } from './message-context.js'
import type { TtsService } from '../services/tts-service.js'

const TTS_PROVIDER_IDS: readonly string[] = ['stepfun', 'minimax', 'mimo']

/** TTS handler 的上下文（共享发消息契约 + TtsService）。 */
export interface TtsHandlerContext extends MessageHandlerContext {
  ttsService: TtsService
}

export class TtsMessageHandler {
  constructor(private ctx: TtsHandlerContext) {}

  /** 本 handler 认领的 ClientMessageType 清单（handles 展开进路由表）。 */
  readonly handles: ClientMessageType[] = [
    'tts.getConfig',
    'tts.configure',
    'tts.speak',
    'tts.getCapabilities',
  ]

  async handleTtsMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    switch (msg.type) {
      case 'tts.getConfig': {
        const config = await this.ctx.ttsService.getConfig()
        this.ctx.reply(ws, msg.id, 'tts.getConfig:result', { config })
        return
      }
      case 'tts.configure': {
        const { providerId, config } = msg.payload
        // 入口结构合法性防御（quota.configure [W3] 同款类校验；领域校验在 service 复核）
        if (typeof providerId !== 'string' || !TTS_PROVIDER_IDS.includes(providerId)) {
          this.ctx.sendError(ws, 'invalid_payload', `providerId must be one of ${TTS_PROVIDER_IDS.join('|')}`, msg.id)
          return
        }
        if (typeof config !== 'object' || config === null || Array.isArray(config)) {
          this.ctx.sendError(ws, 'invalid_payload', 'config must be an object', msg.id)
          return
        }
        const result = await this.ctx.ttsService.configure(msg.payload)
        this.ctx.reply(ws, msg.id, 'tts.configure:result', result)
        return
      }
      case 'tts.speak': {
        const { text, sessionId } = msg.payload
        if (typeof text !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'text required', msg.id)
          return
        }
        if (sessionId !== undefined && typeof sessionId !== 'string') {
          this.ctx.sendError(ws, 'invalid_payload', 'sessionId must be a string', msg.id)
          return
        }
        const result = await this.ctx.ttsService.speak(text, sessionId)
        this.ctx.reply(ws, msg.id, 'tts.speak:result', result)
        return
      }
      case 'tts.getCapabilities': {
        const forms = this.ctx.ttsService.getCapabilities()
        this.ctx.reply(ws, msg.id, 'tts.getCapabilities:result', { forms })
        return
      }
    }
  }
}
