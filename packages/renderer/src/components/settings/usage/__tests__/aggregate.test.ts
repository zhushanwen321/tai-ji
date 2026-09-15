/**
 * aggregate.ts 纯函数单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/aggregate.test.ts
 *
 * 覆盖范围（格式化边界 + 聚合边界）：
 *   - fmtUSD / fmtCompact / niceMax 的全分支数值边界
 *   （fmtWeekday 已随 i18n 收口 D6 迁往 UsageDailyChart 组件层，周几断言随组件测试）
 *   - aggregate：空数组、range=0（全量日期轴）、单日、isolate 复合键 / offProv 过滤组合
 *   - 跨 provider 同名模型：perModel 复合键不合并、各归各 provider、总量守恒（V10）
 *   - aggregateProjects range=0 + metric=cost 贯穿排序；aggregateDetailGroups 复合键归属 + metric 排序
 *
 * 时间确定性：range=0 路径不依赖当前时间（sliceDates=有数日期全集），
 * 纯函数断言不使用真实当前时间。
 */
import { describe, it, expect } from 'vitest'
import type { UsageRow } from '@taiji/shared'
import {
  newMetrics,
  accumulate,
  totalTokens,
  metricValue,
  fmtInt,
  fmtCompact,
  fmtUSD,
  fmtPct,
  niceMax,
  toLocalDate,
  fmtMMDD,
  fmtISO,
  getProviderColor,
  aggregate,
  aggregateHeatmap,
  aggregateProjects,
  aggregateCacheMix,
  aggregateDetailGroups,
} from '../aggregate'

/** 构造单条用量行。 */
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

/** 全量过滤器（range=0，不过滤 provider/model）。 */
function noFilter() {
  return {
    offProv: new Set<string>(),
    isolate: null,
    range: 0,
    metric: 'tokens' as const,
  }
}

describe('格式化函数', () => {
  it('fmtUSD 按 0 / <0.01 / <100 / >=100 四档输出', () => {
    expect(fmtUSD(0)).toBe('—')
    expect(fmtUSD(0.004)).toBe('$0.004')
    expect(fmtUSD(5)).toBe('$5.00')
    // >=100 走千分位取整分支
    expect(fmtUSD(1234.5)).toBe('$1,235')
  })

  it('fmtCompact 按 <1k / >=1k / >=1M / >=10M 压缩', () => {
    expect(fmtCompact(999)).toBe('999')
    expect(fmtCompact(1000)).toBe('1k')
    expect(fmtCompact(1500000)).toBe('1.5M')
    expect(fmtCompact(20000000)).toBe('20M')
  })

  it('fmtInt 千分位取整，fmtPct 一位小数百分比', () => {
    expect(fmtInt(1234.6)).toBe('1,235')
    expect(fmtPct(0.1234)).toBe('12.3%')
  })

  it('niceMax 非正数回退 1，正数上取到 1/2/2.5/5×10^n 阶梯', () => {
    expect(niceMax(0)).toBe(1)
    expect(niceMax(-5)).toBe(1)
    expect(niceMax(1)).toBe(1)
    expect(niceMax(1.2)).toBe(2)
    expect(niceMax(2.4)).toBe(2.5)
    expect(niceMax(3)).toBe(5)
    expect(niceMax(6)).toBe(10)
    expect(niceMax(12)).toBe(20)
    // 小数档：<1 时 0.3 → 0.5
    expect(niceMax(0.3)).toBe(0.5)
  })
})

describe('日期工具', () => {
  it('toLocalDate 解析 YYYY-MM-DD 为本地时区日期（含年末/闰二月边界）', () => {
    expect(toLocalDate('2026-12-31').getMonth()).toBe(11)
    expect(toLocalDate('2026-12-31').getDate()).toBe(31)
    expect(toLocalDate('2024-02-29').getDate()).toBe(29)
  })

  it('fmtISO / fmtMMDD 补零到两位', () => {
    const d = new Date(2026, 0, 5) // 1 月 5 日
    expect(fmtISO(d)).toBe('2026-01-05')
    expect(fmtMMDD(d)).toBe('1/5')
  })
})

