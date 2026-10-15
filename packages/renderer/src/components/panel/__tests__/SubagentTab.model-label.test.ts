// @vitest-environment happy-dom

/**
 * SubagentTab 模型标签槽组件测试（subagent-model-switch §7.1，U1 前端接线 DOM 面）。
 *
 * 断言「标签读取规则四分支」的用户可见呈现（三视角·使用者黑盒；分支逻辑的纯函数面
 * 由 useSubagentModel.test.ts 承担，此处钉住展示接线）：
 * - 分支④ 分叉态重载形态：record 详情载荷携带覆盖状态 + 最近生效值（回执态已丢）→
 *   模型标签显示最近生效值 ref、不回退覆盖意图值；「用户覆盖中」badge 在场；
 * - 兜底形态：从未切换的 record → 标签显示盖章值（record.model），无 badge；
 * - agentcall 视图（workflow 成员详情）：经 call.memberRecordId 圈定成员 record 接
 *   切换入口（与 chat 域同组件同提交通道）；record 缺失降级 meta 槽纯显示。
 *
 * 全 mock：drawer control / 三 store / MessageStream / useSubagentTabData /
 * ModelSelectPopover（trigger slot 直通）/ vue-i18n。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/SubagentTab.model-label.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { JSDOM } from 'jsdom'

// ── drawer：三段式虚拟 id 固定选中（chat 域 record 视图）────────────────────
// useSubagentSelection = main 合并后 SubagentTab 的选中态读取面（core selection 域，
// enteredFrom 词表 'chat' | 'workflow' | null）；useDrawerControl 为旧读取面保留 mock
// （组件已不消费，防挂载树其他子组件引用）。
const drawerState = {
  selectedSubagentId: ref<string>('subagent:main-1:sa-1'),
  enteredFrom: ref<'chat' | 'workflow' | null>('chat'),
}
vi.mock('@taiji/core/domain/drawer', () => ({
  useDrawerControl: () => drawerState,
  useSubagentSelection: () => drawerState,
  openWorkflowInDrawer: vi.fn(),
}))

// ── panel store（focusedSessionId 消费）───────────────────────────────────
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ focusedSessionId: ref('main-1') }),
}))

// ── subagent store：records 分区按 fixture 返回（subagentRecord 可变）──────
let subagentRecordFixture: Record<string, unknown> = {}
// drawer 二级 tab fixture（reactive——computed 依赖追踪，见 store mock 注释）
const drawerTabsFixture = reactive({ tabs: [] as string[], active: null as string | null })
vi.mock('@/stores/subagent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/subagent')>()
  return {
    ...actual,
    useSubagentStore: () => ({
      getRecordsBySession: (_sid: string) => [subagentRecordFixture],
      isStreamingSubagent: () => false,
      // drawer 二级 tab 状态（subagent-detail-tabs）：reactive fixture——组件 computed
      // 依赖追踪需要响应式对象（普通对象会让 tab computed 永不失效）。
      drawerTabsOf: () => drawerTabsFixture,
      openDrawerTab: vi.fn((_sid: string, vid: string) => {
        if (!drawerTabsFixture.tabs.includes(vid)) drawerTabsFixture.tabs.push(vid)
        drawerTabsFixture.active = vid
      }),
      activateDrawerTab: vi.fn((_sid: string, vid: string) => {
        if (drawerTabsFixture.tabs.includes(vid)) drawerTabsFixture.active = vid
      }),
      closeDrawerTab: vi.fn((_sid: string, vid: string) => {
        const idx = drawerTabsFixture.tabs.indexOf(vid)
        if (idx === -1) return drawerTabsFixture.active
        drawerTabsFixture.tabs.splice(idx, 1)
        if (drawerTabsFixture.active === vid) {
          drawerTabsFixture.active = drawerTabsFixture.tabs[Math.min(idx, drawerTabsFixture.tabs.length - 1)] ?? null
        }
        return drawerTabsFixture.active
      }),
    }),
  }
})

/** workflow store 的 records fixture（agentcall 视图用例注入；默认空）。 */
let workflowRecordsFixture: Array<Record<string, unknown>> = []
vi.mock('@/stores/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/workflow')>()
  return {
    ...actual,
    useWorkflowStore: () => ({ getRecordsBySession: () => workflowRecordsFixture }),
  }
})

