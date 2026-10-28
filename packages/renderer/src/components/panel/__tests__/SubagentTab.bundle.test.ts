/**
 * SubagentTab 组件域合并产物（round 6 renderer 测试压缩）：三文件同产物
 * （SubagentTab.model-popover 保留独立——其测真实 ModelSelectPopover 渲染，与本产物
 * 的 ModelSelectPopover mock 结构性互斥）。
 *
 * 并入来源（基名）：
 *  - SubagentTab.degraded（live 流降级提示条，4 例）
 *  - SubagentTab.model-label（模型标签槽四分支，8 例）
 *  - SubagentTab.tabs（二级 tab 编排，8 例）
 *
 * mock 注册与互斥核查（三源归一）：
 *  - drawer domain / stores(subagent·panel·workflow·chat) / ModelSelectPopover /
 *    ui/popover 五路成员子集 → 统一并集工厂；ModelSelectPopover 取 model-label 的
 *    富形态（含 model-select-stub testid，degraded/tabs 节断言不触富形态差异面）。
 *  - subagent store 的 getRecordsBySession：三源各自 fixture → 共享 subagentRecordsList
 *    reactive 数组，各节 beforeEach 重播本节初始记录（tabs 原文件正文零引用
 *    recordsFixture 字段、无跨用例累积依赖，重播语义等价）。
 *  - panel store 的 focusedSessionId：ref 形（degraded/model-label）与 getter 形（tabs）
 *    → 统一 getter 形（共享 panelFocusedSid，各节 beforeEach 重播 'main-1'）。
 *  - chat store 的 isSubagentStreamDegraded：degraded 记录版 → 统一记录版共享
 *    degradedRef/degradedQueries（model-label/tabs 节 beforeEach 重播 false）。
 *  - workflow store：model-label 的 workflowRecordsFixture 形 → 统一共享
 *    workflowRecordsFixture（degraded/tabs 节 beforeEach 清空）。
 *  - 三源逐字相同：MessageStream stub / useSubagentTabData / vue-i18n（t→key +
 *    createI18n 桩）。
 *  - 各节 beforeEach 增补的重播行（panelFocusedSid / degradedRef /
 *    subagentRecordsList / workflowRecordsFixture）见各节内注释。
 *
 * 运行：cd packages/renderer && TAIJI_SKIP_REAL_PI=1 npx vitest run src/components/panel/__tests__/SubagentTab.bundle.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { JSDOM } from 'jsdom'
import SubagentTab from '../SubagentTab.vue'
import { useSubagentStore } from '@/stores/subagent'
import { closeDrawerIfTabsEmpty, openSubagent, clearSubagentSelection } from '@taiji/core/domain/drawer'

// ── 共享 fixture（三节各按 beforeEach 重播）──
/** 降级位 fixture（chat store 读口闭包在测试内改值，computed 追踪） */
const degradedRef = ref(false)
/** 读口查询记录：断言组件传对了 (virtualId, recordId) */
const degradedQueries: Array<{ virtualId: string; recordId: string }> = []
const drawerState = {
  selectedSubagentId: ref<string | null>('subagent:main-1:sa-1'),
}
const panelFocusedSid = ref<string | null>('main-1')
const drawerTabsFixture = reactive({ tabs: [] as string[], active: null as string | null })
// 各节动态取数闭包（节内 fixture 变量被用例重赋值时工厂仍取到新值——闭包晚绑定）
let recordsListDyn: () => Array<Record<string, unknown>> = () => []
let workflowRecordsFixture: Array<Record<string, unknown>> = []
// tab 方法桩 = 模级共享实例（useSubagentStore() 每次调用返回新对象，fn 内联在工厂里
// 会逐调用新建、调用计数不可断言——空串早退用例需跨调用断言 store 编排零触发）。
const openDrawerTabMock = vi.fn((_sid: string, vid: string) => {
  if (!drawerTabsFixture.tabs.includes(vid)) drawerTabsFixture.tabs.push(vid)
  drawerTabsFixture.active = vid
})
const activateDrawerTabMock = vi.fn((_sid: string, vid: string) => {
  if (drawerTabsFixture.tabs.includes(vid)) drawerTabsFixture.active = vid
})
const closeDrawerTabMock = vi.fn((_sid: string, vid: string) => {
  const idx = drawerTabsFixture.tabs.indexOf(vid)
  if (idx === -1) return drawerTabsFixture.active
  drawerTabsFixture.tabs.splice(idx, 1)
  if (drawerTabsFixture.active === vid) {
    drawerTabsFixture.active = drawerTabsFixture.tabs[Math.min(idx, drawerTabsFixture.tabs.length - 1)] ?? null
  }
  return drawerTabsFixture.active
})

