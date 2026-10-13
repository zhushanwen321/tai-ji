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
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises, DOMWrapper } from '@vue/test-utils'
import {
  $,
  defaultTerminalConfig as defaultConfig,
  setupTerminalConfigHarness,
  terminalConfigApiModule,
  terminalConfigMock as configMock,
  trackBodyMount,
} from '../helpers/terminal-config-harness'
import { pickRekaOption } from '../helpers/reka-select-harness'
import { DEFAULT_SYSTEM } from '@taiji/core'
import type { TerminalConfig } from '@taiji/shared'

// [C3] 终端配置读写经 SettingsTransport seam 桩注入（补充 @/api 遗留 mock，组件已不直连门面）；
// configMock 捕获单例 + project 桩单源在 helpers/terminal-config-harness.ts
vi.mock('@/api', () => terminalConfigApiModule())

import AppearancePage from '@/components/settings/appearance/AppearancePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

// beforeEach 重置（pinia/toast/mock 计数/transport 桩）+ afterEach 卸载清 body 单源在 harness
setupTerminalConfigHarness()

function mountPage(system = { ...DEFAULT_SYSTEM }) {
  return trackBodyMount(mount(AppearancePage, {
    props: { system },
    attachTo: document.body,
  }))
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

  it('玄青主题卡渲染（chat-flow 同批：主题名统一 2 字）：短名「玄青」、title 含完整 label、swatch 第一格 = #a5adc2', async () => {
    wrapper = mountPage()
    await flushPromises()
    // 玄青 preset='' → testid 为 appearance-theme-（模板 `appearance-theme-${th.preset}`）
    const xuan = document.body.querySelector<HTMLElement>('[data-testid="appearance-theme-"]')
    expect(xuan, '玄青主题卡应存在').toBeTruthy()
    // 网格卡显 2 字短名；完整 label（含「暗 · 弱蓝灰 · 默认」）收进 title tooltip
    expect(xuan!.textContent).toContain('玄青')
    expect(xuan!.getAttribute('title')).toContain('太极 · 玄青（暗 · 弱蓝灰 · 默认）')
    expect(xuan!.textContent).not.toContain('纯灰')
    // swatch 第一格（accent 位）= D3 定稿值；style 序列化形态按环境可能是 hex 或 rgb
    const firstSwatchStyle = xuan!.querySelector('span[style]')?.getAttribute('style') ?? ''
    expect(/a5adc2|rgb\(\s*165,\s*173,\s*194\s*\)/.test(firstSwatchStyle), `swatch 第一格 style=${firstSwatchStyle}`).toBe(true)
  })
})

describe('AppearancePage Select 载荷守卫（reka Select 交互 → update emit）', () => {
  // reka Select 真实交互（pointerdown 开下拉 + option 点选）单源在 helpers/reka-select-harness。
  // [appearance-grid 外观模式/全局字号已改 segmented（值域闭合字面量直调），仅分区字号仍走 Select]

  function lastUpdate(): Record<string, unknown> {
    const emitted = (wrapper as any).emitted('update')
    expect(emitted).toBeTruthy()
    return emitted.at(-1)[0]
  }

  it('外观模式 segmented：点「浅色」→ emit update {theme:"light"}（字面量直调，isThemeMode 守卫仍收窄）', async () => {
    wrapper = mountPage() // DEFAULT_SYSTEM theme=dark → 深色 active
    await flushPromises()
    const light = document.body.querySelector<HTMLElement>('[data-testid="appearance-mode-light"]')
    expect(light, '浅色段点应存在').toBeTruthy()
    light!.click()
    await flushPromises()
    expect(lastUpdate()).toEqual({ theme: 'light' })
  })

  it('全局字号 segmented：点「大」→ emit update {fontSize:"large"}', async () => {
    wrapper = mountPage() // fontSize=medium → 中 active
    await flushPromises()
    const large = document.body.querySelector<HTMLElement>('[data-testid="appearance-fs-global-large"]')
    expect(large, '「大」段点应存在').toBeTruthy()
    large!.click()
    await flushPromises()
    expect(lastUpdate()).toEqual({ fontSize: 'large' })
  })

  it('分区字号 Select（sidebar）：点「特大」→ emit update {fontScales 含 sidebar:"xlarge"}（浅合并回传完整对象）', async () => {
    wrapper = mountPage()
    await flushPromises()
    const trigger = wrapper!.find('[data-testid="appearance-fs-sidebar-trigger"]').element
    await pickRekaOption(trigger, '特大')
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
