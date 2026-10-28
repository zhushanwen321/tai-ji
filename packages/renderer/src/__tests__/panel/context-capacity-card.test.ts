/**
 * ContextCapacityCard 纯读测试（W6 · Q1 修复 → context-consistency Phase 2.2 适配；
 * ui-optimize 决策 6 起宿主 = hover 指标聚合页的容量卡）。
 *
 * [迁移来源] 原文件 context-capacity-popover.test.ts mount 平铺触发器
 * ContextCapacityPopover 断言按钮文字——决策 6 退役平铺形态（组件删除）后，分区纯读的
 * 用户可见断言宿主换为 ContextCapacityCard（数字唯一入口：hover 指标聚合页），断言锚从
 * 触发器按钮文字换为卡内 stats 文本。组件纯读语义不变：per-session 分区状态在
 * useContextUsage composable，组件只做 status → 显示映射（ok → 真值；no-value/unknown →
 * 「—」）。切回恢复路径 / in-flight / 哨兵行为由 use-context-usage.test.ts（层 1）与
 * context-usage-journeys.test.ts（层 3）覆盖。
 *
 * mock 策略：getContext RPC mock 为受控 pending deferred（不 resolve，分区保持 unknown
 * 过渡态，不污染「无值/在途」断言——mock 门面的固定真值 reply 会让「—」断言失效）。
 *
 * ── 波 2a 簇 2-13 合并说明 ──
 * 节 2 = composer-metrics-aggregate.test.ts（指标聚合触发器 + 聚合页四段卡）；
 * 节 3 = context-usage-ring.test.ts（占用弧三档 + 无数据态）。
 * 三节同域（composer 上下文用量/指标聚合家族），mock 同构：
 * getContextMock（vi.hoisted 单例三节共享）、domains/session + '@/api' 门面转发去重为
 * 顶层一套；节 2/3 的 transportApiCommandModule mock（spread-actual 保真）提升文件级
 * ——节 1 的 events.dispatchSession 走真实通道不受影响（events 透传保留）。
 * **import 顺序注意**：helper import 必须排在触发被 mock 模块加载的组件 import 之前
 * （vi.mock 工厂引用 import 绑定，顺序颠倒 = TDZ ReferenceError，波 1 即栽在此）。
 * 三节原文件级 beforeEach/afterEach 下沉各自 describe 节内。describe/it 名零改动。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/__tests__/panel/context-capacity-card.test.ts --pool=threads
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { apiFacadeWithSessionDomain } from '../helpers/session-context-mock'
import { commandMock, transportApiCommandModule } from '../helpers/transport-command-mock'
import { __clearInFlightGenStatsForTest } from '@/composables/features/model/useGenStats'
import {
  genStatsFrame as genFrame,
  mountGenStatsPanel,
  pushSessionMsg,
} from '../helpers/gen-stats-mount'
import ComposerMetricsAggregate from '@/components/panel/ComposerMetricsAggregate.vue'
import ContextUsageRing from '@/components/panel/ContextUsageRing.vue'
import * as events from '@taiji/core/transport/api'
import { __clearSessionCleanupRegistryForTest } from '@/composables/useSessionScopedState'
import { __clearInFlightContextFetchForTest } from '@/composables/features/model/useContextUsage'
import type { ServerMessage } from '@taiji/shared'

import ContextCapacityCard from '@/components/panel/ContextCapacityCard.vue'

// ── mock 边界：getContext mock 为受控 pending（挂载触发的恢复路径不落地）；'@/api' 门面
//    session 域重指单源 helpers/session-context-mock（domain mock 一行内联 + 工厂转发）──
const getContextMock = vi.hoisted(() => vi.fn())
vi.mock('@taiji/core/transport/api/domains/session', () => ({ getContext: getContextMock }))
vi.mock('@/api', () => apiFacadeWithSessionDomain())
vi.mock('@taiji/core/transport/api', () => transportApiCommandModule())


/** 模拟 runtime 推送 session 通道消息 */
function pushSessionMsg(sid: string, msg: ServerMessage): void {
  events.dispatchSession(sid, msg)
}

