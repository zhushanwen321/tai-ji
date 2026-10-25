/**
 * ComposerMetricsAggregate 测试 —— W3a 指标聚合按钮（hover 出四卡聚合页）。
 *
 * 三视角：
 * - 使用者黑盒：触发器 DOM（单图标按钮 + title「指标」）+ 真实 HoverCard 路径打开聚合页
 *   （focus → reka open 计时器 → 内容进 body portal，对齐 context-capacity-quota 的 openPopover 形态）；
 * - 观察者形态：HoverCard 家族 stub 常开，断言聚合页四段卡齐全（容量 / TTFT / 速度 / 缓存 的
 *   文案与 data-testid）+ 三条发丝分隔 + 帧驱动实时值；
 * - 构建者白盒：数据注入经真实 events.dispatchSession 通道（对齐 gen-stats 系测试形态）。
 *
 * mock 边界：getGenStats / getContext 恢复路径均为受控 pending（不落地，不污染帧直驱断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-metrics-aggregate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { commandMock, transportApiCommandModule } from '../helpers/transport-command-mock'
import { apiFacadeWithSessionDomain } from '../helpers/session-context-mock'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightGenStatsForTest } from '@/composables/features/model/useGenStats'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'
import {
  genStatsFrame as genFrame,
  mountGenStatsPanel,
  pushSessionMsg,
} from '../helpers/gen-stats-mount'

import ComposerMetricsAggregate from '@/components/panel/ComposerMetricsAggregate.vue'

// ── mock：getGenStats（command 门面）与 getContext（session domain 门面）均为受控 pending。
// spread-actual 工厂单源：helpers/transport-command-mock.ts（events 真实通道保留）+
// helpers/session-context-mock.ts（'@/api' 门面 session 域重指回被 mock 的 domain 模块）──
vi.mock('@taiji/core/transport/api', () => transportApiCommandModule())
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', () => apiFacadeWithSessionDomain())

/** GenStats 面板 mount 编排（HoverCard stub 家族 + props）单源在 helpers/gen-stats-mount */
function mountAggregate(stubHover = false) {
  return mountGenStatsPanel(ComposerMetricsAggregate, stubHover)
}

