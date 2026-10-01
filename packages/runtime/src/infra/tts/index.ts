/**
 * TTS driver 注册面（ai-voice-tts 设计 §7.3）——三家 driver 的唯一装配出口。
 *
 * 消费方：u3 TtsService（speak 时按 activeProvider 现读 tts.json baseUrl 建 driver；
 * getCapabilities 回表单投影）与 u3b 组合根接线。能力表/表单投影/请求体组装/错误翻译等
 * 知识本体定义在各家 driver 文件（D3），测试直接从各家模块导入（./stepfun.js 等），
 * 本出口只做 id → 实装的分发，不含厂商判断之外的知识。
 */
import type { TtsProviderId, TtsFormModel } from '@taiji/shared'
import type { TtsDriver } from '../../services/ports/tts.js'
import { createStepfunDriver, stepfunFormModel } from './stepfun.js'
import { createMinimaxDriver, minimaxFormModel } from './minimax.js'
import { createMimoDriver, mimoFormModel } from './mimo.js'

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
