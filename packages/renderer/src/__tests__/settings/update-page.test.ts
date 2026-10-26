/**
 * UpdatePage · 更新设置页测试（单文件全功能区：自动更新卡 + load 失败契约 + testProxy
 * 结果渲染 + 预下载/代理表单保存 + 更新来源三选）。
 *
 * 为什么单文件：各功能区同 SUT（UpdatePage.vue）、同 mock 集同 helper，vitest 按测试文件
 * 隔离模块图——单文件让全部用例共享一份 beforeAll 全树装载预热（setupUpdatePageLifecycle）；
 * 按功能区拆文件会让每个文件各付一次 UpdatePage 全树装载（单份秒级，全量口径翻倍）。
 *
 * 覆盖（自动更新卡）：
 *  - 首屏冒烟：DOM 含自动更新 Switch（switch-auto-update）+ 当前版本 pill（current-version-pill）
 *    + 检查更新按钮（settings-update-check，UpdateCheckCard 内嵌渲染）
 *  - 加载回填：getUpdateSettings 返回 autoUpdate true → Switch 开；false → 关
 *  - 切换交互：切 Switch → setUpdateSettings({ autoUpdate }) 被调用
 *  - 失败恢复：setUpdateSettings reject → Switch 保持原值 + toast error（不抛错）
 *  - 预下载开关回填（原有行为不回归）：getUpdateSettings.preDownload → switch-pre-download 状态
 *
 * 覆盖（更新来源行，自动更新卡内，update-multi-source u-settings-ui）：
 *  - testid 存在：DOM 含 select-update-source（SelectTrigger）
 *  - 三选项渲染：下拉打开后 option 文案含「自动（推荐）」「GitHub」「GitCode」
 *  - 加载回填：getUpdateSettings.updateSource → trigger 显示对应选项；字段缺失 → 缺省「自动（推荐）」
 *  - 切换持久化：点选 GitHub → setUpdateSettings({ updateSource: 'github' }) 且 trigger 显示 GitHub
 *  - 不触发 force 检查：切换只写偏好，checkForUpdate 不被调用（D3：生效以缓存 TTL 为界）
 *  - 失败回滚：setUpdateSettings reject → trigger 保持原选项 + toast error（不抛错）
 *
 * Mock 策略：
 *  - 三条 vi.mock 注册（'@/api/domains/settings' / '@/composables/useToast' /
 *    '@/composables/features/settings/useAppUpdate'——UpdateCheckCard 唯一外部依赖，工厂注入
 *    真实控制器 createAppUpdateController + 内存 ipc）收进 helpers/update-page-mocks.ts
 *    （import 即注册，副作用模块）
 *  - mock 捕获层单例在 helpers/update-card-mock.ts；beforeEach 重置/默认值 + mount 编排 +
 *    afterEach 卸载在 helpers/update-page-mount.ts
 *  - Select 交互经 reka-ui 真实组件：pointerdown 打开下拉（SelectPortal teleport 到 body），
 *    在 document.body 找 [role="option"] 点选（交互序列单源在 helpers/reka-select-harness.ts）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-page.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flushPromises, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import '@/__tests__/helpers/update-page-mocks'
import {
  getCardUpdateHarness,
  settingsMock,
  toastMock,
} from '@/__tests__/helpers/update-card-mock'
import { mountUpdatePage, setupUpdatePageLifecycle } from '@/__tests__/helpers/update-page-mount'
import { openRekaDropdown, pickRekaOption } from '@/__tests__/helpers/reka-select-harness'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub（'0.0.0-test'）

// 脚手架（beforeAll 预热一份全树装载 + beforeEach 重置/默认值 + afterEach 卸载清 body）
// 单源在 helpers/update-page-mount.ts
setupUpdatePageLifecycle()

// ── 用例骨架 helper（文件内重复段单源；断言随骨架保留，用例只留差异覆写与专属断言）──

type PageWrapper = Awaited<ReturnType<typeof mountUpdatePage>>

/** 以 autoUpdate=true 挂载并断言开关初始为开（回填/开→关切换用例的公共基线） */
async function mountWithAutoUpdateOn(): Promise<PageWrapper> {
  settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: true })
  const wrapper = await mountUpdatePage()
  expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
  return wrapper
}

/** 挂载 + 断言开关初始为关 + 点击切换 + flush（persist 结果断言用例的公共前缀） */
async function mountAndToggleFromOff(): Promise<PageWrapper> {
  const wrapper = await mountUpdatePage()
  const sw = wrapper.find('[data-testid="switch-auto-update"]')
  expect(sw.attributes('data-state')).toBe('unchecked')
  await sw.trigger('click')
  await flushPromises()
  return wrapper
}

