/**
 * UsageHeatCalendar 单测（用量统计增量覆盖 gate）。
 *
 * 测试框架：vitest（禁 node:test）。
 * 运行命令：cd packages/renderer && npx vitest run src/components/settings/usage/__tests__/UsageHeatCalendar.test.ts
 *
 * 覆盖（16 周网格 + 分档着色 + hover tooltip）：
 *   - 112 格网格、月份标签、星期标签、底部图例渲染
 *   - 有数格子按分位数着色（heat-1/heat-5），无数据格 heat-0，未来格降透明度
 *   - mouseenter 有数格 → Teleport tooltip 显示日期 + 周几 + token 数
 *   - mouseenter 空格 → 「无消耗」文案；mouseleave → tooltip 关闭
 *
 * 时间确定性：vi.useFakeTimers + setSystemTime 固定 2026-08-25（周二），
 * 网格窗口 = 2026-05-11（周一）.. 2026-08-30，断言不依赖真实当前时间。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UsageHeatCalendar from '../UsageHeatCalendar.vue'

function mountCalendar(heatmapData: Map<string, number>) {
  return mount(UsageHeatCalendar, { props: { heatmapData } })
}

/** 网格容器（grid-auto-flow:column 的 112 格容器）。 */
function gridCells(wrapper: ReturnType<typeof mountCalendar>) {
  return wrapper.find('div[style*="grid-auto-flow"]').findAll('div')
}

describe('UsageHeatCalendar 网格渲染', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 25, 12, 0, 0)) // 2026-08-25 周二
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('16 周 × 7 天 = 112 格；月份标签覆盖 5..8 月；星期标签 一/三/五；底部图例 少/多', () => {
    const wrapper = mountCalendar(new Map())
    expect(gridCells(wrapper)).toHaveLength(112)

    // 月份标签：窗口 2026-05-11..08-30 → 5/6/7/8 四个月
    const monthRow = wrapper.find('div.relative')
    const monthTexts = monthRow.findAll('span').map((n) => n.text())
    expect(monthTexts).toEqual(['5月', '6月', '7月', '8月'])

    // 星期标签（i18n zh-CN）
    const wrapperText = wrapper.text()
    expect(wrapperText).toContain('一')
    expect(wrapperText).toContain('三')
    expect(wrapperText).toContain('五')
    // 底部图例
    expect(wrapperText).toContain('少')
    expect(wrapperText).toContain('多')
  })

  it('有数格按分位档着色：峰值 heat-5、低值 heat-1、无数据 heat-0、未来格降透明度', () => {
    const wrapper = mountCalendar(
      new Map([
        ['2026-08-25', 5000], // 峰值 → heat-5
        ['2026-08-24', 100], // 低值 → heat-1
        ['2026-05-11', 100], // 低值 → heat-1
      ]),
    )
    const cells = gridCells(wrapper)
    const byLevel = (cls: string) => cells.filter((n) => n.classes().includes(cls))
    expect(byLevel('bg-[var(--heat-5)]')).toHaveLength(1)
    expect(byLevel('bg-[var(--heat-1)]')).toHaveLength(2)
    expect(byLevel('bg-[var(--heat-0)]')).toHaveLength(112 - 3)
    // 未来格（2026-08-26..30 共 5 格）降透明度
    expect(cells.filter((n) => n.classes().includes('opacity-[0.28]'))).toHaveLength(5)
  })

  it('mouseenter 有数格 → tooltip 显示日期 + 周几 + token 数；mouseleave → 关闭', async () => {
    const wrapper = mountCalendar(new Map([['2026-08-25', 5000]]))

    // 2026-08-25 是窗口内第 15 周 × 7 + 第 1 天 = 索引 15*7+1=106
    await gridCells(wrapper)[106].trigger('mouseenter', { clientX: 20, clientY: 30 })

    const tip = document.body.querySelector('div.fixed')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('2026-08-25')
    expect(tip!.textContent).toContain('周二')
    expect(tip!.textContent).toContain('5,000')
    expect(tip!.textContent).toContain('tokens')

    await gridCells(wrapper)[106].trigger('mouseleave')
    expect(document.body.querySelector('div.fixed')).toBeNull()
  })

  it('mouseenter 空格 → tooltip 显示「无消耗」', async () => {
    const wrapper = mountCalendar(new Map([['2026-08-25', 5000]]))

    await gridCells(wrapper)[0].trigger('mouseenter', { clientX: 20, clientY: 30 })
    const tip = document.body.querySelector('div.fixed')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('2026-05-11')
    expect(tip!.textContent).toContain('无消耗')
  })
})
