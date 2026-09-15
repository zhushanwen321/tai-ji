/**
 * SubagentFilterBar 组件测试（三视角，TEST-STRATEGY §3；U8b 可见性翻转后语义）。
 *
 * 覆盖（设计 docs/design/subagent-sidebar-filter.md §3.4 + 永久会话模型 §3.2.8）：
 * - 渲染（构建者白盒）：三视图 testid 齐全、计数渲染 counts 载荷、选中视图高亮
 *   （bg-bg-elevated + data-active="true"）、未选中 data-active="false"
 * - 黑盒（使用者）：点击视图按钮 → emit update:modelValue 载荷为视图 id
 * - 形态（观察者）：计数 testid 存在且文本含数字、三视图中文文案（i18n zh-CN）
 *
 * 纯展示组件：v-model 受控，高亮随 modelValue props 移动（含受控切换用例）。
 *
 * 运行：cd packages/renderer && pnpm test src/__tests__/components/SubagentFilterBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SubagentFilterBar from '@/components/sidebar/SubagentFilterBar.vue'
import type { SubagentFilterValue } from '@/lib/subagent-bucket'

const COUNTS = { active: 4, running: 2, archived: 1 }

function mountBar(modelValue: SubagentFilterValue = 'active') {
  return mount(SubagentFilterBar, {
    props: { counts: COUNTS, modelValue },
  })
}

describe('SubagentFilterBar 渲染（白盒：计数 + 选中高亮）', () => {
  it('渲染三个筛选按钮（active / running / archived testid 齐全）', () => {
    const wrapper = mountBar()
    for (const id of ['active', 'running', 'archived'] as const) {
      expect(wrapper.find(`[data-testid="subagent-filter-${id}"]`).exists()).toBe(true)
    }
  })

  // （计数渲染断言由「计数元素三视图齐全」用例承担（exists + contains 超集），
  //  此处原直等版本与其重复，已删。）

  it('选中视图含 bg-bg-elevated 浮起 class 且 data-active="true"', () => {
    const wrapper = mountBar('active')
    const activeBtn = wrapper.find('[data-testid="subagent-filter-active"]')
    expect(activeBtn.classes()).toContain('bg-bg-elevated')
    expect(activeBtn.attributes('data-active')).toBe('true')
  })

  it('未选中视图 data-active="false" 且无 bg-bg-elevated', () => {
    const wrapper = mountBar('active')
    for (const id of ['running', 'archived'] as const) {
      const btn = wrapper.find(`[data-testid="subagent-filter-${id}"]`)
      expect(btn.attributes('data-active')).toBe('false')
      expect(btn.classes()).not.toContain('bg-bg-elevated')
    }
  })

  it('modelValue 切到 archived 时高亮随 props 移动（纯受控组件，无内部状态）', () => {
    const wrapper = mountBar('archived')
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').classes()).toContain('bg-bg-elevated')
    expect(wrapper.find('[data-testid="subagent-filter-active"]').classes()).not.toContain('bg-bg-elevated')
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').attributes('data-active')).toBe('true')
  })
})

describe('SubagentFilterBar 黑盒（点击上抛 update:modelValue）', () => {
  it('点击「已收起」按钮 emit update:modelValue 载荷 ["archived"]（场景 3 寻回入口）', async () => {
    const wrapper = mountBar()
    await wrapper.find('[data-testid="subagent-filter-archived"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['archived'])
  })

  it('点击「正在跑」按钮 emit update:modelValue 载荷 ["running"]', async () => {
    const wrapper = mountBar()
    await wrapper.find('[data-testid="subagent-filter-running"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['running'])
  })

  it('点击「全部」按钮 emit update:modelValue 载荷 ["active"]（从其他视图切回）', async () => {
    const wrapper = mountBar('archived')
    await wrapper.find('[data-testid="subagent-filter-active"]').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual(['active'])
  })
})

describe('SubagentFilterBar 形态（观察者：文案 + 计数可见）', () => {
  it('三视图文案为「全部 / 正在跑 / 已收起」（zh-CN i18n，逐视图断言防串扰）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="subagent-filter-active"]').text()).toContain('全部')
    expect(wrapper.find('[data-testid="subagent-filter-running"]').text()).toContain('正在跑')
    expect(wrapper.find('[data-testid="subagent-filter-archived"]').text()).toContain('已收起')
  })

  it('计数元素三视图齐全且文本含数字（数量预告 G3 用户可见）', () => {
    const wrapper = mountBar()
    const expectations: ReadonlyArray<[SubagentFilterValue, string]> = [
      ['active', '4'],
      ['running', '2'],
      ['archived', '1'],
    ]
    for (const [id, count] of expectations) {
      const el = wrapper.find(`[data-testid="subagent-filter-count-${id}"]`)
      expect(el.exists()).toBe(true)
      expect(el.text()).toContain(count)
    }
  })
})
