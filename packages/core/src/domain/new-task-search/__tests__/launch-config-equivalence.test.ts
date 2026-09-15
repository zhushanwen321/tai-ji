/**
 * [U4] L1 构造性等价守卫 —— 「显示 ≡ 生效」结构锁（设计 state-truth-sync-architecture
 * §3.3 D7-L1；约束登记 C-data-17 的机器载体，参照消息流域 apply-entry-equivalence 先例）。
 *
 * ══════════════════ 结构锁声明（防未来改线回归，C-data-17）══════════════════
 *
 * 本文件锁定的不变量：landing chip 显示值 ≡ resolveLaunchConfig 输出 ≡
 * submitFirstMessage → createSessionFlow 的 create 入参，三段在输入组合矩阵下逐项相等。
 * D1 改线后三者的同源性是构造性的——本测试是这条构造性等价的机器守卫：
 *
 * - 任何让 chip 侧（model-thinking launchConfigView / PresetSelectChip）脱离 resolve
 *   单源的改线（重新给显示链单独兜底、旁路解析）→ 「A ≡ B」断言红；
 * - 任何让 submit 侧（flow.submitFirstMessage）脱离 resolve 的改线（恢复旧
 *   pendingModel 透传、加独立 fallback）→ 「C ≡ B」断言红；
 * - 任何重引入 watch 写记忆 / landing auto 值机制的改动 → grep 结构守卫红。
 *
 * 改线必须先改本测试并在 commit 说明理由——本文件的红即架构决策的显式登记点。
 *
 * ══════════════════ 组成 ══════════════════
 *
 * 1. 三段等价矩阵：pending 有无（pendingModel × authored 档）× lastUsedModel 有无/有效性
 *    × preset 有无（无/默认/显式）× 全局默认有无，全组合（2×2×3×3×2 = 72 格）断言
 *    chip 显示 ≡ resolve 输出 ≡ create 入参。chip 侧 = 真实 useComposerModelThinking
 *    实例（landing 分支 launchConfigView 消费方）+ preset chip 等价视图（U2c
 *    PresetSelectChip 同款 createLaunchConfigView 接线，ui 包不在 core 测试领地）；
 *    create 侧 = 真实 useNewTaskFlow.submitFirstMessage 经 mock ports 捕获
 *    （形态参照 flow.test.ts TC-5）。
 *    [U4r2 破口已修复] round 1 发现 chip 侧 resolve 输入缺 pendingPreset（显式 preset
 *    选择不进显示链，18 格 it.fails 隔离）；本轮补 ModelThinkingDeps.pendingPreset 通道
 *    （壳层从 flow.pendingPreset 只读视图接线）后 D1「pending 三兄弟」两侧齐备，全矩阵
 *    72 格正向绿。未来任何一侧丢失该输入（通道删除/壳层断线）→ 对应矩阵格红。
 * 2. 锚点用例（防「三段相等但全错」的空转等价）：对设计 §2.2/§2.3 全部发散条件
 *    （① lastUsed≠默认不点 chip 直接发送 = 本次 bug / ③ preset 默认 off 档遮蔽记忆 /
 *    显式恒赢 / D4 lastUsed 失效回落）钉具体值——resolve 语义本身的逐档单测在
 *    launch-config.test.ts，此处只锚等价链上的关键分歧点。
 * 3. 窗口语义轻断言（D1/E2）：ensureReady 未完成不 create（占位值不固化）；完成后
 *    create 入参 = 加载后 resolve 输出。完整 P5② 主链路守卫（交接断言、C-W4-3 双
 *    apply 删除断言等）在 flow.test.ts TC-5，此处仅保留结构锁自含所需的最小窗口断言。
 * 4. grep 结构守卫（D7-L1）：node:fs 读 model-thinking.ts 源文本（测试内做，不进
 *    构建脚本）——follow watch / localAuthored 零命中、全部 watch 注册段零 record 族
 *    调用（被删「生效即记录」watch 复发即红）、onThinkingSelect 显式入口仍在记录
 *    且自动对齐路由（routeThinkingLevel）零记录（D2 authored-only 结构前提）。
 *
 * 字段范围说明：等价锁覆盖 model / thinkingLevel / presetId 三字段。cwd 按 D2 现行为
 * 不消费 resolve.cwd（flow.ts：pendingCwd → createSessionFlow ctx.defaultCwd 兜底 →
 * runtime INV-7 降级），不纳入三段等价断言。
 */
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BUILTIN_PRESET_IDS,
  type PiLaunchPreset,
  type ProviderId,
  type ProviderInfo,
  type Segment,
  type SessionSummary,
  type ThinkingLevel,
} from '@taiji/shared'
import { computed, effectScope, nextTick, ref, type ComputedRef, type Ref } from 'vue'
import { useNewTaskFlow } from '../flow'
import { resetNewTaskFlow, useNewTaskFlowState } from '../flow-state'
import {
  resolveLaunchConfig,
  createLaunchConfigView,
  type LaunchConfig,
  type LaunchConfigInput,
} from '../launch-config'
import type { NewTaskFlowDeps } from '../ports'
import { useComposerModelThinking, type ModelThinkingDeps } from '../../composer/model-thinking'
import {
  lookup as lookupMemory,
  record as recordMemory,
  __resetModelThinkingMemoryForTesting,
} from '../../composer/model-thinking-memory'
import {
  lookup as lookupLastUsed,
  record as recordLastUsed,
  __resetLastUsedModelForTesting,
} from '../../composer/last-used-model'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../../../platform/port'

