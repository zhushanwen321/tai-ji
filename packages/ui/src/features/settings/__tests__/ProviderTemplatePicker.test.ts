/**
 * ProviderTemplatePicker 组件单测（wave-picker-b）。
 *
 * 覆盖验收标准：
 * ① 入口两级结构：Popover menu（内置模板/自定义）+ 点内置 → Dialog 打开
 * ② 分类 tab 过滤（both 双归属）
 * ③ 搜索含 envVar
 * ④ 3 列卡片网格 + 品牌色 logo + 认证 chip
 * ⑤ brandColor 纯函数（品牌色/fallback/稳定）
 * ⑥ 点卡片 → emit select + Dialog 关闭
 *
 * 测试模式：reka Dialog 经 Portal teleport 到 document.body，mount attachTo body 后
 * 用 document.body.querySelector 查询；点击用原生 HTMLElement.click()。i18n 经
 * vitest.setup mock（t 返回 key）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/settings/__tests__/ProviderTemplatePicker.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProviderTemplatePicker from '../provider/ProviderTemplatePicker.vue'
import { brandColor } from '../provider/brand-colors.js'
import type { BuiltinProviderTemplate } from '@taiji/shared'

function tpl(id: string, name: string, authMode: BuiltinProviderTemplate['authMode'], envVars: string[], modelCount = 3): BuiltinProviderTemplate {
  return {
    id, name, authMode, envVars, modelCount, oauthSupported: false,
    models: [], apiKeyName: name,
  } as BuiltinProviderTemplate
}

const PROVIDERS = [
  tpl('openai', 'OpenAI', 'api_key', ['OPENAI_API_KEY'], 12),
  tpl('anthropic', 'Anthropic', 'both', ['ANTHROPIC_API_KEY'], 8),
  tpl('openai-codex', 'OpenAI Codex', 'oauth', [], 5),
  tpl('google-vertex', 'Google Vertex AI', 'ambient', [], 6),
]

function mountPicker() {
  const wrapper = mount(ProviderTemplatePicker, {
    props: { providers: PROVIDERS },
    attachTo: document.body,
  })
  return wrapper
}

async function openDialog(): Promise<void> {
  // 打开 Popover menu → 点「从内置模板」→ Dialog 打开
  const trigger = document.body.querySelector('[data-testid="provider-template-picker"]')
  ;(trigger as HTMLElement).click()
  await flushPromises() // reka Popover 异步挂载 menu
  const builtin = document.body.querySelector('[data-testid="add-menu-builtin"]')
  ;(builtin as HTMLElement).click()
  await flushPromises() // Dialog portal 挂载
}

describe('ProviderTemplatePicker 入口两级结构（TC1）', () => {
  it('首屏：Popover menu 含内置模板[推荐] + 自定义，无 Dialog', async () => {
    const wrapper = mountPicker()
    const trigger = document.body.querySelector('[data-testid="provider-template-picker"]')
    expect(trigger).toBeTruthy()
    ;(trigger as HTMLElement).click()
    await flushPromises()
    expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="add-menu-custom"]')).toBeTruthy()
    // Dialog 未打开
    expect(document.body.querySelector('[data-testid="provider-template-dialog"]')).toBeNull()
    wrapper.unmount()
  })

  it('点「从内置模板」→ Dialog 打开（720px 选择器），Popover menu 关闭', async () => {
    const wrapper = mountPicker()
    await openDialog()
    const dialog = document.body.querySelector('[data-testid="provider-template-dialog"]')
    expect(dialog).toBeTruthy()
    // Popover menu 已关（Dialog 与 menu 不同时出现）
    expect(document.body.querySelector('[data-testid="add-menu-builtin"]')).toBeNull()
    wrapper.unmount()
  })
})

describe('分类 tab 过滤（TC2，both 双归属）', () => {
  async function tabCount(tabId: string): Promise<number> {
    const wrapper = mountPicker()
    await openDialog()
    const tab = document.body.querySelector(`[data-testid="picker-tab-${tabId}"]`)
    ;(tab as HTMLElement).click()
    await flushPromises()
    const cards = document.body.querySelectorAll('[data-testid^="provider-template-"]:not([data-testid="provider-template-dialog"]):not([data-testid="provider-template-search"]):not([data-testid="provider-template-picker"])')
    const count = Array.from(cards).filter(el => (el as HTMLElement).getAttribute('data-testid')?.startsWith('provider-template-') && (el as HTMLElement).getAttribute('data-testid') !== 'provider-template-grid').length
    wrapper.unmount()
    return count
  }

  it('全部 tab 显示 4 个 provider', async () => {
    expect(await tabCount('all')).toBe(4)
  })

  it('API Key tab：api_key + both（openai/anthropic 2 个）', async () => {
    expect(await tabCount('api_key')).toBe(2)
  })

  it('OAuth tab：oauth + both（anthropic/openai-codex 2 个）', async () => {
    expect(await tabCount('oauth')).toBe(2)
  })

  it('云凭证 tab：ambient（google-vertex 1 个）', async () => {
    expect(await tabCount('ambient')).toBe(1)
  })
})

describe('搜索（TC3，含 envVar）', () => {
  it('按 envVar 搜索：OPENAI 命中 openai（envVars 含 OPENAI_API_KEY）', async () => {
    const wrapper = mountPicker()
    await openDialog()
    const input = document.body.querySelector('[data-testid="provider-template-search"]') as HTMLInputElement
    input.value = 'OPENAI'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    // openai 卡片存在，anthropic 被过滤
    expect(document.body.querySelector('[data-testid="provider-template-openai"]')).toBeTruthy()
    expect(document.body.querySelector('[data-testid="provider-template-anthropic"]')).toBeNull()
    wrapper.unmount()
  })

  it('按 name 搜索大小写不敏感', async () => {
    const wrapper = mountPicker()
    await openDialog()
    const input = document.body.querySelector('[data-testid="provider-template-search"]') as HTMLInputElement
    input.value = 'vertex'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(document.body.querySelector('[data-testid="provider-template-google-vertex"]')).toBeTruthy()
    wrapper.unmount()
  })
})

describe('卡片网格 + 品牌色 + 认证 chip（TC4）', () => {
  it('3 列网格容器存在，卡片含名称/模型数/认证 chip', async () => {
    const wrapper = mountPicker()
    await openDialog()
    const grid = document.body.querySelector('[data-testid="provider-template-grid"]')
    expect(grid).toBeTruthy()
    // 卡片数 = 4
    const cards = grid!.querySelectorAll('[data-testid^="provider-template-"]')
    expect(cards.length).toBe(4)
    // openai 卡片含名称 + 模型数 + API Key chip
    const openaiCard = document.body.querySelector('[data-testid="provider-template-openai"]')!
    expect(openaiCard.textContent).toContain('OpenAI')
    expect(openaiCard.textContent).toContain('12')
    // i18n mock 返回 key（vitest.setup），断言 key 存在即 chip 渲染
    expect(openaiCard.textContent).toContain('authChip.api_key')
    // anthropic（both）双 chip：API Key + OAuth
    const anthropicCard = document.body.querySelector('[data-testid="provider-template-anthropic"]')!
    expect(anthropicCard.textContent).toContain('authChip.api_key')
    expect(anthropicCard.textContent).toContain('authChip.oauth')
    // 品牌色：openai logo inline style 背景色 #10a37f
    const logo = openaiCard.querySelector('span[style*="background-color"]') as HTMLElement
    expect(logo.style.backgroundColor).toBe('#10a37f')
    wrapper.unmount()
  })
})

describe('brandColor 纯函数（TC5）', () => {
  it('色板内返回品牌色（openai → #10a37f）', () => {
    expect(brandColor('openai')).toBe('#10a37f')
    expect(brandColor('anthropic')).toBe('#d97757')
  })

  it('色板外 hash fallback（在 5 语义色集合内，值为 design-tokens CSS 变量）', () => {
    const FALLBACKS = ['var(--neutral-ico)', 'var(--success)', 'var(--warn)', 'var(--danger)', 'var(--info)']
    expect(FALLBACKS).toContain(brandColor('unknown-provider-foo'))
  })

  it('映射稳定：同 id 两次调用同结果', () => {
    expect(brandColor('unknown-provider-foo')).toBe(brandColor('unknown-provider-foo'))
  })
})

describe('选中流（TC6）', () => {
  it('点卡片 → emit select(template) + Dialog 关闭', async () => {
    const wrapper = mountPicker()
    await openDialog()
    const openaiCard = document.body.querySelector('[data-testid="provider-template-openai"]')!
    ;(openaiCard as HTMLElement).click()
    await flushPromises()
    const selectEvents = wrapper.emitted('select')
    expect(selectEvents).toBeTruthy()
    expect((selectEvents![0][0] as BuiltinProviderTemplate).id).toBe('openai')
    // Dialog 关闭
    expect(document.body.querySelector('[data-testid="provider-template-dialog"]')).toBeNull()
    wrapper.unmount()
  })
})
