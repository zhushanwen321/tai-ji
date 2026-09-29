/**
 * AppearancePage 渲染与交互测试（外观菜单页，原 TokenDebugPage 演化）。
 *
 * 覆盖（三视角：构建者渲染断言 + 使用者交互路径）：
 *  - 首屏渲染：h1 =「外观」、分区字号卡文案命中 locale（无 raw key 泄漏）、
 *    三个区域 Select trigger + 终端字号 input testid 存在。
 *  - 太极主题按钮：点击 → emit update {theme, themePreset}（持久化路径，与 store 落库闭环）。
 *  - Select 载荷守卫：外观模式/全局字号/分区字号三 Select 经 reka 真实交互点选 →
 *    update emit 走 onXxxSelect 运行时守卫收窄（不写死模板 as 断言的回归面）。
 *  - 终端字号：mount 拉取 getTerminalConfig；改值 + blur → setTerminalConfig 整体写回
 *    （保留 shell 等其他字段）+ clamp 边界（30 → 24）。
 *
 * mock 策略：
 *  - vi.mock('@/api') 提供 config.getTerminalConfig / setTerminalConfig。
 *  - i18n 经 vitest-i18n-setup 全局 mock useI18n，t() 从 zh-CN locale 解析。
 *  - GroupCard / useTaijiThemes 真实模块（纯展示 + 纯数据）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/appearance-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { useToast } from '@/composables/useToast'
import { DEFAULT_SYSTEM, provideSettingsTransport } from '@taiji/core'
import { makeSettingsTransportStub } from '../helpers/settings-transport-stub'
import type { TerminalConfig } from '@taiji/shared'

function defaultConfig(): TerminalConfig {
  return {
    version: 1,
    shell: '',
    shellArgs: [],
    fontSize: 14,
    fontFamily: '',
    scrollback: 1000,
    cursorStyle: 'block',
    bell: false,
  }
}

const configMock = vi.hoisted(() => ({
  getTerminalConfig: vi.fn(() => Promise.resolve({ config: defaultConfig(), corrupted: false })),
  setTerminalConfig: vi.fn((cfg: TerminalConfig) => Promise.resolve({ config: cfg, corrupted: false })),
}))

// [C3] 终端配置读写经 SettingsTransport seam 桩注入（补充 @/api 遗留 mock，组件已不直连门面）
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  config: configMock,
}))

import AppearancePage from '@/components/settings/appearance/AppearancePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

function $(selector: string): DOMWrapper<Element> {
  const node = document.body.querySelector(selector)
  expect(node).toBeTruthy()
  return new DOMWrapper(node!)
}

beforeEach(() => {
  setActivePinia(createPinia())
  const { toasts } = useToast()
  toasts.value = []
  configMock.getTerminalConfig.mockClear()
  configMock.setTerminalConfig.mockClear()
  provideSettingsTransport(makeSettingsTransportStub(configMock))
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function mountPage(system = { ...DEFAULT_SYSTEM }) {
  return mount(AppearancePage, {
    props: { system },
    attachTo: document.body,
  })
}

describe('AppearancePage 渲染 gate', () => {
  it('首屏渲染：h1=外观、分区字号卡文案命中 locale、区域/终端控件 testid 存在', async () => {
    wrapper = mountPage()
    await flushPromises()

    const h1 = document.body.querySelector('h1')
    expect(h1?.textContent).toBe('外观') // settings.menu.appearance
    const html = document.body.innerHTML
    expect(html).not.toContain('settings.menu.appearance') // t() 命中后不应出现 raw key
    expect(html).toContain('分区字号') // settings.appearance.regionFontTitle
    expect(html).toContain('左侧边栏') // settings.appearance.region.sidebar
    expect(html).toContain('对话流')
    expect(html).toContain('侧边抽屉')
    // 三个区域 Select trigger + 终端字号 input
    $('[data-testid="appearance-fs-sidebar-trigger"]')
    $('[data-testid="appearance-fs-chat-trigger"]')
    $('[data-testid="appearance-fs-drawer-trigger"]')
    $('[data-testid="appearance-terminal-font-size-input"]')
  })

  it('token 读值区渲染 token 名（getComputedStyle 实际值）', async () => {
    wrapper = mountPage()
    await flushPromises()
    expect(document.body.innerHTML).toContain('--accent')
    expect(document.body.innerHTML).toContain('--bg')
  })
})

describe('AppearancePage Select 载荷守卫（reka Select 交互 → update emit）', () => {
  /** 打开指定 trigger 的下拉（reka Select：pointerdown 打开，SelectPortal teleport 到 body） */
  async function openDropdown(trigger: Element): Promise<HTMLElement[]> {
    trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    ;(trigger as HTMLElement).click()
    await flushPromises()
    return Array.from(document.body.querySelectorAll('[role="option"]')) as HTMLElement[]
  }

  /** 在已打开下拉中点选指定文案 option（同 update-page-source.test.ts 交互模式） */
  async function pickOption(trigger: Element, label: string): Promise<void> {
    const options = await openDropdown(trigger)
    const target = options.find((el) => (el.textContent ?? '').includes(label))
    expect(target, `option "${label}" should exist in dropdown`).toBeTruthy()
    target!.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    target!.click()
    await flushPromises()
  }

  /** 按显示文案定位 SelectTrigger（theme/fontSize 的 trigger 无 testid，以 SelectValue 文案锚定） */
  function findTriggerByText(text: string): HTMLElement {
    const btn = wrapper!.findAll('button').find((b) => b.text() === text)
    expect(btn, `trigger showing "${text}" should exist`).toBeTruthy()
    return btn!.element as HTMLElement
  }

  function lastUpdate(): Record<string, unknown> {
    const emitted = (wrapper as any).emitted('update')
    expect(emitted).toBeTruthy()
    return emitted.at(-1)[0]
  }

  it('外观模式 Select：点「浅色」→ emit update {theme:"light"}（isThemeMode 守卫收窄后放行）', async () => {
    wrapper = mountPage() // DEFAULT_SYSTEM theme=dark → trigger 显示「深色」
    await flushPromises()
    await pickOption(findTriggerByText('深色'), '浅色')
    expect(lastUpdate()).toEqual({ theme: 'light' })
  })

  it('全局字号 Select：点「大」→ emit update {fontSize:"large"}', async () => {
    wrapper = mountPage() // fontSize=medium → trigger 显示「中」
    await flushPromises()
    await pickOption(findTriggerByText('中'), '大')
    expect(lastUpdate()).toEqual({ fontSize: 'large' })
  })

  it('分区字号 Select（sidebar）：点「特大」→ emit update {fontScales 含 sidebar:"xlarge"}（浅合并回传完整对象）', async () => {
    wrapper = mountPage()
    await flushPromises()
    const trigger = wrapper!.find('[data-testid="appearance-fs-sidebar-trigger"]').element
    await pickOption(trigger, '特大')
    expect(lastUpdate().fontScales).toEqual({ ...DEFAULT_SYSTEM.fontScales, sidebar: 'xlarge' })
  })
})

