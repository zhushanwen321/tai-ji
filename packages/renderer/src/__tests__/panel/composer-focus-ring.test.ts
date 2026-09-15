/**
 * Composer 聚焦态聚焦环行为测试（MF-2 回归护栏）。
 *
 * 锁死 Composer.vue focusRingClass 的 3 条分支：
 * - (a) 聚焦 → 输出 3px accent-ring 外环（v6 §6.1 .focused 真值）
 * - (b) 聚焦 + bash 活跃 → 抑制聚焦环（exclusion：boxClass[0] 含 border-[var(--accent)]）
 * - (c) 未聚焦 → 无聚焦环
 *
 * 背景：focusRingClass 的排除条件用脆弱字符串匹配 `border-[var(--accent)]`
 * （注释自述「Plan 04 删 animate-steer-breathe 后原字符串条件变死代码，F3 修复」），
 * 已出过一次回归却无测试护栏。本测试锁死 exclusion 分支，防止再次误删。
 *
 * 断言 token 必须是 --accent-ring（30%），非 --shadow-glow（25%）——与 MF-1 裁决一致。
 * focus 聚焦环用 CSS 属性语法 `![box-shadow:0_0_0_3px_var(--accent-ring)]`（带 ! 前缀），
 * 与 bash 分支的 Tailwind 工具类 `shadow-[0_0_0_3px_var(--accent-ring)]`（无 !）区分。
 *
 * 策略参照 composer-three-states.test.ts：mock useChat/useNewTaskFlow/api + stub 子组件 +
 * ComposerInput mock（defineExpose + emit focus/blur/input）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/composer-focus-ring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'

// ── mock useChat（spy）──
const chatApiMock = {
  send: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
}
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => ({ submitFirstMessage: vi.fn(), currentModel: { value: null }, setPendingModel: vi.fn(), currentCwd: ref(null) }),
  resetNewTaskFlow: vi.fn(),
}))
vi.mock('@/api', () => ({ project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })) },
  composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  config: { getGlobalSkills: vi.fn().mockResolvedValue([]), getProjectSkills: vi.fn().mockResolvedValue([]), onSkillCacheInvalidated: () => () => {} },
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))

// ── ComposerInput mock：defineExpose + emit focus/blur/input ──
const lastInputText = ref('')
const ComposerInputMock = defineComponent({
  name: 'ComposerInput',
  emits: {
    input: (val: string) => {
      lastInputText.value = val
      return true
    },
    keydown: null,
    'slash-trigger': null,
    'file-trigger': null,
    focus: null,
    blur: null,
  },
  setup(_, { expose }) {
    const clear = vi.fn()
    const setText = vi.fn()
    expose({ clear, setText, insertSlashChip: vi.fn(), getSegments: () => textToSegments(lastInputText.value) })
    return { clear, setText }
  },
  template: '<div data-testid="composer-input" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const otherStubs = {
  ComposerInput: ComposerInputMock,
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  ModelSelectPopover: SIMPLE,
  ThinkingLevelPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

import Composer from '@/components/panel/Composer.vue'

/** focus 聚焦环 class（唯一标识：CSS 属性语法 + ! 前缀，区别于 bash 的 Tailwind shadow-[] 工具类） */
const FOCUS_RING_CLASS = '![box-shadow:0_0_0_3px_var(--accent-ring)]'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  lastInputText.value = ''
})

function mountComposer(props: { sessionId: string | null; variant?: 'panel' | 'landing' }) {
  return mount(Composer, { props, global: { stubs: otherStubs } })
}

describe('MF-2 Composer 聚焦环 focusRingClass 三分支', () => {
  it('(a) 聚焦 → composer-box 含 3px accent-ring 聚焦环（token=--accent-ring，非 shadow-glow）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    // 聚焦环出现（token 为 --accent-ring 30%，对应 v6 §6.1 .focused 真值）
    expect(box.classes()).toContain(FOCUS_RING_CLASS)
  })

  it('(b) 聚焦 + bash 活跃 → 聚焦环被抑制（exclusion：boxClass 含 border-[var(--accent)] 不叠环）', async () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    // 输入 ! 前缀触发 bash 模式 → boxClass[0] = composer-bash-mode border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-ring)]
    wrapper.findComponent(ComposerInputMock).vm.$emit('input', '!ls')
    await wrapper.vm.$nextTick()
    // 同时聚焦
    wrapper.findComponent(ComposerInputMock).vm.$emit('focus')
    await wrapper.vm.$nextTick()

    const box = wrapper.find('[data-testid="composer-box"]')
    // bash 环存在（无 ! 前缀的 Tailwind shadow-[] 工具类）
    expect(box.classes()).toContain('shadow-[0_0_0_3px_var(--accent-ring)]')
    // 聚焦环被抑制（exclusion 分支命中）
    expect(box.classes()).not.toContain(FOCUS_RING_CLASS)
  })

  it('(c) 未聚焦 → 无聚焦环（focusRingClass 返回空串）', () => {
    const wrapper = mountComposer({ sessionId: 's1' })
    const box = wrapper.find('[data-testid="composer-box"]')
    expect(box.classes()).not.toContain(FOCUS_RING_CLASS)
  })
})
