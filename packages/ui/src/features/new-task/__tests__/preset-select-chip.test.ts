/**
 * PresetSelectChip 组件测试（U2c：回显改读 resolveLaunchConfig 输出，废 B6 echo）。
 *
 * 覆盖面：
 * 1. 首屏冒烟（C-NT-5 沿袭）：landing 态 chip DOM 存在 + loadPresets 拉数据 + popover 展开选项 DOM。
 * 2. 回显语义（U2c 核心）：chip 显示 = createLaunchConfigView 对 preset 字段的解析输出——
 *    默认档回显（defaultPresetId 有值）、未设默认兜底 builtin:full（D3 默认链）、数据延迟
 *    到达响应式重算（P5①）、显式选择（用户点击 → emit select + 显示切 explicit 档）。
 *    同源性断言：组件外对相同输入直接调 resolveLaunchConfig，chip 文本 ≡ resolve 解析出的
 *    preset 名（「显示 ≡ 生效」在组件层的结构锁，L1 精神的组件实例）。
 *
 * 断言 DOM 结构（data-testid）+ preset.name 文案（不走 i18n，t() mock 返回 key）。
 *
 * 运行：cd packages/ui && npx vitest run src/features/new-task
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import PresetSelectChip from '../PresetSelectChip.vue'
import { NewTaskDepsKey, type NewTaskDeps } from '../new-task-deps'
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  type PiLaunchPreset,
} from '@taiji/shared'
import { resolveLaunchConfig } from '@taiji/core'

/** 构造 mock NewTaskDeps（flow 只需 pendingPreset 只读视图——重入同步 watch 的观察源） */
function makeDeps(overrides?: Partial<NewTaskDeps>): NewTaskDeps {
  const base: NewTaskDeps = {
    flow: { pendingPreset: ref<string | null>(null) } as NewTaskDeps['flow'],
    recentWorkspaces: ref([]),
    listBranches: vi.fn(async () => ({ local: [], remote: [], defaultBranch: 'main' })),
    createWorktree: vi.fn(async () => ({ cwd: '', branch: '' })),
    detectWorkspace: vi.fn(async () => ({
      mode: 'not-repo' as const, wsRoot: '', barePath: '', repoRoot: '', defaultBranch: '',
    })),
    pickDirectory: vi.fn(async () => ({ canceled: true })),
    presets: ref<PiLaunchPreset[]>([]),
    defaultPresetId: ref(''),
    presetOpenRequest: ref(0),
    loadPresets: vi.fn(async () => {}),
    setDefaultPreset: vi.fn(async () => {}),
    toast: { error: vi.fn() },
  }
  return overrides ? { ...base, ...overrides } : base
}

/**
 * 样例预设：出厂 full 原样（isFactoryFullPreset 全等 → resolve 输出 presetId=undefined，
 * D3 不透传形态）+ 自定义预设（name「只读模式」，非出厂 → 正常透传 id）。
 */
function samplePresets(): PiLaunchPreset[] {
  const factoryFull = DEFAULT_PRESETS.find((p) => p.id === BUILTIN_PRESET_IDS.FULL)
  if (!factoryFull) throw new Error('DEFAULT_PRESETS 缺 builtin:full（shared 常量损坏）')
  return [
    factoryFull,
    {
      id: 'custom:read-only', name: '只读模式', description: '仅阅读', builtin: false, order: 9,
      toolMode: 'denylist', deniedTools: ['*'], extensionMode: 'none',
    },
  ]
}

