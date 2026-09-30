/**
 * TTS 域 —— 语音合成朗读 RPC 封装（ai-voice-tts 设计 §7.5，照 quota 域范式）。
 *
 * 四函数对应协议 tts.* 四 type（设计 §7.1）：
 * - getConfig / getCapabilities：请求-响应（设置页首屏并行拉取）
 * - configure：动作-回执（整对象透传，ok/error 回执；写路校验失败 error 带因）
 * - speak：长任务请求-响应（朗读合成 + 落盘，reply 只回 filePath）
 *
 * mock 侧同接口实现见 transport/mock（门面三元要求 real/mock 同构，G4 类型锚定编译强制）。
 */
import type { SanitizedTtsConfig, TtsApiKeyInput, TtsConfig, TtsFormModel, TtsProviderId } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** tts.configure 的 payload 形状（协议 ClientMessageMap['tts.configure'] 同构，整对象透传）。 */
export interface TtsConfigurePayload {
  /** 本次写入的目标家（同步写 activeProvider——设置页卡片单选即默认朗读服务商）。 */
  providerId: TtsProviderId
  config: TtsConfig
  /** 缺席 = 不动；字符串 = 写入；null = 清除；'from-provider' = 供应商 Key 联动带入（D4）。 */
  apiKeys?: Partial<Record<TtsProviderId, TtsApiKeyInput>>
}

/**
 * 读脱敏配置投影（设置页首屏）。每家敏感信息只含 hasApiKey / providerKeyAvailable 两布尔
 * （Key 联动检测信号，D4），永不回 Key 本体。
 */
export async function getConfig(): Promise<{ config: SanitizedTtsConfig }> {
  return command('tts.getConfig', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 保存配置（整对象透传，quota.configure 先例）。ok=false 时 error 带因
 *（runtime 写路校验失败不单独立码，配置错误由设置页就地呈现，设计 §7.1）。
 */
export async function configure(payload: TtsConfigurePayload): Promise<{ config?: SanitizedTtsConfig; ok: boolean; error?: string }> {
  return command('tts.configure', payload, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 拉三家表单投影（设置页表单数据源；数据权威在 runtime driver，renderer 不 import 数据表）。
 * capabilities 拉取失败时表单区禁用 + 重试入口，不渲染半态枚举（设计 §7.5 TtsPage）。
 */
export async function getCapabilities(): Promise<{ forms: Record<TtsProviderId, TtsFormModel> }> {
  return command('tts.getCapabilities', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 朗读合成：清洗后的文本经 runtime 合成 WAV 落 tts-cache，回 filePath（renderer 经
 * local-file:// 播放）。超时传 0 = 任务级不限时（仓库超时默认原则：朗读是任务执行正常
 * 路径禁自带墙钟超时，设计 §7.5 要点 2；防挂死由 driver 每段 120s 兜底）。
 */
export async function speak(payload: { sessionId?: string; text: string }): Promise<{ filePath: string }> {
  return command('tts.speak', payload, 0)
}