// ── KV / 平台基建（同 launch-config.test.ts / model-thinking.test.ts 形态）─────────

/** 平面 KV stub：两 KV 单例的写穿落点（避免无 platform 时 E2 warn 噪音） */
class MemKV implements KVStorage {
  private map = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
}

function provideMockPlatform(storage: KVStorage): void {
  const port: PlatformPort = {
    kind: 'mock',
    storage,
    webSocket: {
      create: () => {
        throw new Error('stub: WebSocketFactory 未在本测试使用')
      },
    },
  }
  providePlatform(port)
}

// ── fixture ───────────────────────────────────────────────────────────

const FIVE_LEVELS = ['off', 'low', 'medium', 'high', 'max']

/**
 * 能力表（D4 校验 + 档位解析数据源）：prov-a 三模型（lastUsed 目标 / 显式选择目标 /
 * preset override 目标），prov-default 单模型（全局默认）。
 */
function makeProviders(): ProviderInfo[] {
  const models = (ids: string[]) => ids.map((id) => ({ id, supportedLevels: [...FIVE_LEVELS] }))
  return [
    {
      id: 'prov-a' as ProviderId,
      name: 'A',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: models(['model-x', 'model-pick', 'model-preset']),
    },
    {
      id: 'prov-default' as ProviderId,
      name: 'D',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: models(['model-default']),
    },
  ]
}

/** V4 / §2.3-③ 形态：默认预设带 modelOverride + thinkingLevel=off（压过记忆档） */
const P_DEFAULT: PiLaunchPreset = {
  id: 'p-default',
  name: '默认预设',
  builtin: false,
  order: 10,
  toolMode: 'all',
  extensionMode: 'all',
  modelOverride: 'prov-a/model-preset',
  thinkingLevel: 'off',
}

/** 用户显式选定预设：无 modelOverride、thinkingLevel=low */
const P_USER: PiLaunchPreset = {
  id: 'p-user',
  name: '用户预设',
  builtin: false,
  order: 11,
  toolMode: 'all',
  extensionMode: 'all',
  thinkingLevel: 'low',
}

/** 两侧消费的共同数据基座（生产形态：壳层从 preset store / settings store 注入两侧） */
interface LaunchDb {
  presets: readonly PiLaunchPreset[]
  defaultPresetId: string | null
  providers: readonly ProviderInfo[]
  defaultModel: string | null
}

function makeDb(preset: 'none' | 'default' | 'explicit', defaultModel: boolean): LaunchDb {
  return {
    presets:
      preset === 'none' ? [] : preset === 'default' ? [P_DEFAULT] : [P_DEFAULT, P_USER],
    defaultPresetId: preset === 'none' ? null : 'p-default',
    providers: makeProviders(),
    defaultModel: defaultModel ? 'prov-default/model-default' : null,
  }
}

