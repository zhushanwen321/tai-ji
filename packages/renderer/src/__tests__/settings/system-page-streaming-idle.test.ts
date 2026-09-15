/**
 * SystemStreamingIdleSection 对话流式空闲超时表单测试（timeout-streaming-ui-idle §4.3 / S4）。
 *
 * 覆盖：
 *  - DOM：mount 后含数字输入（data-testid=setting-streaming-idle-timeout）+ 单位「分钟」+ 范围 desc（用户可见断言）
 *  - 回显：getStreamingIdleTimeout 返回 1800s → 输入框显示 30（分钟）
 *  - 保存：改值 blur → setStreamingIdleTimeout 以秒调用（5 min → 300）+ setStreamingIdleTimeoutMs 收到 ms 生效值（store 同步）
 *  - clamp 回显：runtime 返回生效值（600s）→ 输入框回显生效分钟（10）
 *  - 超范围拒绝：120 min → 红字错误提示出现 + setStreamingIdleTimeout 未被调用（S4「超范围输入被表单拒绝」）
 *  - SystemPage 容器：新 Section 渲染 + 输入在 DOM
 *
 * mock 策略：vi.mock api/settings（捕获 RPC）+ vi.mock stores/chat（捕获 store 注水）+ 隔离 toast；
 * SystemPage 容器用例照 system-page-auto-rename.test.ts 补 command store / ipc stub。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/system-page-streaming-idle.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const settingsMock = vi.hoisted(() => ({
  getStreamingIdleTimeout: vi.fn(() => Promise.resolve({ timeout: 1800 })),
  setStreamingIdleTimeout: vi.fn((timeout: number) => Promise.resolve({ timeout })),
  // SystemPage 容器挂载的其他 Section 的 API 依赖（缺导出会 No export defined 崩 mount）
  getAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setAutoRenameEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  getRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  setRenameModel: vi.fn(() => Promise.resolve({ model: '' })),
  getRenameMode: vi.fn(() => Promise.resolve({ mode: 'first-stop' })),
  setRenameMode: vi.fn((mode: string) => Promise.resolve({ mode })),
  getSmartContextConfig: vi.fn(() =>
    Promise.resolve({ enabled: true, compactModel: '', reminderThresholds: [200_000, 400_000, 600_000], excludedModels: [] }),
  ),
  setSmartContextEnabled: vi.fn(() => Promise.resolve({ enabled: true })),
  setSmartContextCompactModel: vi.fn(() => Promise.resolve({ model: '' })),
  setSmartContextThresholds: vi.fn(() => Promise.resolve({ thresholds: [200_000, 400_000, 600_000] })),
  setSmartContextExcludedModels: vi.fn(() => Promise.resolve({ models: [] })),
  // SystemLlmRetrySection onMounted 拉取 retry 配置（真实 command 会 warn 噪音，mock 消除）
  getRetryConfig: vi.fn(() =>
    Promise.resolve({ configured: false, config: { enabled: true, maxRetries: 3, baseDelayMs: 1000 } }),
  ),
  setRetryConfig: vi.fn(() => Promise.resolve({ ok: true })),
  getSystem: vi.fn(() => Promise.resolve({})),
  updateSystem: vi.fn(() => Promise.resolve()),
}))

/** 捕获 chat store 注水（保存成功 → setStreamingIdleTimeoutMs 生效值 ms）。 */
const chatStoreMock = vi.hoisted(() => ({
  setStreamingIdleTimeoutMs: vi.fn(),
}))

vi.mock('@taiji/core/transport/api/domains/settings', () => (settingsMock))

vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ setStreamingIdleTimeoutMs: chatStoreMock.setStreamingIdleTimeoutMs }),
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ info: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))

// SystemPage 容器用例依赖 stub（照 system-page-auto-rename.test.ts）
vi.mock('@/composables/features/command/useCommandStore', () => {
  const { ref } = require('vue') as typeof import('vue')
  return {
    useCommandStore: () => ({
      appCommands: ref([]),
      shortcutOverrides: ref({}),
      setShortcutOverride: vi.fn(),
      registerApp: vi.fn(),
    }),
  }
})

vi.mock('@/lib/ipc', () => ({
  listSystemSounds: vi.fn(() => Promise.resolve({ sounds: [] })),
  onUpdateProgress: vi.fn(() => () => {}),
  onUpdateError: vi.fn(() => () => {}),
}))

import SystemStreamingIdleSection from '@/components/settings/system/SystemStreamingIdleSection.vue'
import SystemPage from '@/components/settings/system/SystemPage.vue'
import type { SystemSettings } from '@taiji/core'

function systemFixture(): SystemSettings {
  return {
    locale: 'zh-CN',
    theme: 'dark',
    themePreset: 'cold-blue',
    fontSize: 'medium',
    completionSound: true,
  }
}