describe('指标累计', () => {
  it('accumulate 累加六项指标，totalTokens = 四项 token 和（不含 cost/messages）', () => {
    const t = newMetrics()
    accumulate(t, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, messages: 2 })
    accumulate(t, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 1, messages: 3 })
    expect(t.input).toBe(11)
    expect(t.messages).toBe(5)
    expect(t.cost).toBe(1.5)
    expect(totalTokens(t)).toBe(11 + 22 + 33 + 44)
    // metricValue 按指标取值：tokens 取四项和，cost 取费用
    expect(metricValue(t, 'tokens')).toBe(110)
    expect(metricValue(t, 'cost')).toBe(1.5)
  })

  it('getProviderColor 未分配 provider 回退第 5 档色', () => {
    expect(getProviderColor({}, 'never-seen-provider')).toBe('var(--chart-p5)')
  })
})

describe('aggregate 聚合边界', () => {
  it('空 rows → perDay/nDays/activeDays 全空且峰值日期为 null', () => {
    const r = aggregate([], noFilter())
    expect(r.perDay).toEqual([])
    expect(r.nDays).toBe(0)
    expect(r.activeDays).toBe(0)
    expect(r.msgs).toBe(0)
    expect(r.peak).toEqual({ v: 0, d: null })
  })

  it('range=0 → 日期轴只有有数日期，nDays=有数日数（不按今天回溯）', () => {
    const rows = [
      makeRow({ date: '2026-07-15', model: 'm1' }),
      makeRow({ date: '2026-08-20', model: 'm2' }),
    ]
    const r = aggregate(rows, noFilter())
    expect(r.nDays).toBe(2)
    expect(r.perDay.map((d) => d.dateStr)).toEqual(['2026-07-15', '2026-08-20'])
    // 单日两行也只占一格
    expect(r.activeDays).toBe(2)
  })

  it('单日单行 → 该日 provs/dTot 与 tot 一致', () => {
    const rows = [makeRow({ date: '2026-08-01' })]
    const r = aggregate(rows, noFilter())
    expect(r.perDay).toHaveLength(1)
    expect(totalTokens(r.perDay[0].dTot)).toBe(totalTokens(r.tot))
    expect(r.perDay[0].provs['anthropic']).toBeDefined()
    // 峰值即当日
    expect(r.peak.d).toBe('2026-08-01')
  })

  it('isolate 过滤（复合键）：只保留命中 provider/model 组合的行；未命中 → 全滤空', () => {
    const rows = [
      makeRow({ date: '2026-08-01', model: 'm-a' }),
      makeRow({ date: '2026-08-01', model: 'm-b' }),
    ]
    const hit = aggregate(rows, { ...noFilter(), isolate: 'anthropic/m-a' })
    expect(Object.keys(hit.perModel)).toEqual(['anthropic/m-a'])
    // 值结构自带 provider/model 分量
    expect(hit.perModel['anthropic/m-a']).toMatchObject({ provider: 'anthropic', model: 'm-a' })
    expect(hit.activeDays).toBe(1)

    const miss = aggregate(rows, { ...noFilter(), isolate: 'anthropic/m-none' })
    expect(miss.activeDays).toBe(0)
    expect(Object.keys(miss.perModel)).toEqual([])
  })

  it('跨 provider 同名模型 → perModel 出两行、各归各 provider、总量守恒（V10）', () => {
    const rows = [
      makeRow({ date: '2026-08-01', provider: 'p1', model: 'same', input: 100 }),
      makeRow({ date: '2026-08-01', provider: 'p2', model: 'same', input: 300 }),
    ]
    const r = aggregate(rows, noFilter())
    // 复合键：同名模型不合并
    expect(Object.keys(r.perModel).sort()).toEqual(['p1/same', 'p2/same'])
    expect(r.perModel['p1/same']).toMatchObject({ provider: 'p1', model: 'same' })
    expect(r.perModel['p2/same']).toMatchObject({ provider: 'p2', model: 'same' })
    expect(r.perModel['p1/same'].u.input).toBe(100)
    expect(r.perModel['p2/same'].u.input).toBe(300)
    // 总量守恒：两行分属之和 = tot
    expect(r.perModel['p1/same'].u.input + r.perModel['p2/same'].u.input).toBe(r.tot.input)
  })

  it('isolate 复合键过滤：同名模型按 provider 区分（isolate p2/same 只留 p2 行）', () => {
    const rows = [
      makeRow({ date: '2026-08-01', provider: 'p1', model: 'same', input: 100 }),
      makeRow({ date: '2026-08-01', provider: 'p2', model: 'same', input: 300 }),
    ]
    const r = aggregate(rows, { ...noFilter(), isolate: 'p2/same' })
    expect(Object.keys(r.perModel)).toEqual(['p2/same'])
    expect(r.tot.input).toBe(300)
  })

  it('offProv 与 isolate 组合过滤：关闭 provider 后其余 provider 正常聚合', () => {
    const rows = [
      makeRow({ date: '2026-08-01', provider: 'p1', model: 'm1' }),
      makeRow({ date: '2026-08-01', provider: 'p2', model: 'm2' }),
    ]
    const r = aggregate(rows, { ...noFilter(), offProv: new Set(['p1']) })
    expect(Object.keys(r.perProv)).toEqual(['p2'])
    expect(Object.keys(r.perDay[0].provs)).toEqual(['p2'])
  })

  it('metric=cost 时峰值按费用取值', () => {
    const rows = [
      makeRow({ date: '2026-08-01', costUSD: 0.1 }),
      makeRow({ date: '2026-08-02', costUSD: 5 }),
    ]
    const r = aggregate(rows, { ...noFilter(), metric: 'cost' })
    expect(r.peak.d).toBe('2026-08-02')
    expect(r.peak.v).toBe(5)
  })

  it('providerColors 随结果返回：按全量用量降序分配阶梯，过滤变化不重排（候选 9）', () => {
    const rows = [
      makeRow({ date: '2026-08-01', provider: 'big', input: 300 }),
      makeRow({ date: '2026-08-01', provider: 'mid', input: 200 }),
      makeRow({ date: '2026-08-01', provider: 'small', input: 100 }),
      makeRow({ date: '2026-08-02', provider: 'p4', input: 50 }),
      makeRow({ date: '2026-08-02', provider: 'p5', input: 25 }),
      makeRow({ date: '2026-08-02', provider: 'p6', input: 10 }),
    ]
    const r = aggregate(rows, noFilter())
    // 用量降序 → 阶梯 p1..p5，第 6 个封顶在 p5
    expect(r.providerColors['big']).toBe('var(--chart-p1)')
    expect(r.providerColors['mid']).toBe('var(--chart-p2)')
    expect(r.providerColors['small']).toBe('var(--chart-p3)')
    expect(r.providerColors['p4']).toBe('var(--chart-p4)')
    expect(r.providerColors['p5']).toBe('var(--chart-p5)')
    expect(r.providerColors['p6']).toBe('var(--chart-p5)')
    // 取色经结果对象携带的映射（无全局态）；未分配回退 p5
    expect(getProviderColor(r.providerColors, 'mid')).toBe('var(--chart-p2)')
    expect(getProviderColor(r.providerColors, 'never-seen')).toBe('var(--chart-p5)')
    // offProv 过滤 big 后色序不变（色序派生自全量 rows）
    const filtered = aggregate(rows, { ...noFilter(), offProv: new Set(['big']) })
    expect(filtered.providerColors['mid']).toBe('var(--chart-p2)')
    expect(filtered.providerColors['big']).toBe('var(--chart-p1)')
  })
})