/** 按 'provider/modelId' 复合串查能力表条目的 supportedLevels（无条目 = undefined） */
function supportedLevelsOf(
  modelId: string,
  providers: readonly ProviderInfo[],
): string[] | undefined {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return undefined
  const provider = providers.find((p) => p.id === modelId.slice(0, slash))
  if (!provider || provider.enabled === false) return undefined
  return provider.models.find((m) => m.id === modelId.slice(slash + 1))?.supportedLevels
}

const textSeg = (text: string): Segment => ({ type: 'text', text })
const mockSession = {
  id: 's1',
  cwd: '/tmp/x',
  modelId: 'provider/model',
  label: 'hello',
  createdAt: 0,
  updatedAt: 0,
} as unknown as SessionSummary

/** 微任务排空（窗口断言：ensureReady 未完成时 create 不发生） */
async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** KV 加载落地（mt 挂载触发 loadOnce，宏任务边界后 lookup 可见） */
async function flushKvLoads(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

// ── 等价三方 harness ──────────────────────────────────────────────────

interface EquivalenceHarness {
  flow: ReturnType<typeof useNewTaskFlow>
  /** chip 侧真实消费方（landing 分支 launchConfigView） */
  mt: ReturnType<typeof useComposerModelThinking>
  /** preset chip 等价视图（U2c PresetSelectChip 同款接线：本地 explicitPresetId + 数据基座） */
  explicitPresetId: Ref<string | null>
  presetChipResolved: ComputedRef<LaunchConfig>
  createSession: ReturnType<typeof vi.fn>
  scope: ReturnType<typeof effectScope>
}

/**
 * 组装等价三方：
 * - chip 侧 = useComposerModelThinking（launchData 注入数据基座；currentModel/
 *   setPendingModel 接 flow——生产接线形态 composer-shell.ts:180-181）
 * - submit 侧 = useNewTaskFlow（ports.launchConfig 注入同一数据基座——resolve 输入
 *   经 getInput 现读，pending 三兄弟由 flow 自身覆盖）
 * - KV 双源（lastUsedModel / 记忆表）两侧同读 core 单例（launch-config 同款直接 import）
 */
function mountHarness(
  db: LaunchDb,
  opts: {
    getInput?: () => LaunchConfigInput
    ensureReady?: () => Promise<void>
  } = {},
): EquivalenceHarness {
  const defaultInput = (): LaunchConfigInput => ({
    presets: db.presets,
    defaultPresetId: db.defaultPresetId,
    lastUsedModel: lookupLastUsed() ?? null,
    getRememberedThinkingLevel: (modelId) => lookupMemory(modelId),
    providers: db.providers,
    defaultModel: db.defaultModel,
    getSupportedLevels: (modelId) => supportedLevelsOf(modelId, db.providers),
  })
  const createSession = vi.fn().mockResolvedValue({
    session: mockSession,
    migratedSegments: [textSeg('hi')],
  })
  const deps: NewTaskFlowDeps = {
    ports: {
      createSessionFlow: {
        createSession,
      },
      chat: { send: vi.fn(), sendBash: vi.fn() },
      navigation: {
        activePanelId: vi.fn(() => 'p1'),
        loadPanel: vi.fn(),
        clearActiveSession: vi.fn(),
        setActiveSession: vi.fn(),
        pushChat: vi.fn(),
        defaultCwd: vi.fn(() => '/default'),
      },
      toast: { error: vi.fn(), warning: vi.fn() },
      fileTree: { loadTree: vi.fn(), selectFile: vi.fn() },
      t: vi.fn((key: string) => key),
      migrateImage: { migrateImage: vi.fn() },
    },
    gitApi: { checkout: vi.fn(), checkoutByCwd: vi.fn(), createBranch: vi.fn() },
    directoryPicker: { pickDirectory: vi.fn() },
    workspaceApi: {
      detect: vi.fn().mockResolvedValue({ mode: 'not-repo' }),
      listWorktrees: vi.fn().mockResolvedValue({ items: [] }),
    },
    workspaceState: { defaultCwd: vi.fn(() => '/default'), record: vi.fn() },
  }
  const flow = useNewTaskFlow({
    ...deps,
    ports: {
      ...deps.ports,
      launchConfig: {
        getInput: opts.getInput ?? defaultInput,
        ensureReady: opts.ensureReady ?? (async () => {}),
      },
    },
  })

  const scope = effectScope()
  const explicitPresetId = ref<string | null>(null)
  const mt = scope.run(() => {
    const sessionId = ref<string | null>(null)
    const mtDeps: ModelThinkingDeps = {
      getSessionState: () => null,
      defaultModel: computed(() => db.defaultModel ?? ''),
      // 生产接线（composer-shell）：currentModel ← flow.currentModel，pendingPreset ←
      // flow.pendingPreset 只读视图，setPendingModel → flow
      currentModel: flow.currentModel,
      pendingPreset: () => flow.pendingPreset.value,
      setPendingModel: (model: string) => flow.setPendingModel(model),
      switchModel: vi.fn(),
      setThinkingLevel: vi.fn(),
      getThinkingLevelMap: () => undefined,
      getSupportedLevels: (modelId) => supportedLevelsOf(modelId, db.providers),
      launchData: {
        presets: () => db.presets,
        defaultPresetId: () => db.defaultPresetId,
        providers: () => db.providers,
      },
    }
    return useComposerModelThinking(sessionId, mtDeps)
  })!

  // preset chip 等价视图（U2c PresetSelectChip.vue:92-96 同款：本地 explicitPresetId
  // （resolve 输入）+ emit select → Landing.onPresetSelect → flow.setPendingPreset）
  const presetChipResolved = scope.run(() =>
    createLaunchConfigView(() => ({
      pendingPreset: explicitPresetId.value,
      presets: db.presets,
      defaultPresetId: db.defaultPresetId,
    })),
  )!

  return { flow, mt, explicitPresetId, presetChipResolved, createSession, scope }
}

/** 矩阵格执行器：真实用户路径动作（onModelSelect/onThinkingSelect/setPendingPreset）→ 读 chip → submit */
async function runMatrixCell(cell: {
  pickModel: boolean
  authored: boolean
  lastUsed: 'none' | 'valid' | 'invalid'
  preset: 'none' | 'default' | 'explicit'
  defaultModel: boolean
}): Promise<void> {
  const db = makeDb(cell.preset, cell.defaultModel)
  const h = mountHarness(db)
  try {
    await h.flow.startFlow()
    await flushKvLoads()
    // KV fixtures：lastUsedModel 轴（valid/invalid 均写真实 KV——D4 校验的对象是原值）
    if (cell.lastUsed === 'valid') recordLastUsed('prov-a/model-x')
    if (cell.lastUsed === 'invalid') recordLastUsed('prov-gone/model-z')
    // 记忆表 fixture：lastUsed 目标记忆 high；preset override 目标记忆 max（V4 形态——
    // preset 档 off 与记忆档 max 的发散对）
    recordMemory('prov-a/model-x', 'high')
    recordMemory('prov-a/model-preset', 'max')

    // 用户显式动作（生产路径，顺序：模型 → preset → 档位）
    if (cell.pickModel) {
      await h.mt.onModelSelect({ modelId: 'model-pick', provider: 'prov-a' as ProviderId })
    }
    if (cell.preset === 'explicit') {
      h.explicitPresetId.value = 'p-user'
      h.flow.setPendingPreset('p-user')
    }
    if (cell.authored) await h.mt.onThinkingSelect('low')
    await nextTick()

    // A：chip 显示值（读显示侧真实 computed）
    const chipModel = h.mt.currentModelId.value
    const chipThinking = h.mt.currentThinkingLevel.value ?? ''
    const chipPresetId = h.presetChipResolved.value.presetId

    // 快照 resolve 输入 = submit 侧实际合并形态（launchPort.getInput 基座 + flow pending 覆盖）
    const snapshot: LaunchConfigInput = {
      presets: db.presets,
      defaultPresetId: db.defaultPresetId,
      lastUsedModel: lookupLastUsed() ?? null,
      getRememberedThinkingLevel: (modelId) => lookupMemory(modelId),
      providers: db.providers,
      defaultModel: db.defaultModel,
      getSupportedLevels: (modelId) => supportedLevelsOf(modelId, db.providers),
      pendingModel: useNewTaskFlowState().pendingModel.value,
      // submit 的 thinkingLevel 参数 = localThinkingLevel（生产形态 send.ts:237）
      pendingThinkingLevel: h.mt.localThinkingLevel.value ?? null,
      // 与 submit 侧同读 flow pendingPreset 只读视图（U4r2 通道）
      pendingPreset: h.flow.pendingPreset.value,
      pendingCwd: null,
    }
    const B = resolveLaunchConfig(snapshot)

    // C：create 入参（真实 submitFirstMessage → mock ports 捕获）
    await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)

    // ── 三段等价断言 ──
    expect(h.createSession).toHaveBeenCalledTimes(1)
    // A ≡ B（chip 侧未脱离 resolve 单源）
    expect(chipModel).toBe(B.model)
    expect(chipThinking).toBe(B.thinkingLevel)
    expect(chipPresetId).toBe(B.presetId)
    // C ≡ B（submit 侧未脱离 resolve 单源；'' 全链空防御形态不上线 → null → runtime 全局默认）
    expect(h.createSession).toHaveBeenCalledWith({
      cwd: null,
      presetId: B.presetId ?? null,
      pendingModel: B.model || null,
      segments: [textSeg('hi')],
      bashCommand: null,
      pendingThinkingLevel: B.thinkingLevel as ThinkingLevel,
    })
  } finally {
    h.scope.stop()
  }
}