// ── MessageStream / useSubagentTabData / ModelSelectPopover 桩 ─────────────
vi.mock('../MessageStream.vue', () => ({ default: { name: 'MessageStream', template: '<div data-testid="message-stream-stub" />' } }))
vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: ref(null),
    loadSubagentData: vi.fn(async () => {}),
    stopSubagentStream: vi.fn(),
    recordEngine: () => 'pi',
  }),
}))
// [D3-A6 / F1-25] trigger slot 直通 stub 须包真实 Popover 壳：SubagentTab 的
// #trigger 内容含 PopoverTrigger（调用方自包 as-child 契约，缺陷一修复后），
// 无 PopoverRoot 上下文时 PopoverTrigger inject 崩（曾致本文件 3 用例
// `Injection "Symbol(PopoverRootContext)" not found` 红）。popover 内容不渲染——
// 本文件钉标签呈现，点击行为由 SubagentTab.model-popover.test.ts 真实渲染承担。
vi.mock('../ModelSelectPopover.vue', async () => {
  const { Popover } = await import('@/components/ui/popover')
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      name: 'ModelSelectPopover',
      setup(_, { slots }) {
        return () =>
          h('div', { 'data-testid': 'model-select-stub' }, [
            h(Popover, null, { default: () => slots.trigger?.() }),
          ])
      },
    }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: vi.fn((key: string) => key) }),
}))

import SubagentTab from '../SubagentTab.vue'

function baseRecord(): Record<string, unknown> {
  return {
    subagentId: 'sa-1',
    sessionFile: '/sub/sa-1.jsonl',
    agent: 'worker',
    slug: 'work',
    task: 't',
    status: 'running',
    model: 'p/stamped',
    engine: undefined,
  }
}

function mountTab(): ReturnType<typeof mount> {
  return mount(SubagentTab, {
    global: {
      stubs: { teleport: true },
      config: { globalProperties: {} },
    },
  })
}

beforeEach(() => {
  subagentRecordFixture = baseRecord()
  drawerTabsFixture.tabs = []
  drawerTabsFixture.active = null
  drawerState.selectedSubagentId.value = 'subagent:main-1:sa-1'
  // happy-dom 环境缺 window.matchMedia 等时 mount 可能告警，此处不需要真实 DOM 窗口
  // （JSDOM import 仅为显式标注测试环境依赖，防 tree-shake 误删）。
  void JSDOM
})

