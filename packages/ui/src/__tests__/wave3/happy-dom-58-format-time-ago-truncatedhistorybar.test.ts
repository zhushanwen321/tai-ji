import TruncatedHistoryBar from '../../features/chat/TruncatedHistoryBar.vue';
import { formatQuotaTimeAgo, MS_PER_SEC, SEC_PER_MIN, MIN_PER_HOUR, HOUR_PER_DAY } from '../../features/settings/coding-plan/format-time-ago';
import { mount } from '@vue/test-utils';
import { describe, it, expect, vi } from 'vitest';

// wave3 簇 [ui/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - features/chat/__tests__/TruncatedHistoryBar.test.ts
 * - features/settings/coding-plan/__tests__/format-time-ago.test.ts
 */

// ======================================================================
// ← features/chat/__tests__/TruncatedHistoryBar.test.ts
// ======================================================================

// 覆盖全局 setup 的 t：断言真实文案（与 renderer locales zh-CN 同文）；共享口径见 helpers/i18n-mock
vi.mock('vue-i18n', async () => {
  const { i18nMock } = await import('../helpers/i18n-mock')
  return i18nMock({
    'panel.message.loadedRecentTurns': '已加载最近 {count} 轮',
    'panel.message.loadEarlier': '加载更早',
    'panel.message.loadingMore': '正在续载…',
    'common.loading': '加载中…',
  })
})

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
    expect(btn.text()).toContain('正在续载…')
    expect(btn.find('.animate-spin').exists()).toBe(true)
    await btn.trigger('click')
    expect(wrapper.emitted('load')).toBeUndefined()
  })
})

// ======================================================================
// ← features/settings/coding-plan/__tests__/format-time-ago.test.ts
// ======================================================================

const NOW = 1_000_000_000_000

/** stub 文案：把 key + n 压成可断言字符串。 */
const t = (key: string, { n }: { n: number }): string => `${key}|${n}`

function ago(seconds: number): number {
  return NOW - seconds * MS_PER_SEC
}

function fmt(seconds: number): string {
  return formatQuotaTimeAgo(ago(seconds), NOW, t)
}

describe('formatQuotaTimeAgo 档位边界', () => {
  it('59/60min 边界：59min → Minutes(59)，60min → Hours(1)', () => {
    const min = SEC_PER_MIN
    expect(fmt(59 * min)).toBe('settings.providerEdit.quotaTimeAgoMinutes|59')
    expect(fmt(60 * min)).toBe('settings.providerEdit.quotaTimeAgoHours|1')
  })

  it('23/24h 边界：23h → Hours(23)，24h → Days(1)', () => {
    const hourSec = MIN_PER_HOUR * SEC_PER_MIN
    expect(fmt(23 * hourSec)).toBe('settings.providerEdit.quotaTimeAgoHours|23')
    expect(fmt(24 * hourSec)).toBe('settings.providerEdit.quotaTimeAgoDays|1')
  })

  it('59/60s 边界：59s → Seconds(59)，60s → Minutes(1)', () => {
    expect(fmt(59)).toBe('settings.providerEdit.quotaTimeAgoSeconds|59')
    expect(fmt(60)).toBe('settings.providerEdit.quotaTimeAgoMinutes|1')
  })

  it('多天形态：1439min → Hours(23)，1440min → Days(1)，72h → Days 向下取整(3)', () => {
    const s = (m: number) => m * SEC_PER_MIN
    expect(fmt(s(1439))).toBe('settings.providerEdit.quotaTimeAgoHours|23')
    expect(fmt(s(1440))).toBe('settings.providerEdit.quotaTimeAgoDays|1')
    expect(fmt(s(3 * 1440))).toBe('settings.providerEdit.quotaTimeAgoDays|3')
  })

  it('常量导出与组件原值一致（换算基准防漂移）', () => {
    expect(MS_PER_SEC).toBe(1000)
    expect(SEC_PER_MIN).toBe(60)
    expect(MIN_PER_HOUR).toBe(60)
    expect(HOUR_PER_DAY).toBe(24)
  })
})
