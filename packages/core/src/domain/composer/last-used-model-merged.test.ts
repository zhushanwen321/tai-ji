// last-used-model-merged.test.ts —— core C22 簇合并产物（round5-G）。
// 共同被测业务模块：`src/domain/composer/last-used-model.ts`、`src/domain/composer/model-thinking-memory.ts`、`src/platform/port.ts`。mock 相容：全簇零 vi.mock。
// 顶层正文按来源包 describe 纯前缀分节，it 层名零改动。
//
// 来源：
//   - src/domain/composer/model-thinking.test.ts（63 用例，skip 0）
//   - src/domain/new-task-search/launch-config.test.ts（58 用例，skip 0）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DEFAULT_PRESETS, type PiLaunchPreset, type ProviderId, type ProviderInfo, BUILTIN_PRESET_IDS } from '@taiji/shared'
import { computed, effectScope, nextTick, ref, type Ref } from 'vue'
import { useComposerModelThinking, type ModelThinkingDeps } from './model-thinking'
import { MODEL_THINKING_MEMORY_KEY, __resetModelThinkingMemoryForTesting, lookup, record } from './model-thinking-memory'
import { record as recordLastUsed, lookup as lookupLastUsed, __resetLastUsedModelForTesting, LAST_USED_MODEL_KEY, loadOnce as loadLastUsedOnce } from './last-used-model'
import { resolveThinkingValue } from './thinking-levels'
import { providePlatform, __resetPlatformForTesting, type KVStorage, type PlatformPort } from '../../platform/port'
import { resolveLaunchConfig, isFactoryFullPreset, launchFieldEquals, createLaunchConfigView, ensureLaunchDataReady, PRESET_LAUNCH_KEYS, type LaunchConfigInput, type LaunchDataSource } from '../new-task-search/launch-config'

