import { chatApiMethodsMock } from '@/__tests__/helpers/api-facade-mock';
import { toastSpyMock, toastSpyModule } from '@/__tests__/helpers/i18n-toast-mock';
import { makeSettingsTransportStub } from '@/__tests__/helpers/settings-transport-stub';
import Composer from '@/components/panel/Composer.vue';
import { supportedLevelsOf } from '@/composables/features/new-task/supported-levels';
import { useNewTaskFlow, resetNewTaskFlow } from '@/composables/features/new-task/useNewTaskFlow';
import { createExplicitSave, createMirrorSave, createSettingFieldGroup, type SettingField } from '@/composables/features/settings/setting-field';
import { useQuotaAutoEnableNotice } from '@/composables/features/settings/useQuotaAutoEnableNotice';
import { useUpdateInstallActions } from '@/composables/features/settings/useUpdateInstallActions';
import { usePresetStore } from '@/stores/preset';
import { createSessionFlow, getSettingsStore, provideSettingsTransport } from '@taiji/core';
import { __resetLastUsedModelForTesting, recordLastUsedModel, record as recordRememberedLevel, __resetModelThinkingMemoryForTesting } from '@taiji/core/domain/composer';
import { textToSegments, type PiLaunchPreset, type ProviderInfo, type SessionSummary } from '@taiji/shared';
import { mount } from '@vue/test-utils';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, ref } from 'vue';

// wave3 簇 [renderer/happy-dom] 2 文件
/**
 * 合并产物（round6 Wave3 机械合并，环境/簇信息见来源横幅）。
 * 重名顶层标识符已加 _mN 后缀；相对 import 已按产物位置改写。
 * 来源文件：
 * - __tests__/composables/launch-config-shell-wiring.test.ts
 * - composables/features/settings/__tests__/settings-composables-browser.test.ts
 */

// ======================================================================
// ← __tests__/composables/launch-config-shell-wiring.test.ts
// ======================================================================

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

// preset 域 mock：VITE_MOCK=true 下 '@/api'.preset 本就走 mock 层，此处换成可控 fixture
// （list/getDefault 即 usePiPresets.loadPresets 的数据源——ensureReady 接线断言探针）
const presetApiMock = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([] as PiLaunchPreset[]),
  getDefault: vi.fn().mockResolvedValue(''),
  setDefault: vi.fn().mockResolvedValue(undefined),
}))

// '@/api' 单一 mock：session 重定向（createflow 范式）+ preset 可控 + mount 期防御机制
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

// useChat 单一 mock：send/sendBash spy（A 的 submit 主链路终点）+ mount 期防御机制（B）
const chatApiMock = {
  ...chatApiMethodsMock(),
  sendBash: vi.fn(() => Promise.resolve()),
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

// [C3] preset 域调用经 SettingsTransport seam 桩注入（usePiPresets.loadPresets 的数据源探针；
// 替换原 '@/api' 门面 preset mock 的消费方）。
beforeEach(() => {
  provideSettingsTransport(makeSettingsTransportStub({
    listPresets: presetApiMock.list,
    getDefaultPreset: presetApiMock.getDefault,
    setDefaultPreset: presetApiMock.setDefault,
  }))
})

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return { id: 'ns', label: 'L', cwd: '/x', status: 'idle', lastActiveAt: 1, ...over }
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
    // 本用例需 flow 处于 landing 态（setPendingPreset 检查），是 B 组唯一含 await 的用例：
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

// ======================================================================
// ← composables/features/settings/__tests__/settings-composables-browser.test.ts
// ======================================================================

// 机械合并产物（同目录合并，vi.mock 相对路径不变）；源文件见各节横幅。重名顶层标识符已加 _mN 后缀。

// ======================================================================
// ← setting-field.test.ts
// ======================================================================

// toast spy 单源（helpers/i18n-toast-mock.ts 的 toastSpyMock 单例，断言经该单例取）
vi.mock('@/composables/useToast', () => toastSpyModule())

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined ? key : `${key}?${JSON.stringify(params)}`,
  }),
}))

beforeEach(() => {
  toastSpyMock.info.mockClear()
  toastSpyMock.error.mockClear()
  toastSpyMock.warning.mockClear()
})

