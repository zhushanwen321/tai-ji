/**
 * PresetChip（u4 mode-visibility-chip）单测。
 *
 * 覆盖设计 §6.5 D5 / §7.4 / §7.1 的可执行条款：
 * 1. 非默认模式 → 对话态只读 chip 渲染；默认模式 / store 未加载（defaultPresetId 空）→ 不渲染。
 * 2. 三档退化（模式名 → 短名 → 仅图标）**各档信任标记不丢**：文本/短名档 = chip 内后缀
 *    「含替换提示词」；纯图标档 = 右上角警示色角标（`preset-chip-replace-badge`）+ tooltip。
 * 3. 只读 popover 含锁定说明（「模式在创建时确定…不能更换」）+「新建会话以使用其他模式」出口
 *    + 工具面/扩展面/提示词段数。
 * 4. landing 档点击 emit select。
 *
 * 策略：pinia 真 store（setPresets/setDefaultPresetId）+ HoverCard 家族 stub 常开
 * （reka HoverCard 未 hover 不渲染 content；stub 常开使浮层内容可 DOM 断言，
 * 对齐 gen-stats-triggers.test.ts 的观察者形态）；i18n 走全局 zh-CN mock。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/panel/preset-chip.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, nextTick } from 'vue'
import PresetChip from '@/components/panel/PresetChip.vue'
import Composer from '@/components/panel/Composer.vue'
import { usePresetStore } from '@/stores/preset'
import type { PiLaunchPreset } from '@taiji/shared'

/** HoverCard 家族 stub：内容常开渲染（观察者形态——浮层内容行可 DOM 断言） */
const hoverStubs = {
  HoverCard: { name: 'HoverCard', template: '<div><slot /></div>' },
  HoverCardTrigger: { name: 'HoverCardTrigger', template: '<div><slot /></div>' },
  HoverCardContent: { name: 'HoverCardContent', template: '<div><slot /></div>' },
}

/** 样例模式：出厂全工具 + 一个带替换/追加提示词的自定义模式 */
function samplePresets(): PiLaunchPreset[] {
  return [
    {
      id: 'builtin:full', name: '全工具模式', builtin: true, order: 0,
      toolMode: 'all', extensionMode: 'all',
    },
    {
      id: 'custom:dispatch', name: '调度模式', description: '主 Agent 只做拆解与派发',
      builtin: false, order: 1,
      toolMode: 'allowlist', allowedTools: ['read', 'grep'],
      extensionMode: 'denylist', deniedExtensions: ['@zhushanwen/pi-subagent-workflow'],
      prompt: {
        replace: { enabled: true, prompt: '你是调度者，不要自己执行' },
        append: { enabled: true, prompt: '派发前写自包含 brief' },
      },
    },
  ]
}

