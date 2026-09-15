/**
 * compat 预设配置测试。
 *
 * 覆盖：
 *  - getPresetsForApi 按 api 类型过滤（openai-completions 5 个 / anthropic 1 个 / responses 0 个）
 *  - 每个预设的 compat 配置包含必要字段（thinkingFormat 或 forceAdaptiveThinking）
 *  - 预设数据与调研结论一致（DeepSeek/GLM/Kimi/MiMo/MiniMax）
 *
 * 运行：pnpm --filter @taiji/frontend run test -- src/__tests__/settings/compat-presets.test.ts
 */
import { describe, it, expect } from 'vitest'
import {
  COMPAT_PRESETS,
  getPresetsForApi,
} from '@taiji/core'

describe('compat 预设配置（COMPAT_PRESETS）', () => {
  describe('getPresetsForApi 按 api 类型过滤', () => {
    it('openai-completions 返回 5 个预设（DeepSeek/GLM/Kimi-K2/Kimi-K3/MiMo）', () => {
      const presets = getPresetsForApi('openai-completions')
      expect(presets).toHaveLength(5)
      const ids = presets.map(p => p.id)
      expect(ids).toEqual(['deepseek', 'glm', 'kimiK2', 'kimiK3', 'mimo'])
    })

    it('anthropic-messages 返回 1 个预设（MiniMax）', () => {
      const presets = getPresetsForApi('anthropic-messages')
      expect(presets).toHaveLength(1)
      expect(presets[0]!.id).toBe('minimax')
    })

    it('openai-responses 无预设（返回空数组）', () => {
      expect(getPresetsForApi('openai-responses')).toEqual([])
    })

    it('api 为 undefined/未知时返回空数组', () => {
      expect(getPresetsForApi(undefined)).toEqual([])
      expect(getPresetsForApi('unknown-api')).toEqual([])
    })
  })

  describe('各预设的 compat 配置正确性（调研结论固化）', () => {
    // 不用非空断言 `!`：preset id 被删/改名时，find 返回 undefined，后续 `.compat` 会抛晦涩的
    // "Cannot read properties of undefined"。这里显式 expect，失败时给出可定位的诊断信息。
    const findPreset = (id: string) => {
      const p = COMPAT_PRESETS.find(p => p.id === id)
      expect(p, `preset "${id}" not found in COMPAT_PRESETS`).toBeDefined()
      return p!
    }

    it('DeepSeek: thinkingFormat=deepseek + 支持 reasoning_effort + 需回传 reasoning_content', () => {
      const compat = findPreset('deepseek').compat
      expect(compat.thinkingFormat).toBe('deepseek')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(true)
      // 国产 reasoning 模型共性：多轮工具调用需回传 reasoning_content，否则 400
      expect(compat.requiresReasoningContentOnAssistantMessages).toBe(true)
    })

    it('GLM (z.ai): thinkingFormat=zai + 不支持 reasoning_effort', () => {
      const compat = findPreset('glm').compat
      expect(compat.thinkingFormat).toBe('zai')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('Kimi K2.x: thinkingFormat=deepseek + 不支持 reasoning_effort', () => {
      // K2.x 与 DeepSeek 同形（thinking:{type}），但不支持 effort
      const compat = findPreset('kimiK2').compat
      expect(compat.thinkingFormat).toBe('deepseek')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('Kimi K3: thinkingFormat=openai + 支持 reasoning_effort（与 K2.x 必须区分）', () => {
      // K3 走纯 reasoning_effort（openai 格式），不能发 thinking 参数
      const compat = findPreset('kimiK3').compat
      expect(compat.thinkingFormat).toBe('openai')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(true)
    })

    it('MiMo: thinkingFormat=qwen-chat-template（chat_template_kwargs.enable_thinking）', () => {
      const compat = findPreset('mimo').compat
      expect(compat.thinkingFormat).toBe('qwen-chat-template')
      expect(compat.supportsDeveloperRole).toBe(false)
      expect(compat.supportsReasoningEffort).toBe(false)
    })

    it('MiniMax: 走 anthropic-messages API + forceAdaptiveThinking', () => {
      const preset = findPreset('minimax')
      expect(preset.api).toBe('anthropic-messages')
      expect(preset.compat.forceAdaptiveThinking).toBe(true)
    })
  })

  describe('国产模型共性约束', () => {
    it('所有 openai-completions 预设都设 supportsDeveloperRole=false（国产 API 不认 developer 角色）', () => {
      const presets = getPresetsForApi('openai-completions')
      for (const p of presets) {
        expect(p.compat.supportsDeveloperRole).toBe(false)
      }
    })

    it('所有预设的 api 字段与 COMPAT_PRESETS 声明一致', () => {
      for (const p of COMPAT_PRESETS) {
        expect(['openai-completions', 'anthropic-messages', 'openai-responses']).toContain(p.api)
      }
    })
  })

  /**
   * COMPAT_PRESETS 是静态数据，被 CompatEditor 读取并通过 i18n key（settings.compat.preset.<id>）
   * 渲染 label/hint。任一字段缺失会导致运行时 undefined 或 i18n 回退到 key 原文。这里固化数据形状契约，
   * 防止后续手改时静默破坏（如删 id、空 compat、api 写错枚举值）。
   */
  describe('COMPAT_PRESETS 数据形状契约', () => {
    it('每个 preset 有非空字符串 id、合法 api 枚举、且 compat 为非空对象', () => {
      expect(COMPAT_PRESETS.length, 'COMPAT_PRESETS 不应为空').toBeGreaterThan(0)
      const seenIds: string[] = []
      for (const p of COMPAT_PRESETS) {
        expect(typeof p.id, `preset id 应为字符串，实际为 ${typeof p.id}`).toBe('string')
        expect(p.id.length, 'preset id 不应为空字符串').toBeGreaterThan(0)
        expect(seenIds, `preset id "${p.id}" 重复`).not.toContain(p.id)
        seenIds.push(p.id)

        expect(p.api, `preset "${p.id}" 的 api 必须是合法枚举值`).toBeOneOf([
          'openai-completions',
          'anthropic-messages',
          'openai-responses',
        ])

        expect(p.compat, `preset "${p.id}" 的 compat 应为对象`).toBeTypeOf('object')
        expect(p.compat, `preset "${p.id}" 的 compat 不应为 null`).not.toBeNull()
        expect(Object.keys(p.compat).length, `preset "${p.id}" 的 compat 不应为空对象`).toBeGreaterThan(0)
      }
    })
  })
})
