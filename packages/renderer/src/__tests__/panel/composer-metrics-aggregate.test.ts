/**
 * ComposerMetricsAggregate 测试 —— W3a 指标聚合按钮（hover 出三卡聚合页）。
 *
 * 三视角：
 * - 使用者黑盒：触发器 DOM（单图标按钮 + title「指标」）+ 真实 HoverCard 路径打开聚合页
 *   （focus → reka open 计时器 → 内容进 body portal，对齐 context-capacity-quota 的 openPopover 形态）；
 * - 观察者形态：HoverCard 家族 stub 常开，断言聚合页三段卡齐全（容量 / 速度 / 缓存 的
 *   文案与 data-testid）+ 两条发丝分隔 + 帧驱动实时值；
 * - 构建者白盒：数据注入经真实 events.dispatchSession 通道（对齐 gen-stats-triggers.test.ts 形态）。
 *
 * mock 边界：getGenStats / getContext 恢复腿均为受控 pending（不落地，不污染帧直驱断言）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-metrics-aggregate.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as events from '@taiji/core/transport/api'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightGenStatsForTest } from '@/composables/features/model/useGenStats'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'
import type { GenStatsFrame, ServerMessage } from '@taiji/shared'

import ComposerMetricsAggregate from '@/components/panel/ComposerMetricsAggregate.vue'

// ── mock：getGenStats（command 门面）与 getContext（session domain 门面）均为受控 pending ──
const commandMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core/transport/api')>()
  return { ...actual, command: commandMock, RPC_BACKSTOP_TIMEOUT_MS: 30_000 }
})
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return { ...actual, session }
})

/** HoverCard 家族 stub：内容常开渲染（观察者形态——聚合页内容可 DOM 断言） */
const HOVER_STUBS = {
  HoverCard: { name: 'HoverCard', template: '<div><slot /></div>' },
  HoverCardTrigger: { name: 'HoverCardTrigger', template: '<div><slot /></div>' },
  HoverCardContent: { name: 'HoverCardContent', template: '<div><slot /></div>' },
}

function genFrame(sessionId: string, overrides: Partial<GenStatsFrame> = {}): GenStatsFrame {
  return {
    sessionId,
    speed: { current: 35, day: 28, d7: 22, d30: 19 },
    cacheRatio: { current: 91, day: 87 },
    model: 'prov-a/m1',
    ...overrides,
  }
}

function pushSessionMsg(sid: string, msg: ServerMessage): void {
  events.dispatchSession(sid, msg)
}

function mountAggregate(stubHover = false) {
  return mount(ComposerMetricsAggregate, {
    props: { sessionId: 's1', modelId: 'prov-a/m1' },
    global: stubHover ? { stubs: HOVER_STUBS } : {},
  })
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
    // 触发器本身不带数值文本（数值在聚合页三卡里，信息不丢）
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
  it('三张卡齐全：容量段（上下文容量/已用/使用率）+ 速度段 head + 缓存段 head 与数值 testid', () => {
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

  it('卡间恰好三条发丝分隔（h-px + bg-border-strong），无死分隔（四卡：容量/TTFT/速度/缓存）', () => {
    const wrapper = mountAggregate(true)
    const separators = wrapper.findAll('span.h-px.bg-border-strong')
    expect(separators).toHaveLength(3)
  })

  it('帧驱动：stats 帧直达聚合页（速度 35 t/s / 命中率 91% 实时可见）', async () => {
    const wrapper = mountAggregate(true)
    await flushPromises()

    pushSessionMsg('s1', { type: 'session.stats_update', payload: genFrame('s1') })
    await flushPromises()

    // 卡内行实时值（同源分区：聚合页与触发器读同一份帧）
    const text = wrapper.text()
    expect(text).toContain('35 t/s')
    expect(text).toContain('91%')
    expect(text).toContain('近 7 天')
    expect(wrapper.find('[data-testid="genstats-speed-model"]').text()).toBe('prov-a/m1')
    // 缓存 bar：宽度 = 命中率（观察者形态）
    const bar = wrapper.find('[data-testid="genstats-cache-bar"]')
    expect((bar.element as HTMLElement).style.width).toBe('91%')
  })
})
