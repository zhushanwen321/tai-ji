/**
 * UsageProjectRank 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageProjectRank.test.ts
 *
 * 覆盖（排名渲染 + 堆叠条取色，均为用户可见 DOM 断言）：
 *   - 按 metric 降序渲染 01/02 序号 + 项目名 + 数值
 *   - 条形取色来自 providerColors prop（新契约：颜色随 aggregate() 结果返回，无全局色阶）
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageProjectRank from '../UsageProjectRank.vue'
import { newMetrics, accumulate } from '../aggregate'
import type { AggMetrics, RankRow } from '../aggregate'

function metrics(input: number, cost = 0): AggMetrics {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input, cost } as AggMetrics)
  return u
}

function row(name: string, provs: Record<string, AggMetrics>): RankRow {
  const total = newMetrics()
  for (const u of Object.values(provs)) accumulate(total, u)
  return { name, metrics: total, provs }
}

function mountRank(
  projects: RankRow[],
  metric: 'tokens' | 'cost' = 'tokens',
  providerColors: Record<string, string> = {},
) {
  return mount(UsageProjectRank, {
    props: {
      projects,
      metric,
      totalMetric: projects.reduce((s, r) => s + (r.metrics.input + r.metrics.output + r.metrics.cacheRead + r.metrics.cacheWrite), 0),
      providerColors,
    },
  })
}

describe('UsageProjectRank 排名渲染', () => {
  it('按传入顺序渲染 01/02 序号 + 项目名 + 数值文本', () => {
    const wrapper = mountRank([
      row('beta', { p1: metrics(100) }),
      row('alpha', { p1: metrics(900) }),
    ])
    const text = wrapper.text()
    expect(text).toContain('01')
    expect(text).toContain('02')
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    // alpha 行 900 tokens（fmtCompact 千位缩写）
    expect(text).toContain('900')
  })

  it('条形取色来自 providerColors 映射（V4：同 provider 同色，段按占比降序）', () => {
    const wrapper = mountRank(
      [row('demo', { p1: metrics(900), p2: metrics(100) })],
      'tokens',
      { p1: 'var(--chart-p1)', p2: 'var(--chart-p2)' },
    )
    const track = wrapper.find('span.stack-track')
    // 段 span = h-full + shrink-0（外层轨道容器 span.flex.h-full 不带 shrink-0，不误命中）
    const segs = track.findAll('span.h-full.shrink-0')
    expect(segs).toHaveLength(2)
    // 占比降序：p1(90%) 在前 → 第一段 p1 色，第二段 p2 色
    expect(segs[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(segs[1].attributes('style')).toContain('background: var(--chart-p2)')
  })
})
