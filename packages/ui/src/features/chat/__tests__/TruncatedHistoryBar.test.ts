/**
 * TruncatedHistoryBar.vue 组件测试（[u4d-truncated-ui]，crash-resilience §3.3 D4）。
 *
 * 三视角 DOM 断言（TEST-STRATEGY §3）：
 * - 必测①：truncated=true 形态——「已加载最近 N 轮」文案 + 「加载更早」按钮可见
 * - 必测③（DOM 半边）：点击「加载更早」→ emit load（壳层接 useLoadMoreHistory.handleLoadMore
 *   → [u6] 游标翻页；core 半边断言在 core __tests__/truncated-window.test.ts）
 * - loading 态：按钮 disabled + spinner（A6 反向「truncated=false 不显示」由壳层 v-if
 *   承担，DOM 断言在 renderer MessageStream-truncated-bar.test.ts）
 *
 * 运行：cd packages/ui && npx vitest run src/features/chat/__tests__/TruncatedHistoryBar.test.ts
 */
import { describe, it, expect, vi } from 'vitest'

// 覆盖全局 setup 的 t：断言真实文案（与 renderer locales zh-CN 同文）
vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const msgs: Record<string, string> = {
        'panel.message.loadedRecentTurns': '已加载最近 {count} 轮',
        'panel.message.loadEarlier': '加载更早',
        'common.loading': '加载中…',
      }
      let s = msgs[key] ?? key
      if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v))
      return s
    },
  }),
}))

import { mount } from '@vue/test-utils'
import TruncatedHistoryBar from '../TruncatedHistoryBar.vue'

describe('TruncatedHistoryBar 历史预算截断顶部条（u4d）', () => {
  it('必测①：渲染「已加载最近 N 轮」文案 + 「加载更早」按钮可见', () => {
    const wrapper = mount(TruncatedHistoryBar, { props: { loadedTurns: 20 } })
    const bar = wrapper.find('[data-testid="truncated-history-bar"]')
    expect(bar.exists()).toBe(true)
    // 用户可见文案（N 来自 u4b session.history loadedTurns）
    expect(wrapper.find('[data-testid="truncated-history-info"]').text()).toBe('已加载最近 20 轮')
    // 「加载更早」入口可见且可点（[u6] 游标翻页通路）
    const btn = wrapper.find('[data-testid="load-more-history"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toContain('加载更早')
    expect(btn.attributes('disabled')).toBeUndefined()
  })

  it('必测③（DOM 半边）：点击「加载更早」→ emit load（壳层接 handleLoadMore → [u6] 游标翻页）', async () => {
    const wrapper = mount(TruncatedHistoryBar, { props: { loadedTurns: 20 } })
    await wrapper.find('[data-testid="load-more-history"]').trigger('click')
    expect(wrapper.emitted('load')).toHaveLength(1)
  })

  it('loading=true：按钮禁用 + spinner + 文案切换，点击不触发 load', async () => {
    const wrapper = mount(TruncatedHistoryBar, { props: { loadedTurns: 20, loading: true } })
    const btn = wrapper.find('[data-testid="load-more-history"]')
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.text()).toContain('加载中…')
    expect(btn.find('.animate-spin').exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('load')).toBeUndefined()
  })
})
