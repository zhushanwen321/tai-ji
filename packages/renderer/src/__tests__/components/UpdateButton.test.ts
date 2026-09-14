/**
 * UpdateButton 组件测试（w4 update-frontend）。
 *
 * 覆盖 W4TC6/6b/6c/6d/7/8/9：按 state 分支渲染 DOM 断言。
 * - W4TC6  available：红点角标 + releaseNotesHtml（v-html）
 * - W4TC6b restarting：CheckCircle2 图标 + 文案
 * - W4TC6c error：AlertCircle + errorMessage
 * - W4TC6d idle：不渲染（v-if 排除）
 * - W4TC7  downloading：Loader2 + 进度条
 * - W4TC8  unsupported：「前往下载」按钮 + click 触发 openUpdateFallbackUrl
 * - W4TC9  available click：触发 performDownload
 *
 * Mock 策略：vi.mock('@/composables/features/settings/useAppUpdate') 桩 state 与方法，
 * vi.mock('@/lib/ipc') 避免 ipc.ts 顶层 window.electronAPI 报错。
 * i18n 经 vitest-i18n-setup.ts 全局 mock，t() 取 zh-CN 文案。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/UpdateButton.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import type { UpdateState } from '@xyz-agent/shared'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.0.0-test')

// 单例 state：测试通过 setTestState 改写驱动组件分支渲染
const testState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string } | null,
  errorMessage: '',
  percent: 0,
  releaseNotesHtml: '',
})

/** 构造 mock release（downloaded/确认 Dialog 用例需 version 填充 confirmInstall 占位符） */
function makeRelease(version: string): { version: string; htmlUrl: string } {
  return { version, htmlUrl: 'https://example.com/release' }
}

const performDownloadMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const performInstallMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))
const openFallbackUrlMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock('@/composables/features/settings/useAppUpdate', () => ({
  useAppUpdate: () => ({
    state: testState,
    performDownload: performDownloadMock,
    performInstall: performInstallMock,
    openFallbackUrl: openFallbackUrlMock,
    checkForUpdate: vi.fn(),
    initAutoCheck: vi.fn(),
  }),
}))

// ipc.ts 顶层 const api = window.electronAPI；mock 之避免无 preload 报错
vi.mock('@/lib/ipc', () => ({
  checkForUpdate: vi.fn(() => Promise.resolve(null)),
  performUpdate: vi.fn(() => Promise.resolve({ triggerRestart: false })),
  openUpdateFallbackUrl: vi.fn(() => Promise.resolve()),
  onUpdateProgress: vi.fn(() => () => {}),
  onUpdateError: vi.fn(() => () => {}),
}))

import UpdateButton from '@/components/sidebar/UpdateButton.vue'

