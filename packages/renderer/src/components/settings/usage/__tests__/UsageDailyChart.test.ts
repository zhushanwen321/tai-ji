/**
 * UsageDailyChart 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageDailyChart.test.ts
 *
 * 覆盖（SVG 结构 + hover 交互 + 峰值标注，均为用户可见 DOM 断言）：
 *   - Y 轴 gridline/刻度文本、底部 border、按 provider 堆叠的柱形 rect 与色阶
 *   - cost 指标下 Y 轴刻度带 '$' 前缀
 *   - 跨月 perDay → 月份标签（7月/8月）
 *   - mousemove → tooltip（日期/总量/provider 行/输入/缓存命中/输出），mouseleave → 消失
 *   - n>=14 天 → 峰值日三角标注 + MM/DD 文本；空 perDay → 无柱无标注
 *
 * mock 策略（happy-dom 无 ResizeObserver / clientWidth 恒 0）：
 *   - vi.stubGlobal('ResizeObserver', no-op class)
 *   - HTMLElement.prototype.clientWidth stub 为 600（plotW=540，slot>0 才能算 hover 列）
 *   - 颜色分级走新契约：providerColors 随 aggregate() 结果返回，mount 时作为 prop 传入
 *     （无模块级全局色阶；色阶断言用例用真实 aggregate() 管线产出映射，与 UsagePage 传参同源）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { UsageRow } from '@taiji/shared'
import UsageDailyChart from '../UsageDailyChart.vue'
import { aggregate, newMetrics, accumulate, type DayView } from '../aggregate'

/* ── DOM 环境补丁：ResizeObserver + clientWidth ── */
const clientWidthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')

/** 记录每个组件实例注册的 ResizeObserver 回调（测试手动派发 contentRect 变化） */
const roCallbacks: ResizeObserverCallback[] = []
/** disconnect 调用计数（unmount 时 onBeforeUnload 应断开观察者） */
const roDisconnectSpy = vi.fn()

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        roCallbacks.push(cb)
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {
        roDisconnectSpy()
      }
    },
  )
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 600,
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  if (clientWidthDesc) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidthDesc)
})

/* ── props 构造 ── */

function makeRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    input: 1000,
    output: 500,
    cacheRead: 2000,
    cacheWrite: 300,
    costUSD: 0.01,
    messages: 2,
    date: '2026-08-25',
    provider: 'anthropic',
    model: 'claude-x',
    project: 'demo',
    ...overrides,
  }
}

/** 经真实 aggregate 管线构造 perDay/perProv（range=0 路径，不依赖当前日期）。 */
function makeAgg(rows: UsageRow[], metric: 'tokens' | 'cost' = 'tokens') {
  return aggregate(rows, { offProv: new Set(), isolate: null, range: 0, metric })
}

/** 真实 aggregate 管线产出的 providerColors（p-big→p1、p-small→p2），与 UsagePage 传参同源 */
function realColors(): Record<string, string> {
  return makeAgg([
    makeRow({ provider: 'p-big' }),
    makeRow({ provider: 'p-small', input: 10 }),
  ]).providerColors
}

/** 手工构造单日 DayView（峰值标注等用例需要精确控制每日值）。 */
function day(dateStr: string, provs: Record<string, Partial<ReturnType<typeof newMetrics>>>): DayView {
  const provsFull: DayView['provs'] = {}
  const dTot = newMetrics()
  for (const [pid, u] of Object.entries(provs)) {
    const full = newMetrics()
    accumulate(full, { ...newMetrics(), ...u } as ReturnType<typeof newMetrics>)
    provsFull[pid] = full
    accumulate(dTot, full)
  }
  const [y, m, d] = dateStr.split('-').map(Number)
  return { date: new Date(y, m - 1, d), dateStr, provs: provsFull, dTot }
}

function mountChart(
  perDay: DayView[],
  metric: 'tokens' | 'cost' = 'tokens',
  providerColors: Record<string, string> = {},
) {
  return mount(UsageDailyChart, {
    props: {
      perDay,
      perProv: {},
      metric,
      providerColors,
    },
  })
}

