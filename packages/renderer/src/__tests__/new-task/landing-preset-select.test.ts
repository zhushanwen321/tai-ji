/**
 * Landing 模式选择端到端（点击选项 → chip 回显 → flow 透传真源）回归测试。
 *
 * [HISTORICAL] 「landing 选模式后不生效」缺陷：用户在 landing 点 chip 展开模式列表
 * （`flow.state` 进 `preset-popover`），再点选项时 core `setPendingPreset` 的
 * `state !== 'landing'` 守卫把这次真实选择静默丢弃——pendingPreset 恒 null →
 * ① chip 文案不回显（Landing 的 `modeName` 源自 `flow.pendingPreset`）、
 * ② 建出的 session `launchPresetId=undefined`。
 *
 * 既有测试为何抓不住：
 * - ui `preset-select-chip.test.ts` 用假 flow，只断言 `emit('select')`，并**手动**模拟
 *   `pendingPreset.value = '...'`（把被测链路的关键一跳假设为真）。
 * - renderer `landing.test.ts` / `landing-smoke.test.ts` 把整个 flow mock 成 vi.fn，
 *   没有真实 `setPendingPreset` 守卫。
 * - core `flow.test.ts` 只在 `landing` 态调 `setPendingPreset`，从未覆盖点击发生时的
 *   真实态 `preset-popover`。
 *
 * 本用例补上缺口：真实 Landing + 真实 core flow（真守卫）+ 真实 ui PresetSelectChip，
 * 点真实选项 DOM，断言「flow.pendingPreset 被写 + chip 展示名随之变化」。
 *
 * [U-A 方案 B] 同一真实链路上补模式 chip 底色接线断言：`accent` prop 由 Landing 的
 * isNonDefaultPreset 算好传入（displayPreset.id !== (defaultPresetId **||** builtin:full)），
 * 默认模式中性底 / 非默认模式 accent 底——含 `defaultPresetId === ''`（store 未加载）不得误判非默认的守卫。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/new-task/landing-preset-select.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { PiLaunchPreset } from '@taiji/shared'
import type { NewTaskDeps } from '@taiji/ui'
import { resetNewTaskFlow, useNewTaskFlow } from '@taiji/core'
import type { NewTaskFlowDeps, LaunchConfigPort } from '@taiji/core'
import Landing from '@/components/new-task/Landing.vue'

// Composer 退化为「渲染 #meta-row slot」的空壳：chip 仍进 DOM，避免真实 composer 重依赖
vi.mock('@/components/panel/Composer.vue', () => ({
  default: {
    name: 'Composer',
    props: ['variant', 'sessionId'],
    template: '<div data-testid="composer-stub"><slot name="meta-row" /></div>',
  },
}))

// Landing 经 useNewTaskDeps 构造 + provide NewTaskDepsKey；本测试注入「真实 core flow + 可控 presets」
const hosted = vi.hoisted(() => ({ deps: null as unknown }))
vi.mock('@/composables/features/new-task/useNewTaskDeps', () => ({
  useNewTaskDeps: () => hosted.deps,
}))

const presets = ref<PiLaunchPreset[]>([])
const defaultPresetId = ref('')

/** 最小 core flow 端口集（本用例只走 startFlow/openPresetPopover/setPendingPreset，端口不参与断言） */
function makeFlowDeps(launchConfig: LaunchConfigPort): NewTaskFlowDeps & { ports: { launchConfig: LaunchConfigPort } } {
  return {
    ports: {
      createSessionFlow: { createSession: vi.fn() },
      chat: { send: vi.fn().mockResolvedValue(undefined), sendBash: vi.fn().mockResolvedValue(undefined) },
      navigation: {
        activePanelId: vi.fn(() => 'p1'),
        loadPanel: vi.fn(),
        clearActiveSession: vi.fn(),
        setActiveSession: vi.fn(),
        pushChat: vi.fn(),
        defaultCwd: vi.fn(() => null),
      },
      toast: { error: vi.fn(), warning: vi.fn() },
      fileTree: { loadTree: vi.fn(), selectFile: vi.fn() },
      t: vi.fn((key: string) => key),
      migrateImage: { migrateImage: vi.fn() },
      launchConfig,
    },
    gitApi: { checkout: vi.fn(), checkoutByCwd: vi.fn(), createBranch: vi.fn() },
    directoryPicker: { pickDirectory: vi.fn() },
    workspaceApi: {
      detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
      listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
    },
    workspaceState: { defaultCwd: vi.fn(() => null), record: vi.fn() },
  }
}