beforeEach(() => {
  setActivePinia(createPinia())
  commandMock.mockReset()
  commandMock.mockImplementation(() => new Promise(() => {}))
  getContextMock.mockReset()
  getContextMock.mockImplementation(() => new Promise(() => {}))
  __clearSessionCleanupRegistryForTest()
  __clearInFlightGenStatsForTest()
  __clearInFlightContextFetchForTest()
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

// ── 使用者黑盒（真实 HoverCard 渲染路径）────────────────────

describe('指标聚合触发器（黑盒 DOM）', () => {
  it('触发器渲染：单图标 Gauge 按钮，testid + title「指标」（用户可见 DOM）', () => {
    const wrapper = mountAggregate()
    const btn = wrapper.find('[data-testid="composer-metrics-aggregate"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('指标')
    // 单图标硬约束：按钮内只有一个 svg（禁多 icon 重叠）
    expect(btn.findAll('svg')).toHaveLength(1)
    // 触发器本身不带数值文本（数值在聚合页四卡里，信息不丢）
    expect(btn.text()).toBe('')
  })

  it('真实 HoverCard：focus 打开聚合页 → 内容进 body portal，容量段 head 可见', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const wrapper = mountAggregate()
    await wrapper.find('[data-testid="composer-metrics-aggregate"]').trigger('focus')
    await vi.advanceTimersByTimeAsync(700)
    await flushPromises()

    // 聚合页打开（portal 到 body）：容量卡 head 文案在 body 内可见；两卡 head 与 bar testid 在场
    // （genstats-speed-value / genstats-cache-value 属触发器，聚合页不渲染触发器，数值在卡内行）
    expect(document.body.textContent ?? '').toContain('上下文容量')
    expect(document.body.querySelector('[data-testid="genstats-speed-model"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="genstats-cache-model"]')).not.toBeNull()
    wrapper.unmount()
  })
})

// ── 观察者形态（HoverCard stub 常开：聚合页内容行断言）────────────

describe('聚合页四段卡（观察者形态）', () => {
  it('四张卡齐全：容量段（上下文容量/已用/使用率）+ TTFT 段 head + 速度段 head + 缓存段 head 与数值 testid', () => {
    const wrapper = mountAggregate(true)
    const text = wrapper.text()
    // ContextCapacityCard 段
    expect(text).toContain('上下文容量')
    expect(text).toContain('已用')
    expect(text).toContain('使用率')
    // GenStatsSpeedCard 段（head testid + 四行文案）
    expect(text).toContain('TOKEN 速度')
    expect(wrapper.find('[data-testid="genstats-speed-model"]').exists()).toBe(true)
    expect(text).toContain('暂无数据')
    // GenStatsTtftCard 段（head testid + 无帧显暂无数据）
    expect(text).toContain('首字延迟')
    expect(wrapper.find('[data-testid="genstats-ttft-model"]').exists()).toBe(true)
    // GenStatsCacheCard 段（head testid + 两行 + bar + 归因行 testid 在位）
    expect(text).toContain('缓存命中率')
    expect(wrapper.find('[data-testid="genstats-cache-model"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="genstats-cache-bar"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="genstats-cache-miss-note"]').exists()).toBe(false)
  })

  it('卡间恰好三条发丝分隔（h-px + hairline 档），无死分隔（四卡：容量/TTFT/速度/缓存）', () => {
    const wrapper = mountAggregate(true)
    const separators = wrapper.findAll('span.h-px.bg-\\[color\\:var\\(--hairline\\)\\]')
    expect(separators).toHaveLength(3)
  })

  it('帧驱动：stats 帧直达聚合页（本次值 + 5 统计量分布矩阵 + 命中率 + bar 实时可见）', async () => {
    const wrapper = mountAggregate(true)
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1') })
    await flushPromises()

    // 本次值（同源分区：聚合页各卡读同一份帧）
    expect(wrapper.find('[data-testid="genstats-speed-current"]').text()).toBe('35 t/s')
    expect(wrapper.find('[data-testid="genstats-ttft-current"]').text()).toBe('820ms')
    expect(wrapper.text()).toContain('91%')

    // 分布矩阵：列头五个统计量（每卡一份）+ 行头三个窗口（每卡一份）
    const columnHeaders = wrapper.findAll('[data-testid$="-dist-column"]').map((n) => n.text())
    expect(columnHeaders.filter((v) => v === '平均')).toHaveLength(2)
    expect(columnHeaders.filter((v) => v === 'P50')).toHaveLength(2)
    expect(columnHeaders.filter((v) => v === 'P99')).toHaveLength(2)
    expect(columnHeaders.filter((v) => v === '最大')).toHaveLength(2)
    expect(columnHeaders.filter((v) => v === '最小')).toHaveLength(2)
    const rowHeaders = wrapper.findAll('[data-testid$="-dist-row"]').map((n) => n.text())
    expect(rowHeaders.filter((v) => v === '今日')).toHaveLength(2)
    expect(rowHeaders.filter((v) => v === '7 天')).toHaveLength(2)
    expect(rowHeaders.filter((v) => v === '30 天')).toHaveLength(2)

    // 矩阵单元格逐格取值（速度行不带单位；TTFT 行带 ms/s 量级）
    expect(wrapper.find('[data-testid="genstats-speed-dist-day-avg"]').text()).toBe('28')
    expect(wrapper.find('[data-testid="genstats-speed-dist-day-p99"]').text()).toBe('19')
    expect(wrapper.find('[data-testid="genstats-speed-dist-day-min"]').text()).toBe('9')
    expect(wrapper.find('[data-testid="genstats-ttft-dist-d7-p50"]').text()).toBe('1.1s')
    expect(wrapper.find('[data-testid="genstats-ttft-dist-d30-max"]').text()).toBe('1.3s')

    expect(wrapper.find('[data-testid="genstats-speed-model"]').text()).toBe('prov-a/m1')
    // 缓存 bar：宽度 = 命中率（观察者形态；缓存卡不动，仍是两行单值）
    const bar = wrapper.find('[data-testid="genstats-cache-bar"]')
    expect((bar.element as HTMLElement).style.width).toBe('91%')
  })
})
