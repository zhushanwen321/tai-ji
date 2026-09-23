/**
 * launch-config 单元测试。
 *
 * 覆盖（设计 state-truth-sync-architecture §3.3/§3.4）：
 * - D2 字段优先级序全矩阵（model / thinkingLevel / presetId / cwd 各档触发与跳过）
 * - D4 lastUsedModel 失效三形态（provider 删除 / 禁用 / model 不在列表）链内回落
 *   + KV 原值保留（resolve 纯函数无 KV 写点）
 * - D3 isFactoryFullPreset 出厂等价（含 P2b：modelOverride / noSkills / allowedExtensions
 *   三字段覆写翻转 + resolve 透传；数组比对语义：顺序敏感、undefined ≠ []）
 * - D3 对象扩展：prompt（模式提示词）覆写翻转 + 普通对象结构化比对（引用无关）
 * - 穷尽守卫：比对键运行时枚举 vs D3 十一字段清单（编译期由 satisfies 映射类型锁）
 * - P5①：KV 延迟到达时 createLaunchConfigView 响应式重算（chip 脱离默认占位值）
 * - D1 ensureLaunchDataReady：已加载微任务内返回 / 未加载等待完成 / 单源失败不阻塞
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  type PiLaunchPreset,
  type ProviderId,
  type ProviderInfo,
} from '@taiji/shared'
import {
  resolveLaunchConfig,
  isFactoryFullPreset,
  launchFieldEquals,
  createLaunchConfigView,
  ensureLaunchDataReady,
  PRESET_LAUNCH_KEYS,
  type LaunchConfigInput,
  type LaunchDataSource,
} from './launch-config'
import {
  LAST_USED_MODEL_KEY,
  loadOnce as loadLastUsedOnce,
  lookup as lookupLastUsed,
  __resetLastUsedModelForTesting,
} from '../composer/last-used-model'
import { __resetModelThinkingMemoryForTesting } from '../composer/model-thinking-memory'
import {
  providePlatform,
  __resetPlatformForTesting,
  type KVStorage,
  type PlatformPort,
} from '../../platform/port'

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

describe('穷尽守卫 · 比对键 vs D3 十一字段清单', () => {
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