describe('createSettingFieldGroup · loadAll 归并', () => {
  it('任一 loader reject → loadError 置位 + 返回 false；失败不阻塞其余 loader', async () => {
    const group = createSettingFieldGroup()
    const good = vi.fn(() => Promise.resolve())
    const bad = vi.fn(() => Promise.reject(new Error('ws down')))
    group.registerLoader(good)
    group.registerLoader(bad)

    await expect(group.loadAll()).resolves.toBe(false)
    expect(group.loadError.value).toBe(true)
    expect(good).toHaveBeenCalledTimes(1)
    expect(bad).toHaveBeenCalledTimes(1)
  })

  it('全部成功 → loadError 复位 + 返回 true（重试成功路径）', async () => {
    const group = createSettingFieldGroup()
    let shouldFail = true
    group.registerLoader(() => (shouldFail ? Promise.reject(new Error('ws down')) : Promise.resolve()))

    await expect(group.loadAll()).resolves.toBe(false)
    expect(group.loadError.value).toBe(true)

    shouldFail = false
    await expect(group.loadAll()).resolves.toBe(true)
    expect(group.loadError.value).toBe(false)
  })
})

describe('field · 加载回填（便捷 load 自动注册 + 共享 loader）', () => {
  it('便捷 load hooks 自动注册进 loadAll；resolve 值经 reset 回填 value', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<string>('default', { load: () => Promise.resolve('loaded') })

    expect(f.value.value).toBe('default')
    await group.loadAll()
    expect(f.value.value).toBe('loaded')
  })

  it('registerLoader 共享 load：单 loader 回填多字段（SmartContext 形态），基准同步更新', async () => {
    const group = createSettingFieldGroup()
    const enabled = group.field<boolean>(false, { save: async () => undefined })
    const excluded = group.field<string[]>([], { save: async (next) => next })
    group.registerLoader(async () => {
      enabled.reset(true)
      excluded.reset(['p1/m1'])
    })

    await group.loadAll()
    expect(enabled.value.value).toBe(true)
    expect(excluded.value.value).toEqual(['p1/m1'])

    // 基准同步：随后的失败 persist 回滚到加载值而非初始值
    enabled.reset(true)
    const saveRejects = group.field<boolean>(false, { save: () => Promise.reject(new Error('x')) })
    saveRejects.reset(true)
    await saveRejects.persist(false)
    expect(saveRejects.value.value).toBe(true)
  })
})

