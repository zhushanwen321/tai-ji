/**
 * 默认提示词参考区测试（TDD 红灯）。
 *
 * 覆盖：
 *  - SystemPromptPage 渲染后，替换卡下方存在折叠 toggle 按钮（默认折叠）
 *  - 点击 toggle 展开后，参考区显示 DEFAULT_PI_SYSTEM_PROMPT 内容
 *  - 参考区含说明文案（动态段不受影响）
 *  - DEFAULT_PI_SYSTEM_PROMPT 常量导出且非空
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  $,
  hasTestId,
  openSettingsModalPage,
  setupSystemPromptPageHarness,
  systemPromptApiModule,
  systemPromptI18nModule,
} from '../helpers/system-prompt-page-harness'

vi.mock('@/api', () => systemPromptApiModule())
vi.mock('@/i18n', (importOriginal) => systemPromptI18nModule(importOriginal))

import SettingsModal from '@/components/settings/SettingsModal.vue'
import { DEFAULT_PI_SYSTEM_PROMPT, DEFAULT_PI_SYSTEM_PROMPT_VERSION } from '@taiji/shared'

// beforeEach 重置（pinia / toast / 捕获单例计数 / transport 桩）+ afterEach 卸载清 body +
// SettingsModal 挂载切菜单单源在 helpers/system-prompt-page-harness
setupSystemPromptPageHarness()

async function openSystemPromptPage(): Promise<void> {
  await openSettingsModalPage(SettingsModal, 'system-prompt')
}

describe('DEFAULT_PI_SYSTEM_PROMPT 常量', () => {
  it('导出非空字符串，含 pi 核心身份描述', () => {
    expect(typeof DEFAULT_PI_SYSTEM_PROMPT).toBe('string')
    expect(DEFAULT_PI_SYSTEM_PROMPT.length).toBeGreaterThan(100)
    expect(DEFAULT_PI_SYSTEM_PROMPT).toContain('coding assistant')
  })

  it('DEFAULT_PI_SYSTEM_PROMPT_VERSION 标注 pi 版本', () => {
    expect(DEFAULT_PI_SYSTEM_PROMPT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('默认提示词参考区', () => {
  it('页面含折叠 toggle 按钮（默认折叠，参考区内容不可见）', async () => {
    await openSystemPromptPage()
    expect(hasTestId('system-prompt-default-toggle')).toBe(true)
    // 默认折叠：content 不在 DOM 或不可见
    expect(hasTestId('system-prompt-default-content')).toBe(false)
  })

  it('点击 toggle 展开后，参考区显示默认提示词内容', async () => {
    await openSystemPromptPage()
    await $('[data-testid="system-prompt-default-toggle"]').trigger('click')
    await flushPromises()
    expect(hasTestId('system-prompt-default-content')).toBe(true)
    const content = $('[data-testid="system-prompt-default-content"]')
    expect(content.element.textContent).toContain('coding assistant')
  })

  it('参考区含说明文案（动态段不受影响）', async () => {
    await openSystemPromptPage()
    await $('[data-testid="system-prompt-default-toggle"]').trigger('click')
    await flushPromises()
    const page = document.body.querySelector('[data-testid="system-prompt-page"]')
    expect(page).toBeTruthy()
    const text = page!.textContent ?? ''
    expect(text.includes('动态段') || text.includes('不受影响') || text.includes('AGENTS')).toBe(true)
  })

  it('展开后含复制按钮（testid 存在）', async () => {
    await openSystemPromptPage()
    await $('[data-testid="system-prompt-default-toggle"]').trigger('click')
    await flushPromises()
    expect(hasTestId('system-prompt-default-copy')).toBe(true)
  })
})