describe('aggregateHeatmap', () => {
  it('按日期累计 token 总量并应用 offProv/isolate 过滤', () => {
    const rows = [
      makeRow({ date: '2026-08-01', provider: 'p1', model: 'm1' }),
      makeRow({ date: '2026-08-01', provider: 'p2', model: 'm2' }),
      makeRow({ date: '2026-08-02', provider: 'p1', model: 'm1' }),
    ]
    const one = 1000 + 500 + 2000 + 300
    const all = aggregateHeatmap(rows, { offProv: new Set(), isolate: null })
    expect(all.get('2026-08-01')).toBe(one * 2)
    expect(all.get('2026-08-02')).toBe(one)
    // 关掉 p1 → 只剩 08-01 的 p2 行
    const filtered = aggregateHeatmap(rows, { offProv: new Set(['p1']), isolate: null })
    expect(filtered.size).toBe(1)
    expect(filtered.get('2026-08-01')).toBe(one)
    // 空数组边界
    expect(aggregateHeatmap([], { offProv: new Set(), isolate: null }).size).toBe(0)
  })

  it('isolate 复合键过滤：按 provider/model 组合命中（同名模型不串）', () => {
    const rows = [
      makeRow({ date: '2026-08-01', provider: 'p1', model: 'm1' }),
      makeRow({ date: '2026-08-01', provider: 'p2', model: 'm1' }),
      makeRow({ date: '2026-08-02', provider: 'p1', model: 'm1' }),
    ]
    const one = 1000 + 500 + 2000 + 300
    const iso = aggregateHeatmap(rows, { offProv: new Set(), isolate: 'p1/m1' })
    expect(iso.size).toBe(2)
    expect(iso.get('2026-08-01')).toBe(one)
    expect(iso.get('2026-08-02')).toBe(one)
  })
})