// drawer 域 importOriginal 部分 mock（真模块承接 barrel 全导出与顶层绑定，只覆写
// 组件消费的读侧/写侧桩——三源成员并集）。
vi.mock('@taiji/core/domain/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/domain/drawer')>()
  return {
    ...actual,
    useDrawerControl: () => drawerState,
    useSubagentSelection: () => drawerState,
    // 真实语义：清 core 选中态（关闭入口的选中同步通道）
    clearSubagentSelection: vi.fn(() => {
      drawerState.selectedSubagentId.value = null
    }),
    // 真实语义：写选中态（tab 点击/关闭的选中同步通道）
    openSubagent: vi.fn((opts: { virtualId: string }) => {
      drawerState.selectedSubagentId.value = opts.virtualId
    }),
    // 关空收敛桩：编排层 close() 无条件调用的抽屉关空通道（断言用例见「关空清选中态」）
    closeDrawerIfTabsEmpty: vi.fn(),
  }
})

// ── panel store（focusedSessionId 消费；getter 形，共享 panelFocusedSid）──
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({
    get focusedSessionId() {
      return panelFocusedSid.value
    },
  }),
}))

// ── chat store readers 面（core 流状态机的 degraded 位；记录版共享）──
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isSubagentStreamDegraded: (virtualId: string, recordId: string) => {
      degradedQueries.push({ virtualId, recordId })
      return degradedRef.value
    },
  }),
}))

vi.mock('@/stores/subagent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/subagent')>()
  return {
    ...actual,
    useSubagentStore: () => ({
      getRecordsBySession: (_sid: string) => recordsListDyn(),
      isStreamingSubagent: () => false,
      drawerTabsOf: () => drawerTabsFixture,
      openDrawerTab: openDrawerTabMock,
      activateDrawerTab: activateDrawerTabMock,
      closeDrawerTab: closeDrawerTabMock,
    }),
  }
})

vi.mock('@/stores/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/workflow')>()
  return {
    ...actual,
    useWorkflowStore: () => ({ getRecordsBySession: () => workflowRecordsFixture }),
  }
})

// ── 展示重树桩（三源逐字相同）──
vi.mock('../MessageStream.vue', () => ({ default: { name: 'MessageStream', template: '<div data-testid="message-stream-stub" />' } }))
vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: ref(null),
    loadSubagentData: vi.fn(async () => {}),
    stopSubagentStream: vi.fn(),
    recordEngine: () => 'pi',
  }),
}))
// ModelSelectPopover：model-label 富形态（trigger 经 Popover 渲染；testid 面与简形态一致）
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
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, PopoverTrigger: { template: '<div><slot /></div>' } }
})

// i18n mock：t 返回 key——断言键即文案锚（值域见 locales/{zh-CN,en-US}/subagent.ts）
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: vi.fn((key: string) => key) }),
  // @/i18n 模块实例（ui-response-feedback 等 shell 叶子经 import 链拉入）加载期调用：
  // 最小实例桩——本文件文案断言走 useI18n 桩的 t，不经 global 通道
  createI18n: vi.fn(() => ({
    global: {
      t: (key: string) => key,
      locale: ref('zh-CN'),
      setLocaleMessage: vi.fn(),
    },
  })),
}))

// ═══════════ 来源节：SubagentTab.degraded ═══════════

const subagentRecordFixture: Record<string, unknown> = {
  subagentId: 'sa-1',
  sessionFile: '/sub/sa-1.jsonl',
  agent: 'worker',
  slug: 'work',
  task: 't',
  status: 'running',
  model: 'p/stamped',
  engine: undefined,
}
recordsListDyn = () => [subagentRecordFixture]


