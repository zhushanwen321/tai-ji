/**
 * UpdateCheckCard · 版本检查卡片测试（Settings 系统页内嵌组件）。
 *
 * 覆盖 TC1-TC8：按 useAppUpdate.state.state 分支渲染 DOM 断言 + 交互。
 * - TC1 idle      渲染当前版本 + 检查按钮（settings-update-check）
 * - TC2 click 检查 → checkForUpdate(true)
 * - TC3 checking   按钮 loading + disabled
 * - TC4 available  显示新版本号 + 下载按钮（settings-update-download），click → performDownload
 * - TC5 downloaded 重启安装按钮（settings-update-install），click → 弹确认 Dialog
 * - TC6 确认 Dialog 点「立即重启安装」（settings-update-confirm-install）→ performInstall
 * - TC7 error      重试按钮（settings-update-retry），click → checkForUpdate(true)
 * - TC8 unsupported 前往下载按钮（settings-update-unsupported），click → openFallbackUrl
 *
 * Mock 策略：仅需 vi.mock('@/composables/features/settings/useAppUpdate')（UpdateCheckCard 唯一外部依赖）。
 * 不需 SystemPage 的其他 mock（getAutoRenameEnabled/useToast/useCommandStore/listSystemSounds）——
 * UpdateCheckCard 是自包含组件，无 props、无 onMounted 副作用。
 *
 * Dialog 测试要点（参考 UpdateButton.test.ts W3TC2-4）：
 * - Dialog content 经 DialogPortal(Teleport) 挂到 document.body，wrapper.find 不可见，
 *   用 document.body.querySelector 定位
 * - 开 Dialog 的用例末尾必须 wrapper.unmount() 清理 Teleport 节点
 * - 禁止 document.body.innerHTML='' 清理——会破坏 Vue 内部 vnode 引用触发 unmount 崩溃
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/system-page-update.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cardTestState, checkForUpdateMock, performDownloadMock, performInstallMock, openFallbackUrlMock, useAppUpdateCardModule } from '@/__tests__/helpers/update-card-mock'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub

/** 构造 mock release（available/downloaded 用例需 version 填充占位符） */
function makeRelease(version: string): { version: string; htmlUrl: string; releaseNotes: string } {
  return { version, htmlUrl: 'https://example.com/release', releaseNotes: '' }
}

vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())

import UpdateCheckCard from '@/components/settings/UpdateCheckCard.vue'