describe('aggregateProjects', () => {
  it('range=0 → 按 project×provider 聚合并按 token 降序取 top', () => {
    const rows = [
      makeRow({ date: '2026-08-01', project: 'big', provider: 'p1' }),
      makeRow({ date: '2026-08-01', project: 'big', provider: 'p2' }),
      makeRow({ date: '2026-08-02', project: 'small', provider: 'p1' }),
    ]
    const r = aggregateProjects(rows, noFilter())
    expect(r.map((p) => p.name)).toEqual(['big', 'small'])
    expect(Object.keys(r[0].provs).sort()).toEqual(['p1', 'p2'])
    // 空数组边界
    expect(aggregateProjects([], noFilter())).toEqual([])
  })

  it('metric=cost → TOP8 排序按费用贯穿（token 大户费用为 0 时被反超）', () => {
    const rows = [
      makeRow({ date: '2026-08-01', project: 'tok-heavy', input: 100000, costUSD: 0 }),
      makeRow({ date: '2026-08-01', project: 'cost-heavy', input: 10, costUSD: 9 }),
    ]
    // token 视角：tok-heavy 在前
    expect(aggregateProjects(rows, noFilter()).map((p) => p.name)).toEqual(['tok-heavy', 'cost-heavy'])
    // 费用视角：cost-heavy 反超（metric 贯穿）
    expect(aggregateProjects(rows, { ...noFilter(), metric: 'cost' }).map((p) => p.name)).toEqual([
      'cost-heavy',
      'tok-heavy',
    ])
  })
})

describe('aggregateCacheMix', () => {
  it('适配复合键值结构：过滤/排序用 token（token 域例外不随 metric），输出 provider+model 分量', () => {
    const perModel = {
      'p1/idle': {
        provider: 'p1',
        model: 'idle',
        u: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 },
      },
      'p2/busy': {
        provider: 'p2',
        model: 'busy',
        u: { input: 100, output: 100, cacheRead: 300, cacheWrite: 0, cost: 0, messages: 0 },
      },
    }
    const r = aggregateCacheMix(perModel)
    expect(r.map((x) => x.model)).toEqual(['busy'])
    expect(r[0].provider).toBe('p2')
    expect(r[0].hitRate).toBeCloseTo(300 / 400, 5)
    expect(r[0].hit).toBeCloseTo(300 / 500, 5)
  })
})

