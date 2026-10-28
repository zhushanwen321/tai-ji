// @vitest-environment node

// usage.test.ts —— core C12 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/usage/usage-aggregate.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/usage/__tests__/usage-aggregate-pi1-sample.test.ts（6 用例，skip 0）
//   - src/domain/usage/__tests__/usage-aggregate.test.ts（26 用例，skip 0）

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { type UsageRow } from '@taiji/shared'
import { aggregate, type PerModelEntry, type AggMetrics, newMetrics, accumulate, totalTokens, metricValue, fmtInt, fmtCompact, fmtUSD, fmtPct, niceMax, toLocalDate, fmtMMDD, fmtISO, getProviderColor, aggregateHeatmap, aggregateProjects, aggregateCacheMix, aggregateDetailGroups } from '../usage-aggregate'

// ======== 来源：usage-aggregate-pi1-sample.test.ts ========
describe("usage-aggregate-pi1-sample", () => {
  /**
 * pi 1.0 真实 usage 样本注入聚合（pi1-disposition-chat-flow D3 验收项 A7：V7 成本对账追认，L1 单测）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/core && npx vitest run src/domain/usage/__tests__/usage-aggregate-pi1-sample.test.ts
 *
 * 样本：__fixtures__/usage-sample.jsonl —— 480 条真实 pi 1.0 会话 usage 记录
 * （每行 {provider, model, usage:{input,output,cacheRead,cacheWrite,cost:{...}}}，
 * 含保活形态样本 = cacheRead/cacheWrite>0 的条目，共 429 条、19 个供应商×模型组合）。
 * fixture 为 .tmp/dev-flow/assets/usage-sample.jsonl 的原样拷贝（.tmp 不入库，
 * 已提交单测不得依赖 gitignored 资产；样本为纯 provider/model/usage 数值，无本机路径）。
 *
 * 断言目标（锚 aggregate() 实装现状，packages/core/src/domain/usage/usage-aggregate.ts）：
 *   1. 每个供应商×模型组合产出一行（perModel 复合键 `${provider}/${model}`），
 *      行内成本 = 样本逐条求和（浮点 toBeCloseTo）；跨 provider 同名模型不合并
 *   2. 保活条目并入对应供应商×模型行：行数 = 组合数（保活条目不另立行），
 *      cacheRead/cacheWrite 与 messages 计入合并后指标（messages = 样本总条数，不丢条）
 *   3. 聚合结果无「来源」维度分列：perModel 条目键集 = {provider, model, u}，
 *      指标键集 = {input, output, cacheRead, cacheWrite, cost, messages}——
 *      实装不含来源字段（行维度仅 date × provider × model × project），断言锚定该现状
 *
 * 时间确定性：全部行取固定 date 且 filter.range=0（sliceDates = 有数日期全集），
 * 不依赖当前时间。
 */

  const SAMPLE = new URL('./__fixtures__/usage-sample.jsonl', import.meta.url)

  /** pi 1.0 样本行形状（usage 内 reasoning/totalTokens 等额外字段被聚合忽略，不进类型） */
  interface SampleRecord { // oe-exempt:20261004:test:测试样本行类型（单文件局部，非架构契约）
    provider: string
    model: string
    usage: {
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      cost: { total: number }
    }
  }

  /** 样本固定日期（range=0 路径只用有数日期，取值不影响断言） */
  const FIXED_DATE = '2026-10-03'

  /** 样本行 → aggregate() 入参 UsageRow（messages 语义对齐 scanner：每行 = 一个计入事件） */
  function sampleToRow(rec: SampleRecord): UsageRow {
    return {
      input: rec.usage.input,
      output: rec.usage.output,
      cacheRead: rec.usage.cacheRead,
      cacheWrite: rec.usage.cacheWrite,
      costUSD: rec.usage.cost.total,
      messages: 1,
      date: FIXED_DATE,
      provider: rec.provider,
      model: rec.model,
      project: 'usage-sample',
    }
  }

  /** 全量过滤器（range=0，不过滤 provider/model），metric 取 cost（费用对账视角） */
  function noFilter() {
    return {
      offProv: new Set<string>(),
      isolate: null,
      range: 0,
      metric: 'cost' as const,
    }
  }

  /** 读样本并按文件序变换为 UsageRow[]；同时返回逐条原记录（期望值计算用）。 */
  function loadSample(): { rows: UsageRow[]; records: SampleRecord[] } {
    const text = readFileSync(SAMPLE, 'utf8')
    const records: SampleRecord[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      records.push(JSON.parse(line) as SampleRecord)
    }
    return { rows: records.map(sampleToRow), records }
  }

  /** 期望值模型：按文件序对每个供应商×模型组合累加（与聚合遍历同序，浮点期望以 toBeCloseTo 容差比对） */
  interface ExpectedCombo { // oe-exempt:20261004:test:测试辅助类型（单文件局部，非架构契约）
    provider: string
    model: string
    count: number
    cost: number
    cacheRead: number
    cacheWrite: number
    keepaliveCount: number
  }

  function buildExpected(records: SampleRecord[]): Map<string, ExpectedCombo> {
    const expected = new Map<string, ExpectedCombo>()
    for (const rec of records) {
      const key = `${rec.provider}/${rec.model}`
      let entry = expected.get(key)
      if (!entry) {
        entry = { provider: rec.provider, model: rec.model, count: 0, cost: 0, cacheRead: 0, cacheWrite: 0, keepaliveCount: 0 }
        expected.set(key, entry)
      }
      entry.count++
      entry.cost += rec.usage.cost.total
      entry.cacheRead += rec.usage.cacheRead
      entry.cacheWrite += rec.usage.cacheWrite
      if (rec.usage.cacheRead > 0 || rec.usage.cacheWrite > 0) entry.keepaliveCount++
    }
    return expected
  }

  describe('pi 1.0 真实 usage 样本聚合（A7 成本对账）', () => {
    const { rows, records } = loadSample()
    const expected = buildExpected(records)
    const result = aggregate(rows, noFilter())

    it('样本量守恒：480 条记录、19 个供应商×模型组合、429 条保活形态', () => {
      expect(records.length).toBe(480)
      expect(expected.size).toBe(19)
      const keepaliveTotal = [...expected.values()].reduce((sum, e) => sum + e.keepaliveCount, 0)
      expect(keepaliveTotal).toBe(429)
    })

    it('每个供应商×模型组合恰一行，行内成本 = 样本逐条求和', () => {
      expect(Object.keys(result.perModel).length).toBe(expected.size)
      for (const [key, exp] of expected) {
        const entry: PerModelEntry | undefined = result.perModel[key]
        expect(entry, `perModel 缺行 ${key}`).toBeDefined()
        expect(entry.provider).toBe(exp.provider)
        expect(entry.model).toBe(exp.model)
        expect(entry.u.cost, `${key} 成本对账`).toBeCloseTo(exp.cost, 10)
        expect(entry.u.messages, `${key} 计入条数`).toBe(exp.count)
      }
    })

    it('跨 provider 同名模型不合并（deepseek-v4-flash / glm-5.2 各归各 provider 行）', () => {
      // 样本中同名模型跨 provider：deepseek-v4-flash（deepseek 与 opencode-go）、glm-5.2（zai/zai-coding-cn/zhipu-coding-plan-router）
      expect(result.perModel['deepseek/deepseek-v4-flash']).toBeDefined()
      expect(result.perModel['opencode-go/deepseek-v4-flash']).toBeDefined()
      expect(result.perModel['zai/glm-5.2']).toBeDefined()
      expect(result.perModel['zai-coding-cn/glm-5.2']).toBeDefined()
      expect(result.perModel['zhipu-coding-plan-router/glm-5.2']).toBeDefined()
      // 各行成本各自等于本 provider 下的逐条求和，而非跨 provider 混算
      expect(result.perModel['deepseek/deepseek-v4-flash'].u.cost).toBeCloseTo(expected.get('deepseek/deepseek-v4-flash')!.cost, 10)
      expect(result.perModel['opencode-go/deepseek-v4-flash'].u.cost).toBeCloseTo(expected.get('opencode-go/deepseek-v4-flash')!.cost, 10)
    })

    it('保活条目并入对应行：不另立行，cacheRead/cacheWrite 并入合并指标', () => {
      // 行数 = 组合数：若保活条目另立行，行数会大于 19
      expect(Object.keys(result.perModel).length).toBe(expected.size)

      for (const [key, exp] of expected) {
        if (exp.keepaliveCount === 0) continue
        const entry = result.perModel[key]
        // 合并后 cache 指标含保活条目贡献（逐条求和已包含保活形态）
        expect(entry.u.cacheRead, `${key} cacheRead 对账`).toBeCloseTo(exp.cacheRead, 6)
        expect(entry.u.cacheWrite, `${key} cacheWrite 对账`).toBeCloseTo(exp.cacheWrite, 6)
      }

      // 有保活形态的代表性组合（样本第一大成本行）：保活与非保活条目同行共存
      const mainKey = 'zai-coding-cn/glm-5.3'
      expect(expected.get(mainKey)!.keepaliveCount).toBeGreaterThan(0)
      expect(result.perModel[mainKey].u.messages).toBe(expected.get(mainKey)!.count)

      // 全局不丢条：messages 总数 = 样本总条数（保活条目计入合并行而非被丢弃/旁路）
      const mergedMessages = Object.values(result.perModel).reduce((sum, e) => sum + e.u.messages, 0)
      expect(mergedMessages).toBe(records.length)
    })

    it('聚合结果无「来源」维度分列（V7 追认：实装不含来源字段，断言锚定现状）', () => {
      for (const entry of Object.values(result.perModel)) {
        // perModel 条目键集恰为 provider/model/u，无 source/origin/kind 类来源分列
        expect(Object.keys(entry).sort()).toEqual(['model', 'provider', 'u'])
        const u: AggMetrics = entry.u
        expect(Object.keys(u).sort()).toEqual(['cacheRead', 'cacheWrite', 'cost', 'input', 'messages', 'output'])
      }
      // 供应商层同样只有指标，无来源维度
      for (const provU of Object.values(result.perProv)) {
        expect(Object.keys(provU).sort()).toEqual(['cacheRead', 'cacheWrite', 'cost', 'input', 'messages', 'output'])
      }
    })

    it('总成本对账：perProv 合计与样本全量逐条求和一致', () => {
      const sampleTotal = records.reduce((sum, rec) => sum + rec.usage.cost.total, 0)
      const provTotal = Object.values(result.perProv).reduce((sum, u) => sum + u.cost, 0)
      expect(provTotal).toBeCloseTo(sampleTotal, 10)
      expect(result.tot.cost).toBeCloseTo(sampleTotal, 10)
    })
  })
});

