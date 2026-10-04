/**
 * 注册面单测：id → driver 分发与表单投影全集（u3 TtsService / getCapabilities 消费面）。
 */
import { describe, expect, it } from 'vitest'
import { createTtsDriver, getTtsFormModels } from './index.js'

describe('createTtsDriver 分发', () => {
  it('三家 id 各自返回对应 driver（端点路径与鉴权头按 §7.2 各归各家）', () => {
    expect(createTtsDriver('stepfun', 'https://api.stepfun.com/v1').capabilities.endpointPath).toBe('/audio/speech')
    expect(createTtsDriver('minimax', 'https://api.minimax.cn/v1').capabilities.endpointPath).toBe('/t2a_v2')
    expect(createTtsDriver('mimo', 'https://token-plan-cn.xiaomimimo.com/v1').capabilities.endpointPath).toBe('/chat/completions')
    expect(createTtsDriver('mimo', 'https://x/v1').capabilities.authHeader).toBe('api-key')
  })

  it('id 与 formModel 同源（driver 内嵌能力表，投影即本家数据）', () => {
    const driver = createTtsDriver('minimax', 'https://api.minimax.cn/v1')
    expect(driver.id).toBe('minimax')
    expect(driver.formModel.capabilities).toBe(driver.capabilities)
  })
})

describe('getTtsFormModels', () => {
  it('三家投影全集齐备（tts.getCapabilities reply forms 载荷形状）', () => {
    const forms = getTtsFormModels()
    expect(Object.keys(forms).sort()).toEqual(['mimo', 'minimax', 'stepfun'])
    for (const form of Object.values(forms)) {
      expect(form.baseUrlOptions.length).toBeGreaterThan(0)
      expect(form.baseUrlOptions.filter((o) => o.isDefault)).toHaveLength(1)
      expect(form.models.length).toBeGreaterThan(0)
    }
  })
})
