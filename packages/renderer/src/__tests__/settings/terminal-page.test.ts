/**
 * TerminalPage 渲染与交互测试（Phase 6）。
 *
 * 覆盖：
 *  - 首屏渲染：terminal-page testid + 各表单字段 testid 存在（mount TerminalPage，断言 DOM）。
 *  - mount 后调 getTerminalConfig（mock 返回默认配置）。
 *  - 填表 + 点 save → setTerminalConfig 被调 + 正确 payload（含 shellArgs 逗号串 → string[] 转换）。
 *  - corrupted=true → 显示 corrupted 提示条。
 *
 * mock 策略：
 *  - vi.mock('@/api') 提供 config.getTerminalConfig / setTerminalConfig。
 *  - i18n 经 vitest-i18n-setup 全局 mock useI18n，t() 从 zh-CN locale 解析。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/terminal-page.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import {
  $,
  defaultTerminalConfig as defaultConfig,
  setupTerminalConfigHarness,
  terminalConfigApiModule,
  terminalConfigMock as configMock,
  trackBodyMount,
} from '../helpers/terminal-config-harness'
import { useToast } from '@/composables/useToast'
import type { TerminalConfig } from '@taiji/shared'

// [C3] 终端配置读写经 SettingsTransport seam 桩注入（补充 @/api 遗留 mock，组件已不直连门面）；
// configMock 捕获单例 + project 桩单源在 helpers/terminal-config-harness.ts
vi.mock('@/api', () => terminalConfigApiModule())

import TerminalPage from '@/components/settings/terminal/TerminalPage.vue'

// beforeEach 重置（pinia/toast/mock 计数/transport 桩）+ afterEach 卸载清 body 单源在 harness
setupTerminalConfigHarness()

describe('TerminalPage 渲染 gate', () => {
  it('首屏渲染：terminal-page testid + 各表单字段 testid 全部存在', async () => {
    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    const requiredIds = [
      'terminal-page',
      'terminal-shell-input',
      'terminal-shell-args-input',
      'terminal-font-size-input',
      'terminal-font-family-input',
      'terminal-scrollback-input',
      'terminal-cursor-style-select',
      'terminal-bell-switch',
      'terminal-save',
    ]
    for (const id of requiredIds) {
      expect(document.body.querySelector(`[data-testid="${id}"]`)).toBeTruthy()
    }
  })

  it('mount 后调 getTerminalConfig（mock 返回默认配置）', async () => {
    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    expect(configMock.getTerminalConfig).toHaveBeenCalledTimes(1)
    // 默认配置应填充到表单（fontSize=14, scrollback=1000）
    expect($('[data-testid="terminal-font-size-input"]').element).toBeTruthy()
    expect(($('[data-testid="terminal-font-size-input"]').element as HTMLInputElement).value).toBe('14')
    expect(($('[data-testid="terminal-scrollback-input"]').element as HTMLInputElement).value).toBe('1000')
  })
})

describe('TerminalPage 保存交互', () => {
  it('填表 + 点 save → setTerminalConfig 被调 + 正确 payload（含 shellArgs 逗号串 → string[]）', async () => {
    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    // 修改 shell
    await $('[data-testid="terminal-shell-input"]').setValue('/bin/zsh')
    // 修改 shellArgs（逗号分隔串）
    await $('[data-testid="terminal-shell-args-input"]').setValue('-l,-i')
    // 修改 fontFamily
    await $('[data-testid="terminal-font-family-input"]').setValue('Menlo, monospace')
    // 修改 fontSize
    await $('[data-testid="terminal-font-size-input"]').setValue('18')
    // 修改 scrollback
    await $('[data-testid="terminal-scrollback-input"]').setValue('5000')
    // 点保存
    await $('[data-testid="terminal-save"]').trigger('click')
    await flushPromises()

    expect(configMock.setTerminalConfig).toHaveBeenCalledTimes(1)
    const payload = configMock.setTerminalConfig.mock.calls[0]![0] as TerminalConfig
    expect(payload.shell).toBe('/bin/zsh')
    expect(payload.shellArgs).toEqual(['-l', '-i'])
    expect(payload.fontFamily).toBe('Menlo, monospace')
    expect(payload.fontSize).toBe(18)
    expect(payload.scrollback).toBe(5000)
    expect(payload.cursorStyle).toBe('block')
    expect(payload.bell).toBe(false)

    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'info')).toBe(true)
  })

  it('setTerminalConfig 失败时显示 error toast', async () => {
    configMock.setTerminalConfig.mockRejectedValueOnce(new Error('保存失败'))

    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    await $('[data-testid="terminal-save"]').trigger('click')
    await flushPromises()

    expect(configMock.setTerminalConfig).toHaveBeenCalledTimes(1)
    const { toasts } = useToast()
    expect(toasts.value.some((t) => t.type === 'error' && t.message.includes('保存失败'))).toBe(true)
  })

  it('shellArgs 空输入存为 []', async () => {
    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    // shellArgs 留空（默认即为空串），点保存
    await $('[data-testid="terminal-save"]').trigger('click')
    await flushPromises()

    expect(configMock.setTerminalConfig).toHaveBeenCalledTimes(1)
    const payload = configMock.setTerminalConfig.mock.calls[0]![0] as TerminalConfig
    expect(payload.shellArgs).toEqual([])
  })

  it('RD-4#7：保存 in-flight 期间按钮禁用（saving 守卫，防 65s 窗口重复点击并发覆盖）', async () => {
    let resolveSave!: (v: { config: TerminalConfig; corrupted: boolean }) => void
    configMock.setTerminalConfig.mockImplementationOnce(
      () => new Promise((r) => { resolveSave = r }),
    )
    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    // 第一次点击 → 进入 saving（setTerminalConfig pending）
    await $('[data-testid="terminal-save"]').trigger('click')
    await flushPromises()
    expect(configMock.setTerminalConfig).toHaveBeenCalledTimes(1)
    // in-flight：保存按钮禁用
    expect(($('[data-testid="terminal-save"]').element as HTMLButtonElement).disabled).toBe(true)

    // resolve → saving 复位，按钮恢复可用
    resolveSave({ config: defaultConfig(), corrupted: false })
    await flushPromises()
    expect(($('[data-testid="terminal-save"]').element as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('TerminalPage corrupted 提示', () => {
  it('getTerminalConfig 返回 corrupted=true 时页内出现损坏提示', async () => {
    configMock.getTerminalConfig.mockResolvedValueOnce({
      config: defaultConfig(),
      corrupted: true,
    })

    trackBodyMount(mount(TerminalPage, { attachTo: document.body }))
    await flushPromises()

    const page = document.body.querySelector('[data-testid="terminal-page"]')
    expect(page).toBeTruthy()
    const text = page!.textContent ?? ''
    expect(text.includes('已损坏') || text.includes('回退默认') || text.includes('损坏')).toBe(true)
  })
})
