/**
 * Skeleton 原语测试（remote-use-mobile-v2 §6.9 / spec §6.9）。
 *
 * 覆盖：胶囊条形 + 扫光内件 + aria-hidden（装饰不进读屏）+ 尺寸经 class 注入。
 *
 * 运行：cd packages/ui && npx vitest run src/primitives/__tests__/skeleton.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Skeleton from '../skeleton/Skeleton.vue'

describe('Skeleton（spec §6.9 加载占位）', () => {
  it('胶囊条形 + 扫光内件 + aria-hidden（装饰元素不进读屏）', () => {
    const w = mount(Skeleton, { props: { class: 'h-4 w-full' } })
    expect(w.classes()).toContain('rounded-full')
    expect(w.classes()).toContain('bg-surface-2')
    expect(w.attributes('aria-hidden')).toBe('true')
    expect(w.find('.skeleton-sweep').exists()).toBe(true)
  })

  it('尺寸由消费方 class 注入（首屏列表 = 行高/宽度属屏级布局，非原语契约）', () => {
    const w = mount(Skeleton, { props: { class: 'h-4 w-full' } })
    expect(w.classes()).toContain('h-4')
    expect(w.classes()).toContain('w-full')
  })
})
