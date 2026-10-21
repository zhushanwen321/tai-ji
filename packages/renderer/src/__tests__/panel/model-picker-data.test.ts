/**
 * model-picker-data 纯函数侧测试（canonicalizeModelRef——run 级展示链的选中 ref
 * 显示词汇归一，模型段大小写）。
 *
 * 背景：runtime 详情增强把引擎原生 ref 的 provider 段翻回 pi 词汇（manifest 逆表），
 * 模型段保留引擎目录拼写（两世界拼写差：zcode `GLM-5.3-Flash` vs pi 行 id
 * `glm-5.3-flash`），而选择器行匹配是 providerId + id 精确等值——归一在消费侧按
 * settingsStore.models 行完成。本文件守护归一判据与恒等语义。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/model-picker-data.test.ts
 */
import { describe, it, expect } from 'vitest'
import type { ModelInfo } from '@taiji/shared'
import { canonicalizeModelRef } from '../../components/panel/model-picker-data'

/** fixture（ProviderId 是品牌类型，与 model-select-popover.test.ts 同款断言式构造）。 */
function model(providerId: string, id: string, name = id) {
  return { id, name, providerId, providerName: providerId }
}

const MODELS = [
  model('zai-coding-cn', 'glm-5.3-flash', 'GLM-5.3-Flash'),
  model('xiaomi-token-plan-cn', 'mimo-v2.6-flash', 'MiMo-V2.6-Flash'),
] as unknown as ModelInfo[]

describe('canonicalizeModelRef — 选中 ref 模型段大小写归一', () => {
  it('引擎目录拼写命中 pi 行（大小写不敏感）：回写 pi 行原生 id', () => {
    expect(canonicalizeModelRef('zai-coding-cn/GLM-5.3-Flash', MODELS)).toBe('zai-coding-cn/glm-5.3-flash')
  })

  it('已是 pi 行原生拼写：恒等返回（热切回执 / 覆盖意图分支统一套用无副作用）', () => {
    expect(canonicalizeModelRef('zai-coding-cn/glm-5.3-flash', MODELS)).toBe('zai-coding-cn/glm-5.3-flash')
  })

  it('provider 不在清单：原样返回（不伪造匹配）', () => {
    expect(canonicalizeModelRef('account:bigmodel-individual-coding-plan/GLM-5.3-Flash', MODELS)).toBe(
      'account:bigmodel-individual-coding-plan/GLM-5.3-Flash',
    )
  })

  it('provider 命中但模型段无匹配：原样返回', () => {
    expect(canonicalizeModelRef('zai-coding-cn/model-not-registered', MODELS)).toBe('zai-coding-cn/model-not-registered')
  })

  it('裸 id（不含 /）：恒等返回', () => {
    expect(canonicalizeModelRef('glm-5.3-flash', MODELS)).toBe('glm-5.3-flash')
  })

  it('同 short-id 多 provider：providerId 圈定行集，不跨 provider 误归一', () => {
    const models = [...MODELS, model('other-provider', 'GLM-5.3-FLASH')] as unknown as ModelInfo[]
    expect(canonicalizeModelRef('zai-coding-cn/GLM-5.3-Flash', models)).toBe('zai-coding-cn/glm-5.3-flash')
  })
})