describe('ContextCapacityCard 纯读 useContextUsage 分区', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    getContextMock.mockReset()
    getContextMock.mockImplementation(
      () => new Promise(() => {}) /* 永不 resolve：分区保持 unknown，本文件只测帧直驱显示 */,
    )
    __clearSessionCleanupRegistryForTest()
    __clearInFlightContextFetchForTest()
  })
  it('U29: 收到 context.update（含用量）→ 卡内显新用量（used「12K」+ 使用率「6%」）', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's1' },
    })
    await flushPromises()

    pushSessionMsg('s1', {
      type: 'context.update',
      id: 'push-1',
      payload: {
        sessionId: 's1',
        usagePercent: 6,
        inputTokens: 12000,
        contextLimit: 200000,
      },
    })
    await flushPromises()

    // stats 格式：used 格「{used}K」+ usageRate 格「{percent}%」—— 12000 → 12K
    const text = wrapper.text()
    expect(text).toContain('12K')
    expect(text).toContain('6%')
  })

  it('U30: 其他 session 的 context.update 不影响当前卡', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's1' },
    })
    await flushPromises()

    pushSessionMsg('other-session', {
      type: 'context.update',
      id: 'push-2',
      payload: {
        sessionId: 'other-session',
        usagePercent: 99,
        inputTokens: 99000,
        contextLimit: 100000,
      },
    })
    await flushPromises()

    // 未收到目标 session 的推送，分区仍 unknown（status≠'ok'）→ 使用率显「—」
    expect(wrapper.text()).toContain('—')
  })

  it('U31: 无值占位帧（仅含 sessionId，D1 空 = 字段缺失）→ 分区 no-value，使用率保持「—」', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's2' },
    })
    await flushPromises()

    pushSessionMsg('s2', {
      type: 'context.update',
      id: 'push-3',
      payload: {
        sessionId: 's2',
      },
    })
    await flushPromises()

    // 无值占位帧（字段缺失）→ 分区写 no-value → 使用率显「—」（合法无值诚实显示）
    expect(wrapper.text()).toContain('—')
  })

  it('contextLimit=0 但 inputTokens>0（provider 未配 contextWindow）→ 显已用量，不显百分比', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's4' },
    })
    await flushPromises()

    pushSessionMsg('s4', {
      type: 'context.update',
      id: 'ctx-no-window',
      payload: { sessionId: 's4', usagePercent: 0, inputTokens: 69000, contextLimit: 0 },
    })
    await flushPromises()

    // hasPercent=false → usageRate 格显「—」；used 格照常「69K」
    const text = wrapper.text()
    expect(text).toContain('69K')
    // 无百分比：卡内不含 % 号
    expect(text).not.toContain('%')
  })

  it('context.update 仍正常工作（不回归）', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's3' },
    })
    await flushPromises()

    pushSessionMsg('s3', {
      type: 'context.update',
      id: 'ctx-1',
      payload: { sessionId: 's3', usagePercent: 50, inputTokens: 50000, contextLimit: 100000 },
    })
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('50K')
    expect(text).toContain('50%')
  })

  it('大数显 M（≥100万 token）', async () => {
    const wrapper = mount(ContextCapacityCard, {
      props: { sessionId: 's5' },
    })
    await flushPromises()

    pushSessionMsg('s5', {
      type: 'context.update',
      id: 'ctx-big',
      payload: { sessionId: 's5', usagePercent: 80, inputTokens: 1630000, contextLimit: 2000000 },
    })
    await flushPromises()

    // 1630000 → 1.6M
    const text = wrapper.text()
    expect(text).toContain('1.6M')
    expect(text).toContain('80%')
  })
})

// ══════════ 节 2/3 — 来源: composer-metrics-aggregate.test.ts ══════════

/**
 * ComposerMetricsAggregate 测试 —— W3c 指标聚合（hover 指标页四段卡）。
 * mock：getGenStats（command 门面）与 getContext（session domain 门面）均为受控 pending；
 * spread-actual 工厂单源在顶层（events 真实通道保留）。
 * GenStats 面板 mount 编排（HoverCard stub 家族 + props）单源在 helpers/gen-stats-mount。
 */
/** GenStats 面板 mount 编排（HoverCard stub 家族 + props）单源在 helpers/gen-stats-mount */
function mountAggregate(stubHover = false) {
  return mountGenStatsPanel(ComposerMetricsAggregate, stubHover)
}