let flow: ReturnType<typeof useNewTaskFlow>

beforeEach(() => {
  setActivePinia(createPinia())
  resetNewTaskFlow()
  presets.value = [
    { id: 'builtin:full', name: '全工具模式', builtin: true, order: 0, toolMode: 'all', extensionMode: 'all' },
    {
      id: 'builtin:session-dispatch',
      name: '调度模式',
      builtin: true,
      order: 1,
      toolMode: 'allowlist',
      allowedTools: ['read'],
      extensionMode: 'all',
    },
  ]
  defaultPresetId.value = 'builtin:full'
  flow = useNewTaskFlow(
    makeFlowDeps({
      getInput: () => ({ presets: presets.value, defaultPresetId: defaultPresetId.value }),
      ensureReady: async () => {},
    }),
  )
  hosted.deps = {
    flow,
    recentWorkspaces: ref([]),
    listBranches: vi.fn(),
    createWorktree: vi.fn(),
    detectWorkspace: vi.fn(),
    pickDirectory: vi.fn(),
    presets,
    defaultPresetId,
    presetOpenRequest: ref(0),
    loadPresets: vi.fn().mockResolvedValue(undefined),
    setDefaultPreset: vi.fn(),
    toast: { error: vi.fn() },
  } satisfies NewTaskDeps
})

describe('Landing 模式选择端到端（点击 → chip 回显 → flow 透传）', () => {
  it('preset-popover 内点击选项 → flow.pendingPreset 被写 + chip 展示名切换', async () => {
    await flow.startFlow()
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: '/repo', gitBranch: 'main' },
    })
    await flushPromises()

    // 默认档显示（未显式选择 → 回落全局默认 builtin:full）
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).toContain('全工具')
    // U-A 方案 B：默认模式 = 中性底（无 accent 底，颜色只在非默认档携带信息）
    expect(chip.classes().join(' ')).not.toContain('bg-accent-soft')
    expect(chip.classes().join(' ')).toContain('text-neutral-mid')

    // 用户点 chip 展开模式 popover（Landing 的 isPresetOpen setter → flow.openPresetPopover）
    flow.openPresetPopover()
    await flushPromises()
    const option = document.querySelector<HTMLElement>('[data-testid="preset-option-builtin:session-dispatch"]')
    expect(option).toBeTruthy()

    // 点真实选项 DOM：ui chip emit select → Landing.onPresetSelect → flow.setPendingPreset
    option!.click()
    await flushPromises()

    // ① 透传真源被写（修复前恒 null——旧守卫丢弃 preset-popover 态下的写入）
    expect(flow.pendingPreset.value).toBe('builtin:session-dispatch')
    // ② chip 展示名随之切换（修复前仍为「全工具」——Landing 的 modeName 源自 pendingPreset）
    expect(chip.text()).toContain('调度')
    expect(chip.text()).not.toContain('全工具')
    // U-A 方案 B：切到非默认模式 → accent 底接上（颜色即状态）
    expect(chip.classes().join(' ')).toContain('bg-accent-soft')
    expect(chip.classes().join(' ')).toContain('text-accent')
    // ③ 选项自身选中态
    expect(option!.getAttribute('data-active')).toBe('true')
  })

  /**
   * `||` 而非 `??` 守卫（设计 §5.1 判据已踩过的坑）：store 未加载时 defaultPresetId 为 `''`
   * 而非 null，`'' ?? builtin:full` 仍是 `''` → 会把 builtin:full 默认档误判成非默认（恒亮 accent）。
   * 此处默认档解析链完全走 `''` 输入（presets 已加载，无显式选择），断言 chip 仍为中性底。
   */
  it('defaultPresetId 为空（store 未加载）：builtin:full 兜底档不误判非默认 → chip 中性底', async () => {
    defaultPresetId.value = ''
    await flow.startFlow()
    const wrapper = mount(Landing, {
      props: { sessionId: null, currentCwd: '/repo', gitBranch: 'main' },
    })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    // displayPreset 兜底 builtin:full（presets 已加载）
    expect(chip.text()).toContain('全工具')
    expect(chip.classes().join(' ')).not.toContain('bg-accent-soft')
    expect(chip.classes().join(' ')).toContain('text-neutral-mid')
  })
})
