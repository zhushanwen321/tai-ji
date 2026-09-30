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
 *    工厂注入真实控制器 createAppUpdateController + 内存 ipc，同 system-page-update.test.ts）
 *  - mock 捕获层单例在 helpers/update-card-mock.ts；beforeEach 重置/默认值 + mount 编排 +
 *    afterEach 卸载在 helpers/update-page-mount.ts（与 update-page-source.test.ts 单源）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-page.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  settingsMock,
  toastMock,
  settingsApiModule,
  toastMockModule,
  useAppUpdateCardModule,
} from '@/__tests__/helpers/update-card-mock'
import { mountUpdatePage, setupUpdatePageLifecycle } from '@/__tests__/helpers/update-page-mount'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub（'0.0.0-test'）

// mock 捕获层单例在 helpers/update-card-mock.ts（原 vi.hoisted 块收敛）
vi.mock('@/api/domains/settings', () => settingsApiModule())

vi.mock('@/composables/useToast', () => toastMockModule())

vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())

// 脚手架（beforeEach 重置/默认值 + afterEach 卸载清 body）单源在 helpers/update-page-mount.ts
setupUpdatePageLifecycle()

describe('UpdatePage 自动更新卡', () => {
  it('首屏渲染：DOM 含自动更新开关 + 当前版本 pill + 检查更新按钮', async () => {
    const wrapper = await mountUpdatePage()
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
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('checked')
  })

  it('加载回填：getUpdateSettings.autoUpdate false → 开关为关', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
  })

  it('切换开关：click 调 setUpdateSettings({ autoUpdate: true }) 并更新开关状态', async () => {
    const wrapper = await mountUpdatePage()
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
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('checked')
    await sw.trigger('click')
    await flushPromises()
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: false })
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
  })

  it('持久化失败：开关保持原值 + toast error（不抛错）', async () => {
    settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
    // 切换触发持久化 → 失败 → 控件保持 unchecked
    await sw.trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // module 统一失败反馈：saveFailed toast 透传 IPC 错误文案（{reason} 插值）
    expect(toastMock.error).toHaveBeenCalledWith('保存失败：write failed')
    // 失败回滚路径无成功反馈（saved toast 仅在写成功出现）
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it('预下载开关回填不回归：preDownload true → switch-pre-download 为开', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: true, autoUpdate: false })
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-pre-download"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('data-state')).toBe('checked')
  })

  it('切换成功反馈：写成功后出现 saved toast（setting-field module 统一形态）', async () => {
    const wrapper = await mountUpdatePage()
    await wrapper.find('[data-testid="switch-auto-update"]').trigger('click')
    await flushPromises()
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(toastMock.info).toHaveBeenCalledWith('更新设置已保存')
  })
})

// ── load 失败契约（RD-4#8，样板 = subagent-engine-section.test.ts）：失败默认值不冒充已存值 ──
describe('UpdatePage load 失败契约（RD-4#8）', () => {
  it('getUpdateSettings reject → loadError 常驻提示 + 可落盘控件禁用 + 默认值不发写请求', async () => {
    settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down'))
    const wrapper = await mountUpdatePage()
    // 常驻提示 + 重试入口
    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('读取失败，显示的是默认值')
    expect(wrapper.find('[data-testid="update-page-load-retry"]').exists()).toBe(true)
    // 可落盘控件禁用（Switch disabled attribute + Select disabled prop + 保存按钮）
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="switch-pre-download"]').attributes('disabled')).toBeDefined()
    expect(wrapper.findComponent({ name: 'Select' }).props('disabled')).toBe(true)
    expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeDefined()
    // 禁用态下 click 不发写请求（默认值明确不可操作）
    await wrapper.find('[data-testid="switch-auto-update"]').trigger('click')
    await flushPromises()
    expect(settingsMock.setUpdateSettings).not.toHaveBeenCalled()
  })

  it('getProxyConfig reject → 同样归并置 loadError（组级 loadAll 任一失败即置位）', async () => {
    settingsMock.getProxyConfig.mockRejectedValue(new Error('proxy read failed'))
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeDefined()
  })

  it('RD-4#8：重试成功 → loadError 清除 + 控件恢复 + 权威值回填', async () => {
    settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down'))
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)

    // 重试：mock 改成功，权威值 autoUpdate=true
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
    await wrapper.find('[data-testid="update-page-load-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeUndefined()
    // 权威值回填：开关从占位 false 前进到已存 true
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
  })

  it('RD-4#8：重试仍失败 → loadError 保持 + 控件保持禁用', async () => {
    settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down'))
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)

    settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down again'))
    await wrapper.find('[data-testid="update-page-load-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="btn-save-proxy"]').attributes('disabled')).toBeDefined()
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

    const wrapper = await mountUpdatePage()

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

    const wrapper = await mountUpdatePage()

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

    const wrapper = await mountUpdatePage()

    const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
    await testButton.trigger('click')
    await flushPromises()

    const result = wrapper.find('[data-testid="test-proxy-result"]')
    expect(result.exists()).toBe(true)
    expect(result.text()).toContain('代理连接失败: fetch failed')
  })
})
