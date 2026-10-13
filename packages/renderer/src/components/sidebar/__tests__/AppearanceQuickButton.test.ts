/**
 * AppearanceQuickButton 单测（chat-flow-text-color 同批 · 外观快捷入口）。
 *
 * 覆盖（三视角）：
 * - 渲染 gate：trigger 按钮 + popover 打开后 6 主题色块 + chat 字号 4 档 segmented 可见
 * - 使用者行为：点主题色块 → setSystem({theme, themePreset}）；点字号档 → setSystem 完整
 *   fontScales 浅合并对象（chat 档改写，其余区域保留）
 * - 观察者形态：active 态 aria-pressed 标注（当前主题/当前档位）
 *
 * getSettingsStore 桩注入（store 单例真身在测试环境会触达 platform storage——本组件单测
 * 只关心「写通道转发」，不覆盖 store 持久化语义，那是 settings-store 自身的测试领地）。
 *
 * 运行：cd packages/renderer && npx vitest run src/components/sidebar/__tests__/AppearanceQuickButton.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { DEFAULT_SYSTEM } from '@taiji/core'
import type { SystemSettings } from '@taiji/core'

const setSystemMock = vi.fn()

// getSettingsStore 桩：system ref + setSystem spy（组件契约 = 读 system + 写 setSystem）
vi.mock('@taiji/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core')>()
  return {
    ...actual,
    getSettingsStore: () => ({
      system: ref({ ...DEFAULT_SYSTEM } as SystemSettings),
      setSystem: setSystemMock,
    }),
  }
})

import AppearanceQuickButton from '@/components/sidebar/AppearanceQuickButton.vue'

async function mountOpen() {
  const wrapper = mount(AppearanceQuickButton, { attachTo: document.body })
  await flushPromises()
  const trigger = wrapper.find('[data-testid="sidebar-appearance-quick"]')
  await trigger.trigger('click')
  await flushPromises()
  return wrapper
}

describe('AppearanceQuickButton（外观快捷入口）', () => {
  beforeEach(() => {
    setSystemMock.mockClear()
    document.body.innerHTML = ''
  })

  it('渲染 gate：popover 打开后 6 主题色块 + chat 字号 4 档可见', async () => {
    await mountOpen()
    const themes = document.body.querySelectorAll('[data-testid^="appearance-quick-theme-"]')
    expect(themes).toHaveLength(6)
    // 档位按钮 4 档（button 元素限定——容器 seg div 同前缀，不参与计数）
    const tierButtons = document.body.querySelectorAll('button[data-testid^="appearance-quick-chat-"]')
    expect(tierButtons).toHaveLength(4)
  })

  it('点主题色块 → setSystem({theme, themePreset})（同 AppearancePage applyTaijiTheme 通道）', async () => {
    await mountOpen()
    const dailan = document.body.querySelector<HTMLElement>('[data-testid="appearance-quick-theme-dailan"]')
    expect(dailan, '黛蓝色块应存在').toBeTruthy()
    dailan!.click()
    await flushPromises()
    expect(setSystemMock).toHaveBeenCalledWith({ theme: 'dark', themePreset: 'dailan' })
  })

  it('点「特大」档 → setSystem 完整 fontScales（chat=xlarge，其余区域保留）', async () => {
    await mountOpen()
    const xlarge = document.body.querySelector<HTMLElement>('[data-testid="appearance-quick-chat-xlarge"]')
    expect(xlarge, '特大档应存在').toBeTruthy()
    xlarge!.click()
    await flushPromises()
    expect(setSystemMock).toHaveBeenCalledTimes(1)
    const patch = setSystemMock.mock.calls[0][0] as { fontScales: Record<string, string> }
    expect(patch.fontScales).toEqual({ ...DEFAULT_SYSTEM.fontScales, chat: 'xlarge' })
  })

  it('观察者形态：默认主题（玄青 preset=""）与默认档（chat=small）aria-pressed', async () => {
    await mountOpen()
    const defaultTheme = document.body.querySelector<HTMLElement>('[data-testid="appearance-quick-theme-dark"]')
    expect(defaultTheme?.getAttribute('aria-pressed')).toBe('true')
    const dailan = document.body.querySelector<HTMLElement>('[data-testid="appearance-quick-theme-dailan"]')
    expect(dailan?.getAttribute('aria-pressed')).toBe('false')
    const small = document.body.querySelector<HTMLElement>('[data-testid="appearance-quick-chat-small"]')
    expect(small?.getAttribute('aria-pressed')).toBe('true')
  })
})
