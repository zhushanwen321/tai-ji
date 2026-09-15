/**
 * Columns 组件测试（W2 · U5）。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/Columns.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Columns from '../primitives/Columns.vue'
import type { GuiComponent } from '@taiji/extension-protocol'

describe('Columns', () => {
  it('ratios=[2,1] 时子区域 flex-grow 分别为 2 和 1', () => {
    const children: GuiComponent[] = [
      { type: 'ansi-text', props: { lines: ['left'] } },
      { type: 'ansi-text', props: { lines: ['right'] } },
    ]
    const wrapper = mount(Columns, {
      props: { children, ratios: [2, 1] },
    })
    const container = wrapper.find('[data-testid="gui-columns"]')
    expect(container.exists()).toBe(true)
    // v6（§3.5）：容器 gap-3(12px) 标准间距，审计确认已达标
    expect(container.classes()).toContain('gap-3')
    const kids = wrapper.findAll('.columns__child')
    expect(kids).toHaveLength(2)
    expect(kids[0].attributes('style')).toContain('flex-grow: 2')
    expect(kids[1].attributes('style')).toContain('flex-grow: 1')
    // 子组件通过 GuiComponentRenderer 渲染
    expect(wrapper.text()).toContain('left')
    expect(wrapper.text()).toContain('right')
  })

  it('ratios 未传时等分（flex-grow: 1）', () => {
    const children: GuiComponent[] = [
      { type: 'ansi-text', props: { lines: ['a'] } },
      { type: 'ansi-text', props: { lines: ['b'] } },
      { type: 'ansi-text', props: { lines: ['c'] } },
    ]
    const wrapper = mount(Columns, {
      props: { children },
    })
    // v6（§3.5）：等分场景容器同样 gap-3 标准间距
    expect(wrapper.find('[data-testid="gui-columns"]').classes()).toContain('gap-3')
    const kids = wrapper.findAll('.columns__child')
    expect(kids).toHaveLength(3)
    for (const k of kids) {
      expect(k.attributes('style')).toContain('flex-grow: 1')
    }
  })

  it('空 children 不崩', () => {
    const wrapper = mount(Columns, {
      props: { children: [] },
    })
    const container = wrapper.find('[data-testid="gui-columns"]')
    expect(container.exists()).toBe(true)
    // v6（§3.5）：空容器仍保留 gap-3 标准间距
    expect(container.classes()).toContain('gap-3')
  })
})