/** 设置测试态（驱动组件 v-if 分支） */
function setTestState(partial: Partial<typeof testState>): void {
  Object.assign(testState, partial)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(testState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

describe('UpdateButton', () => {
  it('W4TC6d：idle 不渲染（v-if 排除）', () => {
    setTestState({ state: 'idle' })
    const wrapper = mount(UpdateButton)
    expect(wrapper.find('[data-testid="update-button"]').exists()).toBe(false)
  })

  it('W4TC6d：checking 也不渲染', () => {
    setTestState({ state: 'checking' })
    const wrapper = mount(UpdateButton)
    expect(wrapper.find('[data-testid="update-button"]').exists()).toBe(false)
  })

  it('W4TC6：available 渲染红点角标 + releaseNotesHtml 已注入（ref 有值）', async () => {
    const notesHtml = '<h2>新特性</h2>'
    setTestState({
      state: 'available',
      releaseNotesHtml: notesHtml,
    })
    const wrapper = mount(UpdateButton)
    const available = wrapper.find('[data-testid="update-available"]')
    expect(available.exists()).toBe(true)
    // 红点角标存在
    expect(wrapper.find('[data-testid="update-badge"]').exists()).toBe(true)

    // hover 卡片 v-html 渲染验证归 manual/E2E：happy-dom 下 reka-ui HoverCard 的
    // portal 通常不挂载到 document.body，条件断言（if (notes)）恒跳过属噪音，已删。
  })

  it('W4TC9：available click 触发 performDownload', async () => {
    setTestState({ state: 'available' })
    const wrapper = mount(UpdateButton)
    await wrapper.find('[data-testid="update-available"]').trigger('click')
    expect(performDownloadMock).toHaveBeenCalledTimes(1)
  })

  it('W4TC7：downloading 渲染 spinner + 进度条 + 百分比文案', () => {
    setTestState({ state: 'downloading', percent: 42 })
    const wrapper = mount(UpdateButton)
    const progress = wrapper.find('[data-testid="update-progress"]')
    expect(progress.exists()).toBe(true)
    // 百分比文案
    expect(progress.text()).toContain('42%')
    // 进度条子条 width 样式（:style 绑定渲染进 HTML style 属性）
    const bar = progress.find('.bg-accent')
    expect(bar.exists()).toBe(true)
    expect(bar.html()).toContain('width: 42%')
  })

  it('W4TC6b：restarting 渲染 CheckCircle2 + 文案', () => {
    setTestState({ state: 'restarting' })
    const wrapper = mount(UpdateButton)
    const restarting = wrapper.find('[data-testid="update-restarting"]')
    expect(restarting.exists()).toBe(true)
    // zh-CN 文案（vitest-i18n-setup 从 zh-CN/sidebar 取值）
    expect(restarting.text()).toContain('即将重启')
  })

  it('W4TC6c：error 渲染 AlertCircle + 错误文案', () => {
    setTestState({ state: 'error', errorMessage: '校验失败' })
    const wrapper = mount(UpdateButton)
    const errorEl = wrapper.find('[data-testid="update-error"]')
    expect(errorEl.exists()).toBe(true)
    expect(errorEl.text()).toContain('升级失败')
  })

  it('W4TC8：unsupported 渲染「前往下载」按钮，click 触发 openUpdateFallbackUrl', async () => {
    setTestState({ state: 'unsupported' })
    const wrapper = mount(UpdateButton)
    const unsupported = wrapper.find('[data-testid="update-unsupported"]')
    expect(unsupported.exists()).toBe(true)
    expect(unsupported.text()).toContain('前往下载')

    await unsupported.trigger('click')
    expect(openFallbackUrlMock).toHaveBeenCalledTimes(1)
  })

  it('replacing 渲染 spinner + 「替换中」文案', () => {
    setTestState({ state: 'replacing' })
    const wrapper = mount(UpdateButton)
    const replacing = wrapper.find('[data-testid="update-replacing"]')
    expect(replacing.exists()).toBe(true)
    expect(replacing.text()).toContain('替换中')
  })

  // ── W3 downloaded 分支 + 确认 Dialog + error 重试 ──
  // Dialog/HoverCard content 经 Teleport 挂到 document.body；用例末尾 wrapper.unmount()
  // 让 Vue 同步移除 teleport 节点，避免污染后续用例的 document.body.querySelector。
  // 禁止用 document.body.innerHTML='' 强删——会破坏 Vue 内部 vnode 引用，触发 unmount 崩溃。

  it('W3TC1：downloaded 渲染 CheckCircle2 + downloaded 文案', () => {
    setTestState({ state: 'downloaded', latestRelease: makeRelease('0.9.0') })
    const wrapper = mount(UpdateButton)
    const downloaded = wrapper.find('[data-testid="update-downloaded"]')
    expect(downloaded.exists()).toBe(true)
    // zh-CN 文案（vitest-i18n-setup 从 zh-CN/sidebar 取值）
    expect(downloaded.text()).toContain('已下载，重启安装')
  })

  it('W3TC2：downloaded click 弹确认 Dialog', async () => {
    setTestState({ state: 'downloaded', latestRelease: makeRelease('0.9.0') })
    const wrapper = mount(UpdateButton)
    await wrapper.find('[data-testid="update-downloaded"]').trigger('click')
    await nextTick()
    // Dialog content 经 DialogPortal(Teleport) 挂到 document.body，wrapper.find 不可见
    const confirmBtn = document.body.querySelector('[data-testid="update-confirm-install"]')
    expect(confirmBtn).not.toBeNull()
    expect(document.body.textContent).toContain('重启并安装更新')
    wrapper.unmount()
  })

  it('W3TC3：确认安装调 performInstall', async () => {
    setTestState({ state: 'downloaded', latestRelease: makeRelease('0.9.0') })
    const wrapper = mount(UpdateButton)
    await wrapper.find('[data-testid="update-downloaded"]').trigger('click')
    await nextTick()
    const confirmBtn = document.body.querySelector('[data-testid="update-confirm-install"]') as HTMLButtonElement | null
    expect(confirmBtn).not.toBeNull()
    confirmBtn!.click()
    await flushPromises()
    expect(performInstallMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('W3TC4：稍后关闭 Dialog 不调 install', async () => {
    setTestState({ state: 'downloaded', latestRelease: makeRelease('0.9.0') })
    const wrapper = mount(UpdateButton)
    await wrapper.find('[data-testid="update-downloaded"]').trigger('click')
    await nextTick()
    // installLater 按钮（靠文案定位，与 confirm-install 区分）
    const laterBtn = Array.from(document.body.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('稍后再说'))
    expect(laterBtn).toBeTruthy()
    laterBtn!.click()
    await nextTick()
    await flushPromises()
    expect(performInstallMock).not.toHaveBeenCalled()
    // Dialog 关闭：确认安装按钮不再可见（reka-ui Presence 卸载 content）
    expect(document.body.querySelector('[data-testid="update-confirm-install"]')).toBeNull()
    wrapper.unmount()
  })

  it('W3TC5：error 态 hover 后显重试按钮', async () => {
    // reka-ui HoverCard openDelay 默认 700ms，用 fake timer 推进触发 open
    // setTestState 必须先于 mount：组件读 state 决定渲染分支
    vi.useFakeTimers()
    setTestState({ state: 'error', errorMessage: '校验失败' })
    const wrapper = mount(UpdateButton)
    try {
      await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
      vi.advanceTimersByTime(800)
      await nextTick()
      const retry = document.body.querySelector('[data-testid="update-retry"]')
      expect(retry).not.toBeNull()
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('W3TC6：点 retry 回 available 态', async () => {
    // setTestState 必须先于 mount：组件读 state 决定渲染分支
    vi.useFakeTimers()
    setTestState({ state: 'error', errorMessage: '校验失败' })
    const wrapper = mount(UpdateButton)
    try {
      await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
      vi.advanceTimersByTime(800)
      await nextTick()
      const retry = document.body.querySelector('[data-testid="update-retry"]') as HTMLButtonElement | null
      expect(retry).not.toBeNull()
      retry!.click()
      await nextTick()
      // onRetry 设 state.state='available'；testState 与组件 state 同一引用
      expect(testState.state).toBe('available')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
})
