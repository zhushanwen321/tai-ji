/**
 * UpdateCheckCard 单文件多源合并（round5-d 分区 4 簇 4-4 的相容子集）。
 *
 * 为什么单文件：vitest 按测试文件隔离模块图——两文件同 SUT（UpdateCheckCard.vue）、
 * 同 useAppUpdate mock 工厂（helpers/update-card-mock.ts），单文件共享一份装载。
 *
 * 来源文件（describe/it 块原样搬运，测试名零改动）：
 *  - system-page-update.test.ts（版本检查卡片 TC1-TC8 + 状态机补全，主体）
 *  - update-manual-channel.test.ts（手动升级通道区 D9 + 打开目录按钮 u7b）
 *
 * 冲突处理（试点模式）：
 *  - 两文件 vi.mock('@/composables/features/settings/useAppUpdate') 工厂相同
 *    （useAppUpdateCardModule），去重取一份；update-manual 独有的
 *    vi.mock('@/api/domains/settings')（getDataDir/openUpdateManualDir 窄 mock）
 *    提升为文件级——主体节的用例不断言手动通道区 DOM，mock 后无断言影响
 *  - 两文件模块级 wrapper 变量与 beforeEach/afterEach（resetCardUpdateHarness +
 *    wrapper unmount + toast 清空，均幂等重置）合并为一份公共 hook，共享一个
 *    wrapper 变量（两节用例互不重叠使用，语义等价）
 *
 * 簇注：同簇的 llm-retry-section / default-prompt-reference / remote-access-page
 * 不并入——llm-retry 的 useToast mock 与 remote-access 的真实 useToast 单例断言
 * 实质冲突；remote-access 的 @/lib/ipc 三方法窄 mock 会泄漏进 default-prompt 的
 * SettingsModal 全树。三文件保持原样。
 *
 * Dialog 测试要点（参考 UpdateButton.test.ts W3TC2-4）：
 * - Dialog content 经 DialogPortal(Teleport) 挂到 document.body，wrapper.find 不可见，
 *   用 document.body.querySelector 定位
 * - 开 Dialog 的用例末尾必须 wrapper.unmount() 清理 Teleport 节点
 * - 禁止 document.body.innerHTML='' 清理——会破坏 Vue 内部 vnode 引用触发 unmount 崩溃
 *
 * 运行：cd packages/renderer && TAIJI_TEST_DOMAIN=settings npx vitest run src/__tests__/settings/system-page-update.test.ts（本文件登记在 domain-map.json settings 域，默认档被排除）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getCardUpdateHarness, makeCardRelease, resetCardUpdateHarness, useAppUpdateCardModule } from '@/__tests__/helpers/update-card-mock'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import type { UpdateAppState } from '@/composables/features/settings/use-app-update-state'

// __APP_VERSION__ 在 vitest-i18n-setup.ts 全局 stub

// ── mock 层（useAppUpdate 两源文件同工厂去重；settings 域来自 update-manual-channel）──

const getDataDirMock = vi.hoisted(() => vi.fn())
const openUpdateManualDirMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/domains/settings', () => ({
  getDataDir: getDataDirMock,
  openUpdateManualDir: openUpdateManualDirMock,
}))

vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())

import UpdateCheckCard from '@/components/settings/UpdateCheckCard.vue'
import { useToast } from '@/composables/useToast'

// ══════════ 主体：原 system-page-update.test.ts 的 helper 与用例 ══════════

/** 设置测试态（驱动组件 v-if/v-else-if 分支；直改真实控制器的 state） */
function setTestState(partial: Partial<UpdateAppState>): void {
  Object.assign(getCardUpdateHarness().controller.state, partial)
}

/** 断言 force 检查恰好执行一次（TC2/TC7 共用断言对） */
function expectForceCheckCalledOnce(): void {
  expect(getCardUpdateHarness().ipc.checkForUpdate).toHaveBeenCalledTimes(1)
  expect(getCardUpdateHarness().ipc.checkForUpdate).toHaveBeenCalledWith({ force: true })
}

