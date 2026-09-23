// @vitest-environment jsdom
/**
 * LoadMoreErrorBar.vue 组件测试（[RD-1#4] 「加载更早」失败重试行）。
 *
 * 覆盖（三视角 DOM 半边；状态源 useLoadMoreHistory.loadMoreError 的落位断言在
 * load-more-history.test.ts，壳层接线在 MessageStream-truncated-bar.test.ts）：
 * - 必测①：渲染 warn 色失败文案 + 「重试」按钮（用户可见的失败显形）
 * - 必测③（DOM 半边）：点击「重试」→ emit retry（壳层接 handleLoadMore 再走翻页通路）
 * - loading=true：按钮禁用 + spinner（与顶部条「加载更早」按钮态一致）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/components/LoadMoreErrorBar.test.ts
 */
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LoadMoreErrorBar from '@/components/panel/LoadMoreErrorBar.vue'

describe('LoadMoreErrorBar 「加载更早」失败重试行（RD-1#4）', () => {
  it('必测①：渲染失败文案 + 「重试」按钮可见', () => {
    const wrapper = mount(LoadMoreErrorBar)
    expect(wrapper.find('[data-testid="load-more-error-bar"]').exists()).toBe(true)
    // 用户可见文案（既有 i18n key common.loadFailed，未新增 locale key）
    expect(wrapper.find('[data-testid="load-more-error-text"]').text()).toBe('加载失败')
    const btn = wrapper.find('[data-testid="load-more-retry"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('重试')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('必测③（DOM 半边）：点击「重试」→ emit retry（壳层接 handleLoadMore）', async () => {
    const wrapper = mount(LoadMoreErrorBar)
    await wrapper.find('[data-testid="load-more-retry"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)
  })

  it('loading=true：按钮禁用 + spinner，点击不触发 retry', async () => {
    const wrapper = mount(LoadMoreErrorBar, { props: { loading: true } })
    const btn = wrapper.find('[data-testid="load-more-retry"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(wrapper.find('.animate-spin').exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('retry')).toBeUndefined()
  })
})
