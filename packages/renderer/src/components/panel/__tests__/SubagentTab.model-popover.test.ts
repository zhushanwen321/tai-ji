// @vitest-environment happy-dom

/**
 * SubagentTab 模型切换入口真实渲染测试（subagent-model-switch D3 缺陷一防线补强）。
 *
 * 与 SubagentTab.model-label.test.ts 的分工：本文件**不 mock ModelSelectPopover**
 * ——真实挂载组件树（Popover / PopoverTrigger / ModelPickerPanel 全真实），点击
 * subagent-model-trigger 后断言 popover 内容渲染在场，拦截「SubagentTab 的 #trigger
 * slot 丢失 PopoverTrigger as-child 包裹致入口不可达」的同族回归（D3 缺陷一的根因
 * 之一 = 测试 mock 组件致点击行为零覆盖，登记 docs/todo/subagent-model-switch-d3-defects.md）。
 *
 * mock 面最小化（数据层替身）：drawer control / panel store / subagent store /
 * MessageStream / useSubagentTabData / vue-i18n；settings store 用真实单例直写
 * models（同 ModelSelectPopover.spec.ts 模式）。运行：
 *   cd packages/renderer && npx vitest run src/components/panel/__tests__/SubagentTab.model-popover.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { getSettingsStore } from '@taiji/core'

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

// ── subagent store：records 分区按 fixture 返回（chat 域 record 视图锚）────
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
vi.mock('@/stores/subagent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/subagent')>()
  return {
    ...actual,
    useSubagentStore: () => ({
      getRecordsBySession: (_sid: string) => [subagentRecordFixture],
      isStreamingSubagent: () => false,
    }),
  }
})

vi.mock('@/stores/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/workflow')>()
  return {
    ...actual,
    useWorkflowStore: () => ({ getRecordsBySession: () => [] }),
  }
})

// ── 数据层替身（视图数据加载与消息流与入口可达性无关）───────────────────────
vi.mock('../MessageStream.vue', () => ({ default: { name: 'MessageStream', template: '<div data-testid="message-stream-stub" />' } }))
vi.mock('@/composables/panel/useSubagentTabData', () => ({
  useSubagentTabData: () => ({
    loadError: ref(null),
    loadSubagentData: vi.fn(async () => {}),
    stopSubagentStream: vi.fn(),
    recordEngine: () => 'pi',
  }),
}))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: vi.fn((key: string) => key) }),
}))

// ModelSelectPopover / ModelPickerPanel / Popover 原语：不 mock——被测面本体
import SubagentTab from '../SubagentTab.vue'

const MODELS = [
  { id: 'glm-5.3', name: 'GLM 5.3', providerId: 'p', providerName: 'P', enabled: true },
  { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', providerId: 'p', providerName: 'P', enabled: true },
]

let wrapper: ReturnType<typeof mount> | null = null

beforeEach(() => {
  setActivePinia(createPinia())
  getSettingsStore().models.value = MODELS
  drawerState.selectedSubagentId.value = 'subagent:main-1:sa-1'
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

describe('SubagentTab 模型切换入口真实渲染（不 mock ModelSelectPopover）', () => {
  it('点击 subagent-model-trigger → popover 内容（模型列表面板）渲染在场——trigger 的 PopoverTrigger as-child 包裹防线', async () => {
    wrapper = mount(SubagentTab, {
      global: {
        config: { globalProperties: {} },
      },
    })
    await flushPromises()

    // trigger 在场且为 button（PopoverTrigger as-child 直接落附在 Button 上）
    const trigger = wrapper.find('[data-testid="subagent-model-trigger"]')
    expect(trigger.exists()).toBe(true)
    expect(trigger.element.tagName).toBe('BUTTON')

    // 点击打开 popover：模型列表面板渲染在场（teleport 到 body）
    await trigger.trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('[data-testid="model-picker-panel"]')
    expect(panel).not.toBeNull()
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('GLM 5.3 Flash')
  })
})
