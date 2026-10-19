// @vitest-environment happy-dom

/**
 * SubagentTab 二级 tab 编排测试（subagent-detail-tabs 2026-10-15）。
 *
 * 断言用户可见行为（三视角·使用者黑盒）：
 * - tab 条恒渲染（2026-10-17 用户裁决）：单 tab/空态不隐藏，布局稳定不跳变；
 * - 多 tab：选中态入口依次开 tab（保留不互相替换），tab 条渲染、激活者高亮；
 * - tab 点击 = 切激活 + 同步 core 选中态（openSubagent 通道，sidebar 高亮/LRU 豁免
 *   谓词同源一致）；
 * - tab 关闭：激活者关闭激活右邻/左邻 + 选中态同步；全部关闭回空态。
 *
 * 全 mock：drawer control / 三 store / MessageStream / useSubagentTabData /
 * ModelSelectPopover（trigger slot 直通）/ vue-i18n（t 返回 key——断言键即文案锚）。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/SubagentTab.tabs.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { JSDOM } from 'jsdom'

// ── drawer：选中态 ref 可变（驱动 tab 开/关编排）────────────────────────────
const drawerState = {
  selectedSubagentId: ref<string | null>(null),
  enteredFrom: ref<'chat' | 'workflow' | null>('chat'),
}
// drawer 域 importOriginal 部分 mock（挂载树模块图的顶层装配面持续增长——手写桩
// 逐导出补齐必漏）：真模块承接 barrel 全导出与顶层绑定（bindDrawerSessionId /
// bindWorkflowOverlayOpener / bindWorkflowRunLookup，core headless 零副作用），
// 只覆写组件消费的读侧/写侧桩。
vi.mock('@taiji/core/domain/drawer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taiji/core/domain/drawer')>()
  return {
    ...actual,
    useDrawerControl: () => drawerState,
    useSubagentSelection: () => drawerState,
    openWorkflowInDrawer: vi.fn(),
    // 真实语义：写选中态（tab 点击/关闭的选中同步通道）
    openSubagent: vi.fn((opts: { virtualId: string; enteredFrom?: 'chat' | 'workflow' }) => {
      drawerState.selectedSubagentId.value = opts.virtualId
      if (opts.enteredFrom !== undefined) drawerState.enteredFrom.value = opts.enteredFrom
    }),
    // 真实语义：tab 全关回空态时清 core 选中态（close() 空态分支同步通道）
    clearSubagentSelection: vi.fn(() => {
      drawerState.selectedSubagentId.value = null
      drawerState.enteredFrom.value = null
    }),
  }
})

vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ focusedSessionId: ref('main-1') }),
}))

// chat store readers 面（M3 D6 降级位读口）：本文件不测降级，恒 false 桩。
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({ isSubagentStreamDegraded: () => false }),
}))

// ── subagent store：records 双成员 fixture + drawer 二级 tab 状态（reactive）──
const recordsFixture = reactive([
  { subagentId: 'sa-1', sessionFile: '/1.jsonl', agent: 'worker', slug: 'work', task: 't', status: 'running', model: 'p/a', engine: undefined },
  { subagentId: 'sa-2', sessionFile: '/2.jsonl', agent: 'coder', slug: 'code', task: 't2', status: 'running', model: 'p/b', engine: undefined },
  { subagentId: 'sa-3', sessionFile: '/3.jsonl', agent: 'reviewer', slug: 'rev', task: 't3', status: 'running', model: 'p/c', engine: undefined },
])
const drawerTabsFixture = reactive({ tabs: [] as string[], active: null as string | null })
vi.mock('@/stores/subagent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/subagent')>()
  return {
    ...actual,
    useSubagentStore: () => ({
      getRecordsBySession: (_sid: string) => recordsFixture,
      isStreamingSubagent: () => false,
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

vi.mock('@/stores/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/workflow')>()
  return {
    ...actual,
    useWorkflowStore: () => ({ getRecordsBySession: () => [] as Array<Record<string, unknown>> }),
  }
})

vi.mock('../MessageStream.vue', () => ({ default: { name: 'MessageStream', template: '<div data-testid="message-stream-stub" />' } }))
vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: ref(null),
    loadSubagentData: vi.fn(async () => {}),
    stopSubagentStream: vi.fn(),
    recordEngine: () => 'pi',
  }),
}))
vi.mock('../ModelSelectPopover.vue', () => ({ default: { name: 'ModelSelectPopover', template: '<div data-testid="model-select-stub" />' } }))
vi.mock('@/components/ui/popover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/popover')>()
  return { ...actual, PopoverTrigger: { template: '<div><slot /></div>' } }
})
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

import SubagentTab from '../SubagentTab.vue'
import { useSubagentStore } from '@/stores/subagent'

/** store 通道关闭（不经编排层——验证空态渲染路径；测试内调用——需 active pinia）。 */
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
  drawerTabsFixture.tabs = []
  drawerTabsFixture.active = null
  drawerState.selectedSubagentId.value = null
  drawerState.enteredFrom.value = 'chat'
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
      enteredFrom: drawerState.enteredFrom,
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
    // 同值重选：null → vid 有变化边沿，watch 重开 tab（同值 set 不触发 watch 的缺陷不再可达）
    await select('subagent:main-1:sa-1')
    expect([...drawerTabsFixture.tabs]).toEqual(['subagent:main-1:sa-1'])
    expect(drawerTabsFixture.active).toBe('subagent:main-1:sa-1')
  })

  it('关空→切走→切回（MF-3）：空态后选择其他 vid 再切回，tab 集与选中态无残留错位', async () => {
    const { useSubagentDrawerTabs } = await import('@/composables/panel/useSubagentDrawerTabs')
    const tabsApi = useSubagentDrawerTabs({
      selectedSubagentId: drawerState.selectedSubagentId,
      enteredFrom: drawerState.enteredFrom,
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
})
