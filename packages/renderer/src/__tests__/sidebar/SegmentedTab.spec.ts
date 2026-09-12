/**
 * SegmentedTab 组件测试。
 *
 * 覆盖：
 * - 渲染 5 个 tab（sessions/files/subagents/workflows/plugins）
 * - tab title 含 label（icon-only 模式，label 收进 title）
 * - count 数字渲染：count > 0 显示数字、count = 0 不渲染（sidebar-tab-count-restore 设计决策 4）
 * - badge 蓝点已随数字恢复一并移除（设计决策 1：一态一手段，数字是更精确表达）
 * - active 态切换
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import type { SidebarTab } from '@/stores/sidebar'

describe('SegmentedTab', () => {
  it('渲染 5 个 tab（sessions/files/subagents/workflows/plugins）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 0,
        fileCount: 0,
        subagentRunningCount: 0,
        workflowRunningCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(5)

    // tab title 含 label（i18n 中文：与组件 t('sidebar.segmentedTab.*') 输出对齐）
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('子代理')
    expect(buttons[3].attributes('title')).toBe('工作流')
    expect(buttons[4].attributes('title')).toBe('插件')
  })

  it('count > 0 的 tab 图标右侧渲染数字', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'subagents' as SidebarTab,
        sessionCount: 3,
        fileCount: 6,
        subagentRunningCount: 2,
        workflowRunningCount: 1,
      },
    })

    const buttons = wrapper.findAll('button')
    // 各 tab 数字与传入 count props 一致（users 可见断言：数字文本即计数）
    expect(buttons[0].text()).toContain('3')
    expect(buttons[1].text()).toContain('6')
    expect(buttons[2].text()).toContain('2')
    expect(buttons[3].text()).toContain('1')
    // plugins 恒 0，不渲染数字
    expect(buttons[4].find('span').exists()).toBe(false)
  })

  it('count = 0 不渲染数字（决策 4：避免一排 0 的噪音）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 0,
        fileCount: 0,
        subagentRunningCount: 0,
        workflowRunningCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    for (const btn of buttons) {
      expect(btn.find('span').exists()).toBe(false)
    }
  })

  it('badge 蓝点已移除（设计决策 1：数字 > 0 本身是更精确的表达，双手段并存违反一态一手段）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 0,
        fileCount: 0,
        subagentRunningCount: 1,
        workflowRunningCount: 1,
      },
    })

    // 即使 running > 0，也不再有 absolute 定位的 badge dot
    const badge = wrapper.find('.absolute.right-1.top-1')
    expect(badge.exists()).toBe(false)
    // 数字照常渲染（数字取代 badge 承载「进行中 > 0」状态）
    const buttons = wrapper.findAll('button')
    expect(buttons[2].text()).toContain('1')
    expect(buttons[3].text()).toContain('1')
  })

  it('点击 tab 触发 update:modelValue', async () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions' as SidebarTab,
        sessionCount: 0,
        fileCount: 0,
        subagentRunningCount: 0,
        workflowRunningCount: 0,
      },
    })

    const buttons = wrapper.findAll('button')
    await buttons[2].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('subagents')
  })
})
