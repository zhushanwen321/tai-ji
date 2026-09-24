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
import { nextTick } from 'vue'
import { getCardUpdateHarness, makeCardRelease, resetCardUpdateHarness, useAppUpdateCardModule } from '@/__tests__/helpers/update-card-mock'
import type { UpdateAppState } from '@/composables/features/settings/use-app-update-state'

// __APP_VERSION__ 是 vite define 注入的全局常量，vitest 下不存在，stub 之
vi.stubGlobal('__APP_VERSION__', '0.9.7')

// 真实控制器注入（helpers/update-card-mock.ts）：state 恒真形状（UpdateAppState 全 6 字段）
vi.mock('@/composables/features/settings/useAppUpdate', () => useAppUpdateCardModule())

import UpdateButton from '@/components/sidebar/UpdateButton.vue'

function setTestState(partial: Partial<UpdateAppState>): void {
  Object.assign(getCardUpdateHarness().controller.state, partial)
}

beforeEach(() => {
  resetCardUpdateHarness()
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
      latestRelease: makeCardRelease('0.9.9'),
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
