// @vitest-environment happy-dom

/**
 * SubagentTab live 流降级提示条组件测试（M3 relay-spawn-transport D6 / D2 D-U-1 前端落点）。
 *
 * 三视角（TEST-STRATEGY §3）：
 * - 构建者：core 流状态机的 degraded 位经 chat store readers 口（isSubagentStreamDegraded）
 *   被组件消费——断言查询键 = (activeTab 虚拟 id, record.subagentId)，接线不漂移；
 * - 使用者（黑盒 DOM）：degraded=true → 提示条文案可见（i18n key 即文案锚，mock t 返回
 *   key）；degraded=false → 提示条消失；
 * - 观察者：agentcall 快照视图无 live 流，即使降级位为真也不显示提示条。
 *
 * 全 mock：drawer control / 三 store / chat store readers / MessageStream /
 * useSubagentTabData / ModelSelectPopover / vue-i18n。
 * 运行：cd packages/renderer && npx vitest run src/components/panel/__tests__/SubagentTab.degraded.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick, reactive, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { JSDOM } from 'jsdom'

/** 降级位 fixture（模块级 ref：chat store 读口闭包在测试内改值，computed 追踪） */
const degradedRef = ref(false)
/** 读口查询记录：断言组件传对了 (virtualId, recordId) */
const degradedQueries: Array<{ virtualId: string; recordId: string }> = []

// ── drawer：三段式虚拟 id 固定选中（chat 域 record 视图）────────────────────
const drawerState = {
  selectedSubagentId: ref<string | null>('subagent:main-1:sa-1'),
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
    // 真实语义：清 core 选中态（关闭入口的选中同步通道）
    clearSubagentSelection: vi.fn(() => {
      drawerState.selectedSubagentId.value = null
    }),
  }
})

// ── panel store（focusedSessionId 消费）───────────────────────────────────
vi.mock('@/stores/panel', () => ({
  usePanelStore: () => ({ focusedSessionId: ref('main-1') }),
}))

// ── subagent store：单 record + drawer 二级 tab 状态（reactive）────────────
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
const drawerTabsFixture = reactive({ tabs: [] as string[], active: null as string | null })
vi.mock('@/stores/subagent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/subagent')>()
  return {
    ...actual,
    useSubagentStore: () => ({
      getRecordsBySession: (_sid: string) => [subagentRecordFixture],
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

// ── chat store：仅 readers 面读口（core 流状态机的 degraded 位）────────────
vi.mock('@/stores/chat', () => ({
  useChatStore: () => ({
    isSubagentStreamDegraded: (virtualId: string, recordId: string) => {
      degradedQueries.push({ virtualId, recordId })
      return degradedRef.value
    },
  }),
}))

// ── 展示重树桩：本文件只钉降级提示条 ─────────────────────────────────────
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

import SubagentTab from '../SubagentTab.vue'

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
