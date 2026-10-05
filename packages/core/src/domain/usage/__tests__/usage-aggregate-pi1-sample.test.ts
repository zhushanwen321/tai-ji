// @vitest-environment node

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
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { UsageRow } from '@taiji/shared'
import { aggregate } from '../usage-aggregate'
import type { PerModelEntry, AggMetrics } from '../usage-aggregate'

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
