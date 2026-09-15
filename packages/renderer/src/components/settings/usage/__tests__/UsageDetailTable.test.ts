/**
 * UsageDetailTable 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageDetailTable.test.ts
 *
 * 覆盖（分组折叠交互 + 合计行，均为用户可见 DOM 断言）：
 *   - 前两组默认展开、第三组默认收起（模型行可见性）
 *   - 点击分组头 → 折叠（模型行消失）；再点 → 展开
 *   - 合计行渲染总 token 与总费用
 *   - groups 引用刷新（重试/筛选）→ 展开态重置为前两组展开，不残留旧组状态（D5 watch）
 *   - 取色 wiring（V4）：分组头色点背景 = providerColors 映射中该 pid 的色值
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageDetailTable from '../UsageDetailTable.vue'
import { newMetrics, accumulate, type AggMetrics } from '../aggregate'

/** 构造单 provider 分组（含 1 个 model 行）。 */
function group(pid: string, input: number, model: string): {
  pid: string
  u: AggMetrics
  models: { model: string; u: AggMetrics }[]
} {
  const u = newMetrics()
  accumulate(u, { ...newMetrics(), input } as AggMetrics)
  return { pid, u, models: [{ model, u }] }
}

function mountTable(groups: ReturnType<typeof group>[], tot: AggMetrics, providerColors: Record<string, string> = {}) {
  return mount(UsageDetailTable, { props: { groups, tot, providerColors } })
}

describe('UsageDetailTable 分组折叠', () => {
  const groups = [
    group('p1', 300, 'm1'),
    group('p2', 200, 'm2'),
    group('p3', 100, 'm3'),
  ]
  const tot = newMetrics()
  accumulate(tot, { ...newMetrics(), input: 600 } as AggMetrics)

  it('前两组默认展开、第三组默认收起', () => {
    const wrapper = mountTable(groups, tot)
    const text = wrapper.text()
    expect(text).toContain('m1')
    expect(text).toContain('m2')
    expect(text).not.toContain('m3')
    // 分组头显示 provider 名与模型计数
    expect(text).toContain('p1')
    expect(text).toContain('p3')
  })

  it('点击第一组分组头 → 折叠（m1 消失）；再点 → 展开', async () => {
    const wrapper = mountTable(groups, tot)
    const header1 = wrapper.findAll('div.cursor-pointer')[0]

    await header1.trigger('click')
    expect(wrapper.text()).not.toContain('m1')
    expect(wrapper.text()).toContain('m2') // 其他组不受影响

    await header1.trigger('click')
    expect(wrapper.text()).toContain('m1')
  })

  it('点击第三组分组头 → 展开（m3 出现）', async () => {
    const wrapper = mountTable(groups, tot)
    const header3 = wrapper.findAll('div.cursor-pointer')[2]

    await header3.trigger('click')
    expect(wrapper.text()).toContain('m3')
  })

  it('合计行渲染总 token（千分位）与总费用', () => {
    const t = newMetrics()
    accumulate(t, { ...newMetrics(), input: 1234, cost: 2.5 } as AggMetrics)
    const wrapper = mountTable([group('p1', 1234, 'm1')], t)
    const text = wrapper.text()
    expect(text).toContain('合计')
    expect(text).toContain('1,234')
    expect(text).toContain('$2.50')
  })

  it('分组头色点取色来自 providerColors 映射（V4：同 pid 同色）', () => {
    const wrapper = mountTable(groups, tot, { p1: 'var(--chart-p1)', p2: 'var(--chart-p2)', p3: 'var(--chart-p3)' })
    const dots = wrapper.findAll('span.size-2')
    expect(dots).toHaveLength(3)
    expect(dots[0].attributes('style')).toContain('background: var(--chart-p1)')
    expect(dots[1].attributes('style')).toContain('background: var(--chart-p2)')
    expect(dots[2].attributes('style')).toContain('background: var(--chart-p3)')
  })
})

describe('UsageDetailTable groups 刷新重置展开态（D5）', () => {
  const groupsA = [group('p1', 300, 'm1'), group('p2', 200, 'm2'), group('p3', 100, 'm3')]
  const tot = newMetrics()
  accumulate(tot, { ...newMetrics(), input: 600 } as AggMetrics)

  it('用户改过展开态后 groups 换新引用 → 重置为新 groups 前两组展开', async () => {
    const wrapper = mountTable(groupsA, tot)
    // 收起第一组（展开态被用户改动）
    await wrapper.findAll('div.cursor-pointer')[0].trigger('click')
    expect(wrapper.text()).not.toContain('m1')

    // 数据刷新：groups 换成不同 pid 的新引用 → 重置为新前两组展开（q1/q2 模型行直接可见）
    const groupsB = [group('q1', 500, 'x1'), group('q2', 400, 'x2'), group('q3', 300, 'x3')]
    await wrapper.setProps({ groups: groupsB })
    expect(wrapper.text()).toContain('x1')
    expect(wrapper.text()).toContain('x2')
    expect(wrapper.text()).not.toContain('x3')
  })

  it('同 pid 新数组刷新后同样重置（旧折叠态不残留）', async () => {
    const wrapper = mountTable(groupsA, tot)
    await wrapper.findAll('div.cursor-pointer')[0].trigger('click')
    expect(wrapper.text()).not.toContain('m1')

    // 同 pid、新数组引用（筛选变化后 groups 重算的形态）→ 展开态仍重置为前两组
    const refreshed = [group('p1', 300, 'm1'), group('p2', 200, 'm2'), group('p3', 100, 'm3')]
    await wrapper.setProps({ groups: refreshed })
    expect(wrapper.text()).toContain('m1')
    expect(wrapper.text()).toContain('m2')
  })
})
