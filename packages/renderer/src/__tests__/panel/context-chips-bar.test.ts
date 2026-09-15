/**
 * ContextChipsBar 组件单测 —— W4 props/emit 重构（从本地 ref([]) 改 defineProps items + emit remove）。
 *
 * 覆盖：
 * - TC8: props items 含 image → 渲染 image chip（ImageIcon + chip-label 显 name + text-reasoning 色），
 *         点 × → emit('remove', path)
 * - 空数组：整行 v-if 自隐藏（不渲染外层容器）
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/context-chips-bar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ContextChipsBar from '@/components/panel/ContextChipsBar.vue'

describe('ContextChipsBar (W4 props/emit)', () => {
  it('空 items → 整行 v-if 自隐藏，不渲染外层容器', () => {
    const wrapper = mount(ContextChipsBar, { props: { items: [] } })
    expect(wrapper.text()).toBe('')
    expect(wrapper.find('div.flex-wrap').exists()).toBe(false)
  })

  it('TC8: items 含 image → 渲染 chip（label 显 name + text-reasoning）', () => {
    const wrapper = mount(ContextChipsBar, {
      props: {
        items: [{ id: '/tmp/a.png', name: 'a.png', type: 'image' }],
      },
    })
    // 外层容器渲染（v-if=items.length 生效）
    expect(wrapper.find('div.flex-wrap').exists()).toBe(true)
    // chip-label 显 name
    expect(wrapper.text()).toContain('a.png')
    // image chip 带 text-reasoning class（第一个 span chip）
    const chip = wrapper.findAll('span').find((s) => s.text().includes('a.png'))
    expect(chip).toBeTruthy()
    expect(chip!.classes()).toContain('text-reasoning')
  })

  it('TC8: 点 × 按钮 → emit remove 带 id（=path）', async () => {
    const wrapper = mount(ContextChipsBar, {
      props: {
        items: [{ id: '/tmp/a.png', name: 'a.png', type: 'image' }],
      },
    })
    // × 按钮是最后一个 Button（chip 内的删除位）
    const xBtn = wrapper.find('button')
    expect(xBtn.exists()).toBe(true)
    await xBtn.trigger('click')
    const removeEvents = wrapper.emitted('remove')
    expect(removeEvents).toBeTruthy()
    expect(removeEvents![0]).toEqual(['/tmp/a.png'])
  })

  it('非 image 类型（@/#）→ 不带 text-reasoning class', () => {
    const wrapper = mount(ContextChipsBar, {
      props: {
        items: [{ id: 'foo.ts', name: 'foo.ts', type: '#' }],
      },
    })
    const chip = wrapper.findAll('span').find((s) => s.text().includes('foo.ts'))
    expect(chip).toBeTruthy()
    expect(chip!.classes()).not.toContain('text-reasoning')
  })
})