/** 读输入框当前值（number input 的 element.value）。 */
function inputValue(wrapper: ReturnType<typeof mount>): string {
  return (wrapper.find('[data-testid="setting-streaming-idle-timeout"]').element as HTMLInputElement).value
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  settingsMock.getStreamingIdleTimeout.mockReset()
  settingsMock.getStreamingIdleTimeout.mockResolvedValue({ timeout: 1800 })
  settingsMock.setStreamingIdleTimeout.mockReset()
  settingsMock.setStreamingIdleTimeout.mockImplementation((timeout: number) => Promise.resolve({ timeout }))
  chatStoreMock.setStreamingIdleTimeoutMs.mockReset()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SystemStreamingIdleSection 表单', () => {
  it('mount 后 DOM 含数字输入 + 单位「分钟」+ 范围 desc（用户可见断言）', async () => {
    wrapper = mount(SystemStreamingIdleSection, { props: { system: systemFixture() } })
    await flushPromises()
    const input = wrapper.find('[data-testid="setting-streaming-idle-timeout"]')
    expect(input.exists()).toBe(true)
    expect(input.attributes('type')).toBe('number')
    expect(wrapper.text()).toContain('分钟')
    expect(wrapper.text()).toContain('流式空闲超时（分钟）')
    expect(wrapper.text()).toContain('保存后对新对话轮次生效')
  })

  it('回显持久化值：1800s → 输入框显示 30（分钟）', async () => {
    settingsMock.getStreamingIdleTimeout.mockResolvedValue({ timeout: 1800 })
    wrapper = mount(SystemStreamingIdleSection, { props: { system: systemFixture() } })
    await flushPromises()
    expect(inputValue(wrapper!)).toBe('30')
  })

  it('改值 blur 保存：5 min → setStreamingIdleTimeout(300)（秒）+ store 注水 300_000ms', async () => {
    wrapper = mount(SystemStreamingIdleSection, { props: { system: systemFixture() } })
    await flushPromises()
    const input = wrapper!.find('[data-testid="setting-streaming-idle-timeout"]')
    await input.setValue(5)
    await input.trigger('blur')
    await flushPromises()
    expect(settingsMock.setStreamingIdleTimeout).toHaveBeenCalledTimes(1)
    expect(settingsMock.setStreamingIdleTimeout).toHaveBeenCalledWith(300)
    expect(chatStoreMock.setStreamingIdleTimeoutMs).toHaveBeenCalledTimes(1)
    expect(chatStoreMock.setStreamingIdleTimeoutMs).toHaveBeenCalledWith(300_000)
  })

  it('runtime clamp 生效值回显：set 传 600 生效 600s → 输入框回显 10 分钟', async () => {
    settingsMock.setStreamingIdleTimeout.mockResolvedValue({ timeout: 600 })
    wrapper = mount(SystemStreamingIdleSection, { props: { system: systemFixture() } })
    await flushPromises()
    const input = wrapper!.find('[data-testid="setting-streaming-idle-timeout"]')
    await input.setValue(10)
    await input.trigger('blur')
    await flushPromises()
    expect(chatStoreMock.setStreamingIdleTimeoutMs).toHaveBeenCalledWith(600_000)
    expect(inputValue(wrapper!)).toBe('10')
  })

  it('超范围输入被拒：120 min → 红字错误提示可见 + 不发 RPC + 不注水 store（S4）', async () => {
    wrapper = mount(SystemStreamingIdleSection, { props: { system: systemFixture() } })
    await flushPromises()
    const input = wrapper!.find('[data-testid="setting-streaming-idle-timeout"]')
    await input.setValue(120)
    await input.trigger('blur')
    await flushPromises()
    const err = wrapper!.find('[data-testid="setting-streaming-idle-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('1-60')
    expect(settingsMock.setStreamingIdleTimeout).not.toHaveBeenCalled()
    expect(chatStoreMock.setStreamingIdleTimeoutMs).not.toHaveBeenCalled()
  })

  it('值未变更时 blur 不触发保存', async () => {
    wrapper = mount(SystemStreamingIdleSection, { props: { system: systemFixture() } })
    await flushPromises()
    const input = wrapper!.find('[data-testid="setting-streaming-idle-timeout"]')
    await input.trigger('blur')
    await flushPromises()
    expect(settingsMock.setStreamingIdleTimeout).not.toHaveBeenCalled()
  })
})

describe('SystemPage 容器编排（新 Section）', () => {
  it('SystemPage 渲染包含流式空闲超时输入（用户可见断言）', async () => {
    wrapper = mount(SystemPage, { props: { system: systemFixture() } })
    await flushPromises()
    expect(wrapper.find('[data-testid="setting-streaming-idle-timeout"]').exists()).toBe(true)
    expect(wrapper.findComponent(SystemStreamingIdleSection).exists()).toBe(true)
  })
})