describe('field · persist 编排', () => {
  it('乐观写：save 尚未 resolve 时 value 已更新 + busy 置位；resolve 后 busy 复位', async () => {
    const group = createSettingFieldGroup()
    let resolveSave!: () => void
    const f = group.field<boolean>(false, {
      save: () => new Promise<void>((resolve) => { resolveSave = resolve }),
    })

    const pending = f.persist(true)
    expect(f.value.value).toBe(true)
    expect(f.busy.value).toBe(true)

    resolveSave()
    await pending
    expect(f.busy.value).toBe(false)
  })

  it('busy 防重入：busy 期间 persist 直接 return（save 只被调一次，value 不被二次写）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(() => new Promise<void>(() => {}))
    const f = group.field<boolean>(false, { save })

    void f.persist(true)
    await f.persist(false)
    expect(save).toHaveBeenCalledTimes(1)
    expect(f.value.value).toBe(true)
  })

  it('失败回滚到已保存基准 + saveFailed toast 带 reason 插值', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<boolean>(false, { save: () => Promise.reject(new Error('ws down')) })
    f.reset(true)

    await f.persist(false)
    expect(f.value.value).toBe(true)
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.saveFailed?{"reason":"ws down"}')
  })

  it('saveFailedToastKey 覆盖 + 非 Error reject 走 String(reason)', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<string>('a', {
      save: () => Promise.reject('plain-failure'),
      saveFailedToastKey: 'settings.system.customFailed',
    })

    await f.persist('b')
    expect(f.value.value).toBe('a')
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.customFailed?{"reason":"plain-failure"}')
  })

  it('成功回填权威值并更新基准：后续失败回滚到权威值（而非更早的初始值）', async () => {
    const group = createSettingFieldGroup()
    const saveCalls: string[] = []
    const f = group.field<string>('init', {
      save: async (next) => {
        saveCalls.push(next)
        if (saveCalls.length === 2) throw new Error('boom')
        return 'authoritative'
      },
    })

    await f.persist('next')
    expect(f.value.value).toBe('authoritative')
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')

    await f.persist('again')
    expect(f.value.value).toBe('authoritative')
  })

  it('save resolve void = 不回填（乐观值保留）+ 默认 saved toast key', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<boolean>(false, { save: async () => undefined })

    await f.persist(true)
    expect(f.value.value).toBe(true)
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')
  })

  it('validate 非法：不调 RPC、回弹已保存基准、专属 toast（不叠 saveFailed）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: number[]): Promise<number[] | void> => [])
    const f = group.field<number[]>([200, 400], {
      save,
      validate: (next) =>
        next.some((tk) => !Number.isFinite(tk) || tk <= 0) ? 'settings.system.smartContextThresholdInvalid' : null,
    })

    await f.persist([300, -1])
    expect(save).not.toHaveBeenCalled()
    expect(f.value.value).toEqual([200, 400])
    expect(toastSpyMock.error).toHaveBeenCalledTimes(1)
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.smartContextThresholdInvalid')
  })

  it('validate 通过（null）→ 正常走 save 并回填权威值', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (next: number[]) => next.map((tk) => tk * 1000))
    const f = group.field<number[]>([200, 400], {
      save,
      validate: (next) => (next.some((tk) => tk <= 0) ? 'invalid' : null),
    })

    await f.persist([300, 500])
    expect(save).toHaveBeenCalledWith([300, 500])
    expect(f.value.value).toEqual([300000, 500000])
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')
  })

  it('回滚锚点 = 已保存基准而非 persist 入口值：v-model 原地直改脏值后失败回到基准', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<number[]>([200, 400], { save: () => Promise.reject(new Error('x')) })
    f.reset([200, 400])

    // 模拟 v-model.number="thresholdsK[i]" 原地改写（同一数组引用，persist 调用前已带脏值）
    f.value.value[0] = 999
    await f.persist(f.value.value)

    expect(f.value.value).toEqual([200, 400])
  })

  it('savedToastKey 函数形态：保存完成后求值，可按其他字段状态选文案', async () => {
    const group = createSettingFieldGroup()
    const toggle = group.field<boolean>(true, { save: async () => undefined })
    // 显式类型标注：savedToastKey 闭包引用本字段自身（与组件现场同构），不标注构成自引用初始化环
    const mode: SettingField<string> = group.field<string>('first-stop', {
      save: (next) => Promise.resolve(next),
      savedToastKey: () =>
        !toggle.value.value && mode.value.value !== 'agent-tool' ? 'mode.switchedAutoDisabled' : 'mode.switched',
    })

    await mode.persist('agent-tool')
    expect(toastSpyMock.info).toHaveBeenCalledWith('mode.switched')

    toggle.reset(false)
    await mode.persist('first-prompt')
    expect(toastSpyMock.info).toHaveBeenCalledWith('mode.switchedAutoDisabled')
  })
})

describe('field · 同值短路（blur 形态字段）', () => {
  it('persist 与已保存基准同值 → 不校验不保存不 toast（blur 未改动不触发任何动作）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: string): Promise<void> => undefined)
    const validate = vi.fn((_next: string): string | null => null)
    const f = group.field<string>('saved', { save, validate })
    f.reset('saved')

    await f.persist('saved')
    expect(save).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(toastSpyMock.info).not.toHaveBeenCalled()
    expect(toastSpyMock.error).not.toHaveBeenCalled()
  })

  it('数组值域同值短路：元素相同的新数组实例不触发 save（JSON 序列化值比较）', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: number[]): Promise<void> => undefined)
    const f = group.field<number[]>([200, 400], { save })
    f.reset([200, 400])

    await f.persist([200, 400])
    expect(save).not.toHaveBeenCalled()
  })
})

/** 「恒拒校验 inline 字段 + 首次非法 persist」共用前置（同值清 inline / reset 清 inline
 *  两用例的单源形态）：field(60) 的 validate 恒拒 → persist(0) 后 inline 已置 timeoutInvalid、
 *  值回弹基准 60。末尾断言 = 每个用例的前置自检，随用例一并执行。 */
async function rejectedInlineFieldAfterInvalidPersist() {
  const group = createSettingFieldGroup()
  const invalidInline = ref<string | null>(null)
  const f = group.field<number>(60, {
    save: async () => undefined,
    validate: () => 'settings.worktree.timeoutInvalid',
    invalidInline,
  })

  await f.persist(0)
  expect(invalidInline.value).toBe('settings.worktree.timeoutInvalid')
  return { f, invalidInline }
}