// ======== 来源：model-thinking.test.ts ========
describe("model-thinking", () => {
  type Spy = ReturnType<typeof vi.fn>

  interface DepsSpies { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    getSessionState: Spy
    setPendingModel: Spy
    switchModel: Spy
    setThinkingLevel: Spy
    getSupportedLevels: Spy
  }

  function makeDeps(opts: {
    sessionState?: { modelId: string; thinkingLevel?: string } | null
    currentModel?: string | null
    defaultModel?: string
    thinkingLevelMap?: Record<string, string | null>
    /** U6 切源：档位可用集（缺省 undefined → 归一默认五档，与旧断言兼容） */
    supportedLevels?: string[]
    /** [U2a] launchData.providers 能力表注入（resolve D4 校验 + 记忆档 map 派生） */
    providers?: ProviderInfo[]
  } = {}): { deps: ModelThinkingDeps; spies: DepsSpies } {
    const getSessionState = vi.fn(() => opts.sessionState ?? null)
    const setPendingModel = vi.fn()
    const switchModel = vi.fn().mockResolvedValue(undefined)
    const setThinkingLevel = vi.fn().mockResolvedValue(undefined)
    const getSupportedLevels = vi.fn(() => opts.supportedLevels)
    const deps: ModelThinkingDeps = {
      getSessionState,
      defaultModel: computed(() => opts.defaultModel ?? 'provider-D/model-D'),
      currentModel: computed(() => opts.currentModel ?? null),
      setPendingModel,
      switchModel,
      setThinkingLevel,
      getThinkingLevelMap: vi.fn(() => opts.thinkingLevelMap),
      getSupportedLevels,
      launchData: opts.providers
        ? { providers: () => opts.providers }
        : undefined,
    }
    return { deps, spies: { getSessionState, setPendingModel, switchModel, setThinkingLevel, getSupportedLevels } }
  }

  /** 包裹 useComposerModelThinking 在 effectScope 内（用完 stop 清理 watch） */
  function mount(
    sid: string | null,
    opts: Parameters<typeof makeDeps>[0] = {},
  ): { result: ReturnType<typeof useComposerModelThinking>; spies: DepsSpies; scope: ReturnType<typeof effectScope> } {
    const { deps, spies } = makeDeps(opts)
    const sessionId = ref(sid)
    const scope = effectScope()
    const result = scope.run(() => useComposerModelThinking(sessionId, deps))!
    return { result, spies, scope }
  }

  // ══════════ [u3] 记忆恢复套件公共基建 ══════════

  /** 平面 KV stub：u1 memory 模块写穿落点（避免无 platform 时 E2 warn 噪音） */
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

  /**
 * 可控时序 KV：closeGate 挂起 get、openGateNow 放行——控制 u1 预载完成时刻
 * （P2 晚到补写场景：跟随落在 KV 加载前 → 加载完成回调补一次重设，E7②）。
 * initialTable 预置在权威 key 下的整表数据。
 */
  class GatedKV extends MemKV {
    private gate: Promise<void> | null = null
    private open: (() => void) | null = null
    private raw: string | null
    constructor(initialTable?: Record<string, string>) {
      super()
      this.raw = initialTable ? JSON.stringify(initialTable) : null
      if (initialTable) void this.set(MODEL_THINKING_MEMORY_KEY, this.raw!)
    }
    closeGate(): void {
      this.gate = new Promise((resolve) => {
        this.open = resolve
      })
    }
    openGateNow(): void {
      this.open?.()
      this.open = null
    }
    override async get(key: string): Promise<string | null> {
      if (this.gate) await this.gate
      return super.get(key)
    }
  }

  function provideMockPlatform(storage: KVStorage): void {
    const port: PlatformPort = {
      kind: 'mock',
      storage,
      // 本文件只走 storage 端口；webSocket 被触达即测试写错，抛错暴露
      webSocket: {
        create: () => {
          throw new Error('stub: WebSocketFactory 未在本测试使用')
        },
      },
    }
    providePlatform(port)
  }

  // u1 memory 是模块级单例（KV 经 platform 注入）——每用例重置模块态 + 干净 KV，
  // 避免跨用例记忆泄漏；既有用例的 record 写穿也由此落到内存 KV（无 E2 warn 噪音）
  beforeEach(() => {
    provideMockPlatform(new MemKV())
    __resetModelThinkingMemoryForTesting()
    __resetLastUsedModelForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetPlatformForTesting()
    __resetModelThinkingMemoryForTesting()
    __resetLastUsedModelForTesting()
  })

  /**
 * 同内容异身份 map 工厂：identity 变化触发 sync watch（观察源按 Object.is 比较），
 * 内容恒等使既有对齐分支天然静默（同体系 + value 不变 → 不发 RPC）——
 * 「是否有恢复 onReset」因此可被干净断言（恢复是唯一会调 setThinkingLevel 的路径）。
 */
  const sameContentMap = () => ({ off: 'o', low: 'l', medium: 'm', high: 'h' })

  const fourLevels = ['off', 'low', 'medium', 'high']

  /** switchModel 手动可控调用：applyAndResolve 模拟壳层「applyLiveState（壳层回执写状态层）同步执行 + RPC resolve」时序 */
  interface SwitchCall { // oe-exempt:20261027:test:测试夹具接口（合并产物内多节共用的 mock 形状契约）
    provider: string
    modelId: string
    /**
   * 先同步 applyLiveState(生效模型)（壳层回执写状态层；watch flush 微任务在此入队）再 resolve（await 续段
   * 后入队）——对齐 D3 证据②时序：flush 总是先于 onModelSelect 的规则 5 续段。
   */
    applyAndResolve: (effectiveModelId: string) => void
    reject: (err: unknown) => void
  }

  /**
 * armed/记忆套件 harness：响应式 sessionState / defaultModel / currentModel / providers
   * （既有 makeDeps 的 vi.fn 闭包非响应式，无法模拟 applyLiveState（壳层回执写状态层）/ defaultModel 晚到 /
 * providers 刷新——这些恰是 armed 序列族的驱动源）。
 */
  function mountMem(opts: {
    sid?: string | null
    session?: { modelId: string; thinkingLevel?: string } | null
    defaultModel?: string
    currentModel?: string | null
    maps?: Record<string, Record<string, string | null>>
    supported?: Record<string, string[]>
    /**
   * [Gate B] 生产保真 setThinkingLevel：默认 no-op mock 不写 store，无法驱动「恢复回包
   * applyLiveState({thinkingLevel})（壳层回执写状态层）」的第二次 store 写——而跨写污染恰发生在 switchModel
   * 回包（写 modelId）与恢复回包（写 level）两次 store 写之间的 flush 上。true 时改为
   * 可控 promise，resolveReply() 模拟回包：先 applyLiveState 写状态层再 resolve（与
   * useModel.setThinkingLevel 的「await RPC → applyLiveState → resolve」序列同构）。
   */
    realisticSetLevel?: boolean
    /** [U2a] launchData.presets 注入（resolve preset 档显示） */
    launchPresets?: readonly PiLaunchPreset[]
    /** [U2a] launchData.defaultPresetId 注入（undefined = 不注入字段） */
    launchDefaultPresetId?: string | null
    /** [U4r2] deps.pendingPreset 通道注入（flow 显式选定 preset；undefined = 不注入字段） */
    launchPendingPreset?: string | null
  } = {}) {
    const sessionRef = ref<{ modelId: string; thinkingLevel?: string } | null>(opts.session ?? null)
    const defaultModelRef = ref(opts.defaultModel ?? '')
    const currentModelRef = ref<string | null>(opts.currentModel ?? null)
    const providersRef = ref<Record<string, Record<string, string | null>>>(opts.maps ?? {})
    const supportedRef = ref<Record<string, string[]>>(opts.supported ?? {})
    const pending: SwitchCall[] = []
    const switchModel = vi.fn(
      (_sid: string, provider: string, modelId: string) =>
        new Promise<void>((resolve, reject) => {
          pending.push({
            provider,
            modelId,
            applyAndResolve: (effective: string) => {
              sessionRef.value = {
                modelId: effective,
                thinkingLevel: sessionRef.value?.thinkingLevel,
              }
              resolve()
            },
            reject,
          })
        }),
    )
    const setLevelCalls: Array<{ level: string; resolveReply: () => void }> = []
    const setThinkingLevel = opts.realisticSetLevel
      ? vi.fn((_sid: string, level: string) =>
          new Promise<void>((resolve) => {
            setLevelCalls.push({
              level,
              // 生产保真（useModel.setThinkingLevel 时序）：回包 → applyLiveState({thinkingLevel}) → resolve
              resolveReply: () => {
                sessionRef.value = { modelId: sessionRef.value!.modelId, thinkingLevel: level }
                resolve()
              },
            })
          }),
        )
      : vi.fn().mockResolvedValue(undefined)
    // [R2-fix-2] 生产保真：flow.setPendingModel 是同步 ref 写（flow.ts:366-369），经
    // pendingModel → currentModel → currentModelId 同步 computed 传播——no-op mock 会
    // 掩盖「写后读」时序类回归（R2-fix-1 教训）。vi.fn 包真实写，保留调用断言能力。
    const setPendingModel = vi.fn((m: string) => {
      currentModelRef.value = m
    })
    // [U2a] launchData 注入：providers 能力表从 maps/supported refs 派生（响应式 getter，
    // 'p/X' 复合串拆 provider/model——maps 的 ref 名为 providersRef，见上方声明），preset
    // 数据按 opts 注入——landing 显示的 resolve 输入与 getThinkingLevelMap/getSupportedLevels
    // 同源，模拟壳层双通道一致接线
    const launchData: NonNullable<ModelThinkingDeps['launchData']> = {
      providers: () => {
        const byProvider = new Map<
          string,
          Array<{ id: string; thinkingLevelMap?: Record<string, string | null>; supportedLevels?: string[] }>
        >()
        for (const compound of new Set([...Object.keys(providersRef.value), ...Object.keys(supportedRef.value)])) {
          const slash = compound.indexOf('/')
          if (slash <= 0) continue
          const pid = compound.slice(0, slash)
          const mid = compound.slice(slash + 1)
          if (!mid) continue
          const list = byProvider.get(pid) ?? []
          list.push({
            id: mid,
            thinkingLevelMap: providersRef.value[compound],
            supportedLevels: supportedRef.value[compound],
          })
          byProvider.set(pid, list)
        }
        return Array.from(byProvider.entries()).map(([id, models]) => ({
          id: id as ProviderId,
          name: id,
          apiKeySet: true,
          status: 'connected' as const,
          models,
        }))
      },
      ...(opts.launchPresets ? { presets: () => opts.launchPresets } : {}),
      ...(opts.launchDefaultPresetId !== undefined
        ? { defaultPresetId: () => opts.launchDefaultPresetId }
        : {}),
    }
    const deps: ModelThinkingDeps = {
      getSessionState: () => (sessionRef.value ? { ...sessionRef.value } : null),
      defaultModel: computed(() => defaultModelRef.value),
      currentModel: computed(() => currentModelRef.value),
      // [U4r2] flow 显式选定 preset 读通道（壳层接线形态：pendingPreset getter）
      ...(opts.launchPendingPreset !== undefined
        ? { pendingPreset: () => opts.launchPendingPreset }
        : {}),
      setPendingModel,
      switchModel,
      setThinkingLevel,
      getThinkingLevelMap: (id: string) => providersRef.value[id],
      getSupportedLevels: (id: string) => supportedRef.value[id],
      launchData,
    }
    const sessionId = ref<string | null>(opts.sid ?? null)
    const scope = effectScope()
    const result = scope.run(() => useComposerModelThinking(sessionId, deps))!
    return {
      result,
      sessionId,
      sessionRef,
      defaultModelRef,
      currentModelRef,
      providersRef,
      switchModel,
      setThinkingLevel,
      setLevelCalls,
      setPendingModel,
      pending,
      scope,
    }
  }

  /** 刷新某模型 map 的 identity（内容不变）——模拟 providers 数组刷新触发的无关 watch 回调 */
  function refreshProviderIdentity(
    providersRef: Ref<Record<string, Record<string, string | null>>>,
    modelId: string,
  ): void {
    providersRef.value = { ...providersRef.value, [modelId]: { ...providersRef.value[modelId] } }
  }

  describe('useComposerModelThinking · currentModelId 派生', () => {
    it('session 已建 → 读 sessionState.modelId', () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      expect(result.currentModelId.value).toBe('provider-A/model-A')
      scope.stop()
    })

    it('landing + currentModel 有值 → 读 currentModel', () => {
      const { result, scope } = mount(null, { currentModel: 'provider-F/model-F' })
      expect(result.currentModelId.value).toBe('provider-F/model-F')
      scope.stop()
    })

    it('landing + currentModel null → 读 defaultModel', () => {
      const { result, scope } = mount(null)
      expect(result.currentModelId.value).toBe('provider-D/model-D')
      scope.stop()
    })

    it('session.modelId 空串（磁盘/已退出 session）→ D3 占位不回落 defaultModel', () => {
      // 空串场景：广播里已退出 session 的 modelId 硬编码为 ''。D3 已建态空值→占位，不兜底
      const { result, scope } = mount('s1', {
        sessionState: { modelId: '' },
        defaultModel: 'provider-D/model-D',
      })
      expect(result.currentModelId.value).toBe('')
      scope.stop()
    })
  })

  describe('useComposerModelThinking · currentSupportedLevels 派生（U6 切源）', () => {
    it('读 deps.getSupportedLevels(currentModelId)，未下发时 undefined（归一默认五档）', () => {
      const { result, scope, spies } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
        supportedLevels: ['off', 'high'],
      })
      expect(result.currentSupportedLevels.value).toEqual(['off', 'high'])
      expect(spies.getSupportedLevels).toHaveBeenCalledWith('provider-A/model-A')
      scope.stop()
    })

    it('未注入值（undefined）→ currentSupportedLevels 为 undefined，下游归一默认五档', () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      expect(result.currentSupportedLevels.value).toBeUndefined()
      scope.stop()
    })
  })

  describe('useComposerModelThinking · currentThinkingLevel 派生', () => {
    it('session 已建 → 读 sessionState.thinkingLevel', () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      expect(result.currentThinkingLevel.value).toBe('high')
      scope.stop()
    })

    it('landing 态 → currentThinkingLevel 读 resolve 输出（无 authored → default 档最高可用档；authored 后 explicit 档）', () => {
      const { result, scope } = mount(null)
      // [U2a] 未 authored：localThinkingLevel undefined → resolve default 档 = 最高可用档
      //（无 supportedLevels 注入归一默认五档 → 'high'）；显示值不写入 localThinkingLevel
      expect(result.currentThinkingLevel.value).toBe('high')
      expect(result.localThinkingLevel.value).toBeUndefined()
      // authored（直接写 ref 模拟 onThinkingSelect 落值）→ resolve explicit 档直读
      result.localThinkingLevel.value = 'medium'
      expect(result.currentThinkingLevel.value).toBe('medium')
      scope.stop()
    })
  })

  describe('useComposerModelThinking · per-session 隔离（split panel bug 回归）', () => {
    it('两实例传不同 sessionId → getSessionState 按 id 查，各读各的 modelId', () => {
      const { result: c1, scope: sc1 } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      const { result: c2, scope: sc2 } = mount('s2', {
        sessionState: { modelId: 'provider-B/model-B', thinkingLevel: 'xhigh' },
      })
      expect(c1.currentModelId.value).toBe('provider-A/model-A')
      expect(c1.currentThinkingLevel.value).toBe('high')
      expect(c2.currentModelId.value).toBe('provider-B/model-B')
      expect(c2.currentThinkingLevel.value).toBe('xhigh')
      sc1.stop()
      sc2.stop()
    })
  })

  describe('useComposerModelThinking · onModelSelect 三分支', () => {
    it('staging 活跃 → 只写快照，不调 switchModel/setPendingModel', async () => {
      const { result, spies, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      result.enterStagingMode()
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      expect(result.currentModelId.value).toBe('provider-C/model-C')
      expect(spies.switchModel).not.toHaveBeenCalled()
      expect(spies.setPendingModel).not.toHaveBeenCalled()
      scope.stop()
    })

    it('landing 态（sessionId=null）→ 记 pendingModel', async () => {
      const { result, spies, scope } = mount(null)
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      expect(spies.setPendingModel).toHaveBeenCalledWith('provider-C/model-C')
      expect(spies.switchModel).not.toHaveBeenCalled()
      scope.stop()
    })

    it('已建态 → 调 switchModel(sessionId, provider, modelId)', async () => {
      const { result, spies, scope } = mount('s2', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      expect(spies.switchModel).toHaveBeenCalledWith('s2', 'provider-C', 'model-C')
      scope.stop()
    })
  })

  describe('useComposerModelThinking · onThinkingSelect 三分支（含 authored-only 记录）', () => {
    it('staging 活跃 → 只写快照；记录归属暂存快照模型（刻意反转：试选留痕）', async () => {
      const { result, spies, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      result.enterStagingMode()
      await result.onThinkingSelect('medium')
      expect(result.currentThinkingLevel.value).toBe('medium')
      expect(spies.setThinkingLevel).not.toHaveBeenCalled()
      // [U2a/D2] 记录发生在选择时刻，归属 = staging 快照模型（取消暂存也留痕）
      expect(lookup('provider-A/model-A')).toBe('medium')
      scope.stop()
    })

    it('landing 态 → 记 localThinkingLevel；记录归属 resolve 当时选中模型（默认档）', async () => {
      const { result, spies, scope } = mount(null)
      spies.setThinkingLevel.mockClear()
      await result.onThinkingSelect('low')
      expect(result.localThinkingLevel.value).toBe('low')
      expect(spies.setThinkingLevel).not.toHaveBeenCalled()
      // 无 currentModel/lastUsed → resolve 选中模型 = defaultModel（provider-D/model-D）
      expect(lookup('provider-D/model-D')).toBe('low')
      scope.stop()
    })

    it('已建态 → 调 setThinkingLevel(sessionId, level)；记录归属 session 当前模型', async () => {
      const { result, spies, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      spies.setThinkingLevel.mockClear()
      await result.onThinkingSelect('medium')
      expect(spies.setThinkingLevel).toHaveBeenCalledWith('s1', 'medium')
      expect(lookup('provider-A/model-A')).toBe('medium')
      scope.stop()
    })
  })

  describe('useComposerModelThinking · Staging Mode（ADR-0056）', () => {
    it('enterStagingMode：currentModelId/currentThinkingLevel 读快照，后续 onModelSelect/onThinkingSelect 走 staging 分支', async () => {
      const { result, spies, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      result.enterStagingMode()
      // 快照初值直断言：源 enterStagingMode 为「先快照 stagingThinking 再置 stagingModel」——
      // stagingModel 置位后两个 computed 才切读 staging 分支，故读到的都是切换前的常规态原值，
      // 快照初值可直接断言（若回退为反序，thinking 快照会落 undefined，见下一用例检查）
      expect(result.currentModelId.value).toBe('provider-A/model-A')
      expect(result.currentThinkingLevel.value).toBe('high')
      // staging 活跃：onModelSelect 写快照，不调 RPC
      await result.onModelSelect({ modelId: 'model-B', provider: 'provider-B' as ProviderId })
      expect(result.currentModelId.value).toBe('provider-B/model-B')
      expect(spies.switchModel).not.toHaveBeenCalled()
      // staging 活跃：onThinkingSelect 写快照，不调 RPC
      spies.setThinkingLevel.mockClear()
      await result.onThinkingSelect('xhigh')
      expect(result.currentThinkingLevel.value).toBe('xhigh')
      expect(spies.setThinkingLevel).not.toHaveBeenCalled()
      scope.stop()
    })

    it('enterStagingMode 快照直断言：快照初值即原值（先快照后切换，防反序回退）', () => {
      // 反序回退检查：旧顺序「先置 stagingModel 再读 currentThinkingLevel」下，stagingModel
      // 置位后 currentThinkingLevel computed 即切读 staging 分支，读到尚未赋值的
      // stagingThinking（undefined）写进快照——此断言在旧顺序下必红
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'p/m1', thinkingLevel: 'h' },
      })
      result.enterStagingMode()
      expect(result.currentThinkingLevel.value).toBe('h')
      expect(result.currentModelId.value).toBe('p/m1')
      scope.stop()
    })

    it('exitStagingMode 清空快照，chip 恢复读常规态真值', async () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      result.enterStagingMode()
      await result.onModelSelect({ modelId: 'model-B', provider: 'provider-B' as ProviderId })
      result.exitStagingMode()
      // 退出暂存 → currentModelId/currentThinkingLevel 恢复读常规态（源 session 真值）
      expect(result.currentModelId.value).toBe('provider-A/model-A')
      expect(result.currentThinkingLevel.value).toBe('high')
      scope.stop()
    })

    it('getStagingConfig：常规态返回空对象；暂存态导出快照', async () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      // 常规态：无暂存
      expect(result.getStagingConfig()).toEqual({})
      // 进入暂存 + 改快照
      result.enterStagingMode()
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      await result.onThinkingSelect('xhigh')
      expect(result.getStagingConfig()).toEqual({
        modelOverride: 'provider-C/model-C',
        thinkingOverride: 'xhigh',
      })
      // 退出暂存 → 空配置
      result.exitStagingMode()
      expect(result.getStagingConfig()).toEqual({})
      scope.stop()
    })
  })

  // ══════════ [u3] armed 序列族（设计 §3.3 探针表第 1 行，D3 六防线设立侧）══════════
  //
  // 断言策略：armed 是内部状态，全部经行为序列断言——记忆恢复是「同内容异身份 map」下
  // 唯一会调 setThinkingLevel 的路径（既有对齐分支静默），故「恢复 RPC 是否发出」即
  // token 设立/保留/消费/清除的可观测派生视图。预置记忆用真实 u1 record()。
  // 已建态基线：s1 =（p/X，'h'），X/Y/Z 同体系（sameContentMap 异身份 + fourLevels）。
  function mountArmedBaseline() {
    return mountMem({
      sid: 's1',
      session: { modelId: 'p/X', thinkingLevel: 'h' },
      maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap(), 'p/Z': sameContentMap() },
      supported: { 'p/X': fourLevels, 'p/Y': fourLevels, 'p/Z': fourLevels },
    })
  }

  describe('useComposerModelThinking · armed 序列族（D3 六防线）', () => {
    it('S1/(a) RPC 失败 → 规则 4 清自己 token；换绑到同模型 session 不误恢复', async () => {
      const h = mountArmedBaseline()
      record('p/Y', 'low') // 恢复值 'l'——若失败 token 残留，换绑后会以 'l' 伪恢复
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      h.pending[0].reject(new Error('rpc fail'))
      await expect(p).rejects.toThrow('rpc fail')
      // 换绑到 s2（模型恰为 armed 目标 Y，档位 'm'）——armed 已被规则 4 清除，不得恢复
      h.sessionId.value = 's2'
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
      await nextTick()
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      h.scope.stop()
    })

    it('S2/(b) 并发连切重叠窗口：第一调用成功清不误清后来者 token，恢复只发生在第二调用目标', async () => {
      const h = mountArmedBaseline()
      record('p/Y', 'low') // Y 的恢复值 'l'
      record('p/Z', 'medium') // Z 的恢复值 'm'——两值区分「哪个 token 消费了」
      const p1 = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      const p2 = h.result.onModelSelect({ modelId: 'Z', provider: 'p' as ProviderId }) // armed 覆盖为 Z（所有权转移）
      // 第一调用回包（生效 Y）：armed={Z} 不匹配 → 规则 3 保留；规则 5 只清 id1 → 不误清 Z
      h.pending[0].applyAndResolve('p/Y')
      await p1
      expect(h.setThinkingLevel).not.toHaveBeenCalled() // Y 的恢复未发生（token 已是 Z 的）
      // 第二调用回包（生效 Z）：Z token 存活至自己的回包 → 匹配消费恢复
      h.pending[1].applyAndResolve('p/Z')
      await p2
      expect(h.setThinkingLevel).toHaveBeenCalledTimes(1)
      expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'm') // Z 的记忆值，非 Y 的 'l'
      h.scope.stop()
    })

    it("S3/(b') providers 刷新触发无关回调 → 规则 3 保留 token，恢复不丢失", async () => {
      const h = mountArmedBaseline()
      record('p/Y', 'low')
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId }) // RPC 在途，armed={Y}
      // runtime 推 config.providers 广播：数组引用变化触发 watch，但模型尚未到达目标
      refreshProviderIdentity(h.providersRef, 'p/X')
      await nextTick()
      expect(h.setThinkingLevel).not.toHaveBeenCalled() // 不匹配 → 不消费也不清
      // RPC 回包生效 Y → 匹配消费恢复（token 在无关触发中存活）
      h.pending[0].applyAndResolve('p/Y')
      await p
      expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'l')
      h.scope.stop()
    })

    it('S4/跨模型换绑基线（G3）：无 armed 时换绑跨模型 session → 不恢复，各 session 档位保持', async () => {
      const h = mountArmedBaseline()
      record('p/Y', 'low')
      // 无任何显式切模型（armed 恒 null）→ 从 s1（X）换绑到 s2（Y，档位 'm'）
      h.sessionId.value = 's2'
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
      await nextTick()
      // 记忆 Y='low' 存在且可用，但无 armed 门禁放行 → 不得改写 s2 档位
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      expect(h.sessionRef.value?.thinkingLevel).toBe('m')
      h.scope.stop()
    })

    it('S5/E9 静默换模：请求 Y 生效 Z → 既有对齐处理 Z，规则 5 清残留 token，无延迟伪恢复', async () => {
      // Z 用两档体系（与 X 跨体系）：既有对齐会重置到最高可用档——「对齐处理了 Z」可观测
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap(), 'p/Z': { off: 'zo', low: 'zl' } },
        supported: { 'p/X': fourLevels, 'p/Y': fourLevels, 'p/Z': ['off', 'low'] },
      })
      record('p/Y', 'low')
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      h.pending[0].applyAndResolve('p/Z') // pi 静默换模：请求 Y 生效 Z
      await p
      // armed={Y} vs current p/Z 不匹配（规则 3 保留）→ 既有跨体系对齐重置 Z 档位
      // highestAvailableLevel(['off','low']) = 'low' → resolve('low', Z map) = 'zl'
      expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'zl')
      // 规则 5 已清残留 token：后续无关触发（providers 刷新）不再延迟伪恢复——
      // 判据 = armed 目标 Y 的记忆值 'l' 永不发出（mock setThinkingLevel 不回写 store，
      // 无关触发会重发对齐值 'zl'，属既有行为与 armed 无关，故不断言总次数）
      refreshProviderIdentity(h.providersRef, 'p/Z')
      await nextTick()
      expect(h.setThinkingLevel).not.toHaveBeenCalledWith('s1', 'l')
      h.scope.stop()
    })

    it('S6/E10 慢 RPC（>5s）回包：in-flight 豁免窗内正常匹配消费，规则 1 不误杀', async () => {
      vi.useFakeTimers({ toFake: ['Date'] }) // 只伪造 Date.now（armed.at 与规则 1 的时钟），微任务时序保持真实
      try {
        const h = mountArmedBaseline()
        record('p/Y', 'low')
        const t0 = Date.now()
        const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId }) // armed.at = t0
        vi.setSystemTime(t0 + 6000) // 回包时刻已超 5s 保险丝
        h.pending[0].applyAndResolve('p/Y')
        await p
        // flush 发生在 finally 撤销 in-flight 之前（D3 证据②）：计数仍为 1 → 过期不生效 → 正常消费
        expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'l')
        h.scope.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('S7/re-select 同模型：watch 不触发 → token 未消费，规则 5 成功清，无残留伪恢复', async () => {
      const h = mountArmedBaseline()
      record('p/X', 'low') // 同模型也有记忆——若 token 残留，后续触发会以 'l' 伪恢复
      const p = h.result.onModelSelect({ modelId: 'X', provider: 'p' as ProviderId }) // re-select 同模型
      h.pending[0].applyAndResolve('p/X') // modelId 不变 → 观察源不变 → watch 不触发
      await p
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      // 规则 5 清除后，无关触发不得消费陈旧 token
      refreshProviderIdentity(h.providersRef, 'p/X')
      await nextTick()
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      h.scope.stop()
    })

    it('S8/规则 6 换绑清：RPC 在途时换绑 → armed 先清后消费检查，目标模型 session 不被改写', async () => {
      const h = mountArmedBaseline()
      record('p/Y', 'low')
      void h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId }) // RPC 永不回包（在途）
      // 换绑到 s2（模型恰为 armed 目标 Y，档位 'm'）——换绑即作废全部未消费意图
      h.sessionId.value = 's2'
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
      await nextTick()
      // 若换绑清晚于消费检查（注册序错误），此处会以记忆 'l' 伪恢复 s2 的档位
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      h.scope.stop()
    })

    it('S9/基础序列：设立 → 匹配消费 → 恢复记忆档位经 onReset 通路（G1 happy path）', async () => {
      const h = mountArmedBaseline()
      record('p/Y', 'low')
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      h.pending[0].applyAndResolve('p/Y')
      await p
      // 规则 2：match + 命中 + 'l' ≠ 'h' → setThinkingLevel(s1, 'l')；既有分支被 return 跳过
      expect(h.setThinkingLevel).toHaveBeenCalledTimes(1)
      expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'l')
      // 消费即清（一次性 token）：后续无关触发不再重复恢复
      refreshProviderIdentity(h.providersRef, 'p/Y')
      await nextTick()
      expect(h.setThinkingLevel).toHaveBeenCalledTimes(1)
      h.scope.stop()
    })
  })

  // ══════════ [U2a] landing 显示读 resolveLaunchConfig（设计 D1/D2，原「跟随」机制已删）══════════
  function mountLanding(opts: { defaultModel?: string } = {}) {
    return mountMem({
      sid: null,
      defaultModel: opts.defaultModel ?? '',
      maps: { 'p/M': sameContentMap(), 'p/N': sameContentMap() },
      supported: { 'p/M': fourLevels, 'p/N': fourLevels },
    })
  }

  describe('useComposerModelThinking · landing 显示（resolve 单一解析层）', () => {
    it('F1/memory 档命中：显示记忆档位（resolve 解析，不写入 localThinkingLevel）；localThinkingLevel 恒 authored-only', async () => {
      record('p/M', 'low')
      record('p/N', 'medium')
      const h = mountLanding({ defaultModel: 'p/M' })
      // resolve memory 档：lookup('p/M')='low' 可用 → 经 map 转 value 'l'——显示读解析输出，
      // 不再由 follow watch 写入 localThinkingLevel（auto 值机制已删）
      expect(h.result.currentThinkingLevel.value).toBe('l')
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      // 模型变化（defaultModel 换档）→ resolve 重算为新模型记忆档，仍零写入
      h.defaultModelRef.value = 'p/N'
      await nextTick()
      expect(h.result.currentThinkingLevel.value).toBe('m')
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      h.scope.stop()
    })

    it('F2/defaultModel 晚到：computed 依赖驱动 resolve 重算（空串 → p/M），无需补写回调', async () => {
      record('p/M', 'low')
      const h = mountLanding({ defaultModel: '' }) // 挂载时模型 ''（defaultModel 晚到路径）
      expect(h.result.currentThinkingLevel.value).toBe('high') // 无模型 → default 档最高可用档（value=key）
      h.defaultModelRef.value = 'p/M'
      await nextTick()
      expect(h.result.currentThinkingLevel.value).toBe('l') // resolve memory 档自动接管
      h.scope.stop()
    })

    it('F3/authored explicit 档恒赢：用户显式选档后，模型变化不被 memory 档改写', async () => {
      record('p/M', 'low')
      record('p/N', 'medium')
      const h = mountLanding({ defaultModel: 'p/M' })
      expect(h.result.currentThinkingLevel.value).toBe('l')
      await h.result.onThinkingSelect('h') // 用户显式入口 → localThinkingLevel = 'h'（authored）
      h.defaultModelRef.value = 'p/N'
      await nextTick()
      // resolve explicit 档（pendingThinkingLevel='h'）优先于 memory 档——用户值保持
      expect(h.result.currentThinkingLevel.value).toBe('h')
      h.scope.stop()
    })

    it('F5/preset 档显示：默认预设的 modelOverride/thinkingLevel 进入解析链（D2 序 explicit > preset > memory）', async () => {
      const preset: PiLaunchPreset = {
        ...DEFAULT_PRESETS[0]!,
        id: 'preset-readonly',
        builtin: false,
        modelOverride: 'p/N',
        thinkingLevel: 'low',
      }
      record('p/M', 'max') // memory 档存在——preset 档优先于 memory（D2）
      const h = mountMem({
        sid: null,
        defaultModel: 'p/M',
        maps: { 'p/M': sameContentMap(), 'p/N': sameContentMap() },
        supported: { 'p/M': fourLevels, 'p/N': fourLevels },
        launchPresets: [preset],
        launchDefaultPresetId: 'preset-readonly',
      })
      // 模型/档位显示均 = preset 捆绑值（p/N + preset.thinkingLevel 'low' 原样输出，U1 D2
      // 语义：authored/preset 档原样、memory/default 档经 map 转 value），不再被遮蔽
      expect(h.result.currentModelId.value).toBe('p/N')
      expect(h.result.currentThinkingLevel.value).toBe('low')
      // 用户 authored 选档 → explicit 档覆盖 preset 档位（模型保持 preset 的 p/N）
      await h.result.onThinkingSelect('h')
      expect(h.result.currentThinkingLevel.value).toBe('h')
      expect(h.result.currentModelId.value).toBe('p/N')
      h.scope.stop()
    })

    it('F6/显式 preset 选择进 chip 解析（U4r2 pendingPreset 通道）：显示显式 preset 捆绑值，压过默认预设；已建态不消费该通道', async () => {
      const pDefault: PiLaunchPreset = {
        ...DEFAULT_PRESETS[0]!,
        id: 'preset-default',
        builtin: false,
        modelOverride: 'p/M',
        thinkingLevel: 'off',
      }
      const pUser: PiLaunchPreset = {
        ...DEFAULT_PRESETS[0]!,
        id: 'preset-user',
        builtin: false,
        modelOverride: 'p/N',
        thinkingLevel: 'low',
      }
      record('p/M', 'max') // 默认 preset 模型有记忆——显式 preset 档位不被记忆遮蔽
      const h = mountMem({
        sid: null,
        defaultModel: 'p/M',
        maps: { 'p/M': sameContentMap(), 'p/N': sameContentMap() },
        supported: { 'p/M': fourLevels, 'p/N': fourLevels },
        launchPresets: [pDefault, pUser],
        launchDefaultPresetId: 'preset-default',
        launchPendingPreset: 'preset-user',
      })
      // 通道前（U4 round 1 破口形态）：chip 按默认 preset 解析 → p/M + off；
      // 通道后：显式 preset 捆绑值进显示链（D2 presetId 序 explicit > default）
      expect(h.result.currentModelId.value).toBe('p/N')
      expect(h.result.currentThinkingLevel.value).toBe('low')
      // 已建态不消费 pendingPreset（launchConfigView 门控 sessionId===null）：换绑后
      // 显示读 session 真值，显式 preset 选择对已建 session 显示零影响
      h.sessionId.value = 's1'
      h.sessionRef.value = { modelId: 'p/M', thinkingLevel: 'h' }
      await nextTick()
      expect(h.result.currentModelId.value).toBe('p/M')
      expect(h.result.currentThinkingLevel.value).toBe('h')
      h.scope.stop()
    })
  })

  describe('useComposerModelThinking · 记忆防污染（authored-only 结构保证）', () => {
    it('P1/landing 未 authored 直发建站：全程零写入——挂载/模型变化/建站/换绑均不触碰记忆表', async () => {
      record('p/M', 'low')
      const h = mountLanding({ defaultModel: 'p/M' })
      // 显示读 resolve memory 档（'l'），但不写入 localThinkingLevel、不写记忆
      expect(h.result.currentThinkingLevel.value).toBe('l')
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      // 模拟 submitFirstMessage：session create + 新 session 真值落地——
      // 旧「生效即记录」watch 会在此 flush 写表（D2 不采用③ 污染通道），已结构性删除
      h.sessionId.value = 's1'
      h.sessionRef.value = { modelId: 'p/M', thinkingLevel: 'l' }
      await nextTick()
      expect(lookup('p/M')).toBe('low') // 终态：预置值原样保持，零覆写
      h.scope.stop()
    })

    it('P2/KV 晚到（原 E7② 场景）：reactive 源驱动显示重算（P5①），且全程零写入', async () => {
      // 记忆只存在于 KV（未加载）：模拟 app 冷启动，预载慢于 composer 组装
      const gated = new GatedKV({ 'p/M': 'low' })
      gated.closeGate()
      provideMockPlatform(gated)
      __resetModelThinkingMemoryForTesting()
      const h = mountLanding({ defaultModel: 'p/M' })
      // 加载窗口：lookup 未命中 → resolve default 档（最高可用档 'h'），不写 localThinkingLevel
      expect(h.result.currentThinkingLevel.value).toBe('h')
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      // KV 预载完成（宏任务边界落地加载链）→ reactive Map 更新驱动 resolve 重算（P5①，
      // 旧机制的 onLoaded 补写回调已删——computed 依赖自动接管）
      gated.openGateNow()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(h.result.currentThinkingLevel.value).toBe('l')
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      // 首发建站 → 记忆保持预置值（零写入）
      h.sessionId.value = 's1'
      h.sessionRef.value = { modelId: 'p/M', thinkingLevel: 'l' }
      await nextTick()
      expect(lookup('p/M')).toBe('low')
      h.scope.stop()
    })
  })

  // ══════════ [U2a] 记录 authored-only（唯一记录点 = onThinkingSelect，设计 D2）══════════
  describe('useComposerModelThinking · 记录 authored-only（onThinkingSelect 唯一记录点）', () => {
    it('R1/无显式选档动作零入表：landing 模型变化/建站、已建态挂载/换绑均不写记忆', async () => {
      const h = mountLanding({ defaultModel: 'p/M' })
      h.defaultModelRef.value = 'p/N'
      await nextTick()
      // 模拟建站（旧记录 watch 的 immediate/变化触发均会写表，已结构性删除）
      h.sessionId.value = 's1'
      h.sessionRef.value = { modelId: 'p/M', thinkingLevel: 'l' }
      await nextTick()
      // 换绑另一 session（旧条件 b「session 加载既有状态」记录通道，已删除）
      h.sessionId.value = 's2'
      h.sessionRef.value = { modelId: 'p/X', thinkingLevel: 'h' }
      await nextTick()
      expect(lookup('p/M')).toBeUndefined()
      expect(lookup('p/N')).toBeUndefined()
      expect(lookup('p/X')).toBeUndefined()
      h.scope.stop()
    })

    it('R2/staging 试选入表（刻意反转声明，设计 D2）：记录归属暂存快照模型，不问后续 commit/取消', async () => {
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: { 'p/X': { off: 'o', high: 'h' }, 'p/Y': { off: 'o', high: 'h' } },
        supported: { 'p/X': ['off', 'high'], 'p/Y': ['off', 'high'] },
      })
      // 挂载零写入（authored-only——旧 watch mount 即记录载入值 (p/X,'high')，已删）
      expect(lookup('p/X')).toBeUndefined()
      h.result.enterStagingMode()
      await h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId }) // 只写暂存快照
      await h.result.onThinkingSelect('o') // 暂存档位——显式选择即留痕
      // 刻意反转（旧注释「暂存取消时不该入表」的排除语义已废除）：试选模型入表
      expect(lookup('p/Y')).toBe('off')
      expect(lookup('p/X')).toBeUndefined() // 源 session 模型零写入
      // 取消暂存（exitStagingMode）不撤销已留痕记录——记录发生在选择时刻
      h.result.exitStagingMode()
      expect(lookup('p/Y')).toBe('off')
      h.scope.stop()
    })

    it('R3/已建态显式选档入表：value 经 map 反查为 UI key 记录（u3 D1 存 key 非 value）', async () => {
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: { 'p/X': { off: 'o', low: 'l', high: 'h' } },
        supported: { 'p/X': ['off', 'low', 'high'] },
      })
      await h.result.onThinkingSelect('l') // 用户显式选档（value 'l'）
      expect(lookup('p/X')).toBe('low') // 反查 UI key 入表
      // session 真值随后被回执改写（钳制/对齐）——不再触发任何记录（无 watch）
      h.sessionRef.value = { modelId: 'p/X', thinkingLevel: 'h' }
      await nextTick()
      expect(lookup('p/X')).toBe('low')
      h.scope.stop()
    })

    it('R4/体系外值拦截（E5 防线）：map 反查出的 key 不在模型可用集 → 不入表', async () => {
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        // map 含 max:'m'，但 supportedLevels 体系外不含 max——'m' 反查为 'max' 应被拦
        maps: { 'p/X': { off: 'o', high: 'h', max: 'm' } },
        supported: { 'p/X': ['off', 'high'] },
      })
      await h.result.onThinkingSelect('m')
      expect(lookup('p/X')).toBeUndefined() // 'max' 被可用性校验拦截
      h.scope.stop()
    })
  })

  // ══════════ [U2a] 切换链零写入（authored-only 结构保证，原 Gate B 跨写污染检查已删）══════════
  // 历史背景（V4 档位记忆场景，真实 app 复现）：mem[flash]='low'、mem[glm-5.3]='max'，
  // 显式切走再切回后 mem[flash] 变 max——根因是「生效即记录」watch 在切模型回包链的
  // 两次状态层写（applyLiveState({modelId}) 与 applyLiveState({thinkingLevel})）之间的
  // flush 上读到跨纪元错配快照并写穿。旧防线 = 纪元检查 + 第三形态检查（armed 在途判定）。
  //
  // [U2a] 处置（设计 D9「删除」类）：记录 watch 整体删除后，非 authored 值结构性不到达
  // 记录路径——切换链任意 flush 时刻（含错配中间态、pi 归一独立帧先落形态）零写入，
  // by construction 无需任何检查。本组用例保留生产保真 harness（realisticSetLevel）跑
  // 完整切换链时序，断言全链零写入 + authored 手选照常入表（检查不过度拦截正常记录）。
  const fiveLevelMap = () => ({ ...sameContentMap(), max: 'x' })

  const fiveLevels = [...fourLevels, 'max']

  describe('useComposerModelThinking · 切换链零写入（authored-only 结构保证）', () => {
    /** 公共前置：X/Y 五档同 value 空间，mem[X]='low'、mem[Y]='max'，store=(X,'l') */
    function mountCrossWrite() {
      record('p/X', 'low')
      record('p/Y', 'max')
      return mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'l' },
        maps: { 'p/X': fiveLevelMap(), 'p/Y': fiveLevelMap() },
        supported: { 'p/X': fiveLevels, 'p/Y': fiveLevels },
        realisticSetLevel: true,
      })
    }

    it('W1/切走已记忆模型：回包链两次 store 写之间的错配 flush 零写入，记忆双向保持', async () => {
      const h = mountCrossWrite()
      // 切走 X → Y：回包 applyLiveState({modelId:'p/Y'})，level 仍 'l'（X 纪元遗留——
      // 旧 watch 在此 flush 写 record(p/Y,'low') 污染，已结构性不可能）
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      h.pending[0].applyAndResolve('p/Y')
      await nextTick()
      expect(lookup('p/Y')).toBe('max') // 预置值保持
      // 恢复回包：applyLiveState({thinkingLevel:'x'})（consume 命中 mem[Y]='max' 恢复 'x'）
      expect(h.setLevelCalls).toHaveLength(1)
      expect(h.setLevelCalls[0]!.level).toBe('x')
      h.setLevelCalls[0]!.resolveReply()
      await nextTick()
      await p
      expect(lookup('p/X')).toBe('low')
      expect(lookup('p/Y')).toBe('max')
      h.scope.stop()
    })

    it('W2/切走再切回（历史主回归点）：往返链全部 flush 零写入，mem[X] 不被 Y 纪元档位污染', async () => {
      const h = mountCrossWrite()
      // 前半：切走 X → Y，到达 store=(p/Y,'x')、mem[X]='low'、mem[Y]='max' 的稳态
      const p1 = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      h.pending[0].applyAndResolve('p/Y')
      await nextTick()
      h.setLevelCalls[0]!.resolveReply()
      await nextTick()
      await p1
      // 切回 Y → X：回包 applyLiveState({modelId:'p/X'})，level 仍 'x'（Y 纪元的 max value——
      // 旧 watch 在此 flush 写 record(p/X,'max')，即真实 app 观测的 mem[flash] 被改写为 max）
      const p2 = h.result.onModelSelect({ modelId: 'X', provider: 'p' as ProviderId })
      h.pending[1].applyAndResolve('p/X')
      await nextTick()
      // consume 仍按未污染记忆命中 low → 恢复 onReset('l')
      expect(h.setLevelCalls[1]?.level).toBe('l')
      h.setLevelCalls[1]!.resolveReply()
      await nextTick()
      await p2
      // 终态双向不污染
      expect(lookup('p/X')).toBe('low')
      expect(lookup('p/Y')).toBe('max')
      h.scope.stop()
    })

    it('W3/换绑不写入：换绑到另一 session（sid 变、modelId/level 随真值变化）零入表', async () => {
      const h = mountCrossWrite()
      h.sessionId.value = 's2'
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'm' }
      await nextTick()
      // 旧条件 b「session 加载既有状态」记录通道（mount/换绑即记录）已删除
      expect(lookup('p/Y')).toBe('max')
      h.scope.stop()
    })

    it('W4/第三形态·档位先变（pi 归一独立帧先落）：零写入；authored 手选照常入表（不过度拦截）', async () => {
      const h = mountCrossWrite()
      // 切 X → Y：armed={p/Y} 设立，switchModel RPC 在途（不 resolve——模型回包未到）
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      // pi setModel 归一档位独立帧先落：store=(p/X,'x')（旧模型×新档位——
      // 旧第三形态检查在此拦 record(p/X,'max')，现结构性无记录路径）
      h.sessionRef.value = { modelId: 'p/X', thinkingLevel: 'x' }
      await nextTick()
      expect(lookup('p/X')).toBe('low')
      // 模型回包写入仓库：store=(p/Y,'x')，consume 幂等命中 mem[Y]='max' 清 armed
      h.pending[0].applyAndResolve('p/Y')
      await nextTick()
      expect(h.setLevelCalls).toHaveLength(0)
      expect(lookup('p/X')).toBe('low')
      expect(lookup('p/Y')).toBe('max')
      // RPC 收尾；此后用户手选档照常入表——authored 通道不受切换链影响（记录发生在
      // 选择时刻：realisticSetLevel 回包挂起不阻塞记录，resolveReply 前已落表）
      const hand = h.result.onThinkingSelect('m')
      expect(lookup('p/Y')).toBe('medium')
      h.setLevelCalls[0]!.resolveReply()
      await hand
      h.scope.stop()
    })
  })

  // ══════════ [u5→U2a] 探针表收尾（已建态隔离 / 钳制冻结 / 反查幂等，authored-only 语义）══════════
  describe('useComposerModelThinking · 探针表收尾（authored-only 语义更新）', () => {
    it('F4/已建态不受 landing 解析影响：localThinkingLevel 不被触碰（唯一写点 = landing 支路由）', async () => {
      record('p/X', 'low') // 记忆存在——若 landing 链路误写 local 会留下痕迹
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap() },
        supported: { 'p/X': fourLevels, 'p/Y': fourLevels },
      })
      expect(h.result.localThinkingLevel.value).toBeUndefined() // 已建态挂载零写入
      // defaultModel 变化（landing 链路扰动源）与 session 模型变化均不得写 local
      h.defaultModelRef.value = 'p/N'
      await nextTick()
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'h' }
      await nextTick()
      expect(h.result.localThinkingLevel.value).toBeUndefined()
      h.scope.stop()
    })

    it('C1/钳制不更新记忆（authored-only 冻结，D2 语义收窄四要素）：pi 回执钳制值不改写 authored 记忆', async () => {
      // Y：max 档可用（恢复发出 max 的 value 'x'），pi 端把 max 钳制到 high（回执 value 'h2'）
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: {
          'p/X': sameContentMap(),
          'p/Y': { off: 'o', low: 'l', medium: 'm', high: 'h2', max: 'x' },
        },
        supported: { 'p/X': fourLevels, 'p/Y': [...fourLevels, 'max'] },
      })
      record('p/Y', 'max')
      const p = h.result.onModelSelect({ modelId: 'Y', provider: 'p' as ProviderId })
      h.pending[0].applyAndResolve('p/Y')
      await p
      // 恢复发出的是记忆 max 的 value 'x'（钳制发生在 pi 端）
      expect(h.setThinkingLevel).toHaveBeenCalledWith('s1', 'x')
      // 回执钳制值写入 store（U6：回执写 store，显示恒为真值）——authored-only 下钳制值
      // 非用户显式选择，不改写记忆（冻结在最后显式选择，设计 D2 四要素；用户手动再选
      // 一次即更新）。旧「记录 watch 收敛为钳制值」语义已随 watch 删除
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'h2' }
      await nextTick()
      expect(lookup('p/Y')).toBe('max')
      h.scope.stop()
    })

    it('N1/反查幂等边界（非单射 map）：onThinkingSelect value 反查一次归一，往返无累积漂移', async () => {
      // 非单射 map：high 与 max 都映射 'x'——反查 value 'x' 按 entries 遍历序确定性落到 'high'
      const nonInjectiveMap = { off: 'o', low: 'l', high: 'x', max: 'x' }
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: { 'p/X': sameContentMap(), 'p/Y': nonInjectiveMap },
        supported: { 'p/X': fourLevels, 'p/Y': [...fourLevels, 'max'] },
      })
      // 模型切到 Y 后用户显式选档（value 'x'）→ 记录时反查：一次归一漂移 max → 'high'
      h.sessionRef.value = { modelId: 'p/Y', thinkingLevel: 'h' }
      await nextTick()
      await h.result.onThinkingSelect('x')
      expect(lookup('p/Y')).toBe('high')
      // 往返幂等：记忆 key 经同一 map 换算回 value 恒 'x'（恢复语义与用户原选择等效）
      expect(resolveThinkingValue(lookup('p/Y')!, nonInjectiveMap)).toBe('x')
      // 第二轮显式选档（恢复 'high' → value 'x' → 再记录）：反查确定性 → 不动点，无累积漂移
      await h.result.onThinkingSelect('x')
      expect(lookup('p/Y')).toBe('high')
      h.scope.stop()
    })
  })

  // ══════════ [一致性审查第 1 轮修复 → U2a 语义更新] U-fix-1 / U-fix-2 ══════════
  describe('useComposerModelThinking · 一致性审查修复（U-fix-1/2）', () => {
    it('UF1a/landing re-select 同模型：authored 值保持，无关 providers 刷新不覆写（landing 无 armed 概念）', async () => {
      record('p/M', 'low') // 记忆存在——若存在恢复通路覆写 local，刷新会把值改为 'l'
      const h = mountLanding({ defaultModel: 'p/M' })
      expect(h.result.currentThinkingLevel.value).toBe('l') // resolve memory 档显示
      await h.result.onThinkingSelect('h') // 用户显式选档 → localThinkingLevel = 'h'（authored）
      // re-select 同模型：resolve explicit 档 'h' 恒赢，无恢复通路（landing armed 已删）
      await h.result.onModelSelect({ modelId: 'M', provider: 'p' as ProviderId })
      expect(h.setPendingModel).toHaveBeenCalledWith('p/M') // pendingModel 照常记
      // 人为触发一次无关 providers 变化：显示保持 authored 'h'（explicit 档不被 memory 改写）
      refreshProviderIdentity(h.providersRef, 'p/M')
      await nextTick()
      expect(h.result.currentThinkingLevel.value).toBe('h')
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      h.scope.stop()
    })

    it('UF1b/staging re-select 同模型不设 armed：后续 providers 无关刷新不覆写暂存快照', async () => {
      const h = mountMem({
        sid: 's1',
        session: { modelId: 'p/X', thinkingLevel: 'h' },
        maps: { 'p/X': sameContentMap(), 'p/Y': sameContentMap() },
        supported: { 'p/X': fourLevels, 'p/Y': fourLevels },
      })
      record('p/X', 'low')
      h.result.enterStagingMode() // currentModelId 切读快照 'p/X'
      await h.result.onModelSelect({ modelId: 'X', provider: 'p' as ProviderId }) // re-select 同模型 → 不设 armed
      // 无关刷新：若 armed 悬留，规则 2 会 onReset('l') 写入 stagingThinking（伪恢复）
      refreshProviderIdentity(h.providersRef, 'p/X')
      await nextTick()
      expect(h.result.currentThinkingLevel.value).toBe('h') // 暂存快照保持
      expect(h.setThinkingLevel).not.toHaveBeenCalled()
      h.scope.stop()
    })

    it('UF2/resolve 记忆档可用性校验（E3 防线在解析层）：记忆键失效（不在可用集）→ 显示回落最高可用档', async () => {
      // 记忆 'max' 存在，但 M 的 supportedLevels（fourLevels）不含 max——能力注册表变化场景
      record('p/M', 'max')
      const h = mountLanding({ defaultModel: 'p/M' })
      // resolve memory 档校验失败 → default 档 = 最高可用档 'high'（经 map 映射 value 'h'），
      // 不短暂显示不可用档（U1 解析层校验，原「跟随路径可用性校验」机制已随 follow 删除）
      expect(h.result.currentThinkingLevel.value).toBe('h')
      h.scope.stop()
    })

    it('UF3/[U2a 反转] landing authored 后真实切换 M→N：无 armed 恢复——authored 值保持（记忆档经 resolve 在建站时生效）', async () => {
      // 生产保真前提：setPendingModel 同步写 currentModel（与 flow.ts 同构）——
      // 真实切换经 pendingModel → currentModelId 同步 computed 传播
      record('p/N', 'low')
      const h = mountLanding({ defaultModel: 'p/M' })
      expect(h.result.currentThinkingLevel.value).toBe('h') // M 无记忆 → default 档最高档
      await h.result.onThinkingSelect('h') // 用户 authored
      await h.result.onModelSelect({ modelId: 'N', provider: 'p' as ProviderId }) // 真实切换（非 re-select）
      await nextTick()
      // landing armed 已删（D5）：显式切模型不再消费恢复——authored 'h' 作为 resolve
      // explicit 档保持显示；N 的记忆档 'low' 经解析链在 create 时生效（U2b 透传），
      // 不再经 chip 突跳式恢复（旧断言 'l' 已反转，设计 D1「单一写点」+ D5）
      expect(h.result.currentThinkingLevel.value).toBe('h')
      expect(h.setPendingModel).toHaveBeenCalledWith('p/N') // pendingModel 照常记
      expect(h.setThinkingLevel).not.toHaveBeenCalled() // landing 无 RPC
      h.scope.stop()
    })
  })

  // ══════════ [U4] D3 显示分流：已建态空值占位（不回落 landing 残留/全局默认）══════════
  describe('useComposerModelThinking · D3 显示分流（已建态空值占位）', () => {
    it('已建态 session.modelId 空串 → regularModelId 返回空串占位，不兜底到 currentModel/defaultModel', () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: '' },
        currentModel: 'provider-F/model-F',
        defaultModel: 'provider-D/model-D',
      })
      // 空串 → '' 占位，不回落 landing currentModel 或全局 defaultModel
      expect(result.currentModelId.value).toBe('')
      scope.stop()
    })

    it('已建态 session.thinkingLevel undefined → regularThinkingLevel 返回 undefined，不回落 localThinkingLevel', () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A' }, // thinkingLevel 缺失
      })
      // thinkingLevel undefined → undefined 占位，不回落 landing localThinkingLevel
      expect(result.currentThinkingLevel.value).toBeUndefined()
      scope.stop()
    })

    it('已建态 session.modelId 有值 → 正常返回（不被 D3 改变）', () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      expect(result.currentModelId.value).toBe('provider-A/model-A')
      expect(result.currentThinkingLevel.value).toBe('high')
      scope.stop()
    })

    it('landing 态（sessionId=null）→ 走 resolve 解析链（explicit 档），不受 D3 分流影响', () => {
      const { result, scope } = mount(null, {
        currentModel: 'provider-F/model-F',
        defaultModel: 'provider-D/model-D',
      })
      // resolve explicit 档（pendingModel）优先——显示 = 用户显式选择
      expect(result.currentModelId.value).toBe('provider-F/model-F')
      scope.stop()
    })
  })

  // ══════════ [U4→U2a] D4 lastUsedModel 档（resolve 解析链 + 有效性校验）══════════
  /** 最小 providers 能力表（D4 校验数据源）：单 provider 单 model */
  const makeProviders = (...models: Array<{ id: string }>): ProviderInfo[] => [
    {
      id: 'provider-L' as ProviderId,
      name: 'L',
      apiKeySet: true,
      status: 'connected',
      models,
    },
  ]

  describe('useComposerModelThinking · D4 lastUsedModel 档（resolve + 有效性校验）', () => {
    it('landing + currentModel null + lastUsedModel 有效（providers 含该模型）→ 显示 lastUsedModel', () => {
      recordLastUsed('provider-L/model-L')
      const { result, scope } = mount(null, {
        defaultModel: 'provider-D/model-D',
        providers: makeProviders({ id: 'model-L' }),
      })
      // resolve：pending null → preset 无 → lastUsed 档 D4 校验过（provider 存在且 model 在列）→ 选中
      expect(result.currentModelId.value).toBe('provider-L/model-L')
      scope.stop()
    })

    it('landing + currentModel 有值 → 优先读 currentModel（resolve explicit 档，lastUsedModel 不干扰）', () => {
      recordLastUsed('provider-L/model-L')
      const { result, scope } = mount(null, {
        currentModel: 'provider-F/model-F',
        defaultModel: 'provider-D/model-D',
        providers: makeProviders({ id: 'model-L' }),
      })
      // explicit 档优先级最高
      expect(result.currentModelId.value).toBe('provider-F/model-F')
      scope.stop()
    })

    it('landing + currentModel null + lastUsedModel 无记录 → 回落 defaultModel', () => {
      const { result, scope } = mount(null, {
        defaultModel: 'provider-D/model-D',
        providers: makeProviders({ id: 'model-L' }),
      })
      expect(result.currentModelId.value).toBe('provider-D/model-D')
      scope.stop()
    })

    it('D4 校验（E3 语义）：lastUsedModel 指向 providers 外的死模型 → 链内跳过，显示回落 defaultModel（不显示死模型）', () => {
      recordLastUsed('provider-dead/model-Z')
      const { result, scope } = mount(null, {
        defaultModel: 'provider-D/model-D',
        providers: makeProviders({ id: 'model-L' }),
      })
      // provider-dead 不在能力表 → findModelEntry undefined → lastUsed 档跳过 → default 档
      expect(result.currentModelId.value).toBe('provider-D/model-D')
      scope.stop()
    })

    it('launchData 未注入（providers 缺失）：lastUsed 档因 D4 校验无能力表而跳过 → 回落 defaultModel（壳层接线前中间态）', () => {
      recordLastUsed('provider-L/model-L')
      const { result, scope } = mount(null, {
        defaultModel: 'provider-D/model-D',
      })
      expect(result.currentModelId.value).toBe('provider-D/model-D')
      scope.stop()
    })
  })

  // ══════════ [U4] D4 lastUsedModel 写入（显式选择写 KV，staging 不写）══════════
  describe('useComposerModelThinking · D4 lastUsedModel 写入', () => {
    it('已建态 onModelSelect → 写入 lastUsedModel', async () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      expect(lookupLastUsed()).toBe('provider-C/model-C')
      scope.stop()
    })

    it('landing 态 onModelSelect → 写入 lastUsedModel', async () => {
      const { result, scope } = mount(null)
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      expect(lookupLastUsed()).toBe('provider-C/model-C')
      scope.stop()
    })

    it('staging 态 onModelSelect → 不写 lastUsedModel', async () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      result.enterStagingMode()
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      // staging 试选不写 KV
      expect(lookupLastUsed()).toBeUndefined()
      scope.stop()
    })

    it('多次选择 → lastUsedModel 覆盖为最后一次', async () => {
      const { result, scope } = mount('s1', {
        sessionState: { modelId: 'provider-A/model-A', thinkingLevel: 'high' },
      })
      await result.onModelSelect({ modelId: 'model-B', provider: 'provider-B' as ProviderId })
      expect(lookupLastUsed()).toBe('provider-B/model-B')
      await result.onModelSelect({ modelId: 'model-C', provider: 'provider-C' as ProviderId })
      expect(lookupLastUsed()).toBe('provider-C/model-C')
      scope.stop()
    })
  })
});

