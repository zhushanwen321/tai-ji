/**
 * CompatEditor 渲染 + 折叠交互单测（W3 · TC-2）。
 *
 * mount CompatEditor（api=openai-completions），断言 essential 字段渲染 + advanced 折叠态 +
 * 展开后 advanced 字段出现。i18n 经 vitest.setup mock（t 返回 key）。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CompatEditor from '../compat/CompatEditor.vue'

describe('CompatEditor', () => {
  it('essential 字段区默认渲染（api=openai-completions）', () => {
    const wrapper = mount(CompatEditor, {
      props: { api: 'openai-completions', modelValue: undefined },
    })
    // essential 分组标签 i18n key 渲染
    expect(wrapper.text()).toContain('settings.compat.essential')
    // essential 至少渲染一个 CompatField（thinkingFormat 等）
    expect(wrapper.findAllComponents({ name: 'CompatField' }).length).toBeGreaterThan(0)
  })

  it('advanced 区默认折叠，点击展开后渲染 advanced 字段', async () => {
    const wrapper = mount(CompatEditor, {
      props: { api: 'openai-completions', modelValue: undefined },
    })
    // 折叠态：advanced toggle 按钮存在，文案为「展开」语义 key
    const toggle = wrapper.find('button.text-accent')
    expect(toggle.exists()).toBe(true)
    // 展开前 advanced 字段不渲染（only essential CompatField）
    const beforeCount = wrapper.findAllComponents({ name: 'CompatField' }).length
    await toggle.trigger('click')
    // 展开后 CompatField 数量增加（advanced 字段加入）
    const afterCount = wrapper.findAllComponents({ name: 'CompatField' }).length
    expect(afterCount).toBeGreaterThan(beforeCount)
  })

  it('清空按钮在已有 modelValue 时显示', () => {
    const wrapper = mount(CompatEditor, {
      props: { api: 'openai-completions', modelValue: { thinkingFormat: 'openai' } },
    })
    // 清空按钮 i18n key 存在
    expect(wrapper.text()).toContain('settings.compat.clearAll')
  })
})