describe('field · validate inline 通道（invalidInline，RD-4#7 表单红字形态）', () => {
  it('提供 invalidInline：validate 拒绝 → inline key 置入 + 不弹 toast + 回弹基准 + 不调 RPC', async () => {
    const group = createSettingFieldGroup()
    const save = vi.fn(async (_next: number): Promise<void> => undefined)
    const invalidInline = ref<string | null>(null)
    const f = group.field<number>(60, {
      save,
      validate: (next) => (!Number.isFinite(next) || next <= 0 ? 'settings.worktree.timeoutInvalid' : null),
      invalidInline,
    })
    f.reset(60)

    await f.persist(0)
    expect(invalidInline.value).toBe('settings.worktree.timeoutInvalid')
    expect(save).not.toHaveBeenCalled()
    expect(f.value.value).toBe(60)
    expect(toastSpyMock.error).not.toHaveBeenCalled()
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })

  it('不提供 invalidInline：validate 拒绝仍走专属 toast（System sections 形态不受影响）', async () => {
    const group = createSettingFieldGroup()
    const f = group.field<number[]>([200, 400], {
      save: async () => undefined,
      validate: (next) => (next.some((tk) => tk <= 0) ? 'settings.system.smartContextThresholdInvalid' : null),
    })

    await f.persist([300, -1])
    expect(toastSpyMock.error).toHaveBeenCalledTimes(1)
    expect(toastSpyMock.error).toHaveBeenCalledWith('settings.system.smartContextThresholdInvalid')
  })

  it('persist 尝试起点清 inline：拒绝后再合法保存成功 → inline 复位 + saved toast', async () => {
    const group = createSettingFieldGroup()
    const invalidInline = ref<string | null>(null)
    const f = group.field<number>(60, {
      save: async () => undefined,
      validate: (next) => (next <= 0 ? 'settings.worktree.timeoutInvalid' : null),
      invalidInline,
    })

    await f.persist(0)
    expect(invalidInline.value).toBe('settings.worktree.timeoutInvalid')

    await f.persist(120)
    expect(invalidInline.value).toBe(null)
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.system.saved')
  })

  it('同值 persist 同样清 inline（先清后短路：再次 blur 带走旧 error 的既有 UI 行为）', async () => {
    const { f, invalidInline } = await rejectedInlineFieldAfterInvalidPersist()

    // 拒绝路径已回弹基准（60），再次 blur → 同值短路，但旧 inline error 被起点复位带走
    await f.persist(60)
    expect(invalidInline.value).toBe(null)
  })

  it('reset 更新基准时清 inline（重试加载成功后旧校验错误不再适用）', async () => {
    const { f, invalidInline } = await rejectedInlineFieldAfterInvalidPersist()

    f.reset(90)
    expect(invalidInline.value).toBe(null)
  })
})

describe('createMirrorSave（dirs 镜像保存）', () => {
  it('失败 → saveError 置位 + toast error（e.message 原文）；成功 → 复位（尝试起点复位语义）', async () => {
    let shouldFail = true
    const mirror = createMirrorSave((arg: string) =>
      shouldFail ? Promise.reject(new Error('disk full')) : Promise.resolve(),
    )

    await mirror.run('a')
    expect(mirror.saveError.value).toBe(true)
    expect(toastSpyMock.error).toHaveBeenCalledWith('disk full')

    shouldFail = false
    await mirror.run('b')
    expect(mirror.saveError.value).toBe(false)
  })
})

describe('createExplicitSave（显式保存动作）', () => {
  it('防重入：in-flight 期间 run 直接 return（run 本体只执行一次）+ 成功 toast', async () => {
    let resolveRun!: () => void
    const body = vi.fn(() => new Promise<void>((resolve) => { resolveRun = resolve }))
    const action = createExplicitSave({ run: body, savedToastKey: 'x.saved' })

    const first = action.run()
    await action.run()
    expect(body).toHaveBeenCalledTimes(1)
    expect(action.saving.value).toBe(true)

    resolveRun()
    await first
    expect(action.saving.value).toBe(false)
    expect(toastSpyMock.info).toHaveBeenCalledWith('x.saved')
  })

  it('失败不上抛：默认 toast e.message 原文；onError 覆盖文案', async () => {
    const failing = createExplicitSave({ run: () => Promise.reject(new Error('boom')), savedToastKey: 'x.saved' })
    await expect(failing.run()).resolves.toBeUndefined()
    expect(toastSpyMock.error).toHaveBeenCalledWith('boom')

    const custom = createExplicitSave({
      run: () => Promise.reject(new Error('raw')),
      savedToastKey: 'x.saved',
      onError: () => 'custom text',
    })
    await custom.run()
    expect(toastSpyMock.error).toHaveBeenCalledWith('custom text')
  })

  it('带参形态（LlmRetry 整体 config 形态）：run 收到调用方域校验产物', async () => {
    const body = vi.fn(async (_cfg: { n: number }) => undefined)
    const action = createExplicitSave<{ n: number }>({ run: body, savedToastKey: 'x.saved' })

    await action.run({ n: 1 })
    expect(body).toHaveBeenCalledWith({ n: 1 })
    expect(toastSpyMock.info).toHaveBeenCalledWith('x.saved')
  })
})

