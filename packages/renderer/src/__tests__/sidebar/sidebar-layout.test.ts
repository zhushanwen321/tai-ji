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
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'

beforeEach(() => {
  // SessionItem setup 内 useProjectStore（D14 归入项目菜单），mount 需激活 pinia
  setActivePinia(createPinia())
})

// ── D4: SessionItem hover 按钮 bottom-right 定位（spec §5.6A）──────
describe('D4: SessionItem hover 按钮定位', () => {
  function makeSession() {
    return {
      id: 'sess-1',
      label: 'Test Session',
      cwd: '/Users/test/project',
      lastActiveAt: Date.now(),
    }
  }

  it('hover 按钮容器定位在 bottom-right（遮 meta 而非 dirName，与 demo 一致）', () => {
    const wrapper = mount(SessionItem, {
      props: {
        session: makeSession(),
        active: false,
        status: 'done' as never,
      },
    })
    // spec §5.6A / D12：actions 容器 absolute bottom-0.5 right-1（bottom-right）。
    // 用 [class~=] 单词匹配避开 happy-dom 对 class 选择器中点（bottom-0.5）转义的脆弱性。
    const actionsContainer = wrapper.find('.absolute[class~="bottom-0.5"]')
    expect(actionsContainer.exists()).toBe(true)
    expect(actionsContainer.classes()).toContain('right-1')
  })
})

// ── D5: SegmentedTab count 数字渲染（三 tab 终态）────────────────
// [HISTORICAL] 原「badge 蓝点位置」用例已改写：badge 随 count 数字恢复一并移除
// （sidebar-tab-count-restore 设计决策 1，一态一手段——数字是「计数 > 0」的精确表达）。
describe('D5: SegmentedTab count 数字渲染', () => {
  it('count > 0 渲染数字 span，badge 蓝点不再存在（数字取代 badge）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions',
        sessionCount: 3,
        fileCount: 10,
      },
    })
    // badge 蓝点（原 absolute 定位 span）已移除
    expect(wrapper.find('.absolute.right-1.top-1').exists()).toBe(false)
    // 各 tab 图标右侧渲染 count 数字
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(3)
    expect(buttons[0].text()).toContain('3')
    expect(buttons[1].text()).toContain('10')
  })

  it('count = 0 不渲染数字 span（决策 4：避免一排 0 的噪音）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'sessions',
        sessionCount: 0,
        fileCount: 0,
      },
    })
    expect(wrapper.find('.absolute.right-1.top-1').exists()).toBe(false)
    const buttons = wrapper.findAll('button')
    for (const btn of buttons) {
      expect(btn.find('span').exists()).toBe(false)
    }
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
    // 子视图区容器：mt-1 min-h-0 flex-1 后须含 overflow-hidden
    // 正则匹配 `mt-1 min-h-0 flex-1 overflow-hidden`（允许 class 顺序中三者同时出现）
    const hasOverflowHidden = /mt-1\s+min-h-0\s+flex-1\s+overflow-hidden/.test(source)
    expect(hasOverflowHidden).toBe(true)
  })
})
