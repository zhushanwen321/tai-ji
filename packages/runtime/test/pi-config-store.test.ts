import { describe, it, expect } from 'vitest'
import { PiConfigStore } from '../src/infra/pi/pi-config-store.js'

// W1：applyTypeTranslation 改为透传。
// 历史背景：曾经存在 mapTypeToApi 别名翻译表（ollama → openai-completions 等），
// 但前端已直接发送 pi 终值（anthropic-messages / openai-completions），
// runtime 再翻译属于死代码，且 ollama 翻译会掩盖前端 bug。
// W1 要求 runtime 透传，不再做别名翻译。
describe('PiConfigStore.applyTypeTranslation — 透传（W1）', () => {
  const store = new PiConfigStore()

  it('pi 原生终值 anthropic-messages 原样透传', () => {
    expect(store.applyTypeTranslation('anthropic-messages')).toBe('anthropic-messages')
  })

  it('pi 原生终值 openai-completions 原样透传', () => {
    expect(store.applyTypeTranslation('openai-completions')).toBe('openai-completions')
  })

  it('未知值原样透传，不阻断', () => {
    expect(store.applyTypeTranslation('unknown-foo')).toBe('unknown-foo')
  })

  it('不再有 ollama → openai-completions 的别名翻译（原样透传）', () => {
    // 旧 mapTypeToApi 会把 ollama 翻成 openai-completions，现必须透传
    expect(store.applyTypeTranslation('ollama')).toBe('ollama')
  })

  it('不再有 anthropic → anthropic-messages 的别名翻译', () => {
    expect(store.applyTypeTranslation('anthropic')).toBe('anthropic')
  })

  it('不再有 openai → openai-completions 的别名翻译', () => {
    expect(store.applyTypeTranslation('openai')).toBe('openai')
  })
})
