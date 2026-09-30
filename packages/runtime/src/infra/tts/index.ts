/**
 * TTS driver 注册面（ai-voice-tts 设计 §7.3）——三家 driver 的唯一装配出口。
 *
 * 消费方：u3 TtsService（speak 时按 activeProvider 现读 tts.json baseUrl 建 driver；
 * getCapabilities 回表单投影）与 u3b 组合根接线。能力表/表单投影数据本体定义在各家
 * driver 文件（D3），此处只做 id → 实装的分发，不含厂商判断之外的知识。
 */
import type { TtsProviderId, TtsFormModel } from '@taiji/shared'
import type { TtsDriver } from '../../services/ports/tts.js'
import { createStepfunDriver, stepfunFormModel } from './stepfun.js'
import { createMinimaxDriver, minimaxFormModel } from './minimax.js'
import { createMimoDriver, mimoFormModel } from './mimo.js'

export { stepfunCapabilities, stepfunFormModel, buildStepfunRequestBody, createStepfunDriver } from './stepfun.js'
export { minimaxCapabilities, minimaxFormModel, buildMinimaxRequestBody, decodeMinimaxResponse, createMinimaxDriver } from './minimax.js'
export { mimoCapabilities, mimoFormModel, buildMimoRequestBody, decodeMimoResponse, MIMO_PCM_SAMPLE_RATE, createMimoDriver } from './mimo.js'
export { wrapPcmAsWav, WAV_HEADER_BYTES } from './wav.js'
export {
  mergeRequestBody,
  sanitizePassthrough,
  deepMergeLeaves,
  AUTH_RESERVED_PASSTHROUGH_KEYS,
  type PassthroughPolicy,
} from './passthrough-merge.js'
export {
  TtsDriverFailure,
  ttsFailure,
  toErrorSnippet,
  buildAuthHeaders,
  joinEndpoint,
  postTtsRequest,
  parseVendorJson,
  decodeHexToPcm,
  decodeBase64ToPcm,
  snapToNearestSampleRate,
  isRecord,
  TTS_REQUEST_TIMEOUT_MS,
  TTS_ERROR_SNIPPET_MAX,
  DEFAULT_PCM_SAMPLE_RATE,
} from './base.js'

/** 表单投影全集（tts.getCapabilities reply 的 forms 载荷，§7.1）——静态数据，无需 baseUrl。 */
export function getTtsFormModels(): Record<TtsProviderId, TtsFormModel> {
  return { stepfun: stepfunFormModel, minimax: minimaxFormModel, mimo: mimoFormModel }
}

/** 按 id 建 driver（baseUrl 由调用方从配置现读注入；§7.4 步骤 1）。 */
export function createTtsDriver(id: TtsProviderId, baseUrl: string): TtsDriver {
  switch (id) {
    case 'stepfun':
      return createStepfunDriver({ baseUrl })
    case 'minimax':
      return createMinimaxDriver({ baseUrl })
    case 'mimo':
      return createMimoDriver({ baseUrl })
  }
}