// ======== 来源：usage-aggregate.test.ts ========
describe("usage-aggregate", () => {
  /**
 * usage-aggregate.ts 纯函数单测（用量统计增量覆盖 gate，随 aggregate 下沉 core 域）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/core && npx vitest run src/domain/usage/__tests__/usage-aggregate.test.ts
 *
 * 覆盖范围（格式化边界 + 聚合边界）：
 *   - fmtUSD / fmtCompact / niceMax 的全分支数值边界
 *   （fmtWeekday 已随 i18n 收敛 D6 迁往 UsageDailyChart 组件层，周几断言随组件测试）
 *   - aggregate：空数组、range=0（全量日期轴）、单日、isolate 复合键 / offProv 过滤组合
 *   - 跨 provider 同名模型：perModel 复合键不合并、各归各 provider、总量守恒（V10）
 *   - aggregateProjects range=0 + metric=cost 贯穿排序；aggregateDetailGroups 复合键归属 + metric 排序
 *
 * 时间确定性：range=0 路径不依赖当前时间（sliceDates=有数日期全集），
 * 纯函数断言不使用真实当前时间。
 */

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

    it('range>0 → 今天往回 range 天完整日历（含无数据日，本地时区），nDays=range', () => {
      const expected = (offset: number): string => {
        const d = new Date()
        d.setDate(d.getDate() - offset)
        return fmtISO(d)
      }
      // 有数日落在窗内（昨天）；今天与前天无数据但仍占日历格
      const rows = [makeRow({ date: expected(1), model: 'm1' })]
      const r = aggregate(rows, { ...noFilter(), range: 3 })
      expect(r.nDays).toBe(3)
      expect(r.perDay.map((d) => d.dateStr)).toEqual([expected(2), expected(1), expected(0)])
      // 无数据日也有空聚合格（值 0），有数日计入 activeDays
      expect(r.activeDays).toBe(1)
      expect(totalTokens(r.perDay[1].dTot)).toBeGreaterThan(0)
      expect(totalTokens(r.perDay[0].dTot)).toBe(0)
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
      expect(Object.keys(r[0].provs ?? {}).sort()).toEqual(['p1', 'p2'])
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
});