// ── 使用者黑盒（真实 HoverCard 渲染路径）────────────────────

describe('指标聚合触发器（黑盒 DOM）', () => {
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


// ══════════ 节 3/3 — 来源: context-usage-ring.test.ts ══════════

/**
 * ContextUsageRing 测试（占用弧三档 + 无数据态；真实 context.update 帧通道驱动）。
 */
function mountRing(sessionId: string | undefined = 's1') {
  return mount(ContextUsageRing, { props: { sessionId }, attrs: { class: 'size-[16px] shrink-0' } })
}

/** 合法 context.update 帧工厂（0 帧哨兵要求三字段不可全 0） */
function usageFrame(percent: number): Parameters<typeof pushSessionMsg>[1] {
  return {
    type: 'context.update',
    payload: { sessionId: 's1', inputTokens: 1000, contextLimit: 10000, usagePercent: percent },
  }
}


describe('无数据态（黑盒 DOM）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    commandMock.mockReset()
    commandMock.mockImplementation(() => new Promise(() => {}))
    getContextMock.mockReset()
    getContextMock.mockImplementation(() => new Promise(() => {}))
    __clearSessionCleanupRegistryForTest()
    __clearInFlightContextFetchForTest()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('只渲染透明底环（轨道恒在），无占用弧、无语义色（继承按钮文字色）', () => {
    const wrapper = mountRing()
    const svg = wrapper.find('[data-testid="context-usage-ring"]')
    expect(svg.exists()).toBe(true)
    // 底环 stroke-opacity 0.25（「背景偏透明」），弧未渲染
    const circles = wrapper.findAll('circle')
    expect(circles).toHaveLength(1)
    expect(circles[0].attributes('stroke-opacity')).toBe('0.25')
    // 无数据不加色 → class 无语义色调（继承 hover 提亮链）
    expect(svg.classes()).not.toContain('text-success')
    expect(svg.classes()).not.toContain('text-warn')
    expect(svg.classes()).not.toContain('text-danger')
  })
})

describe('占用弧三档（观察者形态 + 真实帧通道）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    commandMock.mockReset()
    commandMock.mockImplementation(() => new Promise(() => {}))
    getContextMock.mockReset()
    getContextMock.mockImplementation(() => new Promise(() => {}))
    __clearSessionCleanupRegistryForTest()
    __clearInFlightContextFetchForTest()
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('50%：绿档 success，弧长 = 50% 周长，rotate(-90) 顶部起点，底环仍在', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(50))
    await wrapper.vm.$nextTick()

    const circles = wrapper.findAll('circle')
    expect(circles).toHaveLength(2)
    // 弧长 = 50% × 2πr（r=9；模板插值输出浮点全精度，期望值用同一表达式计算）
    const CIRCUMFERENCE = 2 * Math.PI * 9
    expect(circles[1].attributes('stroke-dasharray')).toBe(`${0.5 * CIRCUMFERENCE} ${CIRCUMFERENCE}`)
    expect(circles[1].attributes('transform')).toBe('rotate(-90 12 12)')
    expect(circles[1].attributes('stroke-linecap')).toBe('round')
    const svg = wrapper.find('[data-testid="context-usage-ring"]')
    expect(svg.classes()).toContain('text-success')
    expect(svg.classes()).not.toContain('text-warn')
    expect(svg.classes()).not.toContain('text-danger')
  })

  it('75%：黄档 warn（≥70 阈值档）', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(75))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).toContain('text-warn')
  })

  it('95%：红档 danger（>90 阈值档）', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(95))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).toContain('text-danger')
  })

  it('0%：有真值但不渲染弧（round cap 会画出假弧点），色归绿档', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(0))
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('circle')).toHaveLength(1)
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).toContain('text-success')
  })

  it('无值帧（字段缺省 = 合法无值，如 compact 后）：回中性无弧态', async () => {
    const wrapper = mountRing()
    pushSessionMsg('s1', usageFrame(50))
    await wrapper.vm.$nextTick()
    pushSessionMsg('s1', { type: 'context.update', payload: { sessionId: 's1' } })
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('circle')).toHaveLength(1)
    expect(wrapper.find('[data-testid="context-usage-ring"]').classes()).not.toContain('text-success')
  })
})