// ── 1. 三段等价矩阵（全组合 72 格）────────────────────────────────────

interface MatrixCell {
  label: string
  pickModel: boolean
  authored: boolean
  lastUsed: 'none' | 'valid' | 'invalid'
  preset: 'none' | 'default' | 'explicit'
  defaultModel: boolean
}

const MATRIX: MatrixCell[] = []
for (const pickModel of [false, true]) {
  for (const authored of [false, true]) {
    for (const lastUsed of ['none', 'valid', 'invalid'] as const) {
      for (const preset of ['none', 'default', 'explicit'] as const) {
        for (const defaultModel of [true, false]) {
          MATRIX.push({
            label: `pendingModel=${pickModel ? '显式pick' : '无'} · authored档=${authored ? 'low' : '无'} · lastUsed=${lastUsed} · preset=${preset} · 全局默认=${defaultModel ? '有' : '无'}`,
            pickModel,
            authored,
            lastUsed,
            preset,
            defaultModel,
          })
        }
      }
    }
  }
}

describe('L1 等价矩阵 · chip 显示 ≡ resolve 输出 ≡ create 入参（全组合）', () => {
  beforeEach(() => {
    provideMockPlatform(new MemKV())
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  afterEach(() => {
    __resetPlatformForTesting()
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  it.each(MATRIX)('$label', async (cell) => {
    await runMatrixCell(cell)
  })
})

// ── 2. 锚点用例（设计 §2.2/§2.3 发散条件钉具体值，防空转等价）──────────

describe('L1 锚点 · 发散条件具体值（§2.2/§2.3 全覆盖）', () => {
  beforeEach(() => {
    provideMockPlatform(new MemKV())
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  afterEach(() => {
    __resetPlatformForTesting()
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  it('§2.3-① 本次 bug：lastUsed≠全局默认且不点 chip 直接发送 → chip 显示 lastUsed 且 create 携带同一值（不再是 null→runtime 落默认）', async () => {
    const db = makeDb('none', true)
    const h = mountHarness(db)
    try {
      await h.flow.startFlow()
      await flushKvLoads()
      recordLastUsed('prov-a/model-x')
      recordMemory('prov-a/model-x', 'high')
      await nextTick()

      // 显示链：chip 显示 lastUsed（bug 场景的「用户看到的」）
      expect(h.mt.currentModelId.value).toBe('prov-a/model-x')
      // 发送（不点任何 chip）
      await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)

      // 生效链：create 携带解析终值 = lastUsed（旧 bug 形态 = pendingModel null →
      // runtime 落 pi 全局默认 mimo → 对话流显示默认模型，chip≠生效）
      expect(h.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingModel: 'prov-a/model-x',
          pendingThinkingLevel: 'high', // 记忆档（model-x 有 high 记忆）
          presetId: null,
        }),
      )
      // provenance 锚定（lastUsed 档，非默认档）
      const B = resolveLaunchConfig({
        presets: [],
        defaultPresetId: null,
        lastUsedModel: 'prov-a/model-x',
        getRememberedThinkingLevel: (m) => lookupMemory(m),
        providers: db.providers,
        defaultModel: 'prov-default/model-default',
        getSupportedLevels: (m) => supportedLevelsOf(m, db.providers),
        pendingModel: null,
        pendingThinkingLevel: null,
        pendingPreset: null,
      })
      expect(B.modelProvenance).toBe('lastUsed')
      expect(B.thinkingProvenance).toBe('memory')
    } finally {
      h.scope.stop()
    }
  })

  it('§2.3-③/V4：默认预设 thinkingLevel=off + 记忆档 max → chip 显示 off 且 create 生效 off（preset 档优先于记忆档，不再被自动值遮蔽）', async () => {
    const db = makeDb('default', true)
    const h = mountHarness(db)
    try {
      await h.flow.startFlow()
      await flushKvLoads()
      recordLastUsed('prov-a/model-x') // lastUsed 有效——同时锚 preset.modelOverride > lastUsed
      recordMemory('prov-a/model-preset', 'max') // 发散对：记忆 max vs preset off
      await nextTick()

      // 显示：模型/档位均 = preset 捆绑值（off 压过记忆 max——V4 断言）
      expect(h.mt.currentModelId.value).toBe('prov-a/model-preset')
      expect(h.mt.currentThinkingLevel.value).toBe('off')
      // preset chip 等价视图显示默认预设
      expect(h.presetChipResolved.value.presetId).toBe('p-default')

      await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
      expect(h.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingModel: 'prov-a/model-preset',
          pendingThinkingLevel: 'off',
          presetId: 'p-default',
        }),
      )
    } finally {
      h.scope.stop()
    }
  })

  it('显式恒赢：pendingModel + authored 档 + 显式 preset 并存 → 三字段均 explicit 档（赢过 preset 捆绑与 lastUsed）', async () => {
    const db = makeDb('explicit', true)
    const h = mountHarness(db)
    try {
      await h.flow.startFlow()
      await flushKvLoads()
      recordLastUsed('prov-a/model-x')
      recordMemory('prov-a/model-preset', 'max')
      await h.mt.onModelSelect({ modelId: 'model-pick', provider: 'prov-a' as ProviderId })
      h.explicitPresetId.value = 'p-user'
      h.flow.setPendingPreset('p-user')
      await h.mt.onThinkingSelect('low')
      await nextTick()

      expect(h.mt.currentModelId.value).toBe('prov-a/model-pick')
      expect(h.mt.currentThinkingLevel.value).toBe('low')
      expect(h.presetChipResolved.value.presetId).toBe('p-user')

      await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
      expect(h.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          pendingModel: 'prov-a/model-pick',
          pendingThinkingLevel: 'low',
          presetId: 'p-user',
        }),
      )
    } finally {
      h.scope.stop()
    }
  })

  it('D4 失效回落：lastUsedModel 指向能力表外死模型 → chip 与 create 均落全局默认，KV 原值保留不覆写', async () => {
    const db = makeDb('none', true)
    const h = mountHarness(db)
    try {
      await h.flow.startFlow()
      await flushKvLoads()
      recordLastUsed('prov-gone/model-z')
      await nextTick()

      // 显示：不显示死模型，静默回落全局默认（D4）
      expect(h.mt.currentModelId.value).toBe('prov-default/model-default')

      await h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
      expect(h.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ pendingModel: 'prov-default/model-default' }),
      )
      // KV 非破坏性跳过：原值保留（provider 恢复后用户选择自动回来的前提）
      expect(lookupLastUsed()).toBe('prov-gone/model-z')
    } finally {
      h.scope.stop()
    }
  })
})

