/**
 * SegmentedTab 组件测试。
 *
 * 覆盖（三 tab 终态）：
 * - 渲染 3 个 tab（sessions/files/plugins）——DOM 断言，且 Agents/Flows 两枚不存在
 * - tab title 含 label（icon-only 模式，label 收进 title）
 * - count 数字渲染：count > 0 显示数字、count = 0 不渲染（决策 4）
 * - badge 蓝点已随数字恢复一并移除（决策 1：一态一手段，数字是更精确表达）
 * - active 态切换
 *
 * [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：两枚任务 tab 及其属性用例（子代理 / 工作流
 * 进行中计数 props）随侧栏任务 tab 退役删除——任务观察入口唯一化收口到 composer 任务托盘
 * （计数面 = panel/tray）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import type { SidebarTab } from '@/stores/sidebar'

function mountTab(props: Partial<{ modelValue: SidebarTab; sessionCount: number; fileCount: number }> = {}) {
  return mount(SegmentedTab, {
    props: {
      modelValue: 'sessions' as SidebarTab,
      sessionCount: 0,
      fileCount: 0,
      ...props,
    },
  })
}

describe('SegmentedTab', () => {
  it('渲染 3 个 tab（sessions/files/plugins）', () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)

    // tab title 含 label（i18n 中文：与组件 t('sidebar.segmentedTab.*') 输出对齐）
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('插件')
  })

  it('Agents / Flows 两枚 tab 不存在（任务观察入口已迁 composer 托盘）', () => {
    const wrapper = mountTab()

    const titles = wrapper.findAll('button').map((b) => b.attributes('title'))
    expect(titles).not.toContain('子代理')
    expect(titles).not.toContain('工作流')
    // 全渲染文本里不得出现两枚退役 tab 的中英标签
    expect(wrapper.text()).not.toContain('子代理')
    expect(wrapper.text()).not.toContain('工作流')
  })

  it('count > 0 的 tab 图标右侧渲染数字', () => {
    const wrapper = mountTab({ sessionCount: 3, fileCount: 6, modelValue: 'sessions' })

    const buttons = wrapper.findAll('button')
    // 各 tab 数字与传入 count props 一致（users 可见断言：数字文本即计数）
    expect(buttons[0].text()).toContain('3')
    expect(buttons[1].text()).toContain('6')
    // plugins 恒 0，不渲染数字
    expect(buttons[2].find('span').exists()).toBe(false)
  })

  it('count = 0 不渲染数字（决策 4：避免一排 0 的噪音）', () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    for (const btn of buttons) {
      expect(btn.find('span').exists()).toBe(false)
    }
  })

  it('badge 蓝点已移除（设计决策 1：数字 > 0 本身是更精确的表达，双手段并存违反一态一手段）', () => {
    const wrapper = mountTab({ sessionCount: 1, fileCount: 1 })

    // 即使 count > 0，也不再有 absolute 定位的 badge dot
    const badge = wrapper.find('.absolute.right-1.top-1')
    expect(badge.exists()).toBe(false)
    // 数字照常渲染（数字取代 badge 承载「计数 > 0」状态）
    const buttons = wrapper.findAll('button')
    expect(buttons[0].text()).toContain('1')
    expect(buttons[1].text()).toContain('1')
  })

  it('点击 tab 触发 update:modelValue', async () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    await buttons[1].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('files')
  })
})