/** 同源解析：与组件 displayPresetId 相同的输入调 resolveLaunchConfig，取显示语义 id。 */
function resolveDisplayPresetId(input: {
  pendingPreset?: string | null
  presets: PiLaunchPreset[]
  defaultPresetId?: string | null
}): string {
  const resolved = resolveLaunchConfig(input)
  return (
    resolved.presetId ??
    (input.presets.some((p) => p.id === BUILTIN_PRESET_IDS.FULL) ? BUILTIN_PRESET_IDS.FULL : '')
  )
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('PresetSelectChip 首屏冒烟', () => {
  it('landing 态：chip-preset DOM 存在（loadPresets 拉数据，回显无手动写入）', async () => {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises() // onMounted → loadPresets（回显由 resolve 响应式视图自动完成）
    expect(wrapper.find('[data-testid="chip-preset"]').exists()).toBe(true)
    expect(deps.loadPresets).toHaveBeenCalled()
  })

  it('landing 态 Popover 展开：预设选项 DOM 存在（Teleport 到 body，断言 document.body）', async () => {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(document.querySelector('[data-testid="preset-option-builtin:full"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="preset-option-custom:read-only"]')).not.toBeNull()
  })
})

describe('PresetSelectChip 回显 = resolve 输出（U2c，D3 默认预设生效化）', () => {
  it('未显式选择：chip 显示默认预设解析档（displayPresetId = resolve 输出）', async () => {
    const presets = samplePresets()
    const deps = makeDeps({
      presets: ref(presets),
      defaultPresetId: ref('custom:read-only'),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    // 同源断言：resolve 输出的 preset 名 ≡ chip 文本（显示 ≡ 生效的结构锁）
    const displayId = resolveDisplayPresetId({ presets, defaultPresetId: 'custom:read-only' })
    const resolvedName = presets.find((p) => p.id === displayId)?.name ?? displayId
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain(resolvedName)
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('未设默认（defaultPresetId 空）：resolve 默认链兜底 builtin:full，chip 显示「全工具模式」', async () => {
    // D3 行为变化声明：现状（B6 echo）此场景 selectedPresetId 恒空 → 永显「加载中…」；
    // 改线后显示 = resolve 输出（builtin:full 默认档，出厂等价 presetId=undefined 不透传）
    const presets = samplePresets()
    const deps = makeDeps({
      presets: ref(presets),
      defaultPresetId: ref(''),
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(resolveDisplayPresetId({ presets, defaultPresetId: '' })).toBe(BUILTIN_PRESET_IDS.FULL)
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
  })

  it('presets 延迟到达：resolve 响应式重算，chip 脱离「加载中…」（P5①）', async () => {
    const presetsRef = ref<PiLaunchPreset[]>([])
    const defaultRef = ref('')
    const deps = makeDeps({ presets: presetsRef, defaultPresetId: defaultRef })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain(
      'newTask.presetSelect.loadingPresets',
    )
    // 数据到达（loadPresets 写 deps 侧 store）：无任何手动回显，chip 自动重算
    presetsRef.value = samplePresets()
    defaultRef.value = 'custom:read-only'
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('用户点击：emit select { presetId } + 显示切 explicit 档（显式 > 默认，emit 契约不变）', async () => {
    const presets = samplePresets()
    const deps = makeDeps({
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    // 点击自定义项：显式选择（PopoverListItem Teleport 到 body）
    const option = document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!
    option.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ presetId: 'custom:read-only' }]])
    // 显示切 explicit 档 = resolve 输出（pendingPreset=custom:read-only）
    const displayId = resolveDisplayPresetId({
      pendingPreset: 'custom:read-only', presets, defaultPresetId: '',
    })
    expect(displayId).toBe('custom:read-only')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })
})

describe('PresetSelectChip 重入同步（G1 破口修复：explicitPresetId 跟随 flow.pendingPreset）', () => {
  it('选 custom-1 → flow.pendingPreset 被外部重置（startFlow 重入）→ chip 回落默认链显示', async () => {
    const presets = samplePresets()
    // 真实 flow.pendingPreset 是只读 computed<string | null>；ref 读取形态兼容，可写模拟重入
    const pendingPreset = ref<string | null>(null)
    const deps = makeDeps({
      flow: { pendingPreset } as NewTaskDeps['flow'],
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: true },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    // ① 用户显式选择 custom:read-only：emit + Landing 侧 setPendingPreset 回写 pendingPreset
    document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!.click()
    pendingPreset.value = 'custom:read-only' // Landing.vue onSelectPreset → flow.setPendingPreset
    await flushPromises()
    expect(wrapper.emitted('select')).toEqual([[{ presetId: 'custom:read-only' }]])
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
    // ② startFlow 重入（多次 ⌘N / initApp 重试）：Landing 不重挂载（isActive 守卫），
    //    flow.pendingPreset 无条件重置为 null——修复前 explicitPresetId 残留旧选择，
    //    chip 显示「只读模式」而 submit 按默认预设创建（显示 ≠ 生效）
    pendingPreset.value = null
    await flushPromises()
    // chip 回落默认链显示（builtin:full），不再残留 explicit 旧值
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).not.toContain('只读模式')
    // ③ 重置后用户显式点击仍正常 emit（显式选择链路不受同步 watch 影响）
    document.querySelector<HTMLElement>('[data-testid="preset-option-custom:read-only"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('select')).toHaveLength(2)
    expect(wrapper.emitted('select')?.[1]).toEqual([{ presetId: 'custom:read-only' }])
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
  })

  it('挂载时 pendingPreset 已有显式值（immediate）：chip 显示显式预设，非默认链回落', async () => {
    // 挂载时序变体（immediate:true 的靶场景）：chip 实例在 flow.pendingPreset 已非 null 时
    // 新挂载（如 landing 已有显式选择后新增分屏 pane）。新实例 explicitPresetId 初值 null，
    // watch 无 immediate 时错过首帧真值 → chip 显示默认链（builtin:full）而 submit 消费
    // 显式档——显示 ≠ 生效。immediate 使 watch 挂载即跟随当前真值。
    const presets = samplePresets()
    const pendingPreset = ref<string | null>('custom:read-only')
    const deps = makeDeps({
      flow: { pendingPreset } as NewTaskDeps['flow'],
      presets: ref(presets),
      defaultPresetId: ref(''), // 默认档解析为 builtin:full（回落显示锚点）
    })
    const wrapper = mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
    await flushPromises()
    // 挂载首帧即显示显式档（explicit > 默认链）
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('只读模式')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).not.toContain('全工具模式')
    // immediate 不破坏重置回落路径：外部重置 pendingPreset（startFlow 重入）→ 回落默认链
    pendingPreset.value = null
    await flushPromises()
    expect(wrapper.find('[data-testid="chip-preset"]').text()).toContain('全工具模式')
    expect(wrapper.find('[data-testid="chip-preset"]').text()).not.toContain('只读模式')
  })
})

describe('PresetSelectChip 三档退化 + 信任标记跨档不丢（u4a）', () => {
  // 可见文案全部由 renderer 侧经 props 传入（ui 包不耦合 i18n）；此处用固定串模拟 renderer 文案。
  const MODE_NAME = '调度模式'
  const SHORT_NAME = '调度'
  const REPLACE_HINT = '含替换提示词'

  /** 挂载 chip：默认文案 props 齐备；extra 覆盖 density / 信任标记判据等档位开关 */
  function mountChip(extra: Record<string, unknown> = {}) {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    return mount(PresetSelectChip, {
      props: {
        sessionId: null,
        launchPresetId: undefined,
        presetOpen: false,
        modeName: MODE_NAME,
        shortName: SHORT_NAME,
        ...extra,
      },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
  }

  it('① 文本档（full）：显示模式全名 + chip 内替换提示文案，无角标', async () => {
    const wrapper = mountChip({ density: 'full', hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).toContain(MODE_NAME)
    expect(chip.text()).toContain(REPLACE_HINT)
    // 文本档用内嵌后缀，不出现角标（两档形态互斥）
    expect(chip.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
  })

  it('①b 短名档（short）：显示短名 + 信任标记仍在（内嵌后缀）', async () => {
    const wrapper = mountChip({ density: 'short', hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).toContain(SHORT_NAME)
    expect(chip.text()).not.toContain(MODE_NAME)
    expect(chip.text()).toContain(REPLACE_HINT)
  })

  it('② 窄档（icon）：纯图标无可见文本，但信任标记仍以右上角警示色角标存在（+ tooltip）', async () => {
    const wrapper = mountChip({ density: 'icon', accent: true, hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.text()).not.toContain(MODE_NAME)
    expect(chip.text()).not.toContain(REPLACE_HINT)
    // accent 底跨档保留（非默认模式档，颜色 = 状态）；角标独立于 accent 通道（用 warn 色）
    expect(chip.classes().join(' ')).toContain('bg-accent-soft')
    const badge = chip.find('[data-testid="preset-chip-replace-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toBe(REPLACE_HINT)
  })

  it('③ 无替换文案：三档均不渲染信任标记（缺省 false / 文案空）', async () => {
    for (const density of ['full', 'short', 'icon'] as const) {
      const wrapper = mountChip({ density })
      await flushPromises()
      const chip = wrapper.find('[data-testid="chip-preset"]')
      expect(chip.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
      expect(chip.text()).not.toContain(REPLACE_HINT)
    }
    // 判据含「文案非空」：布尔为 true 但文案为空白 → 不渲染空后缀 / 空 tooltip
    const emptyText = mountChip({ density: 'icon', hasReplacePrompt: true, replaceHint: '  ' })
    await flushPromises()
    expect(emptyText.find('[data-testid="preset-chip-replace-badge"]').exists()).toBe(false)
  })

  it('④ 窄档 aria-label / title 保留全名（aria-label 追加信任标记文案；不依赖可见文本）', async () => {
    const wrapper = mountChip({ density: 'icon', hasReplacePrompt: true, replaceHint: REPLACE_HINT })
    await flushPromises()
    const chip = wrapper.find('[data-testid="chip-preset"]')
    expect(chip.attributes('aria-label')).toContain(MODE_NAME)
    expect(chip.attributes('aria-label')).toContain(REPLACE_HINT)
    expect(chip.attributes('title')).toBe(MODE_NAME)
  })
})

/**
 * 模式 chip 底色（方案 B：默认模式中性底 / 非默认模式 accent 底）。
 *
 * 设计 §5.1「颜色即状态」：accent 底只在**非默认模式**档出现，颜色才携带信息（恒亮 = 无色差
 * = 用户读不出状态）。判据由 renderer 侧算好经 `accent` prop 传入（本包只按 prop 出样式），
 * 故断言分两向：缺省/false → 无 accent 底 + 中性文字档；true → accent 底原样（非默认模式零变化）。
 * ① 是反向断言（防将来又退回「无条件 accent 底」）；② 守住 accent 档的既有形态不被顺手改掉。
 */
describe('PresetSelectChip 模式 chip 底色（accent prop：默认中性 / 非默认 accent）', () => {
  function mountTone(accent?: boolean) {
    const deps = makeDeps({
      presets: ref(samplePresets()),
      defaultPresetId: ref('custom:read-only'),
    })
    return mount(PresetSelectChip, {
      props: { sessionId: null, launchPresetId: undefined, presetOpen: false, accent },
      global: { provide: { [NewTaskDepsKey]: deps } },
    })
  }

  it('① 默认模式（accent 缺省 false）：无 accent 底，文字走中性档 + 邻位 chip 同款 hover 反馈', async () => {
    const wrapper = mountTone()
    await flushPromises()
    const cls = wrapper.find('[data-testid="chip-preset"]').classes().join(' ')
    // 反向断言：默认档不得有 accent 底/强调文字（否则「颜色即状态」恒亮失效）
    expect(cls).not.toContain('bg-accent-soft')
    expect(cls).not.toContain('text-accent')
    // 中性档 = 与 landing 首行邻位 chip（chip-directory / chip-branch）同一套反馈
    expect(cls).toContain('text-neutral-mid')
    expect(cls).toContain('hover:bg-surface-hover')
    expect(cls).toContain('hover:text-neutral-fg')
  })

  it('①b 显式 accent=false：与缺省同档（默认模式中性底，非默认模式外观零变化）', async () => {
    const wrapper = mountTone(false)
    await flushPromises()
    const cls = wrapper.find('[data-testid="chip-preset"]').classes().join(' ')
    expect(cls).not.toContain('bg-accent-soft')
    expect(cls).toContain('text-neutral-mid')
  })

  it('② 非默认模式（accent=true）：保留 accent 底 + 强调文字 + accent hover（逐字原样）', async () => {
    const wrapper = mountTone(true)
    await flushPromises()
    const cls = wrapper.find('[data-testid="chip-preset"]').classes().join(' ')
    expect(cls).toContain('bg-accent-soft')
    expect(cls).toContain('text-accent')
    expect(cls).toContain('hover:bg-accent-soft')
    expect(cls).not.toContain('text-neutral-mid')
  })
})