describe('UsageDailyChart SVG 结构', () => {
  beforeEach(() => {
    roCallbacks.length = 0
  })

  it('同日双 provider → 4 条 gridline + 5 个 Y 轴刻度 + 底部 border + 2 段堆叠柱（色阶降序）', () => {
    const wrapper = mountChart(
      [day('2026-08-25', { 'p-big': { input: 800 }, 'p-small': { input: 200 } })],
      'tokens',
      realColors(),
    )

    const lines = wrapper.findAll('svg line')
    // 4 gridline + 1 底部 border
    expect(lines).toHaveLength(5)
    // Y 轴刻度 4 个 text（v-for i in 4，不含 0 刻度；此时无月份/峰值标注 text）
    const axisTexts = wrapper.findAll('svg text').map((n) => n.text())
    // maxVal=niceMax(1000)=1000 → 刻度 250/500/750/1k + 单月份标签 8月
    expect(axisTexts).toEqual(['250', '500', '750', '1k', '8月'])

    // 堆叠柱：两个 provider 两段 rect，色阶 p1/p2（值大者优先着色）
    const bars = wrapper.findAll('svg rect')
    expect(bars).toHaveLength(2)
    const fills = bars.map((b) => b.attributes('style')).sort()
    expect(fills[0]).toContain('var(--chart-p1)')
    expect(fills[1]).toContain('var(--chart-p2)')
  })

  it('cost 指标 → Y 轴刻度带 $ 前缀', () => {
    const wrapper = mountChart([day('2026-08-25', { 'p-big': { cost: 8 } })], 'cost')
    const axisTexts = wrapper.findAll('svg text')
    // 顶部刻度 = $8（niceMax(8)=10 → 刻度 0/2.5/5/7.5/10）
    expect(axisTexts.some((n) => n.text() === '$10')).toBe(true)
    expect(axisTexts.some((n) => n.text().startsWith('$'))).toBe(true)
  })

  it('跨月 perDay → 月份标签渲染 7月 / 8月', () => {
    const wrapper = mountChart([
      day('2026-07-30', { 'p-big': { input: 100 } }),
      day('2026-07-31', { 'p-big': { input: 100 } }),
      day('2026-08-01', { 'p-big': { input: 100 } }),
    ])
    const texts = wrapper.findAll('svg text').map((n) => n.text())
    expect(texts).toContain('7月')
    expect(texts).toContain('8月')
  })

  it('空 perDay → 无柱形、无月份标签、无峰值标注', () => {
    const wrapper = mountChart([])
    expect(wrapper.findAll('svg rect')).toHaveLength(0)
    // 只剩 4 个 Y 轴刻度（maxVal 回退 niceMax(0)=1，不崩溃），无月份标签
    const texts = wrapper.findAll('svg text').map((n) => n.text())
    expect(texts).toHaveLength(4)
    expect(texts).not.toContain('7月')
    expect(texts).not.toContain('8月')
    expect(wrapper.find('svg polygon').exists()).toBe(false)
  })
})

