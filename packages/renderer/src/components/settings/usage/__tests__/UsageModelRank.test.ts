/**
 * UsageModelRank 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageModelRank.test.ts
 *
 * 覆盖（排名渲染 + isolate 单看交互）：
 *   - 按 metric 值降序排名（01/02 序号 + provider/model 分量文本）
 *   - 行标识 = perModel 复合键 `${provider}/${model}`：行 testid / 高亮比较 / toggle emit 均用复合键
 *   - 跨 provider 同名模型 → 两行独立（复合键行标识区分 testid）
 *   - 点击行 → emit update:isolate(复合键)；isolate 态再点同行 → emit null
 *   - isolate 行高亮 accent 背景
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageModelRank from '../UsageModelRank.vue'
import { newMetrics, accumulate } from '../aggregate'
import type { AggMetrics, PerModelEntry } from '../aggregate'

function metrics(input: number, cost = 0): AggMetrics {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input, cost } as AggMetrics)
  return u
}

/** 复合键值结构条目 */
function entry(provider: string, model: string, input: number, cost = 0): PerModelEntry {
  return { provider, model, u: metrics(input, cost) }
}

function mountRank(
  perModel: Record<string, PerModelEntry>,
  isolate: string | null = null,
  providerColors: Record<string, string> = {},
) {
  return mount(UsageModelRank, {
    props: {
      perModel,
      metric: 'tokens' as const,
      isolate,
      providerColors,
    },
  })
}

describe('UsageModelRank 排名渲染', () => {
  it('按 token 降序渲染 01/02 序号与 provider/model 分量文本', () => {
    const wrapper = mountRank({
      'p2/small': entry('p2', 'small', 100),
      'p1/big': entry('p1', 'big', 900),
    })
    const text = wrapper.text()
    expect(text).toContain('01')
    expect(text).toContain('02')
    // 排名靠前的 big 模型整行在前
    expect(text.indexOf('big')).toBeLessThan(text.indexOf('small'))
    // 分量渲染（provider 灰前缀 + 裸 model）
    expect(text).toContain('p1/big')
    expect(text).toContain('p2/small')
  })

  it('跨 provider 同名模型 → 两行独立（复合键行标识区分 testid）', () => {
    const wrapper = mountRank({
      'p1/m': entry('p1', 'm', 100),
      'p2/m': entry('p2', 'm', 300),
    })
    expect(wrapper.find('[data-testid="usage-model-p1/m"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="usage-model-p2/m"]').exists()).toBe(true)
  })

  it('条形取色来自 providerColors 映射（V4：同 provider 同色）', () => {
    const wrapper = mountRank(
      {
        'p1/big': entry('p1', 'big', 900),
        'p2/small': entry('p2', 'small', 100),
      },
      null,
      { p1: 'var(--chart-p1)', p2: 'var(--chart-p2)' },
    )
    const fills = wrapper.findAll('span.absolute')
    expect(fills).toHaveLength(2)
    // 排名降序：p1/big(900) 在前 → 第一条 p1 色，第二条 p2 色
    expect(fills[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(fills[1].attributes('style')).toContain('background: var(--chart-p2)')
  })
})

describe('UsageModelRank isolate 单看交互', () => {
  it('点击行 → emit update:isolate(复合键)', async () => {
    const wrapper = mountRank({ 'p1/big': entry('p1', 'big', 900) })
    await wrapper.find('[data-testid="usage-model-p1/big"]').trigger('click')
    expect(wrapper.emitted('update:isolate')).toEqual([['p1/big']])
  })

  it('isolate 态再点同一行 → emit update:isolate(null)，行高亮 accent（复合键比较）', async () => {
    const wrapper = mountRank({ 'p1/big': entry('p1', 'big', 900) }, 'p1/big')
    const row = wrapper.find('[data-testid="usage-model-p1/big"]')
    // 选中行 accent 高亮
    expect(row.classes()).toContain('bg-[var(--accent-soft)]')

    await row.trigger('click')
    expect(wrapper.emitted('update:isolate')).toEqual([[null]])
  })

  it('isolate 指向另一复合键 → 当前行不高亮（同名模型不串高亮）', () => {
    const wrapper = mountRank(
      {
        'p1/m': entry('p1', 'm', 100),
        'p2/m': entry('p2', 'm', 300),
      },
      'p2/m',
    )
    expect(wrapper.find('[data-testid="usage-model-p2/m"]').classes()).toContain('bg-[var(--accent-soft)]')
    expect(wrapper.find('[data-testid="usage-model-p1/m"]').classes()).not.toContain('bg-[var(--accent-soft)]')
  })
})
