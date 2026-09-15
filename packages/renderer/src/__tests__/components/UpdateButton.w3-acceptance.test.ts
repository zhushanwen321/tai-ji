/**
 * W3 验收测试 - UpdateButton 组件
 *
 * 覆盖验收场景：
 * - W3-A4-update-button-error-overlay-vitest: error 浮层显示 message + suggestion 两段
 * - W3-A5-hover-version-vitest: hover 卡片标题显示版本号
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/UpdateButton.w3-acceptance.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, nextTick } from 'vue'
import type { UpdateState } from '@taiji/shared'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.9.7')

// 单例 state：测试通过 setTestState 改写驱动组件分支渲染
const testState = reactive({
  state: 'idle' as UpdateState,
  latestRelease: null as { version: string; htmlUrl: string } | null,
  errorMessage: '',
  errorSuggestion: '',
  percent: 0,
  releaseNotesHtml: '',
})

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

vi.mock('@/lib/ipc', () => ({
  checkForUpdate: vi.fn(() => Promise.resolve(null)),
  performUpdate: vi.fn(() => Promise.resolve({ triggerRestart: false })),
  openUpdateFallbackUrl: vi.fn(() => Promise.resolve()),
  onUpdateProgress: vi.fn(() => () => {}),
  onUpdateError: vi.fn(() => () => {}),
}))

import UpdateButton from '@/components/sidebar/UpdateButton.vue'

function setTestState(partial: Partial<typeof testState>): void {
  Object.assign(testState, partial)
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(testState, {
    state: 'idle',
    latestRelease: null,
    errorMessage: '',
    errorSuggestion: '',
    percent: 0,
    releaseNotesHtml: '',
  })
})

describe('W3-A4-update-button-error-overlay-vitest', () => {
  it('W3-A4-update-button-error-overlay-vitest: error 浮层显示 message + suggestion 两段', async () => {
    vi.useFakeTimers()
    setTestState({
      state: 'error',
      errorMessage: '无法连接代理 (EHOSTUNREACH)',
      errorSuggestion: 'macOS 未授予「本地网络」权限。恢复指引：系统设置 → 隐私与安全性 → 本地网络',
    })
    const wrapper = mount(UpdateButton)
    try {
      // 触发 hover 打开 HoverCard
      await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
      vi.advanceTimersByTime(800)
      await nextTick()

      // HoverCard content 经 Teleport 挂到 document.body
      const content = document.body.querySelector('.w-\\[280px\\]')
      expect(content).not.toBeNull()

      // 验证两段式显示：message + suggestion
      const text = content!.textContent ?? ''
      expect(text).toContain('无法连接代理 (EHOSTUNREACH)')
      expect(text).toContain('macOS 未授予「本地网络」权限')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('W3-A4-update-button-error-overlay-vitest: 无 suggestion 时只显示 message', async () => {
    vi.useFakeTimers()
    setTestState({
      state: 'error',
      errorMessage: '网络连接失败',
      errorSuggestion: '',
    })
    const wrapper = mount(UpdateButton)
    try {
      await wrapper.find('[data-testid="update-error"]').trigger('pointerenter')
      vi.advanceTimersByTime(800)
      await nextTick()

      const content = document.body.querySelector('.w-\\[280px\\]')
      expect(content).not.toBeNull()

      const text = content!.textContent ?? ''
      expect(text).toContain('网络连接失败')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
})

describe('W3-A5-hover-version-vitest', () => {
  it('W3-A5-hover-version-vitest: hover 卡片标题显示版本号', async () => {
    vi.useFakeTimers()
    setTestState({
      state: 'available',
      latestRelease: { version: '0.9.9', htmlUrl: 'https://example.com' },
      releaseNotesHtml: '<p>Release notes</p>',
    })
    const wrapper = mount(UpdateButton)
    try {
      // 触发 hover 打开 HoverCard
      await wrapper.find('[data-testid="update-available"]').trigger('pointerenter')
      vi.advanceTimersByTime(800)
      await nextTick()

      // HoverCard content 经 Teleport 挂到 document.body
      const content = document.body.querySelector('.release-notes-content')
      expect(content).not.toBeNull()

      // 验证标题包含版本号
      const text = content!.textContent ?? ''
      expect(text).toContain('v0.9.9')
      // 验证版本过渡信息
      expect(text).toContain('v0.9.7')
      expect(text).toContain('v0.9.9')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
})