describe('SubagentTab 模型标签槽（标签读取规则四分支的 DOM 呈现）', () => {
  it('分支④ 分叉态重载：载荷覆盖状态 + 最近生效值在场 → 标签显示最近生效值、不回退覆盖意图值，「用户覆盖中」badge 在场', () => {
    subagentRecordFixture = {
      ...baseRecord(),
      modelOverride: { model: 'p/user-intent', thinkingLevel: 'high' },
      recentEffectiveModel: { provider: 'p', modelId: 'recent-effective' },
    }
    const wrapper = mountTab()
    const trigger = wrapper.find('[data-testid="subagent-model-trigger"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('p/recent-effective')
    expect(trigger.text()).not.toContain('p/user-intent')
    expect(trigger.text()).not.toContain('p/stamped')
    expect(wrapper.find('[data-testid="subagent-override-badge"]').exists()).toBe(true)
  })

  it('[subagent-detail-model-info] 派发期来源标注：modelSource 在场 → badge 展示对应标注 + title 完整语义', () => {
    subagentRecordFixture = { ...baseRecord(), modelSource: 'explicit' }
    const wrapper = mountTab()
    const badge = wrapper.find('[data-testid="subagent-model-source-badge"]')
    expect(badge.exists()).toBe(true)
    // i18n mock 返回 key——键即文案锚（值域四分支各自键位见 locale 文件）
    expect(badge.text()).toBe('panel.sideDrawer.subagentModelSource.explicit')
    expect(badge.attributes('title')).toBe('panel.sideDrawer.subagentModelSourceTitle.explicit')
  })

  it('[subagent-detail-model-info] 存量 record（无 modelSource 字段）→ 来源标注不展示', () => {
    const wrapper = mountTab()
    expect(wrapper.find('[data-testid="subagent-model-source-badge"]').exists()).toBe(false)
  })

  it('分支② 已记账态（仅覆盖状态在场，无生效值）→ 标签显示覆盖意图值 + badge', () => {
    subagentRecordFixture = {
      ...baseRecord(),
      modelOverride: { model: 'p/user-intent' },
    }
    const wrapper = mountTab()
    const trigger = wrapper.find('[data-testid="subagent-model-trigger"]')
    expect(trigger.text()).toContain('p/user-intent')
    expect(wrapper.find('[data-testid="subagent-override-badge"]').exists()).toBe(true)
  })

  it('兜底：从未切换 → 标签显示盖章值、无 badge（现状语义不变）', () => {
    const wrapper = mountTab()
    const trigger = wrapper.find('[data-testid="subagent-model-trigger"]')
    expect(trigger.text()).toContain('p/stamped')
    expect(wrapper.find('[data-testid="subagent-override-badge"]').exists()).toBe(false)
  })

  it('agentcall 视图（workflow 成员详情）：call.memberRecordId 圈定成员 record → 有切换入口，标签走读取规则合成', () => {
    drawerState.selectedSubagentId.value = 'agentcall:sa-wf-1'
    // 成员键单源对齐锚：call.memberRecordId ≡ SubagentRecord.subagentId
    subagentRecordFixture = { ...baseRecord(), subagentId: 'sa-wf-1', model: 'p/member-stamped' }
    workflowRecordsFixture = [
      {
        runId: 'wf-1',
        scriptName: 'flow',
        status: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        agentCalls: [
          {
            id: 0,
            agent: 'worker',
            status: 'running',
            model: 'p/call-model',
            sessionId: 'sa-wf-1',
            memberRecordId: 'sa-wf-1',
          },
        ],
      },
    ]
    const wrapper = mountTab()
    // 切换入口在场（与 chat 域同 trigger testid），标签显示成员 record 盖章值
    // （读取规则兜底分支——从未切换）；call.model 不再走 meta 槽双处显示
    const trigger = wrapper.find('[data-testid="subagent-model-trigger"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('p/member-stamped')
    expect(wrapper.find('[data-testid="subagent-override-badge"]').exists()).toBe(false)
  })

  it('agentcall 视图降级：call 无 memberRecordId（成员 record 缺失）→ 无切换入口，标签走 meta 槽纯显示', () => {
    drawerState.selectedSubagentId.value = 'agentcall:sa-wf-1'
    workflowRecordsFixture = [
      {
        runId: 'wf-1',
        scriptName: 'flow',
        status: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        agentCalls: [{ id: 0, agent: 'worker', status: 'running', model: 'p/call-model', sessionId: 'sa-wf-1' }],
      },
    ]
    const wrapper = mountTab()
    expect(wrapper.find('[data-testid="subagent-model-trigger"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('p/call-model')
  })

  it('agentcall 视图降级：memberRecordId 在场但 subagentStore 无对应 record → 无切换入口，meta 槽纯显示', () => {
    drawerState.selectedSubagentId.value = 'agentcall:sa-wf-1'
    // store fixture 默认 record.subagentId = 'sa-1'，与 memberRecordId 'sa-wf-1' 不命中
    workflowRecordsFixture = [
      {
        runId: 'wf-1',
        scriptName: 'flow',
        status: 'running',
        startedAt: '2026-10-06T00:00:00Z',
        agentCalls: [
          {
            id: 0,
            agent: 'worker',
            status: 'running',
            model: 'p/call-model',
            sessionId: 'sa-wf-1',
            memberRecordId: 'sa-wf-1',
          },
        ],
      },
    ]
    const wrapper = mountTab()
    expect(wrapper.find('[data-testid="subagent-model-trigger"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('p/call-model')
  })
})