describe('aggregateDetailGroups', () => {
  it('按 provider 分组，组内 model 按当前指标降序、组间按当前指标降序', () => {
    const perProv = {
      pa: newMetrics(),
      pb: newMetrics(),
    }
    accumulate(perProv.pa, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    accumulate(perProv.pb, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    const perModel = {
      'pa/pa-small': { provider: 'pa', model: 'pa-small', u: newMetrics() },
      'pa/pa-big': { provider: 'pa', model: 'pa-big', u: newMetrics() },
      'pb/pb-x': { provider: 'pb', model: 'pb-x', u: newMetrics() },
    }
    accumulate(perModel['pa/pa-small'].u, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    accumulate(perModel['pa/pa-big'].u, { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    accumulate(perModel['pb/pb-x'].u, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })

    const groups = aggregateDetailGroups(
      perProv,
      perModel,
      [
        makeRow({ provider: 'pa', model: 'pa-small' }),
        makeRow({ provider: 'pa', model: 'pa-big' }),
        makeRow({ provider: 'pb', model: 'pb-x' }),
      ],
      'tokens',
    )
    expect(groups.map((g) => g.pid)).toEqual(['pb', 'pa'])
    // 组内多 model 触发排序：大 token 在前；输出用裸 model 分量
    const pa = groups.find((g) => g.pid === 'pa')!
    expect(pa.models.map((m) => m.model)).toEqual(['pa-big', 'pa-small'])
  })

  it('同名模型跨 provider → 各归各组（复合键表派生自全量 rows，不串组）', () => {
    const perProv = { pa: newMetrics(), pb: newMetrics() }
    accumulate(perProv.pa, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    accumulate(perProv.pb, { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    const perModel = {
      'pa/x': { provider: 'pa', model: 'x', u: newMetrics() },
      'pb/x': { provider: 'pb', model: 'x', u: newMetrics() },
    }
    accumulate(perModel['pa/x'].u, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    accumulate(perModel['pb/x'].u, { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })

    const groups = aggregateDetailGroups(
      perProv,
      perModel,
      [
        makeRow({ provider: 'pa', model: 'x' }),
        makeRow({ provider: 'pb', model: 'x' }),
      ],
      'tokens',
    )
    const pa = groups.find((g) => g.pid === 'pa')!
    const pb = groups.find((g) => g.pid === 'pb')!
    // 复合键归属：pa/x 与 pb/x 各归各组，不因同名被 first-seen 折到单组
    expect(pa.models.map((m) => m.model)).toEqual(['x'])
    expect(pb.models.map((m) => m.model)).toEqual(['x'])
  })

  it('metric=cost → 组间与组内排序按费用贯穿', () => {
    const perProv = { pa: newMetrics(), pb: newMetrics() }
    accumulate(perProv.pa, { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, messages: 1 })
    accumulate(perProv.pb, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })
    const perModel = {
      'pa/y': { provider: 'pa', model: 'y', u: newMetrics() },
      'pa/z': { provider: 'pa', model: 'z', u: newMetrics() },
      'pb/x': { provider: 'pb', model: 'x', u: newMetrics() },
    }
    accumulate(perModel['pa/y'].u, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 4, messages: 1 })
    accumulate(perModel['pa/z'].u, { input: 9, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1, messages: 1 })
    accumulate(perModel['pb/x'].u, { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 1 })

    const groups = aggregateDetailGroups(
      perProv,
      perModel,
      [
        makeRow({ provider: 'pa', model: 'y', costUSD: 4 }),
        makeRow({ provider: 'pa', model: 'z', costUSD: 1 }),
        makeRow({ provider: 'pb', model: 'x', costUSD: 0 }),
      ],
      'cost',
    )
    // 组间：pb token 大但费用 0 → cost 视角 pa 反超在前
    expect(groups.map((g) => g.pid)).toEqual(['pa', 'pb'])
    // 组内：y 费用 4 > z 费用 1（token 视角相反）
    expect(groups[0].models.map((m) => m.model)).toEqual(['y', 'z'])
  })
})