/** 设置测试态（驱动组件 v-if/v-else-if 分支） */
function setTestState(partial: Partial<typeof cardTestState>): void {
  Object.assign(cardTestState, partial)
}

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  checkForUpdateMock.mockReset()
  performDownloadMock.mockReset()
  performInstallMock.mockReset()
  openFallbackUrlMock.mockReset()
  Object.assign(cardTestState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

afterEach(() => {
  // 若有未 unmount 的 wrapper（含 Teleport Dialog 节点），这里兜底清理
  wrapper?.unmount()
  wrapper = null
})

describe('UpdateCheckCard 版本检查卡片', () => {
  it('TC1：idle 渲染当前版本 + 检查按钮（settings-update-check）', async () => {
    setTestState({ state: 'idle' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 检查按钮存在
    const checkBtn = wrapper.find('[data-testid="settings-update-check"]')
    expect(checkBtn.exists()).toBe(true)
    expect(checkBtn.text()).toContain('检查更新')
  })

  it('TC2：点击检查按钮调 checkForUpdate(true)', async () => {
    setTestState({ state: 'idle' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    await wrapper.find('[data-testid="settings-update-check"]').trigger('click')
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1)
    expect(checkForUpdateMock).toHaveBeenCalledWith(true)
  })

  it('TC3：checking 态按钮 loading + disabled', async () => {
    setTestState({ state: 'checking' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const checkBtn = wrapper.find('[data-testid="settings-update-check"]')
    expect(checkBtn.exists()).toBe(true)
    // disabled 属性
    expect(checkBtn.attributes('disabled')).toBeDefined()
    // 文案为「检查中…」
    expect(checkBtn.text()).toContain('检查中')
  })

  it('TC4：available 显示新版本号 + 下载按钮，click 调 performDownload', async () => {
    setTestState({ state: 'available', latestRelease: makeRelease('0.9.0') })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 新版本号（i18n newVersionAvailable 含 {version}）
    expect(wrapper.find('[data-testid="settings-update-new-version"]').text()).toContain('0.9.0')
    // 下载按钮
    const downloadBtn = wrapper.find('[data-testid="settings-update-download"]')
    expect(downloadBtn.exists()).toBe(true)
    expect(downloadBtn.text()).toContain('下载并安装')
    // click → performDownload
    await downloadBtn.trigger('click')
    expect(performDownloadMock).toHaveBeenCalledTimes(1)
  })

  it('TC5：downloaded 显示重启安装按钮，click 弹确认 Dialog', async () => {
    setTestState({ state: 'downloaded', latestRelease: makeRelease('0.9.0') })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const installBtn = wrapper.find('[data-testid="settings-update-install"]')
    expect(installBtn.exists()).toBe(true)
    expect(installBtn.text()).toContain('重启并安装更新')
    // click → 弹 Dialog
    await installBtn.trigger('click')
    await nextTick()
    // Dialog content 经 Teleport 挂到 document.body，wrapper.find 不可见
    const confirmBtn = document.body.querySelector('[data-testid="settings-update-confirm-install"]')
    expect(confirmBtn).not.toBeNull()
    expect(document.body.textContent).toContain('重启并安装更新')
    wrapper.unmount()
    wrapper = null
  })

  it('TC6：确认 Dialog 点「立即重启安装」调 performInstall', async () => {
    setTestState({ state: 'downloaded', latestRelease: makeRelease('0.9.0') })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 打开 Dialog
    await wrapper.find('[data-testid="settings-update-install"]').trigger('click')
    await nextTick()
    const confirmBtn = document.body.querySelector(
      '[data-testid="settings-update-confirm-install"]',
    ) as HTMLButtonElement | null
    expect(confirmBtn).not.toBeNull()
    confirmBtn!.click()
    await flushPromises()
    expect(performInstallMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    wrapper = null
  })

  it('TC7：error 态显示重试按钮，click 调 checkForUpdate(true)', async () => {
    setTestState({ state: 'error', errorMessage: '下载校验失败' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 错误文案可见
    expect(wrapper.find('[data-testid="settings-update-error"]').text()).toContain('下载校验失败')
    // 重试按钮
    const retryBtn = wrapper.find('[data-testid="settings-update-retry"]')
    expect(retryBtn.exists()).toBe(true)
    expect(retryBtn.text()).toContain('重试')
    await retryBtn.trigger('click')
    expect(checkForUpdateMock).toHaveBeenCalledTimes(1)
    expect(checkForUpdateMock).toHaveBeenCalledWith(true)
  })

  it('TC8：unsupported 态显示前往下载按钮，click 调 openFallbackUrl', async () => {
    setTestState({ state: 'unsupported' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 不支持文案
    expect(wrapper.text()).toContain('当前平台不支持自动更新')
    // 前往下载按钮
    const fallbackBtn = wrapper.find('[data-testid="settings-update-unsupported"]')
    expect(fallbackBtn.exists()).toBe(true)
    expect(fallbackBtn.text()).toContain('前往下载')
    await fallbackBtn.trigger('click')
    expect(openFallbackUrlMock).toHaveBeenCalledTimes(1)
  })

  // ── 附加：downloading / replacing / restarting 渲染断言（补全状态机覆盖） ──

  it('downloading 渲染进度百分比文案', async () => {
    setTestState({ state: 'downloading', percent: 65 })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    expect(wrapper.text()).toContain('65%')
    // 下载态无 check/download/install 按钮
    expect(wrapper.find('[data-testid="settings-update-check"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="settings-update-download"]').exists()).toBe(false)
  })

  it('replacing 渲染替换中文案', async () => {
    setTestState({ state: 'replacing' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    expect(wrapper.text()).toContain('替换中')
  })

  it('restarting 渲染即将重启文案', async () => {
    setTestState({ state: 'restarting' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    expect(wrapper.text()).toContain('即将重启')
  })
})
