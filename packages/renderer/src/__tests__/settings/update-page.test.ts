/**
 * UpdatePage · 更新设置页测试（v6 demo 回填：自动更新卡 + 预下载 + 代理配置）。
 *
 * 覆盖（自动更新卡）：
 *  - 首屏冒烟：DOM 含自动更新 Switch（switch-auto-update）+ 当前版本 pill（current-version-pill）
 *    + 检查更新按钮（settings-update-check，UpdateCheckCard 内嵌渲染）
 *  - 加载回填：getUpdateSettings 返回 autoUpdate true → Switch 开；false → 关
 *  - 切换交互：切 Switch → setUpdateSettings({ autoUpdate }) 被调用
 *  - 失败恢复：setUpdateSettings reject → Switch 保持原值 + toast error（不抛错）
 *  - 预下载开关回填（原有行为不回归）：getUpdateSettings.preDownload → switch-pre-download 状态
 *
 * Mock 策略：
 *  - vi.mock('@/api/domains/settings') 捕获 getProxyConfig/getUpdateSettings/setUpdateSettings 等
 *  - vi.mock('@/composables/useToast') 隔离 toast（失败用例断言 error 被调）
 *  - vi.mock('@/composables/features/settings/useAppUpdate')（UpdateCheckCard 唯一外部依赖，
 *    同 system-page-update.test.ts 的 mock 结构）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-page.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import type { UpdateState } from '@xyz-agent/shared'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub（'0.0.0-test'）

// ── mock 捕获层（vi.hoisted 保证在 vi.mock 工厂执行前就绪） ──
const settingsMock = vi.hoisted(() => ({
  getProxyConfig: vi.fn(() => Promise.resolve({ mode: 'system', httpProxy: '', httpsProxy: '' })),
  setProxyConfig: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() => Promise.resolve({ success: true, message: '' })),
  getUpdateSettings: vi.fn(() => Promise.resolve({ preDownload: false, autoUpdate: false })),
  setUpdateSettings: vi.fn(() => Promise.resolve()),
}))

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}))

vi.mock('@/api/domains/settings', () => ({
  getProxyConfig: settingsMock.getProxyConfig,
  setProxyConfig: settingsMock.setProxyConfig,
  testProxy: settingsMock.testProxy,
  getUpdateSettings: settingsMock.getUpdateSettings,
  setUpdateSettings: settingsMock.setUpdateSettings,
}))

vi.mock('@/composables/useToast', () => ({
  useToast: () => toastMock,
}))

// UpdateCheckCard → useAppUpdate 单例 state（同 system-page-update.test.ts mock 结构）
const testState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string; releaseNotes: string } | null,
  errorMessage: '',
  percent: 0,
  releaseNotesHtml: '',
})

const checkForUpdateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const performDownloadMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const performInstallMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const openFallbackUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('@/composables/features/settings/useAppUpdate', () => ({
  useAppUpdate: () => ({
    state: testState,
    checkForUpdate: checkForUpdateMock,
    performDownload: performDownloadMock,
    performInstall: performInstallMock,
    openFallbackUrl: openFallbackUrlMock,
    initAutoCheck: vi.fn(),
    restorePendingUpdate: vi.fn(),
    restorePreloadedUpdate: vi.fn(),
  }),
}))

import UpdatePage from '@/components/settings/update/UpdatePage.vue'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  settingsMock.getProxyConfig.mockReset()
  settingsMock.setProxyConfig.mockReset()
  settingsMock.testProxy.mockReset()
  settingsMock.getUpdateSettings.mockReset()
  settingsMock.setUpdateSettings.mockReset()
  toastMock.info.mockReset()
  toastMock.error.mockReset()
  // 默认解析值：与组件默认 ref 一致
  settingsMock.getProxyConfig.mockResolvedValue({ mode: 'system', httpProxy: '', httpsProxy: '' })
  settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
  settingsMock.setUpdateSettings.mockResolvedValue(undefined)
  Object.assign(testState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('UpdatePage 自动更新卡', () => {
  it('首屏渲染：DOM 含自动更新开关 + 当前版本 pill + 检查更新按钮', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    // 自动更新开关存在
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.exists()).toBe(true)
    // 当前版本 pill 存在（含版本号 + 渠道文案）
    const pill = wrapper.find('[data-testid="current-version-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('v0.0.0-test')
    expect(pill.text()).toContain('stable 渠道')
    // UpdateCheckCard 内嵌渲染（检查更新状态机在自动更新卡内）
    expect(wrapper.find('[data-testid="settings-update-check"]').exists()).toBe(true)
  })

  it('加载回填：getUpdateSettings.autoUpdate true → 开关为开', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
    wrapper = mount(UpdatePage)
    await flushPromises()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('checked')
  })

  it('加载回填：getUpdateSettings.autoUpdate false → 开关为关', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    wrapper = mount(UpdatePage)
    await flushPromises()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
  })

  it('切换开关：click 调 setUpdateSettings({ autoUpdate: true }) 并更新开关状态', async () => {
    wrapper = mount(UpdatePage)
    await flushPromises()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    // reka-ui Switch 通过 click 切换并 emit update:model-value
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: true })
    // 持久化成功后开关状态更新
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
  })

  it('切换开关：开 → 关 调 setUpdateSettings({ autoUpdate: false })', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
    wrapper = mount(UpdatePage)
    await flushPromises()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('checked')
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: false })
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
  })

  it('持久化失败：开关保持原值 + toast error（不抛错）', async () => {
    settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
    wrapper = mount(UpdatePage)
    await flushPromises()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    // 切换触发持久化 → 失败 → 控件保持 unchecked
    await sw.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error).toHaveBeenCalledWith('write failed')
  })

  it('预下载开关回填不回归：preDownload true → switch-pre-download 为开', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: true, autoUpdate: false })
    wrapper = mount(UpdatePage)
    await flushPromises()
    const sw = wrapper.find('[data-testid="switch-pre-download"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('data-state')).toBe('checked')
  })
})

// ── 原 UpdatePage.w3-acceptance.test.ts 并入（同 SUT 异功能区：testProxy 结果两行渲染；
//    W3-A6 验收，mock 形态对齐本文件 settingsMock，UpdateCheckCard 经 useAppUpdate mock 走真实组件）──
describe('testProxy 测试代理结果渲染（W3-A6）', () => {
  it('测试失败时显示两行（message + suggestion）', async () => {
    settingsMock.testProxy.mockResolvedValue({
      success: false,
      message: '无法连接代理 (EHOSTUNREACH)',
      suggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络',
    })

    const wrapper = mount(UpdatePage)
    await flushPromises()

    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    expect(testButton.exists()).toBe(true)
    await testButton.trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)

    const text = result.text()
    // 第一行：错误摘要
    expect(text).toContain('代理连接失败: 无法连接代理 (EHOSTUNREACH)')
    // 第二行：恢复指引
    expect(text).toContain('macOS 未授予「本地网络」权限')
  })

  it('测试成功时只显示成功消息（不显示 suggestion）', async () => {
    settingsMock.testProxy.mockResolvedValue({ success: true })

    const wrapper = mount(UpdatePage)
    await flushPromises()

    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    await testButton.trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接成功')
    expect(result.text()).not.toContain('macOS')
  })

  it('测试失败无 suggestion 时只显示一行', async () => {
    settingsMock.testProxy.mockResolvedValue({
      success: false,
      message: 'fetch failed',
    })

    const wrapper = mount(UpdatePage)
    await flushPromises()

    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    await testButton.trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接失败: fetch failed')
  })
})
