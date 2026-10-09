/**
 * ComposerCapacityBar 组件测试 —— ui-optimize 决策 6 / N7 顶缘容量细条。
 *
 * 三视角：
 * - 使用者黑盒：色阶三档用户可见样式（bg-accent-soft 常态 / >80 bg-warn / >95 bg-danger，
 *   严格大于边界）+ 可访问性提示（aria-label 百分比，数字唯一入口在 hover 指标聚合页）；
 * - 观察者形态：顶缘 2px 定位锚（absolute top-0 h-[2px]）+ testid；
 * - 构建者白盒：渲染条件 = 分区 ok 且 contextWindow 已知（unknown / no-value / total=0
 *   不渲染——无百分比可分档，空 accent 条会伪装「永远安全」的假信号）。
 *
 * mock 策略：useContextUsage 替身（受控分区对象）——组件纯读契约的唯一外部输入；
 * 分区行为（订阅/恢复腿/哨兵）归 use-context-usage.test.ts（层 1），本文件不重复。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-capacity-bar.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

import ComposerCapacityBar from '@/components/panel/ComposerCapacityBar.vue'
import type { UsagePartition } from '@/composables/features/model/useContextUsage'

// ── useContextUsage 替身：分区值受控注入（vi.hoisted 保证 mock 工厂可引用）──
const usageFixture = vi.hoisted(() => ({
  current: null as UsagePartition | null,
}))

vi.mock('@/composables/features/model/useContextUsage', () => ({
  useContextUsage: () => ({ current: ref(usageFixture.current) }),
}))

/** ok 分区快捷工厂 */
function okPartition(percent: number, total = 200000): UsagePartition {
  return { status: 'ok', used: Math.round((total * percent) / 100), total, percent }
}

/** 挂载（读当前 fixture 分区；每用例先写 fixture 再 mount） */
function mountBar() {
  return mount(ComposerCapacityBar, { props: { sessionId: 's1' } })
}

describe('渲染条件（无百分比不分档，不渲染）', () => {
  it.each([
    ['unknown（首拉在途）', { status: 'unknown', used: 0, total: 0, percent: 0 } satisfies UsagePartition],
    ['no-value（compact 后合法无值）', { status: 'no-value', used: 0, total: 0, percent: 0 } satisfies UsagePartition],
    ['ok 但 contextWindow 未知（total=0）', okPartition(42, 0)],
  ])('%s → 不渲染细条', (_name, partition) => {
    usageFixture.current = partition
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="composer-capacity-bar"]').exists()).toBe(false)
  })
})

describe('色阶三档（决策 6：常态 accent 半透明 · >80 warn · >95 danger，严格大于）', () => {
  it.each([
    [0, 'bg-accent-soft'],
    [42, 'bg-accent-soft'],
    [80, 'bg-accent-soft'],
    [81, 'bg-warn'],
    [95, 'bg-warn'],
    [96, 'bg-danger'],
    [100, 'bg-danger'],
  ])('percent=%i → 内层填充条 %s', (percent, expected) => {
    usageFixture.current = okPartition(percent)
    const wrapper = mountBar()
    const bar = wrapper.find('[data-testid="composer-capacity-bar"]')
    expect(bar.exists()).toBe(true)
    // 色阶落内层填充条（demo .capbar > i 结构；外层轨道只管定位与裁剪）
    expect(bar.find('span').classes()).toContain(expected)
  })
})

describe('形态锚与可访问性（用户可见）', () => {
  it('顶缘 2px 定位锚：absolute inset-x top-0 + h-[2px]，随容器顶圆角 rounded-t-lg', () => {
    usageFixture.current = okPartition(42)
    const wrapper = mountBar()
    const bar = wrapper.find('[data-testid="composer-capacity-bar"]')
    for (const cls of ['absolute', 'top-0', 'h-[2px]', 'rounded-t-lg']) {
      expect(bar.classes()).toContain(cls)
    }
  })

  it('内层填充条宽度 = 已用百分比（demo .capbar i width:% 对齐）', () => {
    usageFixture.current = okPartition(42)
    const wrapper = mountBar()
    const fill = wrapper.find('[data-testid="composer-capacity-bar"] span')
    expect(fill.attributes('style')).toContain('width: 42%')
  })

  it('aria-label 带百分比数字（数字唯一入口在 hover 指标聚合页，细条只给色阶 + 读屏提示）', () => {
    usageFixture.current = okPartition(42)
    const wrapper = mountBar()
    const bar = wrapper.find('[data-testid="composer-capacity-bar"]')
    expect(bar.attributes('role')).toBe('img')
    expect(bar.attributes('aria-label')).toBe('上下文用量 42%')
  })
})
