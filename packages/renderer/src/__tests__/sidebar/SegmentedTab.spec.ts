/**
 * SegmentedTab 组件测试。
 *
 * 覆盖（三 tab 终态）：
 * - 渲染 3 个 tab（sessions/files/plugins）——DOM 断言，且 Agents/Flows 两枚不存在
 * - tab title 含 label（label 直出 + title 双通道）
 * - 文字 tab 形态（demo .vtab 对齐）：label 直出、icon/count 不渲染
 * - active 态切换
 *
 * [HISTORICAL] 2026-09-16 五 tab 收敛为三 tab：两枚任务 tab 及其属性用例（子代理 / 工作流
 * 进行中计数 props）随侧栏任务 tab 退役删除——任务观察入口唯一化收口到 composer 任务托盘
 * （计数面 = panel/tray）。
 * [HISTORICAL] icon-only + count 数字形态随 demo .vtab 文字 tab 对齐退役（2026-10 M1 视觉复刻）：
 * 原「count 数字渲染 / badge 蓝点」两组用例随之改写为文字 tab 形态断言。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/SegmentedTab.spec.ts
 */
import { expectTextOnlyTabs } from '../helpers/sidebar-mount'
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
  it('渲染 3 个 tab（sessions/files/plugins），label 直出', () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)

    // tab title 含 label（i18n 中文：与组件 t('sidebar.segmentedTab.*') 输出对齐）
    expect(buttons[0].attributes('title')).toBe('会话')
    expect(buttons[1].attributes('title')).toBe('文件')
    expect(buttons[2].attributes('title')).toBe('插件')
    // 文字 tab：label 直出（demo .vtab 形态）
    expect(buttons[0].text()).toContain('会话')
    expect(buttons[1].text()).toContain('文件')
    expect(buttons[2].text()).toContain('插件')
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

  it('文字 tab 形态：不渲染 icon svg 与 count 数字（demo .vtab，count props 保留外部契约）', () => {
    const wrapper = mountTab({ sessionCount: 3, fileCount: 6, modelValue: 'sessions' })

    const buttons = wrapper.findAll('button')
    expectTextOnlyTabs(buttons, ['3', '6'])
  })

  it('点击 tab 触发 update:modelValue', async () => {
    const wrapper = mountTab()

    const buttons = wrapper.findAll('button')
    await buttons[1].trigger('click')

    const emitted = wrapper.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    expect(emitted![0][0]).toBe('files')
  })

  it('tablist 范式（spec sidebar §3.1）：容器 role=tablist + 钮 role=tab + aria-selected', () => {
    const wrapper = mountTab({ modelValue: 'files' })

    expect(wrapper.find('[role="tablist"]').exists()).toBe(true)
    const buttons = wrapper.findAll('button')
    expect(buttons.map((b) => b.attributes('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(buttons[1].attributes('aria-selected')).toBe('true')
    expect(buttons[0].attributes('aria-selected')).toBe('false')
  })

  it('方向键环形移动并立即激活（spec §3.1：→ 下一视图、← 上一视图、首尾环形）', async () => {
    const wrapper = mountTab({ modelValue: 'sessions' })
    const tablist = wrapper.find('[role="tablist"]')

    // → 自会话到文件
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![0][0]).toBe('files')
    await wrapper.setProps({ modelValue: 'files' })

    // → 自文件到插件（立即激活随 modelValue 推进）
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![1][0]).toBe('plugins')
    await wrapper.setProps({ modelValue: 'plugins' })

    // → 自插件环形回会话（尾首相接）
    await tablist.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.emitted('update:modelValue')![2][0]).toBe('sessions')
    await wrapper.setProps({ modelValue: 'sessions' })

    // ← 自会话环形回插件（反向环绕）
    await tablist.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('update:modelValue')![3][0]).toBe('plugins')
  })
})
