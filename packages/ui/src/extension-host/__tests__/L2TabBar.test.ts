/**
 * L2TabBar 组件测试（W4 · T7）。
 *
 * 覆盖：tab 渲染 / active 态（v-model）/ close 按钮（builtin 不渲染 + 事件上抛）/
 * pin 按钮（事件上抛 + pinned 态）。
 *
 * 运行：cd packages/ui && npx vitest run src/extension-host/__tests__/L2TabBar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { ListTodo, Target } from '@lucide/vue'
import L2TabBar from '../L2TabBar.vue'
import type { L2TabItem } from '../l2-tab-item'

const TABS: L2TabItem[] = [
  { viewId: 'todo', title: '任务', icon: ListTodo, builtin: true },
  { viewId: 'goal', title: '目标', icon: Target, pinned: false },
]

function mountBar(tabs: L2TabItem[] = TABS, modelValue = 'todo') {
  return mount(L2TabBar, {
    props: { tabs, modelValue },
  })
}

describe('L2TabBar', () => {
  it('tab 渲染：标题文本 + data-testid（DOM 断言）', () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="l2-tabbar"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="l2-tab-todo"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="l2-tab-goal"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('任务')
    expect(wrapper.text()).toContain('目标')
    wrapper.unmount()
  })

  it('active 态：modelValue 对应 tab data-active=true，其余 false', () => {
    const wrapper = mountBar(TABS, 'goal')
    expect(wrapper.find('[data-testid="l2-tab-goal"]').attributes('data-active')).toBe('true')
    expect(wrapper.find('[data-testid="l2-tab-todo"]').attributes('data-active')).toBe('false')
    wrapper.unmount()
  })

  it('点击 tab → emit update:modelValue(viewId)', async () => {
    const wrapper = mountBar()
    await wrapper.find('[data-testid="l2-tab-goal"]').trigger('click')
    expect(wrapper.emitted('update:modelValue')).toBeTruthy()
    expect(wrapper.emitted('update:modelValue')![0]).toEqual(['goal'])
    wrapper.unmount()
  })

  it('close 按钮：builtin tab 不渲染 close；非 builtin 渲染；点击 emit close(viewId) 且不触发切换', async () => {
    const wrapper = mountBar()
    // builtin（todo）无 close；非 builtin（goal）有 close
    expect(wrapper.find('[data-testid="l2-tab-close-todo"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="l2-tab-close-goal"]').exists()).toBe(true)

    // 点击 close → emit close('goal')，且 @click.stop 不触发 update:modelValue
    await wrapper.find('[data-testid="l2-tab-close-goal"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(wrapper.emitted('close')![0]).toEqual(['goal'])
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    wrapper.unmount()
  })

  it('pin 按钮：点击 emit pin(viewId)；pinned 态 data-pinned=true（DOM 断言）', async () => {
    const wrapper = mountBar()
    expect(wrapper.find('[data-testid="l2-tab-pin-goal"]').attributes('data-pinned')).toBe('false')

    await wrapper.find('[data-testid="l2-tab-pin-goal"]').trigger('click')
    expect(wrapper.emitted('pin')).toBeTruthy()
    expect(wrapper.emitted('pin')![0]).toEqual(['goal'])

    // pinned 态（父层回传 pinned=true）→ data-pinned=true
    const pinnedTabs: L2TabItem[] = [
      { viewId: 'todo', title: '任务', icon: ListTodo, builtin: true },
      { viewId: 'goal', title: '目标', icon: Target, pinned: true },
    ]
    const wrapper2 = mountBar(pinnedTabs, 'goal')
    expect(wrapper2.find('[data-testid="l2-tab-pin-goal"]').attributes('data-pinned')).toBe('true')
    wrapper.unmount()
    wrapper2.unmount()
  })

  it('无 icon 的 tab：纯文字渲染，不抛错', () => {
    const noIconTabs: L2TabItem[] = [
      { viewId: 'plain', title: '纯文字', builtin: false },
    ]
    const wrapper = mountBar(noIconTabs, 'plain')
    expect(wrapper.text()).toContain('纯文字')
    expect(wrapper.find('[data-testid="l2-tab-plain"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
