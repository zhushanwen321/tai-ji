/**
 * U2d 壳层接线收口测试：launch 配置单一解析层的两端壳注入非空断言。
 *
 * 覆盖三条接线（不接线则显式 preset 透传处于回归态 + landing 显示链退化）：
 * - submit 侧：useNewTaskFlow 壳注入 ports.launchConfig——preset store 数据基座 +
 *   usePiPresets().loadPresets 就绪源 + settings 单例 getters + core KV 双源。
 *   断言 create 入参端到端到达 resolve 终值（D3 默认预设生效化 / D4 lastUsedModel
 *   校验获得能力表 / 显式自定义 preset 透传恢复）。
 * - 显示侧：composer-shell 注入 ModelThinkingDeps.launchData——landing 态 chip 显示
 *   读 resolveLaunchConfig 输出，preset 档（此前 core 无镜像恒不可达）经 preset store
 *   真实落到 Composer 树 DOM。
 * - 显示侧 [U4r2]：composer-shell 注入 ModelThinkingDeps.pendingPreset（flow 显式选定
 *   preset 只读视图）——显式 preset 捆绑字段进 chip 显示链（拆线 = 显示回落默认预设
 *   解析，「显示 ≡ 生效」破口复发，突变断言红）。
 *
 * 两 describe 共用真实 useNewTaskFlow（壳单例）——B 不 mock flow（真实壳挂 Composer
 * 在 idle 态渲染输入区已足够，见各用例断言）。
 *
 * 范式参照 submit-firstmessage-createflow.test.ts（mock 集合同款）+
 * composer-model-reasoning.test.ts（Composer mount + 透传探针 stub）。
 *
 * 运行：cd packages/renderer && npx vitest run src/__tests__/composables/launch-config-shell-wiring.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, getActivePinia, setActivePinia } from 'pinia'
import { textToSegments } from '@taiji/shared'
import type { PiLaunchPreset, ProviderInfo, SessionSummary } from '@taiji/shared'

// ── core.createSessionFlow mock（submit 侧断言 create 入参 = resolve 终值）──
vi.mock('@taiji/core', async (importActual) => {
  const actual = await importActual<typeof import('@taiji/core')>()
  return {
    ...actual,
    createSessionFlow: vi.fn(),
  }
})
vi.mock('@taiji/core/transport/api', () => ({
  on: vi.fn(() => () => {}),
  onGlobalType: vi.fn(() => () => {}),
  dispatchSession: vi.fn(),
}))
vi.mock('@taiji/core/transport/api/domains/session', () => ({
  create: vi.fn(),
  removeByCwd: vi.fn(),
  migrateImage: vi.fn(),
  writeSegments: vi.fn(),
  setThinkingLevel: vi.fn(async (sessionId: string, level: string) => ({ sessionId, level })),
  getCommands: vi.fn().mockResolvedValue({ commands: [] }),
  getSubagents: vi.fn().mockResolvedValue([]),
  getWorkflows: vi.fn().mockResolvedValue([]),
  getAgentCallHistory: vi.fn().mockResolvedValue([]),
}))
vi.mock('@taiji/core/transport/api/domains/file', () => ({ tree: vi.fn().mockResolvedValue({}) }))
vi.mock('@taiji/core/transport/api/domains/git', () => ({ status: vi.fn().mockResolvedValue({}) }))

// preset 域 mock：VITE_MOCK=true 下 '@/api'.preset 本就走 mock 轨，此处换成可控 fixture
// （list/getDefault 即 usePiPresets.loadPresets 的数据源——ensureReady 接线断言探针）
const presetApiMock = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([] as PiLaunchPreset[]),
  getDefault: vi.fn().mockResolvedValue(''),
  setDefault: vi.fn().mockResolvedValue(undefined),
}))

// '@/api' 单一 mock：session 重定向（createflow 范式）+ preset 可控 + mount 期防御面
//（project/model/composer，composer-model-reasoning 范式）
vi.mock('@/api', async (importActual) => {
  const actual = await importActual<typeof import('@/api')>()
  const session = await import('@taiji/core/transport/api/domains/session')
  return {
    ...actual,
    session,
    preset: presetApiMock,
    project: { load: vi.fn().mockResolvedValue({ projects: [], activeProjectId: '' }), save: vi.fn().mockResolvedValue(undefined) },
    model: { switchModel: vi.fn() },
    composer: { getMentionCandidates: vi.fn().mockResolvedValue([]), getFileCandidates: vi.fn().mockResolvedValue([]) },
  }
})

// useChat 单一 mock：send/sendBash spy（A 的 submit 主链路终点）+ mount 期防御面（B）
const chatApiMock = {
  send: vi.fn(() => Promise.resolve()),
  sendBash: vi.fn(() => Promise.resolve()),
  steer: vi.fn(() => Promise.resolve()),
  followUp: vi.fn(() => Promise.resolve()),
  abort: vi.fn(() => Promise.resolve()),
  compact: vi.fn(() => Promise.resolve()),
  editAndResend: vi.fn(),
  hydrateHistory: vi.fn(),
  abortBash: vi.fn(() => Promise.resolve()),
}
vi.mock('@/composables/features/chat/useChat', () => ({
  useChat: () => chatApiMock,
  ensureStreamSubscription: vi.fn(),
}))
vi.mock('@/composables/features/file-tree/useFileTree', () => ({ useFileTree: vi.fn(() => ({ loadTree: vi.fn() })) }))
vi.mock('@/composables/features/settings/useProjectSkills', () => ({
  useProjectSkills: () => ({ projectSkills: [] }),
  useGlobalSkills: () => ({ globalSkills: [] }),
}))
vi.mock('@/stores/session', () => ({
  useSessionStore: () => ({ active: undefined, list: [], applySnapshot: vi.fn() }),
}))
vi.mock('@/composables/features/sidebar/useSidebar', () => ({
  useSidebar: () => ({ forkSessionAsk: vi.fn(), forkSession: vi.fn() }),
}))

import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow'
import { supportedLevelsOf } from '@/composables/features/new-task/supported-levels'
import { createSessionFlow, getSettingsStore } from '@taiji/core'
import {
  __resetLastUsedModelForTesting,
  recordLastUsedModel,
  record as recordRememberedLevel,
  __resetModelThinkingMemoryForTesting,
} from '@taiji/core/domain/composer'
import { usePresetStore } from '@/stores/preset'
import Composer from '@/components/panel/Composer.vue'

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'ns', label: 'L', cwd: '/x', status: 'idle', lastActiveAt: 1, modelId: '', ...over }
}

function makePreset(p: Partial<PiLaunchPreset> = {}): PiLaunchPreset {
  return {
    id: 'p-default',
    name: '默认预设',
    builtin: false,
    order: 1,
    toolMode: 'all',
    extensionMode: 'all',
    ...p,
  }
}

function makeProviders(): ProviderInfo[] {
  return [
    {
      id: 'p1',
      name: 'P1',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: [
        { id: 'm-preset', supportedLevels: ['off', 'low', 'high'] },
        { id: 'm-x', supportedLevels: ['off', 'low', 'high'] },
      ],
    },
  ]
}

// ════════════════════════════════════════════════════════════════════════
// A. submit 侧：ports.launchConfig 接线（create 入参端到端到达 resolve 终值）
// ════════════════════════════════════════════════════════════════════════
describe('useNewTaskFlow 壳注入 ports.launchConfig（U2d submit 侧接线）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNewTaskFlow()
    // KV/settings 单例用例间隔离（provenance 档位断言不互相渗漏）
    __resetLastUsedModelForTesting()
    getSettingsStore().providers.value = []
    getSettingsStore().defaultModel.value = ''
    vi.clearAllMocks()
    vi.mocked(createSessionFlow).mockResolvedValue({
      session: summary(),
      migratedSegments: textToSegments('hi'),
    })
  })

  it('默认预设生效化（D3）：loadPresets 就绪后 create 入参带 preset 档终值（presetId + modelOverride + thinkingLevel）', async () => {
    // preset RPC fixture：默认预设 p-default 捆绑 modelOverride + thinkingLevel
    presetApiMock.list.mockResolvedValue([
      makePreset({ modelOverride: 'p1/m-preset', thinkingLevel: 'low' }),
    ])
    presetApiMock.getDefault.mockResolvedValue('p-default')

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi'))

    // ensureReady 接线断言：submit 前的 loadPresets 真实触发（list RPC 被调）
    expect(presetApiMock.list).toHaveBeenCalled()
    // 端到端：preset store 数据（经 launchConfig.getInput）到达 resolve → create 入参
    expect(createSessionFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        presetId: 'p-default',
        pendingModel: 'p1/m-preset',
        pendingThinkingLevel: 'low',
      }),
    )
    expect(chatApiMock.send).toHaveBeenCalledTimes(1)
  })

  it('lastUsedModel 档经 getInput 覆盖（D4）：KV 值 + providers 能力表（settings 单例）→ create 入参带校验后的延续模型', async () => {
    // 无 preset（列表空）→ preset 档不可达；KV 种入跨任务延续模型
    presetApiMock.list.mockResolvedValue([])
    presetApiMock.getDefault.mockResolvedValue('')
    recordLastUsedModel('p1/m-x')
    getSettingsStore().providers.value = makeProviders()

    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi'))

    // D4 校验链：lastUsed 'p1/m-x' 在 providers 能力表内 → 生效（未接线 providers 时该档被跳过）
    expect(createSessionFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pendingModel: 'p1/m-x', presetId: null }),
    )
  })

  it('显式自定义 preset 透传恢复（U2b deviation 消解）：pendingPreset 在壳侧 presets 列表内可解析 → presetId 透传', async () => {
    const custom = makePreset({ id: 'custom-1', name: 'Custom' })
    presetApiMock.list.mockResolvedValue([custom])
    presetApiMock.getDefault.mockResolvedValue('')

    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.setPendingPreset('custom-1')
    await flow.submitFirstMessage(textToSegments('hi'))

    // 接线前：fallback 基座无 preset 列表 → explicit 档失效回落 builtin:full（透传回归态）
    expect(createSessionFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ presetId: 'custom-1' }),
    )
  })
})

// ════════════════════════════════════════════════════════════════════════
// B. 显示侧：composer-shell 注入 ModelThinkingDeps.launchData（landing chip 消费 resolve 输出）
// ════════════════════════════════════════════════════════════════════════

// 透传探针：把 ModelSelectPopover 的 selected / ThinkingLevelPopover 的 level 落到 DOM
const ModelSelectProbe = defineComponent({
  name: 'ModelSelectPopover',
  props: { selected: { type: String, default: '' } },
  template: '<div data-testid="model-probe" :data-selected="selected" />',
})
const ThinkingLevelProbe = defineComponent({
  name: 'ThinkingLevelPopover',
  props: { level: { type: String, default: '' } },
  template: '<div data-testid="tlp-probe" :data-level="level" />',
})

const SIMPLE = defineComponent({ name: 'SimpleStub', template: '<div />' })
const composerStubs = {
  ModelSelectPopover: ModelSelectProbe,
  ThinkingLevelPopover: ThinkingLevelProbe,
  ComposerInput: defineComponent({
    name: 'ComposerInput',
    emits: ['input', 'keydown', 'slash-trigger', 'file-trigger'],
    setup(_, { expose }) {
      expose({ clear: vi.fn(), setText: vi.fn(), insertSlashChip: vi.fn(), getSegments: () => textToSegments('') })
      return {}
    },
    template: '<div data-testid="composer-input" />',
  }),
  CommandPopover: defineComponent({ name: 'CommandPopover', template: '<div><slot /></div>' }),
  AddMenuPopover: SIMPLE,
  ContextChipsBar: SIMPLE,
  ContextCapacityPopover: SIMPLE,
  RetryIndicator: SIMPLE,
  QueueBubble: SIMPLE,
}

function mountLandingComposer() {
  return mount(Composer, { props: { sessionId: null }, global: { stubs: composerStubs } })
}

describe('composer-shell 注入 launchData（U2d 显示侧接线）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNewTaskFlow()
    // KV 单例跨 describe 泄漏防护（A2 种入的 lastUsed 会改写本组回落链断言）
    __resetLastUsedModelForTesting()
    getSettingsStore().providers.value = []
    getSettingsStore().defaultModel.value = ''
    vi.clearAllMocks()
  })

  it('默认预设捆绑字段经 launchData 到达 resolve：landing chip 显示 preset.modelOverride / preset.thinkingLevel（非接线时该档恒不可达）', async () => {
    const presetStore = usePresetStore()
    presetStore.setPresets([
      makePreset({ modelOverride: 'p1/m-preset', thinkingLevel: 'low' }),
    ])
    presetStore.setDefaultPresetId('p-default')

    const wrapper = mountLandingComposer()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="model-probe"]').attributes('data-selected')).toBe('p1/m-preset')
    expect(wrapper.find('[data-testid="tlp-probe"]').attributes('data-level')).toBe('low')
  })

  it('preset 缺位回落链不变：无 presets 时仍回落全局默认模型（接线不破坏既有档位）', async () => {
    getSettingsStore().defaultModel.value = 'p1/m-default'

    const wrapper = mountLandingComposer()
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="model-probe"]').attributes('data-selected')).toBe('p1/m-default')
  })

  it('显式 preset 选择经 pendingPreset 通道到达 chip 显示（U4r2 接线突变断言：壳拆线则回落默认预设解析而红）', async () => {
    // 本用例需 flow 处于 landing 态（setPendingPreset 守卫），是 B 组唯一含 await 的用例：
    // await 会让早前用例挂起的微任务把 active pinia 翻回旧实例（已实测：await startFlow
    // 后 getActivePinia() ≠ beforeEach 的 pinia，mount 即绑到旧 store 读到别用例数据）——
    // mount 前钉回本用例 pinia，保证壳层 usePresetStore() 绑定本用例 store
    const pinia = getActivePinia()
    const defaultPreset = makePreset({ modelOverride: 'p1/m-default-preset', thinkingLevel: 'off' })
    const userPreset = makePreset({ id: 'p-user', name: '用户预设', order: 2, modelOverride: 'p1/m-user-preset', thinkingLevel: 'low' })
    const presetStore = usePresetStore()
    presetStore.setPresets([defaultPreset, userPreset])
    presetStore.setDefaultPresetId('p-default')
    // RPC mock impl 钉到同款 fixture：clearAllMocks 不清 impl，任何迟到的 loadPresets
    // 写进 store 的也是本用例数据（跨用例 mock impl 遗留防线）
    presetApiMock.list.mockResolvedValue([defaultPreset, userPreset])
    presetApiMock.getDefault.mockResolvedValue('p-default')

    // 用户显式选定 p-user（Landing.onPresetSelect → flow.setPendingPreset 同款写入）
    const flow = useNewTaskFlow()
    await flow.startFlow()
    flow.setPendingPreset('p-user')

    setActivePinia(pinia)
    const wrapper = mountLandingComposer()
    await wrapper.vm.$nextTick()

    // 接线突变断言：chip 显示 = 显式 preset 捆绑值。若壳层拆掉 pendingPreset 通道
    //（deps 不注入），chip 侧 resolve 输入缺 explicit preset 档 → 按默认预设解析，
    // 显示回落 p1/m-default-preset + off，两条断言即红（U4 round 1 等价破口形态）
    expect(wrapper.find('[data-testid="model-probe"]').attributes('data-selected')).toBe('p1/m-user-preset')
    expect(wrapper.find('[data-testid="tlp-probe"]').attributes('data-level')).toBe('low')
  })
})

// ════════════════════════════════════════════════════════════════════════
// C. 显示侧 / submit 侧 getSupportedLevels 同源（F5：显示侧曾漏 enabled 检查致档位发散）
// ════════════════════════════════════════════════════════════════════════
describe('composer-shell 与 submit 侧 getSupportedLevels 是同一函数（F5 统一）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
    getSettingsStore().providers.value = []
    getSettingsStore().defaultModel.value = ''
    vi.clearAllMocks()
    // clearAllMocks 不清 implementation——B 组钉住的 preset RPC fixture 会经 ensureReady
    // 拉进本组 preset store（preset 档覆盖 defaultModel/memory 链），重置为空保持链路纯净
    presetApiMock.list.mockResolvedValue([])
    presetApiMock.getDefault.mockResolvedValue('')
    vi.mocked(createSessionFlow).mockResolvedValue({
      session: summary(),
      migratedSegments: textToSegments('hi'),
    })
  })

  it('enabled=false provider：显示侧（chip 解析）与 submit 侧（create 入参）档位一致（统一默认五档）', async () => {
    // 场景：provider 禁用 + 其模型声明档位 ['off','high']（不含 low）+ 记忆档 low。
    // 修复前发散形态：显示侧 getSupportedLevels 漏 enabled 检查 → 读到 ['off','high']
    // → 记忆档 low 不可用 → chip 回落最高档 'high'；submit 侧 supportedLevelsOf 有检查
    // → undefined → 归一默认五档（含 low）→ 记忆档 low 生效——显示 high ≠ 生效 low。
    // 修复后：两侧即同一函数（supportedLevelsOf）→ 同归一默认五档 → 显示 ≡ 生效 = low。
    getSettingsStore().providers.value = [
      {
        id: 'p1', name: 'P1', apiKeySet: true, status: 'connected', enabled: false,
        models: [{ id: 'm-x', supportedLevels: ['off', 'high'] }],
      },
    ]
    getSettingsStore().defaultModel.value = 'p1/m-x'
    recordRememberedLevel('p1/m-x', 'low') // 用户此前显式选过的记忆档

    // 单元级：唯一实现对 enabled=false 返回 undefined（禁用 provider 不参与档位解析）
    expect(supportedLevelsOf('p1/m-x', getSettingsStore().providers.value)).toBeUndefined()

    // 显示侧：landing chip 解析输出（tlp-probe = currentThinkingLevel / model-probe = currentModelId）
    const wrapper = mountLandingComposer()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="model-probe"]').attributes('data-selected')).toBe('p1/m-x')
    expect(wrapper.find('[data-testid="tlp-probe"]').attributes('data-level')).toBe('low')

    // submit 侧：同输入下 create 入参 = 显示侧同值（「显示 ≡ 生效」在禁用 provider 场景的结构锁）
    const flow = useNewTaskFlow()
    await flow.startFlow()
    await flow.submitFirstMessage(textToSegments('hi'))
    expect(createSessionFlow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pendingModel: 'p1/m-x', pendingThinkingLevel: 'low' }),
    )
  })
})