/** 以 getUpdateSettings reject('ipc down') 挂载并断言常驻 loadError 显形（load 失败契约用例共用） */
async function mountWithUpdateLoadError(): Promise<PageWrapper> {
  settingsMock.getUpdateSettings.mockRejectedValue(new Error('ipc down'))
  const wrapper = await mountUpdatePage()
  expect(wrapper.find('[data-testid="update-page-load-error"]').exists()).toBe(true)
  return wrapper
}

/** 挂载 → 点「测试代理」→ flush → 返回结果块（testProxy 结果渲染用例共用；按钮与结果块存在
 *  断言随骨架保留） */
async function mountAndTestProxy(): Promise<DOMWrapper<Element>> {
  const wrapper = await mountUpdatePage()
  const testButton = wrapper.find('[data-testid="btn-test-proxy"]')
  expect(testButton.exists()).toBe(true)
  await testButton.trigger('click')
  await flushPromises()
  const result = wrapper.find('[data-testid="test-proxy-result"]')
  expect(result.exists()).toBe(true)
  return result
}

/** 打开 select-update-source 的下拉，返回全部 option（reka 交互序列单源在 helpers/reka-select-harness.ts） */
async function openSourceDropdown(wrapper: VueWrapper): Promise<HTMLElement[]> {
  return openRekaDropdown(wrapper.find('[data-testid="select-update-source"]').element)
}

/** 在 select-update-source 的下拉中点选指定文案的 option（reka 交互序列同上单源） */
async function pickOption(label: string, wrapper: VueWrapper): Promise<void> {
  await pickRekaOption(wrapper.find('[data-testid="select-update-source"]').element, label)
}

describe('UpdatePage 自动更新卡', () => {
  it('首屏渲染：DOM 含自动更新开关 + 当前版本 pill + 检查更新按钮', async () => {
    const wrapper = await mountUpdatePage()
    // 自动更新开关存在
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.exists()).toBe(true)
    // 当前版本 pill 存在（[w3] demo 版本行形态：pill 只含版本号，渠道文案在同行 desc）
    const pill = wrapper.find('[data-testid="current-version-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.text()).toContain('v0.0.0-test')
    expect(wrapper.text()).toContain('stable 渠道')
    // UpdateCheckCard 内嵌渲染（检查更新状态机在自动更新卡内）
    expect(wrapper.find('[data-testid="settings-update-check"]').exists()).toBe(true)
  })

  it('加载回填：getUpdateSettings.autoUpdate true → 开关为开', async () => {
    await mountWithAutoUpdateOn()
  })

  it('加载回填：getUpdateSettings.autoUpdate false → 开关为关', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    const wrapper = await mountUpdatePage()
    const sw = wrapper.find('[data-testid="switch-auto-update"]')
    expect(sw.attributes('data-state')).toBe('unchecked')
  })

  it('切换开关：click 调 setUpdateSettings({ autoUpdate: true }) 并更新开关状态', async () => {
    // reka-ui Switch 通过 click 切换并 emit update:model-value
    const wrapper = await mountAndToggleFromOff()
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: true })
    // 持久化成功后开关状态更新
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('checked')
  })

  it('切换开关：开 → 关 调 setUpdateSettings({ autoUpdate: false })', async () => {
    const wrapper = await mountWithAutoUpdateOn()
    await wrapper.find('[data-testid="switch-auto-update"]').trigger('click')
    await flushPromises()
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ autoUpdate: false })
    expect(wrapper.find('[data-testid="switch-auto-update"]').attributes('data-state')).toBe('unchecked')
  })

  it('持久化失败：开关保持原值 + toast error（不抛错）', async () => {
    settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
    // 切换触发持久化 → 失败 → 控件保持 unchecked
    const wrapper = await mountAndToggleFromOff()
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
    const wrapper = await mountWithUpdateLoadError()
    // 常驻提示 + 重试入口
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
    const wrapper = await mountWithUpdateLoadError()

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
    const wrapper = await mountWithUpdateLoadError()

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

    const result = await mountAndTestProxy()

    const text = result.text()
    // 第一行：错误摘要
    expect(text).toContain('代理连接失败: 无法连接代理 (EHOSTUNREACH)')
    // 第二行：恢复指引
    expect(text).toContain('macOS 未授予「本地网络」权限')
  })

  it('测试成功时只显示成功消息（不显示 suggestion）', async () => {
    settingsMock.testProxy.mockResolvedValue({ success: true })

    const result = await mountAndTestProxy()

    expect(result.text()).toContain('代理连接成功')
    expect(result.text()).not.toContain('macOS')
  })

  it('测试失败无 suggestion 时只显示一行', async () => {
    settingsMock.testProxy.mockResolvedValue({
      success: false,
      message: 'fetch failed',
    })

    const result = await mountAndTestProxy()

    expect(result.text()).toContain('代理连接失败: fetch failed')
  })
})