// ── 3. 窗口语义轻断言（D1/E2；主守卫在 flow.test.ts TC-5，见文件头声明）──

describe('L1 窗口语义（D1/E2）· ensureLaunchDataReady 门闩', () => {
  beforeEach(() => {
    provideMockPlatform(new MemKV())
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  afterEach(() => {
    __resetPlatformForTesting()
    resetNewTaskFlow()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  it('ensureReady 未完成 → 不 create（加载窗口占位值不固化）；完成后 create 入参 = 加载后 resolve 输出', async () => {
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let presetsLoaded = false
    const db = makeDb('none', true)
    // 占位/终值两态数据：加载前 preset store 空（preset 档不可达），加载后默认预设生效
    const getInput = (): LaunchConfigInput => ({
      presets: presetsLoaded ? [P_DEFAULT] : [],
      defaultPresetId: presetsLoaded ? 'p-default' : null,
      lastUsedModel: lookupLastUsed() ?? null,
      getRememberedThinkingLevel: (m) => lookupMemory(m),
      providers: db.providers,
      defaultModel: db.defaultModel,
      getSupportedLevels: (m) => supportedLevelsOf(m, db.providers),
    })
    const h = mountHarness(db, {
      getInput,
      ensureReady: () => gate.then(() => {
        presetsLoaded = true
      }),
    })
    try {
      await h.flow.startFlow()
      await flushKvLoads()
      recordLastUsed('prov-a/model-x')
      await nextTick()

      const pending = h.flow.submitFirstMessage([textSeg('hi')], h.mt.localThinkingLevel.value)
      // 门闩：ensureReady 未完成 → create 不发生（若未 await 就 resolve，会把加载前的
      // 占位解析值——lastUsed 档 model-x——固化进新 session）
      await flushMicrotasks()
      expect(h.createSession).not.toHaveBeenCalled()

      openGate()
      await pending

      // create 入参 = 加载后 resolve 输出：默认预设 p-default 生效（modelOverride 压过
      // lastUsed 档），≠ 加载前占位解析值（model-x）——占位不固化
      expect(h.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          presetId: 'p-default',
          pendingModel: 'prov-a/model-preset',
        }),
      )
      expect(h.createSession).not.toHaveBeenCalledWith(
        expect.objectContaining({ pendingModel: 'prov-a/model-x' }),
      )
    } finally {
      h.scope.stop()
    }
  })
})

// ── 4. grep 结构守卫（D7-L1：测试内源码文本扫描，不进构建脚本）─────────

const MODEL_THINKING_SRC = readFileSync(
  new URL('../../composer/model-thinking.ts', import.meta.url),
  'utf8',
)

/**
 * 源文本（保长度）剥注释：行/块注释替换为等长空白——索引不漂移，且注释里的
 * "record"/"watch(" 字样不参与结构判定（防注释措辞误伤结构守卫）。
 * 已知边界（可接受）：字符串字面量内的 "//"（如 URL）会被误剥——本文件无此形态；
 * 守卫红时先核对源码再更新结构锁。
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
  return out
}

/** 提取 openIdx 处 '(' 或 '{' 起的平衡段（跳过字符串字面量；注释已由 stripComments 剥除）。 */
function extractBalanced(code: string, openIdx: number): string {
  const open = code[openIdx]!
  const close = open === '(' ? ')' : '}'
  let depth = 0
  let i = openIdx
  while (i < code.length) {
    const ch = code[i]!
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      i++
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') i++
        i++
      }
      i++
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return code.slice(openIdx, i + 1)
    }
    i++
  }
  throw new Error('extractBalanced: 源码括号不平衡（结构守卫扫描器异常，先核对源码）')
}

