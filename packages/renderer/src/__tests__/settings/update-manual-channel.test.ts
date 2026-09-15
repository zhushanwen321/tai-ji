/**
 * UpdateCheckCard · 手动升级通道区测试（update-network-resilience D9 renderer 衔接）。
 *
 * 覆盖（三视角 · 使用者黑盒：每用例断言用户可见 DOM）：
 *  - 默认展开：DOM 含引导文案 + 「仅支持 app 已提示的新版本」限定语 + 目录路径展示
 *  - 路径推导：getDataDir('~ 缩写形态) + /update/manual 与 main 侧 MANUAL_ASSET_DIR 同源
 *  - 折叠交互：点折叠触发器 → 引导内容从 DOM 消失
 *  - 降级：getDataDir 无值（web/mock 环境）→ 展示「路径暂不可用」占位而非报错；
 *    getDataDir reject（IPC 异常）→ 同占位降级且不产生未处理 rejection
 *  - 「打开目录」按钮（u7b D9）：可见 + 点击触发 openUpdateManualDir IPC + 失败 toast 降级
 *
 * Mock 策略（同 update-page.test.ts 结构）：
 *  - vi.mock('@/composables/features/settings/useAppUpdate') 隔离单例 state
 *  - vi.mock('@/api/domains/settings') 提供 getDataDir / openUpdateManualDir（手动通道区 IPC
 *    依赖；组件已收编走 settings 域接缝，不再直取 @/lib/ipc）
 *  - useToast 保留真实模块（模块级单例，无 provider 依赖；断言失败态 toast 入列）
 *  - i18n 走 vitest-i18n-setup 全局 mock（zh-CN 真实文案，断言用户可见文本）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/settings/update-manual-channel.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import type { UpdateState } from '@taiji/shared'

// ── mock 层 ──

const getDataDirMock = vi.hoisted(() => vi.fn())
const openUpdateManualDirMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/domains/settings', () => ({
  getDataDir: getDataDirMock,
  openUpdateManualDir: openUpdateManualDirMock,
}))

const testState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string; releaseNotes: string } | null,
  errorMessage: '',
  errorSuggestion: '',
  percent: 0,
  releaseNotesHtml: '',
})

vi.mock('@/composables/features/settings/useAppUpdate', () => ({
  useAppUpdate: () => ({
    state: testState,
    checkForUpdate: vi.fn(() => Promise.resolve()),
    performDownload: vi.fn(() => Promise.resolve()),
    performInstall: vi.fn(() => Promise.resolve()),
    openFallbackUrl: vi.fn(() => Promise.resolve()),
    initAutoCheck: vi.fn(),
    restorePendingUpdate: vi.fn(),
    restorePreloadedUpdate: vi.fn(),
  }),
}))

import UpdateCheckCard from '@/components/settings/UpdateCheckCard.vue'
import { useToast } from '@/composables/useToast'

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  getDataDirMock.mockReset()
  // 默认：dev 数据目录（~ 缩写展示形态，与 bridge-handlers get-data-dir 返回一致）
  getDataDirMock.mockResolvedValue('~/.taiji-dev')
  openUpdateManualDirMock.mockReset()
  openUpdateManualDirMock.mockResolvedValue({ success: true })
  Object.assign(testState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    errorSuggestion: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  // 清空 toast 单例在列（失败态用例入列的 error toast 不跨用例残留）
  const { toasts } = useToast()
  toasts.value.splice(0, toasts.value.length)
})

describe('UpdateCheckCard 手动升级通道区（D9）', () => {
  it('默认展开：DOM 含引导文案与「仅支持 app 已提示的新版本」限定语', async () => {
    wrapper = mount(UpdateCheckCard)
    await flushPromises()
    // 引导文案（用户可见）
    const hint = wrapper.find('[data-testid="settings-update-manual-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('从 release 页手动下载安装包')
    expect(hint.text()).toContain('重启应用或重试更新即可识别安装')
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
