/**
 * useSettingsShell locale 接线测试（W03 对抗式审查 Fix-1，major）。
 *
 * 断链背景：SettingsModal 的语言 radio → settingsStore.setSystem({locale}) 是用户切语言的
 * 唯一真实路径，但 useSettingsShell 的 watch 源数组原只有 [theme, themePreset, fontSize]
 * 不含 locale → applyCurrent 不触发 → setLocale 永不被调，切语言后 UI 不变。
 *
 * 端到端链路验证（mount 真实 shell setup + 真实 core store + 真实 @/i18n）：
 * setSystem({locale:'en-US'}) → watch(flush:pre) → applyCurrent → applySystemToDom →
 * setLocale('en-US')（spy 断言被调）→ i18n.global.locale 变为 'en-US'。
 *
 * 运行：cd packages/renderer && npx vitest run src/composables/shell/__tests__/useSettingsShell.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'

// ── mock 与被测行为无关的壳接线依赖（避免拖入 WS/IPC/quota 真实链路）──
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }),
}))
vi.mock('@/composables/features/model/useQuotaConfigure', () => ({
  useQuotaConfigure: vi.fn(),
}))
vi.mock('@/api', () => ({
  config: { detectSources: vi.fn().mockResolvedValue([]) },
}))
vi.mock('../settings-transport-adapter', () => ({
  createSettingsTransport: vi.fn(() => ({})),
}))
vi.mock('@/platform/desktop-platform', () => ({ provideDesktopPlatform: vi.fn() }))
vi.mock('@taiji/core/transport/mock/mock-ws', () => ({ createMockPlatform: vi.fn() }))

// ── @/i18n 包装 spy：委托真实 setLocale（保留端到端 locale 真变化断言）──
const setLocaleSpy = vi.fn()
vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>()
  return {
    ...actual,
    setLocale: (locale: import('@/i18n').Locale) => {
      setLocaleSpy(locale)
      return actual.setLocale(locale)
    },
  }
})

import { useSettingsShell } from '../useSettingsShell'
import { getSettingsStore, __resetSettingsStoreForTesting } from '@taiji/core'
import { getLocale } from '@/i18n'

/** 挂载一个 setup 内调用 useSettingsShell 的探针组件（provide/watch 需组件实例上下文） */
function mountShell() {
  const Probe = defineComponent({
    setup() {
      useSettingsShell()
      return () => h('div')
    },
  })
  return mount(Probe)
}

beforeEach(() => {
  localStorage.clear()
  setLocaleSpy.mockClear()
  __resetSettingsStoreForTesting()
})

describe('useSettingsShell · locale 接线（Fix-1）', () => {
  it('setSystem({locale}) 触发 setLocale 且 i18n.global.locale 真实切换（zh→en→zh）', async () => {
    const wrapper = mountShell()
    const store = getSettingsStore()
    expect(getLocale()).toBe('zh-CN') // 前置：store 默认 zh-CN

    // 用户切英文（SettingsModal 语言 Select 的真实路径）
    await store.setSystem({ locale: 'en-US' })
    await nextTick() // watch flush:pre 派发 applyCurrent
    expect(setLocaleSpy).toHaveBeenCalledWith('en-US')
    // en-US 动态 import 完成后 locale 真实翻转（端到端，非仅 spy）
    await vi.waitFor(() => expect(getLocale()).toBe('en-US'))

    // 切回中文同样即时生效（watch 源含 locale 后双向都有响应）
    await store.setSystem({ locale: 'zh-CN' })
    await nextTick()
    expect(setLocaleSpy).toHaveBeenLastCalledWith('zh-CN')
    await vi.waitFor(() => expect(getLocale()).toBe('zh-CN'))

    wrapper.unmount()
  })

  it('mount 时初始 applyCurrent 兜底调用过 setLocale（store 默认 zh-CN）', async () => {
    const wrapper = mountShell()
    // 初始 apply：applySystemToDom 以 store 当前 system（DEFAULT_SYSTEM.locale='zh-CN'）调用 setLocale
    expect(setLocaleSpy).toHaveBeenCalledWith('zh-CN')
    wrapper.unmount()
  })
})