describe('SubagentTab.degraded', () => {
const subagentRecordFixture: Record<string, unknown> = {
  subagentId: 'sa-1',
  sessionFile: '/sub/sa-1.jsonl',
  agent: 'worker',
  slug: 'work',
  task: 't',
  status: 'running',
  model: 'p/stamped',
  engine: undefined,
}

const DEGRADED_TESTID = 'subagent-stream-degraded'
const VIDEO_ID = 'subagent:main-1:sa-1'

function mountTab(): ReturnType<typeof mount> {
  return mount(SubagentTab, {
    global: {
      stubs: { teleport: true },
      config: { globalProperties: {} },
    },
  })
}

beforeEach(() => {
  degradedRef.value = false
  degradedQueries.length = 0
  // 合并产物增补：共享 fixture 重播（原文件为工厂内联常量/ref）
  panelFocusedSid.value = 'main-1'
  workflowRecordsFixture.length = 0
  recordsListDyn = () => [subagentRecordFixture]
  drawerTabsFixture.tabs = []
  drawerTabsFixture.active = null
  drawerState.selectedSubagentId.value = VIDEO_ID
  void JSDOM
})

describe('SubagentTab live 流降级提示条（M3 D6）', () => {
  it('未降级：无提示条，对话流正常渲染', () => {
    const wrapper = mountTab()
    expect(wrapper.find(`[data-testid="${DEGRADED_TESTID}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })

  it('降级：提示条可见（i18n 文案锚 + role=status），读口查询键 = (虚拟 id, record id)', async () => {
    degradedRef.value = true
    const wrapper = mountTab()
    await nextTick()

    const bar = wrapper.find(`[data-testid="${DEGRADED_TESTID}"]`)
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('panel.sideDrawer.subagentStreamDegraded')
    expect(bar.attributes('role')).toBe('status')

    expect(degradedQueries.at(-1)).toEqual({ virtualId: VIDEO_ID, recordId: 'sa-1' })
  })

  it('降级恢复：读口回落 false → 提示条消失（响应式重算，非首帧快照）', async () => {
    degradedRef.value = true
    const wrapper = mountTab()
    await nextTick()
    expect(wrapper.find(`[data-testid="${DEGRADED_TESTID}"]`).exists()).toBe(true)

    degradedRef.value = false
    await nextTick()
    expect(wrapper.find(`[data-testid="${DEGRADED_TESTID}"]`).exists()).toBe(false)
  })

  it('agentcall 快照视图无 live 流：降级位为真也不显示提示条', async () => {
    degradedRef.value = true
    drawerState.selectedSubagentId.value = 'agentcall:acs-1'
    const wrapper = mountTab()
    await nextTick()

    expect(wrapper.find(`[data-testid="${DEGRADED_TESTID}"]`).exists()).toBe(false)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })
})
})

// ═══════════ 来源节：SubagentTab.model-label ═══════════

describe('SubagentTab.model-label', () => {
let subagentRecordFixture: Record<string, unknown> = {}
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
  // 合并产物增补：共享 fixture 重播
  panelFocusedSid.value = 'main-1'
  degradedRef.value = false
  recordsListDyn = () => [subagentRecordFixture]
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
})

// ═══════════ 来源节：SubagentTab.tabs ═══════════

describe('SubagentTab.tabs', () => {
function closeViaStore(sessionId: string, vid: string): void {
  useSubagentStore().closeDrawerTab(sessionId, vid)
}

function mountTab(): ReturnType<typeof mount> {
  return mount(SubagentTab, {
    global: {
      stubs: { teleport: true },
      config: { globalProperties: {} },
    },
  })
}

/** 选中态变化 → 开 tab → tab 条/内容响应（双 nextTick 跨 computed/watch 链）。 */
async function select(vid: string): Promise<void> {
  drawerState.selectedSubagentId.value = vid
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  // 共享桩计数清零（跨用例调用计数断言前提；只清记录不动实现）
  vi.clearAllMocks()
  panelFocusedSid.value = 'main-1'
  // 合并产物增补：共享 fixture 重播（原 recordsFixture 模块级初始 3 条，正文零字段引用）
  degradedRef.value = false
  workflowRecordsFixture.length = 0
  recordsListDyn = () => [subagentRecordFixture]
  drawerTabsFixture.tabs = []
  drawerTabsFixture.active = null
  drawerState.selectedSubagentId.value = null
  void JSDOM
})

describe('SubagentTab 二级 tab 编排（subagent-detail-tabs）', () => {
  it('单 tab：tab 条恒渲染（单条目即激活者，仍带 × 关闭入口），详情正常渲染', async () => {
    const wrapper = mountTab()
    await select('subagent:main-1:sa-1')
    const strip = wrapper.find('[data-testid="drawer-subagent-tab-strip"]')
    expect(strip.exists()).toBe(true)
    const tabs = wrapper.findAll('[data-testid="drawer-subagent-tab-item"]')
    expect(tabs).toHaveLength(1)
    expect(tabs[0]!.attributes('data-active')).toBe('true')
    expect(tabs[0]!.find('[data-testid="drawer-subagent-tab-close"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })

  it('多 tab：第二个选中开新 tab（保留不替换），tab 条渲染且激活者高亮', async () => {
    const wrapper = mountTab()
    await select('subagent:main-1:sa-1')
    await select('subagent:main-1:sa-2')
    const strip = wrapper.find('[data-testid="drawer-subagent-tab-strip"]')
    expect(strip.exists()).toBe(true)
    const tabs = wrapper.findAll('[data-testid="drawer-subagent-tab-item"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.attributes('data-active')).toBe('false')
    expect(tabs[1]!.attributes('data-active')).toBe('true')
    // 内容区跟随激活者（sa-2）
    expect(wrapper.find('[data-testid="message-stream-stub"]').exists()).toBe(true)
  })

  it('tab 点击切换激活 + 同步 core 选中态（openSubagent 通道）', async () => {
    const wrapper = mountTab()
    await select('subagent:main-1:sa-1')
    await select('subagent:main-1:sa-2')
    await wrapper.findAll('[data-testid="drawer-subagent-tab-item"]')[0]!.trigger('click')
    await nextTick()
    await nextTick()
    const tabs = wrapper.findAll('[data-testid="drawer-subagent-tab-item"]')
    expect(tabs[0]!.attributes('data-active')).toBe('true')
    expect(tabs[1]!.attributes('data-active')).toBe('false')
    expect(drawerState.selectedSubagentId.value).toBe('subagent:main-1:sa-1')
  })

  it('tab 关闭：激活者关闭激活右邻 + 选中态同步；全部关闭回空态', async () => {
    const wrapper = mountTab()
    await select('subagent:main-1:sa-1')
    await select('subagent:main-1:sa-2')
    await select('subagent:main-1:sa-3')
    // 关闭激活者（sa-2，中间）→ 激活右邻（sa-3）
    let tabs = wrapper.findAll('[data-testid="drawer-subagent-tab-item"]')
    await tabs[1]!.find('[data-testid="drawer-subagent-tab-close"]').trigger('click')
    await nextTick()
    await nextTick()
    tabs = wrapper.findAll('[data-testid="drawer-subagent-tab-item"]')
    expect(tabs).toHaveLength(2)
    expect(tabs[1]!.attributes('data-active')).toBe('true')
    expect(drawerState.selectedSubagentId.value).toBe('subagent:main-1:sa-3')
    // 关闭非激活者（sa-1）→ 剩 sa-3 单 tab（条恒渲染，单条目仍可 × 关闭）
    await tabs[0]!.find('[data-testid="drawer-subagent-tab-close"]').trigger('click')
    await nextTick()
    await nextTick()
    expect(drawerTabsFixture.tabs).toEqual(['subagent:main-1:sa-3'])
    // store 通道关闭最后一个 → 空态（activeTab null 分支停流）
    closeViaStore('main-1', 'subagent:main-1:sa-3')
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="drawer-subagent-empty"]').exists()).toBe(true)
    expect(drawerTabsFixture.tabs).toHaveLength(0)
  })

  it('关空清选中态（MF-3）：最后一个 tab 关闭后 core 选中态同步清空，重选同一 vid 重开 tab', async () => {
    // 经编排 composable 直驱 close 通道（与 tab 条 × 按钮同一通道）。
    const stopStream = vi.fn()
    const { useSubagentDrawerTabs } = await import('@/composables/panel/useSubagentDrawerTabs')
    const tabsApi = useSubagentDrawerTabs({
      selectedSubagentId: drawerState.selectedSubagentId,
      labelOf: (vid) => vid,
      stopStream,
    })
    await select('subagent:main-1:sa-1')
    expect([...drawerTabsFixture.tabs]).toEqual(['subagent:main-1:sa-1'])
    tabsApi.close('subagent:main-1:sa-1')
    await nextTick()
    await nextTick()
    // 空态分支：选中态清空（残留 vid 会经 watch immediate 复活已关 tab 并拉流）+ 停流
    expect(drawerState.selectedSubagentId.value).toBeNull()
    expect(drawerTabsFixture.tabs).toHaveLength(0)
    expect(stopStream).toHaveBeenCalled()
    // 关空收敛：最后一个二级 tab 关闭即关整个抽屉（规则单一落点 core closeDrawerIfTabsEmpty）
    expect(closeDrawerIfTabsEmpty).toHaveBeenLastCalledWith(true)
    // 同值重选：null → vid 有变化边沿，watch 重开 tab（同值 set 不触发 watch 的缺陷不再可达）
    await select('subagent:main-1:sa-1')
    expect([...drawerTabsFixture.tabs]).toEqual(['subagent:main-1:sa-1'])
    expect(drawerTabsFixture.active).toBe('subagent:main-1:sa-1')
  })

  it('关空→切走→切回（MF-3）：空态后选择其他 vid 再切回，tab 集与选中态无残留错位', async () => {
    const { useSubagentDrawerTabs } = await import('@/composables/panel/useSubagentDrawerTabs')
    const tabsApi = useSubagentDrawerTabs({
      selectedSubagentId: drawerState.selectedSubagentId,
      labelOf: (vid) => vid,
      stopStream: vi.fn(),
    })
    await select('subagent:main-1:sa-1')
    tabsApi.close('subagent:main-1:sa-1')
    await nextTick()
    expect(drawerState.selectedSubagentId.value).toBeNull()
    // 切走（sa-2）→ 切回（sa-1）：两 tab 都按新选择重建，无已关 tab 复活
    await select('subagent:main-1:sa-2')
    await select('subagent:main-1:sa-1')
    expect([...drawerTabsFixture.tabs]).toEqual(['subagent:main-1:sa-2', 'subagent:main-1:sa-1'])
    expect(drawerTabsFixture.active).toBe('subagent:main-1:sa-1')
  })

  it('空串早退（S-5）：focusedSessionId 为空串时 activate/close 不触 store 编排与 core 同步', async () => {
    const { useSubagentDrawerTabs } = await import('@/composables/panel/useSubagentDrawerTabs')
    const stopStream = vi.fn()
    const tabsApi = useSubagentDrawerTabs({
      selectedSubagentId: drawerState.selectedSubagentId,
      labelOf: (vid) => vid,
      stopStream,
    })
    // 前置：正常聚焦下开两个 tab（active = sa-2），随后失焦（focusedSessionId → null
    // → computed '' ）——早退判据的触发形态
    await select('subagent:main-1:sa-1')
    await select('subagent:main-1:sa-2')
    panelFocusedSid.value = null
    tabsApi.activate('subagent:main-1:sa-1')
    tabsApi.close('subagent:main-1:sa-2')
    await nextTick()
    await nextTick()
    // store 编排零触发：'' 键不建退化分区（clearSession 按真实 sid 释放、永不回收）
    expect(activateDrawerTabMock).not.toHaveBeenCalled()
    expect(closeDrawerTabMock).not.toHaveBeenCalled()
    expect(drawerTabsFixture.tabs).toEqual(['subagent:main-1:sa-1', 'subagent:main-1:sa-2'])
    expect(drawerTabsFixture.active).toBe('subagent:main-1:sa-2')
    // core 选中同步（openSubagent）与空态收敛编排（清选中/停流/关抽屉）同样被早退挡住
    expect(openSubagent).not.toHaveBeenCalled()
    expect(clearSubagentSelection).not.toHaveBeenCalled()
    expect(stopStream).not.toHaveBeenCalled()
    expect(closeDrawerIfTabsEmpty).not.toHaveBeenCalled()
  })

  it('关空定向清除（N-1）：close 至空态时 clearSubagentSelection 以 focused sid 调用（键与 tab 分区同源）', async () => {
    const { useSubagentDrawerTabs } = await import('@/composables/panel/useSubagentDrawerTabs')
    const tabsApi = useSubagentDrawerTabs({
      selectedSubagentId: drawerState.selectedSubagentId,
      labelOf: (vid) => vid,
      stopStream: vi.fn(),
    })
    await select('subagent:main-1:sa-1')
    tabsApi.close('subagent:main-1:sa-1')
    await nextTick()
    // 定向清除：传 focusedSid（显式分区键），不再走「清除 = current 绑定分区」的
    // 隐式 current == focused 不变量
    expect(clearSubagentSelection).toHaveBeenCalledTimes(1)
    expect(clearSubagentSelection).toHaveBeenCalledWith('main-1')
    expect(drawerState.selectedSubagentId.value).toBeNull()
  })
})
})