function mountChip(props: Record<string, unknown>) {
  return mount(PresetChip, {
    props,
    global: { stubs: hoverStubs },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  const presetStore = usePresetStore()
  presetStore.setPresets(samplePresets())
  presetStore.setDefaultPresetId('builtin:full')
  presetStore.setLoadError(null)
})

describe('PresetChip 可见性（设计 D5 可执行判据）', () => {
  it('非默认模式 → 只读 chip 渲染（模式名 + 图标 + 锁）', () => {
    const wrapper = mountChip({ presetId: 'custom:dispatch', variant: 'readonly' })
    const chip = wrapper.find('[data-testid="preset-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('调度模式')
    // 图标（模式图标 + 锁）都是 svg，禁 Emoji
    expect(chip.findAll('svg').length).toBeGreaterThanOrEqual(2)
    // 纯图标档才有的角标不在此档
    expect(wrapper.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
  })

  it('默认模式 → 不渲染（launchPresetId === defaultPresetId）', () => {
    const wrapper = mountChip({ presetId: 'builtin:full', variant: 'readonly' })
    expect(wrapper.find('[data-testid="preset-chip"]').exists()).toBe(false)
  })

  it('store 未加载（defaultPresetId 空）→ 按 builtin:full 兜底：默认模式不渲染', () => {
    usePresetStore().setDefaultPresetId('')
    const wrapper = mountChip({ presetId: 'builtin:full', variant: 'readonly' })
    expect(wrapper.find('[data-testid="preset-chip"]').exists()).toBe(false)
  })

  it('判据锚在 defaultPresetId（不是硬编码 builtin:full）：默认 = 自定义模式时它不渲染、builtin:full 反而渲染', () => {
    // 回归点：若误用 landing 的 resolve 链（或把默认写死成 builtin:full），本用例必红
    usePresetStore().setDefaultPresetId('custom:dispatch')
    expect(
      mountChip({ presetId: 'custom:dispatch', variant: 'readonly' })
        .find('[data-testid="preset-chip"]')
        .exists(),
    ).toBe(false)
    expect(
      mountChip({ presetId: 'builtin:full', variant: 'readonly' })
        .find('[data-testid="preset-chip"]')
        .exists(),
    ).toBe(true)
  })
})

describe('PresetChip 三档退化 + 信任标记跨档不丢（设计 §7.4 / §7.1）', () => {
  it('文本档：显示模式全名 + chip 内「含替换提示词」后缀', () => {
    const wrapper = mountChip({ presetId: 'custom:dispatch', variant: 'readonly', density: 'full' })
    const chip = wrapper.find('[data-testid="preset-chip"]')
    expect(chip.text()).toContain('调度模式')
    expect(chip.text()).toContain('含替换提示词')
    expect(wrapper.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
  })

  it('短名档：显示去尾缀短名 + 信任标记仍在', () => {
    const wrapper = mountChip({ presetId: 'custom:dispatch', variant: 'readonly', density: 'short' })
    const chip = wrapper.find('[data-testid="preset-chip"]')
    expect(chip.text()).toContain('调度')
    expect(chip.text()).not.toContain('调度模式')
    expect(chip.text()).toContain('含替换提示词')
  })

  it('纯图标档：无文本（全名进 aria-label / tooltip）+ 右上角警示色角标仍在', () => {
    const wrapper = mountChip({ presetId: 'custom:dispatch', variant: 'readonly', density: 'icon' })
    const chip = wrapper.find('[data-testid="preset-chip"]')
    expect(chip.text()).not.toContain('调度')
    expect(chip.attributes('aria-label')).toContain('调度模式')
    expect(chip.attributes('aria-label')).toContain('含替换提示词')
    expect(chip.attributes('title')).toContain('调度模式')
    const badge = wrapper.find('[data-testid="preset-chip-replace-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toContain('含替换提示词')
  })

  it('无替换提示词的模式：三档均不显示信任标记', () => {
    for (const density of ['full', 'short', 'icon'] as const) {
      // builtin:full 无 prompt；landing 档不受「默认不渲染」闸限制，可直接观察三档
      const wrapper = mountChip({ presetId: 'builtin:full', variant: 'landing', density })
      expect(wrapper.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="preset-chip"]').text()).not.toContain('含替换提示词')
    }
  })
})

describe('PresetChip 只读 popover（设计 D5 第 4 点）', () => {
  it('popover 含锁定说明 + 新建会话出口 + 工具/扩展/提示词面', () => {
    const wrapper = mountChip({ presetId: 'custom:dispatch', variant: 'readonly' })
    const popover = wrapper.find('[data-testid="preset-chip-popover"]')
    expect(popover.exists()).toBe(true)
    // 不可切换声明（验收条款）
    expect(popover.text()).toContain('模式在创建时确定')
    expect(popover.text()).toContain('不能更换')
    expect(popover.text()).toContain('新建会话以使用其他模式')
    // 出口带跨平台快捷键显示（mac ⌘N / win Ctrl+N）——不是裸文案
    expect(popover.text()).toMatch(/⌘N|Ctrl\+N/)
    // 模式面摘要
    expect(popover.text()).toContain('主 Agent 只做拆解与派发')
    expect(popover.text()).toContain('工具面')
    expect(popover.text()).toContain('扩展面')
    expect(popover.text()).toContain('提示词段数')
    // 提示词两段都启用 → 段数 2
    expect(popover.text()).toContain('2 段')
  })
})

describe('PresetChip landing 档', () => {
  it('点击 emit select（父级负责写 pendingPreset）', async () => {
    const wrapper = mountChip({ presetId: 'custom:dispatch', variant: 'landing' })
    await wrapper.find('[data-testid="preset-chip"]').trigger('click')
    expect(wrapper.emitted('select')).toEqual([[{ presetId: 'custom:dispatch' }]])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Composer 集成（u4b 接线）：对话态 `#meta-row` 只读模式 chip 的真实挂载点。
// 轻量 mock 对齐 composer-smoke.test.ts（chat/api/toast/session store + flow mock），
// 子组件 stub 只保留 meta 行 chip；验证「非默认渲染 / 默认不渲染」在真实挂载点成立。
// ───────────────────────────────────────────────────────────────────────────
const composerFlowMock = vi.hoisted(() => ({
  currentCwd: { value: null as string | null },
  currentSession: { value: null as { launchPresetId?: string } | null },
  currentSessionId: { value: 's1' as string | null },
  pendingPreset: { value: null as string | null },
  state: { value: 'idle' as string },
  isActive: { value: false as boolean },
  setPendingPreset: vi.fn(),
  startFlow: vi.fn(),
  closeOverlay: vi.fn(),
  setPendingModel: vi.fn(),
}))
vi.mock('@/composables/features/new-task/useNewTaskFlow', () => ({
  useNewTaskFlow: () => composerFlowMock,
  resetNewTaskFlow: vi.fn(),
}))
const noopAsync = vi.fn(async () => {})
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => ({
    send: noopAsync, steer: noopAsync, followUp: noopAsync, abort: noopAsync,
    compact: noopAsync, editAndResend: vi.fn(), hydrateHistory: vi.fn(),
    sendBash: noopAsync, abortBash: noopAsync,
  }),
  resetChatModuleState: vi.fn(),
}))
vi.mock('@/composables/useToast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/api', () => ({
  project: { load: vi.fn(async () => ({ projects: [], activeProjectId: '' })), save: vi.fn(async () => {}) },
  chat: { send: vi.fn(), steer: vi.fn() },
  model: { switchModel: vi.fn() },
  session: { setThinkingLevel: vi.fn() },
  composer: { getMentionCandidates: vi.fn(async () => []), getFileCandidates: vi.fn(async () => []) },
  config: {
    getGlobalSkills: vi.fn(async () => []), getProjectSkills: vi.fn(async () => []),
    onSkillCacheInvalidated: () => () => {},
  },
}))
vi.mock('@/stores/session', () => ({
  // Composer 的模式 chip 判据读 sessionStore.list 的 launchPresetId（非默认模式）
  useSessionStore: () => ({
    active: undefined,
    list: [{ id: 's1', launchPresetId: 'custom:dispatch', cwd: '/repo' }],
    applySnapshot: vi.fn(),
    revive: vi.fn(),
  }),
}))

const composerStubs = {
  ComposerInput: defineComponent({
    name: 'ComposerInput',
    template: '<div data-testid="composer-input" />',
    setup(_, { expose }) {
      expose({ clear: vi.fn(), setText: vi.fn(), getSegments: () => [], insertSlashChip: vi.fn() })
      return {}
    },
  }),
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: true,
  ComposerTray: true,
  ViewHost: true,
  GenStatsTriggers: true,
  ContextCapacityPopover: true,
  ModelSelectPopover: true,
  ThinkingLevelPopover: true,
  ContextChipsBar: true,
  RetryIndicator: true,
  QueueBubble: true,
}

describe('Composer 集成：对话态 meta 行只读模式 chip', () => {
  it('非默认模式 → 渲染 chip（模式名 + 信任后缀）；切为默认 → 不渲染', async () => {
    const presetStore = usePresetStore()
    presetStore.setPresets(samplePresets())
    presetStore.setDefaultPresetId('builtin:full')
    const wrapper = mount(Composer, {
      props: { sessionId: 's1' },
      global: { stubs: composerStubs },
    })
    await nextTick()
    const chip = wrapper.find('[data-testid="preset-chip"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('调度模式')
    expect(chip.text()).toContain('含替换提示词')
    // 判据 regression 锁：模式一旦成为默认档 → 条件恒假、chip 消失
    presetStore.setDefaultPresetId('custom:dispatch')
    await nextTick()
    expect(wrapper.find('[data-testid="preset-chip"]').exists()).toBe(false)
  })
})