// ======== 来源：launch-config.test.ts ========
describe("launch-config", () => {
  // ── fixture ───────────────────────────────────────────────────────────

  /** 平面 KV stub（同 last-used-model.test.ts） */
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

  /** 可控时序 KV：closeGate 挂起 get、openGateNow 放行（P5① / ensureLaunchDataReady 用） */
  class GatedKV extends MemKV {
    private gate: Promise<void> | null = null
    private open: (() => void) | null = null
    closeGate(): void {
      this.gate = new Promise((resolve) => {
        this.open = resolve
      })
    }
    openGateNow(): void {
      this.open?.()
      this.open = null
    }
    override async get(key: string): Promise<string | null> {
      if (this.gate) await this.gate
      return super.get(key)
    }
  }

  function provideMockPlatform(storage: KVStorage): void {
    const port: PlatformPort = {
      kind: 'mock',
      storage,
      webSocket: {
        create: () => {
          throw new Error('stub')
        },
      },
    }
    providePlatform(port)
  }

  function makeProvider(p: Partial<ProviderInfo> = {}): ProviderInfo {
    return {
      id: 'prov-a' as ProviderId,
      name: 'Provider A',
      apiKeySet: true,
      status: 'connected',
      enabled: true,
      models: [{ id: 'model-x' }, { id: 'model-y' }],
      ...p,
    }
  }

  function makePreset(p: Partial<PiLaunchPreset> = {}): PiLaunchPreset {
    return {
      id: 'custom-1',
      name: 'Custom',
      builtin: false,
      order: 10,
      toolMode: 'all',
      extensionMode: 'all',
      ...p,
    }
  }

  /** 出厂 builtin:full 真实定义（比对基准用 shared 常量，防 fixture 与实现空转对齐） */
  function factoryFull(): PiLaunchPreset {
    const p = DEFAULT_PRESETS.find((x) => x.id === BUILTIN_PRESET_IDS.FULL)
    if (!p) throw new Error('DEFAULT_PRESETS missing builtin:full')
    return p
  }

  function makeInput(p: Partial<LaunchConfigInput> = {}): LaunchConfigInput {
    return {
      pendingModel: null,
      pendingThinkingLevel: null,
      pendingPreset: null,
      pendingCwd: null,
      presets: [],
      defaultPresetId: null,
      lastUsedModel: null,
      getRememberedThinkingLevel: () => undefined,
      providers: [],
      defaultModel: 'prov-default/model-default',
      getSupportedLevels: () => ['off', 'low', 'medium', 'high', 'max'],
      recentSessionCwd: null,
      defaultCwd: '/default/cwd',
      ...p,
    }
  }

  beforeEach(() => {
    provideMockPlatform(new MemKV())
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    __resetPlatformForTesting()
    __resetLastUsedModelForTesting()
    __resetModelThinkingMemoryForTesting()
  })

  // ── D2 model 序矩阵 ────────────────────────────────────────────────────

  describe('resolveLaunchConfig · D2 model 序', () => {
    it('explicit 档：pendingModel 赢过 preset.modelOverride / 有效 lastUsed / 全局默认', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingModel: 'prov-a/model-explicit',
          presets: [makePreset({ id: 'p1', modelOverride: 'prov-a/model-preset' })],
          defaultPresetId: 'p1',
          lastUsedModel: 'prov-a/model-x',
          providers: [makeProvider()],
        }),
      )
      expect(cfg.model).toBe('prov-a/model-explicit')
      expect(cfg.modelProvenance).toBe('explicit')
    })

    it('preset 档：pendingModel 空 + preset.modelOverride 生效（压过有效 lastUsed——D2 捆绑意图优先）', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          presets: [makePreset({ id: 'p1', modelOverride: 'prov-a/model-preset' })],
          defaultPresetId: 'p1',
          lastUsedModel: 'prov-a/model-x',
          providers: [makeProvider()],
        }),
      )
      expect(cfg.model).toBe('prov-a/model-preset')
      expect(cfg.modelProvenance).toBe('preset')
    })

    it('lastUsed 档：前两档空 + lastUsedModel 通过 D4 校验', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          lastUsedModel: 'prov-a/model-x',
          providers: [makeProvider()],
        }),
      )
      expect(cfg.model).toBe('prov-a/model-x')
      expect(cfg.modelProvenance).toBe('lastUsed')
    })

    it('default 档：前三档空 → 全局默认', () => {
      const cfg = resolveLaunchConfig(makeInput())
      expect(cfg.model).toBe('prov-default/model-default')
      expect(cfg.modelProvenance).toBe('default')
    })

    it('全链空（含 defaultModel 空）→ model 为空串防御形态', () => {
      const cfg = resolveLaunchConfig(makeInput({ defaultModel: null }))
      expect(cfg.model).toBe('')
      expect(cfg.modelProvenance).toBe('default')
    })

    it('preset 无 modelOverride 时不遮蔽 lastUsed 档', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          presets: [makePreset({ id: 'p1' })], // 无 modelOverride
          defaultPresetId: 'p1',
          lastUsedModel: 'prov-a/model-x',
          providers: [makeProvider()],
        }),
      )
      expect(cfg.model).toBe('prov-a/model-x')
      expect(cfg.modelProvenance).toBe('lastUsed')
    })
  })

  // ── D4 lastUsedModel 失效链内回落 ──────────────────────────────────────

  describe('resolveLaunchConfig · D4 失效跳过链内回落', () => {
    it('provider 不在列表（已删除）→ 落全局默认，provenance=default', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          lastUsedModel: 'prov-gone/model-x',
          providers: [makeProvider()], // 只有 prov-a
        }),
      )
      expect(cfg.model).toBe('prov-default/model-default')
      expect(cfg.modelProvenance).toBe('default')
    })

    it('provider.enabled=false（禁用）→ 落全局默认', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          lastUsedModel: 'prov-a/model-x',
          providers: [makeProvider({ enabled: false })],
        }),
      )
      expect(cfg.model).toBe('prov-default/model-default')
      expect(cfg.modelProvenance).toBe('default')
    })

    it('model 不在该 provider models 列表 → 落全局默认', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          lastUsedModel: 'prov-a/model-nonexistent',
          providers: [makeProvider()],
        }),
      )
      expect(cfg.model).toBe('prov-default/model-default')
      expect(cfg.modelProvenance).toBe('default')
    })

    it('KV 保留原值不覆写：resolve 全程零 KV 写、原值可再恢复（provider 恢复场景前提）', async () => {
      const kv = new MemKV()
      const setSpy = vi.spyOn(kv, 'set')
      provideMockPlatform(kv)
      await kv.set(LAST_USED_MODEL_KEY, JSON.stringify('prov-gone/model-x'))
      setSpy.mockClear()
      __resetLastUsedModelForTesting()

      resolveLaunchConfig(
        makeInput({ lastUsedModel: 'prov-gone/model-x', providers: [] }),
      )
      resolveLaunchConfig(
        makeInput({ lastUsedModel: 'prov-gone/model-x', providers: [] }),
      )

      // 纯函数无 KV 写点：两次 resolve 不产生任何 storage.set
      expect(setSpy).not.toHaveBeenCalled()
      // KV 原值保留（D4：非破坏性跳过）
      expect(JSON.parse((await kv.get(LAST_USED_MODEL_KEY))!)).toBe('prov-gone/model-x')
    })

    it('D4 失效跳过后 explicit 档仍最高（显式选择不受校验影响）', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingModel: 'prov-gone/model-explicit',
          lastUsedModel: 'prov-gone/model-x',
          providers: [],
        }),
      )
      expect(cfg.model).toBe('prov-gone/model-explicit')
      expect(cfg.modelProvenance).toBe('explicit')
    })
  })

  // ── D2 thinkingLevel 序矩阵 ────────────────────────────────────────────

  describe('resolveLaunchConfig · D2 thinkingLevel 序', () => {
    it('explicit 档：authored 选档赢过 preset / 记忆 / 最高档', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingThinkingLevel: 'low',
          presets: [makePreset({ id: 'p1', thinkingLevel: 'off' })],
          defaultPresetId: 'p1',
          getRememberedThinkingLevel: () => 'max',
        }),
      )
      expect(cfg.thinkingLevel).toBe('low')
      expect(cfg.thinkingProvenance).toBe('explicit')
    })

    it('preset 档压过记忆表（V4 场景：默认预设 off + mem[max] → off）', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          presets: [makePreset({ id: 'p1', thinkingLevel: 'off' })],
          defaultPresetId: 'p1',
          getRememberedThinkingLevel: () => 'max',
        }),
      )
      expect(cfg.thinkingLevel).toBe('off')
      expect(cfg.thinkingProvenance).toBe('preset')
    })

    it('memory 档：前两档空 + 记忆档可用 → 生效', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingModel: 'prov-a/model-x',
          getRememberedThinkingLevel: () => 'high',
        }),
      )
      expect(cfg.thinkingLevel).toBe('high')
      expect(cfg.thinkingProvenance).toBe('memory')
    })

    it('memory 档不可用（不在 supported levels）→ 跳过回落最高可用档', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingModel: 'prov-a/model-x',
          getRememberedThinkingLevel: () => 'max',
          getSupportedLevels: () => ['off', 'low', 'high'], // max 不可用
        }),
      )
      expect(cfg.thinkingLevel).toBe('high')
      expect(cfg.thinkingProvenance).toBe('default')
    })

    it('无记忆 → 最高可用档', () => {
      const cfg = resolveLaunchConfig(makeInput({ pendingModel: 'prov-a/model-x' }))
      expect(cfg.thinkingLevel).toBe('max')
      expect(cfg.thinkingProvenance).toBe('default')
    })

    it('getSupportedLevels 未注入 → 归一默认五档，最高 high', () => {
      const cfg = resolveLaunchConfig(
        makeInput({ pendingModel: 'prov-a/model-x', getSupportedLevels: undefined }),
      )
      expect(cfg.thinkingLevel).toBe('high')
      expect(cfg.thinkingProvenance).toBe('default')
    })

    it('memory 档经 thinkingLevelMap 转 value 域（map max→xhigh）', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingModel: 'prov-a/model-x',
          providers: [
            makeProvider({
              models: [
                {
                  id: 'model-x',
                  thinkingLevelMap: { off: 'off', high: 'high', max: 'xhigh' },
                  supportedLevels: ['off', 'high', 'max'],
                },
              ],
            }),
          ],
          getSupportedLevels: () => ['off', 'high', 'max'],
          getRememberedThinkingLevel: () => 'max',
        }),
      )
      expect(cfg.thinkingLevel).toBe('xhigh')
      expect(cfg.thinkingProvenance).toBe('memory')
    })

    it('最高档经 thinkingLevelMap 转 value 域', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingModel: 'prov-a/model-x',
          providers: [
            makeProvider({
              models: [
                {
                  id: 'model-x',
                  thinkingLevelMap: { off: 'off', high: 'high', max: 'xhigh' },
                  supportedLevels: ['off', 'high', 'max'],
                },
              ],
            }),
          ],
          getSupportedLevels: () => ['off', 'high', 'max'],
          getRememberedThinkingLevel: () => undefined,
        }),
      )
      expect(cfg.thinkingLevel).toBe('xhigh')
      expect(cfg.thinkingProvenance).toBe('default')
    })
  })

  // ── D2 presetId 序 + D3 透传语义 ───────────────────────────────────────

  describe('resolveLaunchConfig · D2 presetId 序与 D3 透传', () => {
    it('explicit 档：pendingPreset 生效 → 透传 id，provenance=explicit', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingPreset: 'p-user',
          presets: [makePreset({ id: 'p-user' })],
          defaultPresetId: 'p-other',
        }),
      )
      expect(cfg.presetId).toBe('p-user')
      expect(cfg.presetProvenance).toBe('explicit')
    })

    it('explicit 档失效（指向已删 id）→ 链内回落全局默认预设，provenance=default', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingPreset: 'p-gone',
          presets: [makePreset({ id: 'p-default' })],
          defaultPresetId: 'p-default',
        }),
      )
      expect(cfg.presetId).toBe('p-default')
      expect(cfg.presetProvenance).toBe('default')
    })

    it('default 档：全局默认预设生效（无 pending）', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          presets: [makePreset({ id: 'p-default' })],
          defaultPresetId: 'p-default',
        }),
      )
      expect(cfg.presetId).toBe('p-default')
      expect(cfg.presetProvenance).toBe('default')
    })

    it('默认预设指向已删 id（E4）→ 回落 builtin:full', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          presets: [factoryFull()],
          defaultPresetId: 'p-gone',
        }),
      )
      expect(cfg.presetProvenance).toBe('default')
      // 出厂 full → presetId=undefined 不透传（D3）
      expect(cfg.presetId).toBeUndefined()
    })

    it('defaultPresetId 未设 → builtin:full 兜底', () => {
      const cfg = resolveLaunchConfig(makeInput({ presets: [factoryFull()] }))
      expect(cfg.presetProvenance).toBe('default')
      expect(cfg.presetId).toBeUndefined()
    })

    it('preset 档解析不到任何实例（列表空）→ presetId=undefined，model/thinking 的 preset 档不可达', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          presets: [],
          pendingPreset: 'p-gone',
          lastUsedModel: 'prov-a/model-x',
          providers: [makeProvider()],
        }),
      )
      expect(cfg.presetId).toBeUndefined()
      expect(cfg.model).toBe('prov-a/model-x') // preset 档缺席不遮蔽 lastUsed
      expect(cfg.modelProvenance).toBe('lastUsed')
      expect(cfg.thinkingProvenance).toBe('default')
    })
  })

  // ── D2 cwd 序 ──────────────────────────────────────────────────────────

  describe('resolveLaunchConfig · D2 cwd 序', () => {
    it('explicit 档：pendingCwd 赢过预填与默认', () => {
      const cfg = resolveLaunchConfig(
        makeInput({
          pendingCwd: '/explicit',
          recentSessionCwd: '/recent',
          defaultCwd: '/default/cwd',
        }),
      )
      expect(cfg.cwd).toBe('/explicit')
      expect(cfg.cwdProvenance).toBe('explicit')
    })

    it('lastUsed 档：最近 session 目录预填', () => {
      const cfg = resolveLaunchConfig(
        makeInput({ recentSessionCwd: '/recent', defaultCwd: '/default/cwd' }),
      )
      expect(cfg.cwd).toBe('/recent')
      expect(cfg.cwdProvenance).toBe('lastUsed')
    })

    it('default 档：defaultCwd', () => {
      const cfg = resolveLaunchConfig(makeInput({ defaultCwd: '/default/cwd' }))
      expect(cfg.cwd).toBe('/default/cwd')
      expect(cfg.cwdProvenance).toBe('default')
    })

    it('两空（未选目录且无默认）→ 空串（E7 现行为，本层只解析不变更）', () => {
      const cfg = resolveLaunchConfig(makeInput({ defaultCwd: null }))
      expect(cfg.cwd).toBe('')
      expect(cfg.cwdProvenance).toBe('default')
    })
  })

  // ── D3 isFactoryFullPreset + P2b ───────────────────────────────────────

  describe('isFactoryFullPreset · 出厂等价判定', () => {
    it('出厂 builtin:full → true', () => {
      expect(isFactoryFullPreset(factoryFull())).toBe(true)
    })

    it('非 builtin:full 的 preset → false', () => {
      expect(isFactoryFullPreset(makePreset({ id: 'custom-1' }))).toBe(false)
      const readonlyPreset = DEFAULT_PRESETS.find(
        (p) => p.id === BUILTIN_PRESET_IDS.READONLY,
      )!
      expect(isFactoryFullPreset(readonlyPreset)).toBe(false)
    })

    it('P2b：覆写 modelOverride → 判定翻转 + resolve 透传 presetId=builtin:full', () => {
      const overwritten = { ...factoryFull(), modelOverride: 'prov-a/model-x' }
      expect(isFactoryFullPreset(overwritten)).toBe(false)
      const cfg = resolveLaunchConfig(makeInput({ presets: [overwritten] }))
      expect(cfg.presetId).toBe('builtin:full')
      // 覆写的 modelOverride 进入 model 解析链（preset 档）
      expect(cfg.model).toBe('prov-a/model-x')
      expect(cfg.modelProvenance).toBe('preset')
    })

    it('P2b：覆写 noSkills → 判定翻转 + resolve 透传', () => {
      const overwritten = { ...factoryFull(), noSkills: true }
      expect(isFactoryFullPreset(overwritten)).toBe(false)
      const cfg = resolveLaunchConfig(makeInput({ presets: [overwritten] }))
      expect(cfg.presetId).toBe('builtin:full')
    })

    it('P2b：覆写 allowedExtensions（数组字段）→ 判定翻转 + resolve 透传', () => {
      const overwritten = { ...factoryFull(), allowedExtensions: ['@zhushanwen/pi-plan'] }
      expect(isFactoryFullPreset(overwritten)).toBe(false)
      const cfg = resolveLaunchConfig(makeInput({ presets: [overwritten] }))
      expect(cfg.presetId).toBe('builtin:full')
    })

    it('覆写 allowedExtensions=[]（undefined ≠ []，用户显式清空）→ 判定翻转', () => {
      const overwritten = { ...factoryFull(), allowedExtensions: [] }
      expect(isFactoryFullPreset(overwritten)).toBe(false)
    })

    it('prompt：覆写 append 段（模式提示词）→ 判定翻转 + resolve 透传 presetId=builtin:full', () => {
      const overwritten: PiLaunchPreset = {
        ...factoryFull(),
        prompt: { append: { enabled: true, prompt: 'x' } },
      }
      expect(isFactoryFullPreset(overwritten)).toBe(false)
      const cfg = resolveLaunchConfig(makeInput({ presets: [overwritten] }))
      expect(cfg.presetId).toBe('builtin:full')
    })

    it('prompt：双侧都未配置（出厂 full 无 prompt）→ 仍判出厂等价', () => {
      expect(isFactoryFullPreset(factoryFull())).toBe(true)
      expect(isFactoryFullPreset({ ...factoryFull() })).toBe(true)
    })

    it('覆盖写其他非比对字段（name/order）不影响出厂判定（比对键只含 11 个生效字段）', () => {
      const renamed = { ...factoryFull(), name: '我的全工具', order: 99 }
      expect(isFactoryFullPreset(renamed)).toBe(true)
    })
  })

  describe('launchFieldEquals · 数组比对语义（P2b）', () => {
    it('标量：同值等价、异值不等', () => {
      expect(launchFieldEquals('all', 'all')).toBe(true)
      expect(launchFieldEquals('all', 'denylist')).toBe(false)
      expect(launchFieldEquals(undefined, undefined)).toBe(true)
      expect(launchFieldEquals(true, true)).toBe(true)
    })

    it('undefined 与 [] 不等价（显式清空 ≠ 从未配置）', () => {
      expect(launchFieldEquals(undefined, [])).toBe(false)
      expect(launchFieldEquals([], undefined)).toBe(false)
    })

    it('顺序敏感', () => {
      expect(launchFieldEquals(['a', 'b'], ['b', 'a'])).toBe(false)
      expect(launchFieldEquals(['a', 'b'], ['a', 'b'])).toBe(true)
    })

    it('长度不等 → 不等价', () => {
      expect(launchFieldEquals(['a'], ['a', 'b'])).toBe(false)
      expect(launchFieldEquals([], [])).toBe(true)
    })
  })

  describe('launchFieldEquals · 普通对象比对语义（D3 对象扩展）', () => {
    it('结构相同但引用不同 → 等价（结构化比对，非引用比较）', () => {
      const a = { append: { enabled: true, prompt: 'x' } }
      const b = { append: { enabled: true, prompt: 'x' } }
      expect(a).not.toBe(b)
      expect(launchFieldEquals(a, b)).toBe(true)
      // 段级对象同样走结构比对
      expect(launchFieldEquals(a.append, b.append)).toBe(true)
    })

    it('undefined vs 对象 → 不等价（从未配置 ≠ 显式配置）', () => {
      const configured = { append: { enabled: true, prompt: 'x' } }
      expect(launchFieldEquals(undefined, configured)).toBe(false)
      expect(launchFieldEquals(configured, undefined)).toBe(false)
    })

    it('段级 enabled 翻转（replace true vs false）→ 不等价', () => {
      expect(
        launchFieldEquals(
          { replace: { enabled: true, prompt: 'p' } },
          { replace: { enabled: false, prompt: 'p' } },
        ),
      ).toBe(false)
    })

    it('段级 prompt 文本不同 → 不等价', () => {
      expect(
        launchFieldEquals(
          { replace: { enabled: true, prompt: 'a' } },
          { replace: { enabled: true, prompt: 'b' } },
        ),
      ).toBe(false)
    })

    it('键集合不同（缺键 vs 有键 / 同键集不同名）→ 不等价', () => {
      expect(launchFieldEquals({}, { append: { enabled: true, prompt: 'x' } })).toBe(false)
      expect(
        launchFieldEquals(
          { append: { enabled: true, prompt: 'x' } },
          { replace: { enabled: true, prompt: 'x' } },
        ),
      ).toBe(false)
    })

    it('两段齐全结构相同 → 等价；少一段 → 不等价', () => {
      const both = {
        replace: { enabled: true, prompt: 'r' },
        append: { enabled: false, prompt: 'a' },
      }
      expect(launchFieldEquals(both, { ...both })).toBe(true)
      expect(launchFieldEquals(both, { replace: both.replace })).toBe(false)
    })

    it('空对象 vs 空对象 → 等价（键集合同为空）', () => {
      expect(launchFieldEquals({}, {})).toBe(true)
    })
  })

  describe('穷尽检查 · 比对键 vs D3 十一字段清单', () => {
    it('PRESET_LAUNCH_KEYS 键集 = D3 声明的 11 个 launch 生效字段', () => {
      expect(Object.keys(PRESET_LAUNCH_KEYS).sort()).toEqual(
        [
          'toolMode',
          'allowedTools',
          'deniedTools',
          'extensionMode',
          'allowedExtensions',
          'deniedExtensions',
          'modelOverride',
          'thinkingLevel',
          'noSkills',
          'noContextFiles',
          'prompt',
        ].sort(),
      )
    })

    it('比对键全部是 PiLaunchPreset 合法键（类型级由 satisfies 锁，运行时复验）', () => {
      // 全字段构造（可选字段也显式写出）——运行时键全集代表类型键全集
      const fullShapePreset: PiLaunchPreset = {
        id: 'x',
        name: 'x',
        description: 'x',
        builtin: false,
        order: 0,
        toolMode: 'all',
        allowedTools: [],
        deniedTools: [],
        extensionMode: 'all',
        allowedExtensions: [],
        deniedExtensions: [],
        modelOverride: 'prov/m',
        thinkingLevel: 'high',
        noSkills: true,
        noContextFiles: true,
        prompt: {
          replace: { enabled: true, prompt: 'r' },
          append: { enabled: false, prompt: 'a' },
        },
      }
      const presetKeys = Object.keys(fullShapePreset)
      for (const key of Object.keys(PRESET_LAUNCH_KEYS)) {
        expect(presetKeys).toContain(key)
      }
    })
  })

  // ── P5① 响应式视图 ─────────────────────────────────────────────────────

  describe('P5① · KV 延迟到达时 createLaunchConfigView 响应式重算', () => {
    it('KV 挂起期输出默认占位，数据到达后自动脱离（chip 不需要手动刷新）', async () => {
      const gated = new GatedKV()
      await gated.set(LAST_USED_MODEL_KEY, JSON.stringify('prov-a/model-x'))
      gated.closeGate()
      provideMockPlatform(gated)
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()

      loadLastUsedOnce() // get 挂起（冷启动毫秒级窗口）
      const view = createLaunchConfigView(() =>
        makeInput({
          lastUsedModel: lookupLastUsed(), // 经模块 ref 读——computed 建立响应式依赖
          providers: [makeProvider()],
        }),
      )

      // 加载窗口内：lookup 为 undefined → 全局默认占位
      expect(view.value.model).toBe('prov-default/model-default')
      expect(view.value.modelProvenance).toBe('default')

      gated.openGateNow()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      // 数据到达：view 自动重算，脱离占位值
      expect(view.value.model).toBe('prov-a/model-x')
      expect(view.value.modelProvenance).toBe('lastUsed')
    })

    it('纯函数性：相同输入两次 resolve 输出 deep equal', () => {
      const input = makeInput({
        pendingModel: 'prov-a/model-x',
        pendingThinkingLevel: 'high',
        presets: [makePreset({ id: 'p1' })],
        defaultPresetId: 'p1',
        lastUsedModel: 'prov-a/model-y',
        providers: [makeProvider()],
        recentSessionCwd: '/recent',
      })
      expect(resolveLaunchConfig(input)).toEqual(resolveLaunchConfig(input))
    })
  })

  // ── D1 ensureLaunchDataReady ───────────────────────────────────────────

  describe('ensureLaunchDataReady · 五数据源聚合', () => {
    /** 已加载形态的注入源（onLoaded 立即同步触发） */
    function loadedSource(): LaunchDataSource {
      return {
        loadOnce: vi.fn(),
        onLoaded: (cb: () => void) => cb(),
      }
    }

    /** 等待两 KV 模块加载完成（beforeEach 已 provide MemKV） */
    async function flushKvLoads(): Promise<void> {
      loadLastUsedOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    }

    it('全部已加载 → 微任务内返回（不依赖任何异步 IO）', async () => {
      await flushKvLoads()
      const p = ensureLaunchDataReady({
        presets: loadedSource(),
        providers: loadedSource(),
      })
      let settled = false
      void p.then(() => {
        settled = true
      })
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      expect(settled).toBe(true)
    })

    it('未加载 → 等待 KV 加载完成后才 resolve（窗口内 await 不放行）', async () => {
      const gated = new GatedKV()
      gated.closeGate()
      provideMockPlatform(gated)
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()

      const p = ensureLaunchDataReady()
      let settled = false
      void p.then(() => {
        settled = true
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(settled).toBe(false) // KV get 挂起，ensure 未完成

      gated.openGateNow()
      await p
      expect(settled).toBe(true)
    })

    it('deps 单源 loadOnce 抛错 → 不 reject 不阻塞（按收敛语义放行）', async () => {
      await flushKvLoads()
      const badSource: LaunchDataSource = {
        loadOnce: () => {
          throw new Error('store boom')
        },
        onLoaded: vi.fn(),
      }
      await expect(
        ensureLaunchDataReady({ presets: badSource, providers: loadedSource() }),
      ).resolves.toBeUndefined()
    })

    it('KV 读失败（E4）→ 模块内收敛，ensure 正常完成', async () => {
      const kv = new MemKV()
      vi.spyOn(kv, 'get').mockRejectedValue(new Error('read error'))
      provideMockPlatform(kv)
      __resetLastUsedModelForTesting()
      __resetModelThinkingMemoryForTesting()

      await expect(ensureLaunchDataReady()).resolves.toBeUndefined()
      expect(lookupLastUsed()).toBeUndefined() // E4 收敛到 undefined，下游回落 defaultModel
    })

    it('deps 缺省（presets/providers 未注入）→ 只聚合两 KV 源，正常完成', async () => {
      await flushKvLoads()
      await expect(ensureLaunchDataReady()).resolves.toBeUndefined()
    })
  })
});
