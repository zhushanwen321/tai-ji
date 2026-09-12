/**
 * sidebar 布局优化单测（CW topic: sidebar-layout-optimization）。
 * 验证 5 项改动（D1-D5）：宽度缩窄、slug 去除、model 降级、hover 重定位、count 数字渲染。
 *
 * 测试框架：vitest（从 vitest 导入 describe/it/expect/vi）。
 * 运行：cd packages/renderer && npx vitest run src/__tests__/sidebar/sidebar-layout.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SubagentList from '@/components/sidebar/SubagentList.vue'
import WorkflowDetail from '@/components/sidebar/WorkflowDetail.vue'
import SessionItem from '@/components/sidebar/SessionItem.vue'
import SegmentedTab from '@/components/sidebar/SegmentedTab.vue'
import type { SubagentRecord, WorkflowRunRecord } from '@xyz-agent/shared'

beforeEach(() => {
  // SessionItem setup 内 useProjectStore（D14 归入项目菜单），mount 需激活 pinia
  setActivePinia(createPinia())
})

// ── D2: SubagentList slug 首行展示 ──────────────────────────
// [HISTORICAL] 2026-08-05 曾降级为 tooltip（不渲染独立 span）；135295d0d（2026-08-22）
// 恢复首行 slug 展示（与 WorkflowList 第一行对齐），测试同步反转。
describe('D2: SubagentList slug 首行展示', () => {
  it('slug 以独立 mono 小字渲染在 agent name 右侧，卡片 title 仍带完整 tooltip', () => {
    const records: SubagentRecord[] = [{
      subagentId: 'sub-abc123def456',
      agent: 'code-reviewer',
      slug: 'cr-abc123',
      // [D6 适配 subagent-sidebar-filter] 原 status:'done' 落「已结束」桶，默认 active 桶下卡片不渲染；
      // 布局断言与 status 无关，改 running（真在跑）即可见
      status: 'running',
      task: 'Review the auth module',
    } as SubagentRecord]
    const wrapper = mount(SubagentList, { props: { subagents: records, sessionId: 'sess-1' } })
    const slugSpan = wrapper.find('[data-testid=subagent-card-slug]')
    expect(slugSpan.exists()).toBe(true)
    expect(slugSpan.text()).toBe('cr-abc123')
    expect(slugSpan.classes()).toContain('font-mono')
    const card = wrapper.find('[data-testid=subagent-card]')
    expect(card.attributes('title')).toBe('code-reviewer · cr-abc123')
  })

  it('agent name 完整展示（不再被 slug 挤占）', () => {
    const records: SubagentRecord[] = [{
      subagentId: 'sub-abc123def456',
      agent: 'documentation-writer',
      slug: 'dw-abc123',
      status: 'running',
      task: 'Write API docs',
    } as SubagentRecord]
    const wrapper = mount(SubagentList, { props: { subagents: records, sessionId: 'sess-1' } })
    expect(wrapper.text()).toContain('documentation-writer')
  })
})

// ── D3: WorkflowDetail model 降级到摘要行 ──────────────────
describe('D3: WorkflowDetail model 降级', () => {
  function makeWorkflow(): WorkflowRunRecord {
    return {
      runId: 'run-1',
      scriptName: 'lint-fix',
      slug: 'lf-001',
      status: 'done',
      reason: 'completed',
      startedAt: '2026-07-15T10:00:00Z',
      completedAt: '2026-07-15T10:05:00Z',
      agentCalls: [{
        id: 'call-1',
        agent: 'coder',
        model: 'claude-sonnet-4-5',
        status: 'completed',
        phase: 'implement',
        inputTokens: 5000,
        outputTokens: 3000,
        turns: 5,
        durationMs: 12000,
        sessionId: 'sess-1',
      }],
    } as unknown as WorkflowRunRecord
  }

  it('model 不在 agent call 主行（主行只含 dot + agent name）', () => {
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeWorkflow() } })
    // agent call 卡片主行：[dot] [agent name flex-1] — model 曾以 shrink-0 span 在主行右侧
    const agentCallCards = wrapper.findAll('[data-testid="workflow-agent-call"]')
    expect(agentCallCards.length).toBe(1)
    // 主行是第一个 flex items-center gap-2 的 div
    const firstRow = agentCallCards[0].find('.flex.items-center.gap-2')
    // model 不应出现在主行文本里（主行只有 agent name）
    const mainRowText = firstRow.text()
    expect(mainRowText).not.toContain('claude-sonnet-4-5')
  })

  it('model 出现在摘要行（与 tokens/turns/duration 并列）', () => {
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeWorkflow() } })
    // 摘要行：pl-[19px] 的 meta 行（font-mono text-[10px] text-neutral-dim）
    const summaryLines = wrapper.findAll('.pl-\\[19px\\]')
    const allSummaryText = summaryLines.map((s) => s.text()).join(' ')
    expect(allSummaryText).toContain('claude-sonnet-4-5')
  })
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

// ── D5: SegmentedTab count 数字渲染 ─────────────────────────
// [HISTORICAL] 原「badge 蓝点位置」用例已改写：badge 随 count 数字恢复一并移除
// （sidebar-tab-count-restore 设计决策 1，一态一手段——数字是「进行中 > 0」的精确表达）。
describe('D5: SegmentedTab count 数字渲染', () => {
  it('count > 0 渲染数字 span，badge 蓝点不再存在（数字取代 badge）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'subagents',
        sessionCount: 3,
        fileCount: 10,
        subagentRunningCount: 2,
        workflowRunningCount: 1,
      },
    })
    // badge 蓝点（原 absolute 定位 span）已移除
    expect(wrapper.find('.absolute.right-1.top-1').exists()).toBe(false)
    // 各 tab 图标右侧渲染 count 数字
    const buttons = wrapper.findAll('button')
    expect(buttons[0].text()).toContain('3')
    expect(buttons[1].text()).toContain('10')
    expect(buttons[2].text()).toContain('2')
    expect(buttons[3].text()).toContain('1')
  })

  it('count = 0 不渲染数字 span（决策 4：避免一排 0 的噪音）', () => {
    const wrapper = mount(SegmentedTab, {
      props: {
        modelValue: 'subagents',
        sessionCount: 0,
        fileCount: 0,
        subagentRunningCount: 0,
        workflowRunningCount: 0,
      },
    })
    expect(wrapper.find('.absolute.right-1.top-1').exists()).toBe(false)
    const buttons = wrapper.findAll('button')
    for (const btn of buttons) {
      expect(btn.find('span').exists()).toBe(false)
    }
  })
})

// ── 滚动修复：根 div h-full + Sidebar overflow-hidden（CW topic: fix-sidebar-subagent-workflow-scroll）
// 根因：三个侧边栏组件根 div 缺 h-full，flex 高度传递链断裂，
// 列表超长时 ScrollArea 不出现滚动条。Sidebar 子视图区缺 overflow-hidden 防御。
describe('滚动修复：根 div h-full', () => {
  function makeWorkflow(): WorkflowRunRecord {
    return {
      runId: 'run-scroll-1',
      scriptName: 'lint-fix',
      slug: 'lf-001',
      status: 'done',
      reason: 'completed',
      startedAt: '2026-07-15T10:00:00Z',
      completedAt: '2026-07-15T10:05:00Z',
      agentCalls: [{
        id: 'call-1',
        agent: 'coder',
        status: 'completed',
        phase: 'implement',
      }] as WorkflowRunRecord['agentCalls'][number],
    } as unknown as WorkflowRunRecord
  }

  it('WorkflowDetail 根 div 含 h-full（确保撑满父容器，ScrollArea flex-1 才能正确约束高度）', () => {
    const wrapper = mount(WorkflowDetail, { props: { workflow: makeWorkflow() } })
    const root = wrapper.find('[data-testid="workflow-detail"]')
    expect(root.exists()).toBe(true)
    expect(root.classes()).toContain('h-full')
    expect(root.classes()).toContain('min-h-0')
    expect(root.classes()).toContain('flex-col')
  })
})

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