describe('AppearancePage 交互', () => {
  it('点击太极主题按钮 → emit update {theme, themePreset}', async () => {
    wrapper = mountPage()
    await flushPromises()
    const dailan = document.body.querySelector<HTMLElement>('[data-testid="appearance-theme-dailan"]')
    expect(dailan).toBeTruthy()
    await new DOMWrapper(dailan!).trigger('click')
    const emitted = (wrapper as any).emitted('update')
    expect(emitted).toBeTruthy()
    const last = emitted.at(-1)[0]
    expect(last.theme).toBe('dark')
    expect(last.themePreset).toBe('dailan')
  })

  it('mount 拉取终端配置；改字号 + blur → 整体写回 config（保留其他字段）', async () => {
    configMock.getTerminalConfig.mockImplementation(() =>
      Promise.resolve({ config: { ...defaultConfig(), shell: '/bin/zsh', fontSize: 14 }, corrupted: false }),
    )
    wrapper = mountPage()
    await flushPromises()
    expect(configMock.getTerminalConfig).toHaveBeenCalled()

    const input = $('[data-testid="appearance-terminal-font-size-input"]')
    await input.setValue('16')
    await input.trigger('blur')
    await flushPromises()
    expect(configMock.setTerminalConfig).toHaveBeenCalledTimes(1)
    const payload = configMock.setTerminalConfig.mock.calls[0][0] as TerminalConfig
    expect(payload.fontSize).toBe(16)
    expect(payload.shell).toBe('/bin/zsh') // 整体写回，不丢其他终端偏好
  })

  it('终端字号 clamp：30 → 24', async () => {
    wrapper = mountPage()
    await flushPromises()
    const input = $('[data-testid="appearance-terminal-font-size-input"]')
    await input.setValue('30')
    await input.trigger('blur')
    await flushPromises()
    expect(configMock.setTerminalConfig).toHaveBeenCalled()
    expect((configMock.setTerminalConfig.mock.calls[0][0] as TerminalConfig).fontSize).toBe(24)
  })
})
