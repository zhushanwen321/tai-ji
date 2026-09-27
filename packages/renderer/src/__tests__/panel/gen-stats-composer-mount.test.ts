/**
 * Composer 挂载点测试 —— composer-gen-stats u4 Gate A（挂载点 + DOM 顺序）+ composer-genstats-ttft U4。
 *
 * 验收：GenStatsTriggers 挂载于 Composer.vue composer-bar 的 ContextCapacityPopover 之前
 * （位于上下文容量左侧）；组件内三触发器顺序 = TTFT · 速度 · 缓存（TTFT 在速度左侧，
 * composer-genstats-ttft 设计 §3.1）。
 *
 * 策略（照 composer-three-states.test.ts 既有 mock 模式）：
 * - Composer 真实渲染；GenStatsTriggers 不 stub（真渲染，含 title/触发器 DOM）；
 * - ContextCapacityPopover 用带 testid 的 stub（仅需定位 DOM 顺序锚点，不必真渲染）；
 * - 其余重子组件 stub（对齐既有 Composer 测试 stub 清单）；
 * - GenStatsTriggers 内 useGenStats 的恢复腿 command() 走真实 request 层（ws 未连接立即
 *   reject，composable 内 debug 兜底），不影响断言。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/gen-stats-composer-mount.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'

// ── mock（照 composer-three-states.test.ts 形态）──
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: vi.fn(() => Promise.resolve()),
    steer: vi.fn(() => Promise.resolve()),
    followUp: vi.fn(() => Promise.resolve()),
    abort: vi.fn(() => Promise.resolve()),
    compact: vi.fn(() => Promise.resolve()),
    editAndResend: vi.fn(),
    hydrateHistory: vi.fn(),
  }),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({
    submitFirstMessage: vi.fn(),
    currentModel: { value: null },
    setPendingModel: vi.fn(),
    currentCwd: ref(null),
  }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({
  project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock + 子组件 stub ──
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: { input: null, keydown: null, 'slash-trigger': null, 'file-trigger': null },
  setup(_, { expose }) {
    expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => textToSegments('') })
    return {}
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const stubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  // ContextCapacityPopover stub 带标记：DOM 顺序断言的右锚点
  ContextCapacityPopover: defineComponent({
    name: 'ContextCapacityPopover',
    template: '<div data-testid="stub-context-capacity" />',
  }),
  // 独立命名：landing 隐藏断言需验证「同工具带非数据位仍可见」时按名定位
  ModelSelectPopover: defineComponent({ name: 'StubModelSelectPopover', template: '<div />' }),
  ThinkingLevelPopover: defineComponent({ name: 'StubThinkingLevelPopover', template: '<div />' }),
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

import Composer from '@/components/panel/Composer.vue'
import GenStatsTriggers from '@/components/panel/GenStatsTriggers.vue'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('Composer 挂载 GenStatsTriggers（Gate A：挂载点 + 左侧顺序）', () => {
  it('GenStatsTriggers 组件存在且 session-id 正确下发', () => {
    const wrapper = mount(Composer, { props: { sessionId: 's1', variant: 'panel' as const }, global: { stubs } })
    const triggers = wrapper.findComponent(GenStatsTriggers)
    expect(triggers.exists()).toBe(true)
    expect(triggers.props('sessionId')).toBe('s1')
    // modelId prop 通道存在（受控范式，由 Composer currentModelId 下发）
    expect('modelId' in triggers.props()).toBe(true)
  })

  it('DOM 顺序：GenStatsTriggers 位于 ContextCapacityPopover 之前（设计 §3.1「上下文容量左侧」）', () => {
    const wrapper = mount(Composer, { props: { sessionId: 's1', variant: 'panel' as const }, global: { stubs } })
    const speedBtn = wrapper.find('[title="TOKEN 速度"]')
    const ctxStub = wrapper.find('[data-testid="stub-context-capacity"]')
    expect(speedBtn.exists()).toBe(true)
    expect(ctxStub.exists()).toBe(true)
    // compareDocumentPosition：右锚点视角下，GenStatsTriggers 元素带 PRECEDING 位 = 在其之前
    const preceding = ctxStub.element.compareDocumentPosition(speedBtn.element) & Node.DOCUMENT_POSITION_PRECEDING
    expect(preceding).toBeTruthy()
  })

  it('DOM 顺序：TTFT 触发器位于速度触发器左侧（composer-genstats-ttft §3.1 组件内顺序 TTFT · 速度 · 缓存）', () => {
    const wrapper = mount(Composer, { props: { sessionId: 's1', variant: 'panel' as const }, global: { stubs } })
    const ttftBtn = wrapper.find('[title="首字延迟 TTFT"]')
    const speedBtn = wrapper.find('[title="TOKEN 速度"]')
    const cacheBtn = wrapper.find('[title="缓存命中率"]')
    expect(ttftBtn.exists()).toBe(true)
    expect(speedBtn.exists()).toBe(true)
    expect(cacheBtn.exists()).toBe(true)
    // 速度视角：TTFT 带 PRECEDING 位 = TTFT 在速度左侧
    const ttftPrecedes =
      speedBtn.element.compareDocumentPosition(ttftBtn.element) & Node.DOCUMENT_POSITION_PRECEDING
    expect(ttftPrecedes).toBeTruthy()
    // 缓存视角：速度带 PRECEDING 位 = 速度在缓存左侧（三段顺序链 TTFT → 速度 → 缓存）
    const speedPrecedes =
      cacheBtn.element.compareDocumentPosition(speedBtn.element) & Node.DOCUMENT_POSITION_PRECEDING
    expect(speedPrecedes).toBeTruthy()
  })

  it('三触发器在 Composer 真实挂载下渲染（null 初值显「—」）', () => {
    const wrapper = mount(Composer, { props: { sessionId: 's1', variant: 'panel' as const }, global: { stubs } })
    expect(wrapper.find('[title="首字延迟 TTFT"]').exists()).toBe(true)
    expect(wrapper.find('[title="TOKEN 速度"]').exists()).toBe(true)
    expect(wrapper.find('[title="缓存命中率"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="genstats-ttft-value"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="genstats-speed-value"]').text()).toBe('—')
    expect(wrapper.find('[data-testid="genstats-cache-value"]').text()).toBe('—')
  })

  it('landing（sessionId=null 未开始）隐藏 TTFT/速度/缓存命中率/上下文容量，不显「—」横线占位', () => {
    const wrapper = mount(Composer, { props: { sessionId: null, variant: 'landing' as const }, global: { stubs } })
    // 四项数据位全部不渲染（而非渲染后显「—」）；TTFT 与速度/缓存同一条 v-if="sessionId" 判据
    expect(wrapper.find('[title="首字延迟 TTFT"]').exists()).toBe(false)
    expect(wrapper.find('[title="TOKEN 速度"]').exists()).toBe(false)
    expect(wrapper.find('[title="缓存命中率"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="genstats-ttft-value"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="genstats-speed-value"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="stub-context-capacity"]').exists()).toBe(false)
    // 同条工具带上的非数据位不受影响：模型/思考档位选择器仍然可见
    expect(wrapper.findComponent({ name: 'StubModelSelectPopover' }).exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'StubThinkingLevelPopover' }).exists()).toBe(true)
  })
})
