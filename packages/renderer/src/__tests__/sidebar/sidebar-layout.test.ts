/**
 * sidebar 布局优化单测（CW topic: sidebar-layout-optimization）。
 * 验证改动：宽度缩窄、hover 重定位、count 数字渲染（D1/D4/D5）。
 *
 * [HISTORICAL] 2026-09-16 侧栏任务 tab 退役：D2「子代理列表 slug 首行展示」、D3
 * 「工作流详情 model 降级」两组用例与「滚动修复：根 div h-full」的工作流详情用例随组件删除
 * ——同批删除的还有侧栏子代理列表 / 工作流列表 / 工作流详情三组件。
 * 「Sidebar 子视图区 overflow-hidden 防御」静态源码断言保留（Sidebar.vue 仍在）。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-layout.test.ts
 */
import { expectTextOnlyTabs } from '../helpers/sidebar-mount'
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'

beforeEach(() => {
  // SessionItem setup 内 useProjectStore（D14 归入项目菜单），mount 需激活 pinia
  setActivePinia(createPinia())
})

// ── D4: SessionItem hover 按钮定位（demo .si-acts 契约：右缘 6px 垂直居中，钮 20px / 图标 12px / 间距 2px）──────
describe('D4: SessionItem hover 按钮定位', () => {
  function makeSession() {
    return {
      id: 'sess-1',
      label: 'Test Session',
      cwd: '/Users/test/project',
      lastActiveAt: Date.now(),
    }
  }

  it('hover 按钮容器覆盖行右侧定宽槽（2026-10-11 裁决：absolute inset-0 覆盖「点+时间」槽，不遮名称）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: makeSession(),
        active: false,
        status: 'done' as never,
      },
    })
    // 契约：Actions 容器 = absolute inset-0 justify-end（覆盖 Display 右槽 58px，槽内
    // meta 悬停淡出）；名称块 flex-1 min-w-0 在槽左缘截断，钮构造性不遮名称。
    // 用 [class~=] 单词匹配避开 happy-dom 对 class 选择器中点/方括号转义的脆弱性。
    const actionsContainer = wrapper.find('.absolute[class~="inset-0"][class~="justify-end"]')
    expect(actionsContainer.exists()).toBe(true)
    expect(actionsContainer.classes()).toContain('gap-[2px]')
    // 右槽定宽 58px（三钮 18px×3 + gap 2×2 的覆盖预算）
    const slot = wrapper.find('.relative[class~="w-[58px]"]')
    expect(slot.exists()).toBe(true)
    // 状态点在右槽内（时间左侧），不在名称块前（2026-10-11 裁决改位）
    expect(slot.find('[data-testid="session-icon"]').exists()).toBe(true)
    const nameBlock = wrapper.find('.min-w-0.flex-1')
    expect(nameBlock.find('[data-testid="session-icon"]').exists()).toBe(false)
  })
})

// ── D5: SegmentedTab 文字 tab 形态（三 tab 终态）────────────────
// [HISTORICAL] 2026-09-16 任务 tab 退役；2026-10 M1 视觉复刻：icon-only + count 数字形态
// 随 demo .vtab 文字 tab 对齐退役，用例改写为「无 icon / 无数字」形态断言（count props
// 保留外部契约不渲染）。
describe('D5: SegmentedTab 文字 tab 形态', () => {
  it('count > 0 也不渲染数字与 icon（demo .vtab 文字 tab）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions',
        sessionCount: 3,
        fileCount: 10,
      },
    })
    // badge 蓝点（原 absolute 定位 span）已移除
    expect(wrapper.find('.absolute.right-1.top-1').exists()).toBe(false)
    // 文字 tab：三按钮只含 label 文字，无 icon svg、无 count 数字
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)
    expectTextOnlyTabs(buttons, ['3', '10'])
  })
})

// ── 滚动修复：Sidebar overflow-hidden（CW topic: fix-sidebar-subagent-workflow-scroll）
// 根因：侧边栏子视图组件根 div 缺 h-full，flex 高度传递链断裂，列表超长时 ScrollArea
// 不出现滚动条。Sidebar 子视图区缺 overflow-hidden 防御。
// [HISTORICAL] 2026-09-16：原「根 div h-full」的工作流详情用例随组件退役删除。
describe('滚动修复：Sidebar 子视图区 overflow-hidden 防御', () => {
  it('Sidebar.vue 子视图区容器含 overflow-hidden（防止子组件溢出撑开 footer）', async () => {
    // 静态源码断言：Sidebar 整体 mount 依赖多个 store/composable，成本高且与滚动修复无关。
    // 滚动修复的关键是子视图区容器（SegmentedTab 下方）的 class，直接读源码验证。
    const fs = await import('node:fs')
    const path = await import('node:path')
    const sidebarPath = path.resolve(__dirname, '../../components/sidebar/Sidebar.vue')
    const source = fs.readFileSync(sidebarPath, 'utf-8')
    // 子视图区容器：min-h-0 flex-1 后须含 overflow-hidden；mt-1 已删（视觉复刻 MF-1-16：
    // flex 容器内不塌缩多出 4px，节奏由 SegmentedTab mb-2 承担）
    const hasOverflowHidden = /min-h-0\s+flex-1\s+overflow-hidden/.test(source)
    expect(hasOverflowHidden).toBe(true)
    expect(source).not.toMatch(/class="mt-1\s+min-h-0/)
  })
})