// ======================================================================
// ← useQuotaAutoEnableNotice.test.ts
// ======================================================================

vi.mock('@/i18n', () => ({
  // t 返回 key；带 params 时拼接 name，让 toast 断言能验证插值确有传入
  default: { global: { t: (key: string, params?: Record<string, unknown>) =>
    params?.name ? `${key}:${String(params.name)}` : key } },
}))


describe('notifyQuotaAutoEnabled 判定矩阵', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enabled=true 且 name=undefined → 不 toast（!name 检查：savedId 空时调用点真传 undefined）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(true, undefined)
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })

  it('enabled=true 且 name 空串 → 不 toast（!name 同分支拦截无可展示名）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(true, '')
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })

  it('enabled=true 且有展示名 → info toast 一次，payload 含 name（指引语境）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(true, 'Z.AI Coding CN')
    expect(toastSpyMock.info).toHaveBeenCalledOnce()
    expect(toastSpyMock.info).toHaveBeenCalledWith('settings.provider.quotaAutoEnabledToast:Z.AI Coding CN')
  })

  it('enabled=false → 不 toast（runtime 未开启额度显示）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(false, 'Z.AI Coding CN')
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })

  it('enabled=undefined → 不 toast（旧 runtime 版本无该 reply 字段）', () => {
    const { notifyQuotaAutoEnabled } = useQuotaAutoEnableNotice()
    notifyQuotaAutoEnabled(undefined, 'Z.AI Coding CN')
    expect(toastSpyMock.info).not.toHaveBeenCalled()
  })
})

// ======================================================================
// ← useUpdateInstallActions.test.ts
// ======================================================================

describe('useUpdateInstallActions', () => {
  it('onInstallClick：开确认 Dialog，不触发 performInstall', () => {
    const performInstall = vi.fn().mockResolvedValue(undefined)
    const { showConfirmDialog, onInstallClick } = useUpdateInstallActions(performInstall)
    expect(showConfirmDialog.value).toBe(false)
    onInstallClick()
    expect(showConfirmDialog.value).toBe(true)
    expect(performInstall).not.toHaveBeenCalled()
  })

  it('onConfirmInstall：先关 Dialog 再执行 install（顺序契约）', async () => {
    const calls: string[] = []
    const performInstall = vi.fn(async () => {
      calls.push('install')
    })
    const { showConfirmDialog, onConfirmInstall } = useUpdateInstallActions(performInstall)
    showConfirmDialog.value = true
    await onConfirmInstall()
    expect(showConfirmDialog.value).toBe(false)
    expect(performInstall).toHaveBeenCalledTimes(1)
    // 先关后装的顺序由 Dialog 状态迁移契约锁定（避免执行期间弹窗滞留）
    expect(calls).toEqual(['install'])
  })

  it('onLater：仅关 Dialog，不触发 performInstall', () => {
    const performInstall = vi.fn().mockResolvedValue(undefined)
    const { showConfirmDialog, onLater } = useUpdateInstallActions(performInstall)
    showConfirmDialog.value = true
    onLater()
    expect(showConfirmDialog.value).toBe(false)
    expect(performInstall).not.toHaveBeenCalled()
  })

  it('install 失败：Dialog 已先行关闭，异常上抛由调用方消费', async () => {
    const performInstall = vi.fn().mockRejectedValue(new Error('install failed'))
    const { showConfirmDialog, onConfirmInstall } = useUpdateInstallActions(performInstall)
    showConfirmDialog.value = true
    await expect(onConfirmInstall()).rejects.toThrow('install failed')
    expect(showConfirmDialog.value).toBe(false)
  })
})
