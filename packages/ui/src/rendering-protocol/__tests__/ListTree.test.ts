/**
 * ListTree 组件测试（W3 · v6 视觉改造）。
 * v6：缩进 16px、icon size-3 中性、status 7px 圆点（bg-success/accent/danger）右对齐。
 *
 * 运行：cd packages/ui && npx vitest run src/rendering-protocol/__tests__/ListTree.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ListTree from '../primitives/ListTree.vue'
import type { TreeItem } from '@zhushanwen/extension-protocol'

describe('ListTree', () => {
  it('递归渲染：parent 含嵌套 children + status 圆点', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        icon: 'arrow',
        children: [
          { label: 'child1', status: 'done' },
          { label: 'child2', status: 'running' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('parent')
    expect(wrapper.text()).toContain('child1')
    expect(wrapper.text()).toContain('child2')
    // v6: status 是圆点（bg-*），done→bg-success，running→bg-accent
    const statuses = wrapper.findAll('[data-testid="list-tree-status"]')
    expect(statuses).toHaveLength(2)
    expect(statuses[0].classes()).toContain('bg-success')
    expect(statuses[1].classes()).toContain('bg-accent')
  })

  it('failed status 圆点 bg-danger', () => {
    const items: TreeItem[] = [
      { label: 'failed-item', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    expect(wrapper.find('[data-testid="list-tree-status"]').classes()).toContain('bg-danger')
  })

  it('v6: depth 缩进 16px/层，depth=2 时 padding-left=32px', () => {
    const items: TreeItem[] = [
      { label: 'deep' },
    ]
    const wrapper = mount(ListTree, { props: { items, depth: 2 } })
    const item = wrapper.find('.list-tree__item')
    expect(item.attributes('style')).toContain('padding-left: 32px')
  })

  it('递归 children 自动 depth+1 缩进（children padding > parent padding）', () => {
    const items: TreeItem[] = [
      {
        label: 'parent',
        children: [
          { label: 'child' },
        ],
      },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const allItems = wrapper.findAll('.list-tree__item')
    expect(allItems).toHaveLength(2)
    // parent 在 depth=0 → padding-left: 0px
    expect(allItems[0].attributes('style')).toContain('padding-left: 0px')
    // v6: child 在 depth=1 → padding-left: 16px（比 parent 缩进）
    expect(allItems[1].attributes('style')).toContain('padding-left: 16px')
  })

  it('v6: status 改圆点后无文字标签（无进行中/完成/失败文本）', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'running' },
      { label: 'b', status: 'done' },
      { label: 'c', status: 'failed' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const statuses = wrapper.findAll('[data-testid="list-tree-status"]')
    expect(statuses).toHaveLength(3)
    // 圆点无文字内容
    for (const s of statuses) {
      expect(s.text()).toBe('')
    }
    // 整体文本不含旧 STATUS_LABEL 中文
    expect(wrapper.text()).not.toContain('进行中')
    expect(wrapper.text()).not.toContain('完成')
    expect(wrapper.text()).not.toContain('失败')
  })

  it('v6: status 圆点右对齐 + 7px 尺寸 + rounded-full', () => {
    const items: TreeItem[] = [
      { label: 'a', status: 'done' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const dot = wrapper.find('[data-testid="list-tree-status"]')
    expect(dot.classes()).toContain('ml-auto')
    expect(dot.classes()).toContain('size-[7px]')
    expect(dot.classes()).toContain('rounded-full')
    expect(dot.classes()).toContain('bg-success')
  })

  it('v6: icon size-3(12px) 且中性（无 status text-* 着色）', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check', status: 'done' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    const icon = wrapper.find('.list-tree__icon svg')
    expect(icon.exists()).toBe(true)
    expect(icon.classes()).toContain('size-3')
    // v6: icon 不再着 status 色（中性，继承 label）
    expect(icon.classes()).not.toContain('text-success')
    expect(icon.classes()).not.toContain('text-accent')
    expect(icon.classes()).not.toContain('text-danger')
  })

  it('icon=check 渲染对应图标', () => {
    const items: TreeItem[] = [
      { label: 'checked', icon: 'check' },
    ]
    const wrapper = mount(ListTree, { props: { items } })
    // check icon 用 lucide Check 组件（svg）
    expect(wrapper.find('.list-tree__icon svg').exists()).toBe(true)
  })

  it('空 items 不崩', () => {
    const wrapper = mount(ListTree, { props: { items: [] } })
    expect(wrapper.find('[data-testid="gui-list-tree"]').exists()).toBe(true)
  })
})