describe('UsageDailyChart hover tooltip', () => {
  it('mousemove 到首列 → tooltip 显示日期/总量/provider 行/输入/缓存命中/输出', async () => {
    const wrapper = mountChart([
      day('2026-08-25', { 'p-big': { input: 3000, output: 1000, cacheRead: 2000 } }),
      day('2026-08-26', { 'p-big': { input: 10 } }),
    ])

    // width=600, padL=48, plotW=540, 2 天 slot=270 → clientX=100 命中第 0 列
    await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 60 })

    const tip = wrapper.find('div.absolute')
    expect(tip.exists()).toBe(true)
    const text = tip.text()
    // 日期 + 周二（2026-08-25）
    expect(text).toContain('2026-08-25')
    expect(text).toContain('周二')
    // provider 行出现 pid
    expect(text).toContain('p-big')
    // 输入/缓存命中/输出三值区（i18n zh-CN）
    expect(text).toContain('输入')
    expect(text).toContain('缓存命中')
    expect(text).toContain('输出')
    // 总量 3000+1000+2000=6k（tokens 指标 fmtInt）
    expect(text).toContain('6,000')

    // hover 列高亮 rect 出现（带 hover-col class）
    const hoverCol = wrapper.findAll('svg rect').find((n) => n.classes().includes('hover-col'))
    expect(hoverCol).toBeDefined()
  })

  it('cost 指标 hover → 总量按 fmtUSD 展示且 provider 行带百分比（tooltip 行取色同源 V4）', async () => {
    const wrapper = mountChart(
      [day('2026-08-25', { 'p-big': { cost: 6 }, 'p-small': { cost: 3 } })],
      'cost',
      realColors(),
    )
    await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 60 })

    const tip = wrapper.find('div.absolute')
    expect(tip.exists()).toBe(true)
    // 总量 $9.00；占比 66.7% / 33.3%
    expect(tip.text()).toContain('$9.00')
    expect(tip.text()).toContain('66.7%')
    expect(tip.text()).toContain('33.3%')

    // V4：tooltip 行色块与堆叠柱同源（providerColors 降序 → p-big=p1、p-small=p2）
    const tipDots = tip.findAll('span.w-2')
    expect(tipDots).toHaveLength(2)
    expect(tipDots[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(tipDots[1].attributes('style')).toContain('background: var(--chart-p2)')
  })

  it('mousemove 移出数据列（x < padL）→ tooltip 不出现；mouseleave → 关闭', async () => {
    const wrapper = mountChart([day('2026-08-25', { 'p-big': { input: 100 } })])

    // 靠左 padding 区：idx<0 → 无 tooltip
    await wrapper.find('svg').trigger('mousemove', { clientX: 10, clientY: 60 })
    expect(wrapper.find('div.absolute').exists()).toBe(false)

    // 命中列出现后再 mouseleave 消失
    await wrapper.find('svg').trigger('mousemove', { clientX: 100, clientY: 60 })
    expect(wrapper.find('div.absolute').exists()).toBe(true)
    await wrapper.find('svg').trigger('mouseleave')
    expect(wrapper.find('div.absolute').exists()).toBe(false)
  })
})

describe('UsageDailyChart 峰值标注', () => {
  it('n>=14 天 → 峰值日三角 polygon + MM/DD 文本指向最大值日', () => {
    const perDay: DayView[] = []
    for (let i = 1; i <= 14; i++) {
      const dateStr = `2026-08-${String(i).padStart(2, '0')}`
      // 08-08 为峰值
      perDay.push(day(dateStr, { 'p-big': { input: i === 8 ? 5000 : 100 } }))
    }
    const wrapper = mountChart(perDay)

    const polygon = wrapper.find('svg polygon')
    expect(polygon.exists()).toBe(true)
    expect(polygon.attributes('points')).toBeTruthy()
    // 峰值日文本 8/8
    const texts = wrapper.findAll('svg text').map((n) => n.text())
    expect(texts).toContain('8/8')
  })

  it('n<14 天 → 不显示峰值标注（即使有峰值）', () => {
    const perDay = [day('2026-08-01', { 'p-big': { input: 100 } }), day('2026-08-02', { 'p-big': { input: 900 } })]
    const wrapper = mountChart(perDay)
    expect(wrapper.find('svg polygon').exists()).toBe(false)
  })
})

describe('UsageDailyChart 容器自适应与卸载', () => {
  beforeEach(() => {
    roCallbacks.length = 0
  })

  it('ResizeObserver 派发更窄宽度 → gridline 右端随 plotW 收窄', async () => {
    const wrapper = mountChart([day('2026-08-25', { 'p-big': { input: 900 } })])
    expect(roCallbacks.length).toBeGreaterThanOrEqual(1)

    // 容器从 600 收窄到 480：x2 = width - padR = 480 - 12
    roCallbacks[roCallbacks.length - 1]([{ contentRect: { width: 480 } } as unknown as ResizeObserverEntry])
    await wrapper.vm.$nextTick()

    const gridline = wrapper.findAll('svg line')[0]
    expect(gridline.attributes('x2')).toBe('468')
  })

  it('unmount → 图表从文档移除且观察者断开', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(UsageDailyChart, {
      props: {
        perDay: [day('2026-08-25', { 'p-big': { input: 900 } })],
        perProv: {},
        metric: 'tokens',
        providerColors: realColors(),
      },
      attachTo: host,
    })
    expect(host.querySelector('svg')).not.toBeNull()

    wrapper.unmount()
    // 图表节点从文档移除
    expect(host.querySelector('svg')).toBeNull()
    // onBeforeUnmount 断开 ResizeObserver（无泄漏观察者）
    expect(roDisconnectSpy).toHaveBeenCalled()
    document.body.removeChild(host)
  })
})
