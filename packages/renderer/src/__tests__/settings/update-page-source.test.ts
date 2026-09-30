/**
 * UpdatePage · 更新来源三选控件测试（update-multi-source u-settings-ui）。
 *
 * 覆盖（更新来源行，自动更新卡内）：
 *  - testid 存在：DOM 含 select-update-source（SelectTrigger）
 *  - 三选项渲染：下拉打开后 option 文案含「自动（推荐）」「GitHub」「GitCode」
 *  - 加载回填：getUpdateSettings.updateSource → trigger 显示对应选项；字段缺失 → 缺省「自动（推荐）」
 *  - 切换持久化：点选 GitHub → setUpdateSettings({ updateSource: 'github' }) 且 trigger 显示 GitHub
 *  - 不触发 force 检查：切换只写偏好，checkForUpdate 不被调用（D3：生效以缓存 TTL 为界）
 *  - 失败回滚：setUpdateSettings reject → trigger 保持原选项 + toast error（不抛错）
 *
 * Mock 策略（同 update-page.test.ts，单源）：
 *  - 三条 vi.mock 注册收进 helpers/update-page-mocks.ts（import 即注册，副作用模块）；
 *    脚手架（beforeEach 重置/默认值 + afterEach 卸载）单源在 helpers/update-page-mount.ts
 *  - Select 交互经 reka-ui 真实组件：pointerdown 打开下拉（SelectPortal teleport 到 body），
 *    在 document.body 找 [role="option"] 点选（交互序列单源在 helpers/reka-select-harness.ts）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-page-source.test.ts
 */
import { describe, it, expect } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import '@/__tests__/helpers/update-page-mocks'
import {
  getCardUpdateHarness,
  settingsMock,
  toastMock,
} from '@/__tests__/helpers/update-card-mock'
import { mountUpdatePage, setupUpdatePageLifecycle } from '@/__tests__/helpers/update-page-mount'
import { openRekaDropdown, pickRekaOption } from '@/__tests__/helpers/reka-select-harness'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub（'0.0.0-test'）

// 脚手架（beforeEach 重置/默认值 + afterEach 卸载清 body）单源在 helpers/update-page-mount.ts
setupUpdatePageLifecycle()

/** 打开 select-update-source 的下拉，返回全部 option（reka 交互序列单源在 helpers/reka-select-harness.ts） */
async function openSourceDropdown(wrapper: VueWrapper): Promise<HTMLElement[]> {
  return openRekaDropdown(wrapper.find('[data-testid="select-update-source"]').element)
}

/** 在 select-update-source 的下拉中点选指定文案的 option（reka 交互序列同上单源） */
async function pickOption(label: string, wrapper: VueWrapper): Promise<void> {
  await pickRekaOption(wrapper.find('[data-testid="select-update-source"]').element, label)
}

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
