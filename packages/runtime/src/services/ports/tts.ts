/**
 * TTS driver port —— 厂商适配器契约（ai-voice-tts 设计 §7.3）。
 *
 * 🔒 三层架构：services 定义 port，infra/tts/<vendor>.ts 实现（u2）；transport（tts-message-handler）
 * 经 TtsService 编排消费，组合根构造注入。外部 HTTP 只准出现在 infra/tts/（仓库硬约束）——
 * 本 port 是厂商协议差异的唯一集中点：driver 负责「字段换家 + 钳制/丢弃」（设计 D3，
 * 差异判断读能力表不写 if (vendor === ...)）与厂商错误形态 → 统一错误码的翻译（§7.3 分层，
 * 统一层只见 TtsErrorCode）。
 *
 * 能力表与表单投影的本体（三家各一份）随 driver 实装定义在 infra/tts/，形状 SSOT 在
 * shared tts-types（协议 reply tts.getCapabilities 引用同一形状，两处漂移编译期红）。
 */
import type { InternalSpeechRequest, TtsCapabilities, TtsErrorCode, TtsFormModel, TtsProviderId } from '@taiji/shared'

/** 单段合成产物：PCM 裸流 + 实际采样率 + 声道数（WAV 头封装的三个事实输入，§7.4 步骤 6）。 */
export interface TtsSynthesisChunk {
  /** PCM 裸采样字节流（多段直接相接天然连续，D9——无压缩格式编码单元边界问题）。 */
  pcm: Buffer
  /** 实际采样率（写 WAV 头；driver 从本家请求组装值取，不猜不写死）。 */
  sampleRate: number
  /**
   * 声道数（写 WAV 头 numChannels——双声道 PCM 是左右声道交织字节流，头按 mono 写会
   * 变速/时长翻倍）。driver 从本家请求组装值取（MiniMax 经 passthrough 的
   * audio_setting.channel，默认 1；其余两家恒 1），不猜不写死（§7.3 synthesizeChunk 注释）。
   */
  channels: number
}

/** driver 失败的统一错误形态（driver 最后一步职责 = 厂商错误形态 → 统一错误码翻译，§7.3）。 */
export interface TtsDriverError {
  code: TtsErrorCode
  /** 厂商原始码或 HTTP status + 响应摘要（toErrorSnippet 截断 200 字符，供归因）。 */
  snippet: string
}

export interface TtsDriver {
  readonly id: TtsProviderId
  /** 合成能力表：driver 钳制/丢弃的唯一数据源（设计 D3）。 */
  readonly capabilities: TtsCapabilities
  /** 表单投影：设置页表单渲染唯一数据源（经 tts.getCapabilities 提供，内嵌能力表保同源）。 */
  readonly formModel: TtsFormModel
  /**
   * 单段合成：输入已按 capabilities.maxInputChars 切好的文本段，返回 PCM 裸流 + 实际采样率 + 声道数。
   *
   * 不设外部 signal 参数——M0 无外部取消源（取消是客户端任务作废，不打扰 runtime，设计 §7.5
   * 要点 2）；超时兜底由 driver 内部自起（AbortSignal.timeout 每段 120s 防挂死，范式照
   * model-connection-tester 实装形态：test(request) 签名本无外部 signal，超时 signal 在
   * fetch 调用点内部构造）。Phase 2 若做真取消（流式/分段 reply 的 abort）随真实消费方
   * 加回参数，口径同 D3 对 supportsStream 的处理。
   *
   * 失败一律以 TtsDriverError 形态 reject（含网络异常/超时 → tts_network_error，driver 基座归类）。
   */
  synthesizeChunk(req: InternalSpeechRequest, apiKey: string): Promise<TtsSynthesisChunk>
}