// 公共 hook（两源文件顶层 hook 的幂等并集：resetCardUpdateHarness + 手动通道 mock
// 默认值 + wrapper 兜底卸载 + toast 单例清列）
let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  resetCardUpdateHarness()
  // 默认：dev 数据目录（~ 缩写展示形态，与 bridge-handlers get-data-dir 返回一致）
  getDataDirMock.mockReset()
  getDataDirMock.mockResolvedValue('~/.taiji-dev')
  openUpdateManualDirMock.mockReset()
  openUpdateManualDirMock.mockResolvedValue({ success: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  // 清空 toast 单例在列（失败态用例入列的 error toast 不跨用例残留）
  const { toasts } = useToast()
  toasts.value.splice(0, toasts.value.length)
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

  it('TC2：点击检查按钮调 checkForUpdate(force=true)（RD-4#5 手动检查显形）', async () => {
    setTestState({ state: 'idle' })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    await wrapper.find('[data-testid="settings-update-check"]').trigger('click')
    expectForceCheckCalledOnce()
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
    setTestState({ state: 'available', latestRelease: makeCardRelease('0.9.0') })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 新版本号（i18n newVersionAvailable 含 {version}）
    expect(wrapper.find('[data-testid="settings-update-new-version"]').text()).toContain('0.9.0')
    // 下载按钮
    const downloadBtn = wrapper.find('[data-testid="settings-update-download"]')
    expect(downloadBtn.exists()).toBe(true)
    expect(downloadBtn.text()).toContain('下载并安装')
    // click → performDownload 执行到 ipc（动作断言走内存 adapter）
    await downloadBtn.trigger('click')
    expect(getCardUpdateHarness().ipc.updateDownload).toHaveBeenCalledTimes(1)
    expect(getCardUpdateHarness().ipc.updateDownload).toHaveBeenCalledWith('0.9.0')
  })

  it('TC5：downloaded 显示重启安装按钮，click 弹确认 Dialog', async () => {
    setTestState({ state: 'downloaded', latestRelease: makeCardRelease('0.9.0') })
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
    setTestState({ state: 'downloaded', latestRelease: makeCardRelease('0.9.0') })
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
    expect(getCardUpdateHarness().ipc.updateInstall).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    wrapper = null
  })

  it('TC7：error 态显示重试按钮，click 调 checkForUpdate(force=true)', async () => {
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
    expectForceCheckCalledOnce()
  })

  it('TC8：unsupported 态显示前往下载按钮，click 调 openFallbackUrl', async () => {
    // 摆 latestRelease：真实链 available → main 推送 unsupported 错误时 release 数据保留，
    // controller.openFallbackUrl 前置 latestRelease 提供 htmlUrl（无 release 时短路不调 ipc）
    setTestState({ state: 'unsupported', latestRelease: makeCardRelease('0.9.0') })
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 不支持文案
    expect(wrapper.text()).toContain('当前平台不支持自动更新')
    // 前往下载按钮
    const fallbackBtn = wrapper.find('[data-testid="settings-update-unsupported"]')
    expect(fallbackBtn.exists()).toBe(true)
    expect(fallbackBtn.text()).toContain('前往下载')
    await fallbackBtn.trigger('click')
    expect(getCardUpdateHarness().ipc.openExternal).toHaveBeenCalledTimes(1)
    expect(getCardUpdateHarness().ipc.openExternal).toHaveBeenCalledWith('https://example.com/release')
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

// ══════════ 来源：update-manual-channel.test.ts（手动升级通道区；其
//             @/api/domains/settings mock 与顶层 hook 已并入上方公共区） ══════════

describe('UpdateCheckCard 手动升级通道区（D9）', () => {
  it('默认展开：DOM 含引导文案与「仅支持 app 已提示的新版本」限定语', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 引导文案（用户可见）
    const hint = wrapper.find('[data-testid="settings-update-manual-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('从 release 页手动下载安装包')
    expect(hint.text()).toContain('重启应用或重试更新即可识别')
    // 限定语（D3 已知边界必须言明）
    const restriction = wrapper.find('[data-testid="settings-update-manual-restriction"]')
    expect(restriction.exists()).toBe(true)
    expect(restriction.text()).toContain('仅支持 app 已提示的新版本')
  })

  it('目录路径展示：getDataDir + /update/manual（与 main 侧 MANUAL_ASSET_DIR 同源）', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const dir = wrapper.find('[data-testid="settings-update-manual-dir"]')
    expect(dir.exists()).toBe(true)
    expect(dir.text()).toBe('~/.taiji-dev/update/manual')
  })

  it('折叠交互：点触发器 → 引导内容从 DOM 消失（标题仍可见）', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    expect(wrapper.find('[data-testid="settings-update-manual-hint"]').exists()).toBe(true)
    await wrapper.find('[data-testid="settings-update-manual-toggle"]').trigger('click')
    // reka-ui CollapsibleContent 无 forceMount：关闭即卸载内容
    expect(wrapper.find('[data-testid="settings-update-manual-hint"]').exists()).toBe(false)
    // 折叠区标题（触发器文案）常驻
    expect(wrapper.find('[data-testid="settings-update-manual-toggle"]').text()).toContain('手动升级通道')
  })

  it('降级：getDataDir 无值（web/mock 环境）→ 展示「路径暂不可用」占位', async () => {
    getDataDirMock.mockResolvedValue(undefined)
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const dir = wrapper.find('[data-testid="settings-update-manual-dir"]')
    expect(dir.exists()).toBe(true)
    expect(dir.text()).toBe('路径暂不可用')
  })

  it('降级：getDataDir reject（IPC 异常）→ 不产生未处理 rejection，路径区显示占位', async () => {
    getDataDirMock.mockRejectedValue(new Error('ipc get-data-dir unavailable'))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      wrapper = mount(UpdateCheckCard)
      await flushPromises()
      // onMounted async 不被 await：无 catch 会以 unhandledRejection 形态逃逸
      expect(unhandled).not.toHaveBeenCalled()
      const dir = wrapper.find('[data-testid="settings-update-manual-dir"]')
      expect(dir.exists()).toBe(true)
      expect(dir.text()).toBe('路径暂不可用')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('UpdateCheckCard 手动通道「打开目录」按钮（D9 u7b）', () => {
  it('按钮可见（用户可见 DOM：文案「打开目录」），点击触发 openUpdateManualDir IPC', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const btn = wrapper.find('[data-testid="settings-update-manual-open-dir"]')
    expect(btn.exists()).toBe(true)
    // 使用者黑盒：按钮文案用户可读
    expect(btn.text()).toBe('打开目录')
    expect(openUpdateManualDirMock).not.toHaveBeenCalled()

    await btn.trigger('click')
    // 构建者白盒：点击 → ipc 包装函数被调一次
    expect(openUpdateManualDirMock).toHaveBeenCalledTimes(1)
  })

  it('路径占位态（getDataDir 无值）按钮仍可用：目录由 main 侧创建，打开不依赖路径展示', async () => {
    getDataDirMock.mockResolvedValue(undefined)
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    const btn = wrapper.find('[data-testid="settings-update-manual-open-dir"]')
    expect(btn.exists()).toBe(true)
    await btn.trigger('click')
    expect(openUpdateManualDirMock).toHaveBeenCalledTimes(1)
  })

  it('失败降级：IPC reject → toast 错误提示（观察者形态），组件不中断', async () => {
    openUpdateManualDirMock.mockRejectedValue(new Error('Failed to open manual asset directory: no access'))
    wrapper = mount(UpdateCheckCard)
    await flushPromises()

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      await wrapper.find('[data-testid="settings-update-manual-open-dir"]').trigger('click')
      await flushPromises()
      // 观察者形态：错误进入 toast 单例在列（ToastContainer 渲染的用户可见通道）
      const { toasts } = useToast()
      expect(
        toasts.value.some((toast) => toast.type === 'error' && toast.message.includes('Failed to open manual asset directory')),
      ).toBe(true)
      // catch 已兜住，无未处理 rejection（不打断页面）
      expect(unhandled).not.toHaveBeenCalled()
      // 组件仍在渲染（按钮未消失）
      expect(wrapper.find('[data-testid="settings-update-manual-open-dir"]').exists()).toBe(true)
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