/** 提取指定函数的完整定义段（签名定位 → 参数表 → 函数体花括号平衡段）。 */
function functionSpan(code: string, name: string): string {
  const sigRe = new RegExp(`function\\s+${name}\\s*\\(`)
  const sig = sigRe.exec(code)
  if (!sig) throw new Error(`grep 守卫：model-thinking.ts 缺少函数 ${name}（结构锁需先更新本测试）`)
  const params = extractBalanced(code, code.indexOf('(', sig.index))
  const bodyOpen = code.indexOf('{', sig.index + params.length - 1)
  return extractBalanced(code, bodyOpen)
}

/** 提取全部顶层 watch( 调用段（含回调体）。 */
function watchSpans(code: string): string[] {
  const spans: string[] = []
  const re = /(?<![A-Za-z0-9_$.])watch\s*\(/g
  for (let m = re.exec(code); m; m = re.exec(code)) {
    spans.push(extractBalanced(code, code.indexOf('(', m.index)))
  }
  return spans
}

describe('grep 结构守卫 · 记录路径 authored-only（D2/D7-L1）', () => {
  // 剥注释后的源码：结构判定只看可执行代码，注释措辞不误伤
  const code = stripComments(MODEL_THINKING_SRC)

  it('landing auto 值机制零残留：followRememberedOrDefault / localAuthored 无命中（U2a 删除项复发即红）', () => {
    expect(code).not.toMatch(/followRememberedOrDefault/)
    expect(code).not.toMatch(/localAuthored/)
  })

  it('记录路径结构性无 watch：全部 watch 注册段零 record 族调用（「生效即记录」watch 复发即红）', () => {
    const spans = watchSpans(code)
    // 扫描器健全性：至少存在换绑清 armed 的合法 watch（若零命中说明扫描器失效=守卫空转）
    expect(spans.length).toBeGreaterThanOrEqual(1)
    for (const span of spans) {
      // watch 内任何 record 族调用（record / recordAuthoredThinking / recordLastUsed）
      // 都是「非显式选择写入 KV」通道——记忆污染（D2 被否③）或 lastUsed 污染
      expect(span).not.toMatch(/record/)
    }
  })

  it('onThinkingSelect 显式入口正常入表：recordAuthoredThinking 调用在入口体内，且全文件仅此一个调用点', () => {
    const onSpan = functionSpan(code, 'onThinkingSelect')
    // 入口仍在（U2a 后唯一记录点）
    expect(onSpan).toMatch(/recordAuthoredThinking\s*\(/)
    // 全文件 recordAuthoredThinking( 出现次数 = 定义签名 1 + onThinkingSelect 调用 1
    // （出现第三处 = 新增了绕过用户入口的记录通道）
    const total = code.match(/recordAuthoredThinking\s*\(/g)?.length ?? 0
    expect(total).toBe(2)
  })

  it('直接 record( 写点唯一在 recordAuthoredThinking 体内；自动对齐路由 routeThinkingLevel 零记录', () => {
    // record( 不匹配 recordLastUsed( / recordAuthoredThinking(（后随字符非 '('）
    const directCalls = [...code.matchAll(/(?<![A-Za-z0-9_$])record\s*\(/g)]
    // 非空守卫：零命中 = 写点被移走/改名，结构锁需先更新
    expect(directCalls.length).toBeGreaterThanOrEqual(1)
    const recordSpan = functionSpan(code, 'recordAuthoredThinking')
    const rel = code.indexOf(recordSpan)
    expect(rel).toBeGreaterThanOrEqual(0)
    for (const call of directCalls) {
      const idx = call.index ?? -1
      // 直接写点必须落在 recordAuthoredThinking 定义段内
      expect(idx).toBeGreaterThanOrEqual(rel)
      expect(idx).toBeLessThanOrEqual(rel + recordSpan.length)
    }
    // 自动对齐走 routeThinkingLevel（非用户入口）——零记录（authored-only 结构前提）
    const routeSpan = functionSpan(code, 'routeThinkingLevel')
    expect(routeSpan).not.toMatch(/record/)
  })
})