describe('UpdatePage 预下载开关与代理表单保存（setting-field 编排）', () => {
  it('预下载开关：点 switch → setUpdateSettings({ preDownload: true }) 立即持久化', async () => {
    const wrapper = await mountUpdatePage()
    expect(settingsMock.getUpdateSettings).toHaveBeenCalled()

    const sw = wrapper.find('[data-testid="switch-pre-download"]')
    expect(sw.exists()).toBe(true)
    await sw.trigger('click')
    await flushPromises()

    expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ preDownload: true })
  })

  it('代理表单保存（system 模式直存）：点保存 → setProxyConfig 整体写回 + 成功 toast', async () => {
    const wrapper = await mountUpdatePage()

    await wrapper.find('[data-testid="btn-save-proxy"]').trigger('click')
    await flushPromises()

    expect(settingsMock.setProxyConfig).toHaveBeenCalledTimes(1)
    expect(settingsMock.setProxyConfig).toHaveBeenCalledWith({
      mode: 'system',
      httpProxy: undefined,
      httpsProxy: undefined,
    })
    // createExplicitSave 成功 toast（settings.update.saved = 「代理配置已保存」）
    expect(toastMock.info).toHaveBeenCalledWith('代理配置已保存')
  })

  it('代理保存失败：setProxyConfig reject → error toast 透传 RPC 错误文案（onError 路径）', async () => {
    settingsMock.setProxyConfig.mockRejectedValue(new Error('proxy down'))
    const wrapper = await mountUpdatePage()

    await wrapper.find('[data-testid="btn-save-proxy"]').trigger('click')
    await flushPromises()

    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // onError 文案 = settings.update.saveFailed 插值（半角冒号，locale 原文）
    expect(toastMock.error).toHaveBeenCalledWith('保存失败: proxy down')
  })
})

describe('UpdatePage 更新来源三选控件', () => {
  it('testid 存在：DOM 含 select-update-source trigger', async () => {
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="select-update-source"]').exists()).toBe(true)
  })

  it('三选项渲染：下拉 option 含「自动（推荐）」「GitHub」「GitCode」', async () => {
    const wrapper = await mountUpdatePage()
    const options = await openSourceDropdown(wrapper)
    const labels = options.map((el) => el.textContent ?? '')
    expect(labels).toContain('自动（推荐）')
    expect(labels).toContain('GitHub')
    expect(labels).toContain('GitCode')
    expect(labels).toHaveLength(3)
  })

  it('加载回填：updateSource=gitcode → trigger 显示 GitCode', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({
      preDownload: false,
      autoUpdate: false,
      updateSource: 'gitcode',
    })
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('GitCode')
  })

  it('加载回填：updateSource 缺失（旧 settings 文件）→ 缺省显示「自动（推荐）」', async () => {
    settingsMock.getUpdateSettings.mockResolvedValue({ preDownload: false, autoUpdate: false })
    const wrapper = await mountUpdatePage()
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('自动（推荐）')
  })

  it('切换持久化：点选 GitHub → setUpdateSettings({ updateSource: "github" }) + trigger 显示 GitHub', async () => {
    const wrapper = await mountUpdatePage()
    await pickOption('GitHub', wrapper)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledTimes(1)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'github' })
    // 持久化成功后 trigger 显示更新
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('GitHub')
  })

  it('切换持久化：点选 GitCode → setUpdateSettings({ updateSource: "gitcode" })', async () => {
    const wrapper = await mountUpdatePage()
    await pickOption('GitCode', wrapper)
    expect(settingsMock.setUpdateSettings).toHaveBeenCalledWith({ updateSource: 'gitcode' })
  })

  it('切换后不触发 force 检查：checkForUpdate 不被调用（D3：生效以缓存 TTL 为界）', async () => {
    const wrapper = await mountUpdatePage()
    await pickOption('GitHub', wrapper)
    expect(getCardUpdateHarness().ipc.checkForUpdate).not.toHaveBeenCalled()
  })

  it('持久化失败：trigger 保持原选项 + toast error（不抛错）', async () => {
    settingsMock.setUpdateSettings.mockRejectedValue(new Error('write failed'))
    const wrapper = await mountUpdatePage()
    await pickOption('GitHub', wrapper)
    // 失败回滚：trigger 仍显示初始选项「自动（推荐）」
    expect(wrapper.find('[data-testid="select-update-source"]').text()).toContain('自动（推荐）')
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    // module 统一失败反馈：saveFailed toast 透传 IPC 错误文案（{reason} 插值）
    expect(toastMock.error).toHaveBeenCalledWith('保存失败：write failed')
  })
})
