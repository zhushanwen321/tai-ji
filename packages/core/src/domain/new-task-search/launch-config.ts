/**
 * launch-config —— 新 session 生效配置单一解析层（设计 state-truth-sync-architecture §3.3）。
 *
 * 「新 session 用什么配置」此前在 ≥5 个解析点各自 fallback（landing 显示链 / flow 透传链 /
 * runtime 创建链 / runtime 播种链 / pi 启动默认链），链间组合必然发散（用户看到 A、实际跑 B）。
 * 本模块把该概念值收敛为一个纯函数：landing chip 显示（后续 U2a/U2c 改线）与
 * submitFirstMessage 透传（后续 U2b 改线）消费同一 resolve 输出——「显示 ≡ 生效」由
 * 构造保证（by construction），不再靠对账。
 *
 * 导出面：
 * - resolveLaunchConfig：D2 字段优先级序 + D4 有效性校验（失效链内跳过回落下一档，
 *   KV 保留原值——本模块无 KV 写点）+ 每字段 provenance 标签
 *   （explicit / preset / lastUsed / memory / default）。
 * - isFactoryFullPreset：D3 出厂等价判定（PiLaunchPreset 的 11 个 launch 生效字段逐字段
 *   比对；出厂 builtin:full 时 resolve 输出 presetId=undefined 不透传）。
 * - ensureLaunchDataReady：数据源就绪聚合（D1 submit 侧加载窗口语义）。生产接线 = 仅直聚
 *   core KV 双源（lastUsedModel KV / 记忆表）；presets 就绪走壳侧 launchPort.ensureReady()
 *   （usePiPresets.loadPresets，flow.ts 并行 await）；providers 不等待（偏差 #15：WS
 *   initial-state 先于任何用户发送交互到达）；deps 形参为预留聚合形态（生产零消费，
 *   测试锚定）。已加载即同步返回 resolved promise；各源加载失败按既有 E1/E2/E4 语义
 *   收敛——回落默认，不 reject 不阻塞。
 * - createLaunchConfigView：P5① 响应式包装——输入经 getter 闭包读响应式数据源
 *   （如 last-used-model 模块 ref / preset store），数据延迟到达时输出自动重算。
 *
 * store 数据经 input 显式传入（core 零 store 依赖，同 ModelThinkingDeps deps 注入先例）；
 * last-used-model / model-thinking-memory 是 core 域内 KV 单例，直接 import
 * （同 model-thinking.ts import 先例，设计 D1「KV/记忆模块 core 域直接 import」）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import {
  BUILTIN_PRESET_IDS,
  DEFAULT_PRESETS,
  type PiLaunchPreset,
  type ProviderInfo,
} from '@taiji/shared'
import {
  loadOnce as loadLastUsedOnce,
  onLoaded as onLastUsedLoaded,
} from '../composer/last-used-model'
import {
  loadOnce as loadMemoryOnce,
  onLoaded as onMemoryLoaded,
} from '../composer/model-thinking-memory'
import {
  highestAvailableLevel,
  normalizeSupportedLevels,
  resolveThinkingValue,
  type ThinkingLevel,
} from '../composer/thinking-levels'

// ── provenance 标签（设计 D1）──────────────────────────────────────────

/**
 * 每字段解析结果的来源标签（§3.3 D1）：
 * - explicit：用户当次显式选择（pending 值）
 * - preset：生效 preset 的捆绑字段（modelOverride / thinkingLevel）
 * - lastUsed：跨任务延续值（lastUsedModel KV / 最近 session 目录）
 * - memory：per-model 记忆表档位
 * - default：全局默认 / 兜底（含 D4 校验失效后的回落结果）
 */
export type LaunchProvenance = 'explicit' | 'preset' | 'lastUsed' | 'memory' | 'default'

/** 新 session 生效配置（§2.6 术语：生效链末端真正用到的值）+ 每字段 provenance。 */
export interface LaunchConfig {
  /** 模型（'provider/modelId' 复合串；全链空时 ''——防御形态，消费方按未配置处理） */
  model: string
  modelProvenance: LaunchProvenance
  /**
   * 思考档位（发给 runtime/pi 的 value 域：authored/preset 档原样，memory/最高档经
   * thinkingLevelMap 转 value——与 Composer 现有 emit 值域一致，U2b 直接透传 thinkingOverride）
   */
  thinkingLevel: string
  thinkingProvenance: LaunchProvenance
  /**
   * 生效 preset id：出厂 builtin:full → undefined（D3 不透传，行为与写入面全等现状）；
   * 被字段级覆写过的 builtin:full / 自定义 preset → 正常透传 id
   */
  presetId: string | undefined
  presetProvenance: LaunchProvenance
  /** 工作目录（两空时 ''——E7 现行为静默落 homedir，本层只做解析输出不变更行为） */
  cwd: string
  cwdProvenance: LaunchProvenance
}

/** resolveLaunchConfig 输入（全部显式传入，纯函数不触任何 store/KV）。 */
export interface LaunchConfigInput {
  // ── 显式选择（landing pending 值，null/undefined/'' = 未显式选择）──
  /** 用户显式选定的模型（'provider/modelId' 复合串） */
  pendingModel?: string | null
  /**
   * 用户 authored 选档（U2a 后 localThinkingLevel 唯一写点 = onThinkingSelect，
   * 不含任何 auto 写入值——D1 authored 守卫的结构前提）。value 域。
   */
  pendingThinkingLevel?: string | null
  /** 用户显式选定的 preset id */
  pendingPreset?: string | null
  /** 用户显式选定的目录 */
  pendingCwd?: string | null

  // ── preset 解析数据 ──
  /** preset 列表（renderer preset store 经壳层注入） */
  presets?: readonly PiLaunchPreset[]
  /** 全局默认 preset id（PiPresetsFile.defaultPresetId，空 = 未设 → builtin:full） */
  defaultPresetId?: string | null

  // ── lastUsedModel KV 读值（D4 校验前的原值）──
  lastUsedModel?: string | null

  // ── 记忆表读值（per-model，按解析出的最终 model 查询）──
  getRememberedThinkingLevel?: (modelId: string) => string | undefined

  // ── providers 能力表（D4 校验 + thinkingLevelMap 派生）──
  providers?: readonly ProviderInfo[]

  // ── 全局默认模型 ──
  defaultModel?: string | null

  // ── 档位可用性（ModelThinkingDeps.getSupportedLevels 同款注入形态，pi 同源 supportedLevels）──
  getSupportedLevels?: (modelId: string) => string[] | undefined

  // ── cwd 链数据 ──
  /** 最近 session 目录（landing 预填） */
  recentSessionCwd?: string | null
  /** 默认 cwd（workspaceStore.defaultCwd） */
  defaultCwd?: string | null
}

// ── D3 出厂等价判定 ────────────────────────────────────────────────────

/** PiLaunchPreset 的非 launch 生效字段（标识/展示/簿记元数据），不参与出厂等价比对。 */
type PresetMetadataKey = 'id' | 'name' | 'description' | 'builtin' | 'order'

/**
 * PiLaunchPreset 的 launch 生效键全集（编译期从类型派生——新增生效字段自动入集）。
 */
export type PresetLaunchKey = Exclude<keyof PiLaunchPreset, PresetMetadataKey>

/**
 * 比对键运行时枚举（D3 十一字段 SSOT：toolMode / allowedTools / deniedTools / extensionMode /
 * allowedExtensions / deniedExtensions / modelOverride / thinkingLevel / noSkills / noContextFiles /
 * prompt）。
 *
 * prompt = 模式提示词对象（`{ replace?: {enabled,prompt}, append?: {enabled,prompt} }`，同
 * shared PresetPromptConfig）——它随 preset 落到新 session 的 pi 启动参数，是 launch 生效
 * 字段，故参与出厂等价比对（用户在提示词上的任何编辑都意味着「已覆写过 builtin:full」，
 * 不能被折叠成出厂等价而丢掉 presetId 透传）。比对走下方普通对象结构化分支。
 *
 * satisfies 映射类型做编译期穷尽强制（D3）：PiLaunchPreset 新增生效字段而漏登此表 →
 * Record<PresetLaunchKey, null> 缺键编译红；键拼写漂移 → 多余属性编译红。
 * skillPaths 不是 preset 字段（resolution 派生输出），不属于本集。
 */
export const PRESET_LAUNCH_KEYS = {
  toolMode: null,
  allowedTools: null,
  deniedTools: null,
  extensionMode: null,
  allowedExtensions: null,
  deniedExtensions: null,
  modelOverride: null,
  thinkingLevel: null,
  noSkills: null,
  noContextFiles: null,
  prompt: null,
} as const satisfies Record<PresetLaunchKey, null>

/** 比对键顺序表（isFactoryFullPreset 遍历用）。 */
const PRESET_LAUNCH_KEY_LIST: readonly PresetLaunchKey[] = Object.keys(
  PRESET_LAUNCH_KEYS,
) as PresetLaunchKey[]

/**
 * 普通对象判定（JSON 字面量形状：Object 原型或 null 原型；Array / Date / Map 等不算）。
 * 用于把「结构化对象」与「标量引用比较」两类语义分开——非普通对象（含跨 realm 对象，
 * 其原型不同 realm）仍走 `===`（保守不等 → 判为非出厂等价、透传 presetId，行为差异
 * 不会被吞）。
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 单个 launch 字段的出厂等价比对语义（P2b 锁定 + D3 对象扩展）：
 * - 标量：=== （undefined === undefined 等价）
 * - 数组：顺序敏感、undefined 与 [] 不等价（用户显式清空 ≠ 从未配置）
 * - 普通对象：按键结构化比对（键集合相同 + 逐键递归），见下
 *
 * 对象分支是 D3/P2b 比对语义的**扩展**——原锁定的是标量 / 数组两类；`prompt`
 * （`{ replace?, append? }`，每段 `{ enabled, prompt }`）是纯 JSON 对象，出厂 full 不带
 * 该字段，逐字段比对必须能区分「都没配置」与「配置了但文本相同/不同」。
 *
 * 边界（保持既有语义不回归）：
 * - `undefined` vs `undefined` → true（标量分支，既有语义保留）
 * - 一方 `undefined`，另一方对象/数组 → false（「从未配置」≠「显式配置」，不得因
 *   对象分支把它翻成等价）
 * - 键集合不同即不等（含 `{ replace: undefined }` 与 `{}`——显式写出未启用段也算配置
 *   痕迹，判非等价是保守方向）
 * - 数组语义不受影响（数组先于对象分支判定，顺序敏感、`undefined` ≠ `[]`）
 *
 * @internal 导出仅为 launch-config.test.ts 锚定比对语义，非公开 API。
 */
export function launchFieldEquals(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    return a.length === b.length && a.every((v, i) => v === b[i])
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false
    const aKeys = Object.keys(a)
    const bKeys = Object.keys(b)
    if (aKeys.length !== bKeys.length) return false
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(b, key) &&
        launchFieldEquals(a[key], b[key]),
    )
  }
  return a === b
}

/**
 * D3 出厂等价判定：preset 是否与出厂 builtin:full 定义在全部 launch 生效字段上逐字段等价。
 *
 * - id 非 builtin:full → 恒 false（谈不上出厂 full 等价）
 * - 出厂等价 → resolve 输出 presetId=undefined 不透传（写入面与现状全等）
 * - 被用户字段级覆写过（savePreset 只保护 id/builtin/order/name 四字段）→ false，正常透传
 * - 比对基准缺失（DEFAULT_PRESETS 无 FULL，理论不可达的 shared 常量损坏）→ 保守 false
 *   （透传侧：preset 内容仍随 resolve 生效，不吞行为差异）
 */
export function isFactoryFullPreset(preset: PiLaunchPreset): boolean {
  if (preset.id !== BUILTIN_PRESET_IDS.FULL) return false
  const factory = DEFAULT_PRESETS.find((p) => p.id === BUILTIN_PRESET_IDS.FULL)
  if (!factory) return false
  return PRESET_LAUNCH_KEY_LIST.every((key) =>
    launchFieldEquals(preset[key], factory[key]),
  )
}

// ── 模型有效性（D4）───────────────────────────────────────────────────

/**
 * 拆 'provider/modelId' 复合串（首 '/' 分割——provider 段自身不含 '/'，同 runtime
 * model.switched 回填的拆分先例）后在 providers 能力表中查 model 条目。
 * provider 不存在 / provider.enabled === false（D4：存在且 enabled）/ model 不在
 * 该 provider models 列表内 → undefined。
 */
function findModelEntry(
  modelId: string,
  providers: readonly ProviderInfo[],
): ProviderInfo['models'][number] | undefined {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return undefined // 无 provider 段或 provider 段为空 = 非法复合串
  const providerId = modelId.slice(0, slash)
  const modelPart = modelId.slice(slash + 1)
  if (!modelPart) return undefined
  const provider = providers.find((p) => p.id === providerId)
  if (!provider || provider.enabled === false) return undefined
  return provider.models.find((m) => m.id === modelPart)
}

// ── D2 字段优先级序解析 ────────────────────────────────────────────────

/**
 * preset 档解析：explicit(pendingPreset) > 全局默认预设 > builtin:full。
 * 各档 id 失效（指向已删条目）→ 链内跳过回落下一档（E4 语义延伸到 explicit 档）；
 * 三档全空（presets 列表不含 builtin:full 等）→ undefined（model/thinking 的 preset 档不可达）。
 */
function resolveEffectivePreset(input: LaunchConfigInput): {
  preset: PiLaunchPreset | undefined
  provenance: LaunchProvenance
} {
  const presets = input.presets ?? []
  const find = (id: string | null | undefined): PiLaunchPreset | undefined =>
    id ? presets.find((p) => p.id === id) : undefined
  if (input.pendingPreset) {
    const p = find(input.pendingPreset)
    if (p) return { preset: p, provenance: 'explicit' }
  }
  const byDefault = find(input.defaultPresetId)
  if (byDefault) return { preset: byDefault, provenance: 'default' }
  const byBuiltinFull = find(BUILTIN_PRESET_IDS.FULL)
  return byBuiltinFull
    ? { preset: byBuiltinFull, provenance: 'default' }
    : { preset: undefined, provenance: 'default' }
}

/**
 * model 档解析（D2）：explicit(pendingModel) > preset.modelOverride > lastUsedModel(D4 校验后)
 * > 全局默认。
 *
 * explicit / preset 档不做 D4 校验（显式选择的死模型由 pi 报错用户可见可改，同 runtime
 * C-RL-6「model 不校验值域」语义）；lastUsedModel 是跨任务延续的便利默认，消费前必须
 * D4 校验（provider 存在且 enabled、model 在列表内），失效链内跳过回落——KV 保留原值
 * 不覆写（provider 恢复后用户选择自动回来，resolve 纯函数无 KV 写点）。
 */
function resolveEffectiveModel(
  input: LaunchConfigInput,
  preset: PiLaunchPreset | undefined,
): { model: string; provenance: LaunchProvenance } {
  if (input.pendingModel) return { model: input.pendingModel, provenance: 'explicit' }
  if (preset?.modelOverride) {
    return { model: preset.modelOverride, provenance: 'preset' }
  }
  if (
    input.lastUsedModel &&
    findModelEntry(input.lastUsedModel, input.providers ?? []) !== undefined
  ) {
    return { model: input.lastUsedModel, provenance: 'lastUsed' }
  }
  return { model: input.defaultModel ?? '', provenance: 'default' }
}

/**
 * thinkingLevel 档解析（D2）：explicit(authored 选档) > preset.thinkingLevel > 记忆表
 * （per-model，可用性校验后）> 最高可用档。
 *
 * - explicit 档信任上游 authored 守卫（U2a 后唯一写点 onThinkingSelect）+ runtime S-RT-5
 *   白名单兜底，此处不重复校验
 * - 记忆档可用性校验（不在该模型 supported levels 内则跳过——能力注册表变化致记忆键
 *   失效时回落最高可用档，防 landing 显示不可用档）
 * - memory / 最高档输出经 thinkingLevelMap 转 value 域（与 Composer emit 值域一致）
 */
function resolveEffectiveThinkingLevel(
  input: LaunchConfigInput,
  preset: PiLaunchPreset | undefined,
  model: string,
): { thinkingLevel: string; provenance: LaunchProvenance } {
  if (input.pendingThinkingLevel) {
    return { thinkingLevel: input.pendingThinkingLevel, provenance: 'explicit' }
  }
  if (preset?.thinkingLevel) {
    return { thinkingLevel: preset.thinkingLevel, provenance: 'preset' }
  }
  const supported = normalizeSupportedLevels(input.getSupportedLevels?.(model))
  const remembered = input.getRememberedThinkingLevel?.(model)
  // map 从 providers 能力表派生（model 条目的 thinkingLevelMap；无条目/无 map = 恒等）
  const map = findModelEntry(model, input.providers ?? [])?.thinkingLevelMap
  if (remembered && (supported as readonly string[]).includes(remembered)) {
    return {
      thinkingLevel: resolveThinkingValue(remembered as ThinkingLevel, map),
      provenance: 'memory',
    }
  }
  return {
    thinkingLevel: resolveThinkingValue(highestAvailableLevel(supported), map),
    provenance: 'default',
  }
}

/**
 * cwd 档解析（D2，现行为不变只做解析输出）：explicit(pendingCwd) > 最近 session 目录预填
 * > defaultCwd。两空 → ''（E7 静默落 homedir 的提示属 U2b 范畴）。
 */
function resolveEffectiveCwd(input: LaunchConfigInput): {
  cwd: string
  provenance: LaunchProvenance
} {
  if (input.pendingCwd) return { cwd: input.pendingCwd, provenance: 'explicit' }
  if (input.recentSessionCwd) {
    return { cwd: input.recentSessionCwd, provenance: 'lastUsed' }
  }
  return { cwd: input.defaultCwd ?? '', provenance: 'default' }
}

/**
 * 新 session 生效配置解析（D1 单一解析点，纯函数——无 KV/store 写点）。
 *
 * 显示侧（chip）与 submit 侧（create 透传）必须消费同一输出，「显示 ≡ 生效」才由
 * 构造成立；任何一侢单独兜底都是发散源。
 */
export function resolveLaunchConfig(input: LaunchConfigInput): LaunchConfig {
  const { preset, provenance: presetProvenance } = resolveEffectivePreset(input)
  const { model, provenance: modelProvenance } = resolveEffectiveModel(input, preset)
  const { thinkingLevel, provenance: thinkingProvenance } = resolveEffectiveThinkingLevel(
    input,
    preset,
    model,
  )
  const { cwd, provenance: cwdProvenance } = resolveEffectiveCwd(input)
  return {
    model,
    modelProvenance,
    thinkingLevel,
    thinkingProvenance,
    // D3：出厂等价 builtin:full → undefined 不透传（不写 launchPresetId meta 与
    // .preset.json sidecar）；覆写过的 builtin:full / 自定义 preset → 正常透传
    presetId: preset && !isFactoryFullPreset(preset) ? preset.id : undefined,
    presetProvenance,
    cwd,
    cwdProvenance,
  }
}

// ── P5① 响应式包装 ────────────────────────────────────────────────────

/**
 * resolve 的响应式视图：输入经 getter 闭包读取（闭包内读响应式数据源——如
 * last-used-model 的 lookup()（模块级 ref）、preset store 的 computed——computed
 * 随之建立依赖）。KV/记忆表冷启动延迟到达时视图自动重算，chip 脱离默认占位值
 * （E2 显示侧语义 / P5① 探针机制）。
 */
export function createLaunchConfigView(
  getInput: () => LaunchConfigInput,
): ComputedRef<LaunchConfig> {
  return computed(() => resolveLaunchConfig(getInput()))
}

// ── D1 数据源就绪聚合 ──────────────────────────────────────────────────

/**
 * 单个异步数据源的加载契约（loadOnce/onLoaded 形态，对齐 last-used-model /
 * model-thinking-memory 既有模块签名）：loadOnce 幂等触发惰性预载；
 * onLoaded 注册加载完成回调（已完成则立即同步触发——ensure 据此同步返回）。
 */
export interface LaunchDataSource {
  loadOnce(): void
  onLoaded(cb: () => void): void
}

/**
 * 壳层注入的 store 数据源（core 零 store 依赖）：
 * - presets：preset 列表 + 全局默认 presetId（renderer preset store，一源覆盖两数据）
 * - providers：providers 能力表 + 全局默认模型（settings store，一源覆盖两数据）
 *
 * @internal 预留聚合形态：生产接线零消费（flow.ts 唯一调用点无参调用，presets 就绪走
 * 壳侧 launchPort.ensureReady、providers 按偏差 #15 不等待），仅 launch-config.test.ts
 * 注入锚定聚合语义。
 */
export interface LaunchDataDeps {
  presets?: LaunchDataSource
  providers?: LaunchDataSource
}

/** 单源等待：触发预载 + 注册完成回调；触发失败（坏 deps）按收敛语义放行不阻塞。 */
function waitSourceLoaded(source: LaunchDataSource): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      source.loadOnce()
      source.onLoaded(() => resolve())
    } catch {
      // E1/E2/E4 语义：数据源失败回落默认继续（resolve 占位值），不 reject 不阻塞发送
      resolve()
    }
  })
}

/**
 * 数据源就绪聚合（D1 submit 侧加载窗口语义）。生产接线形态（唯一调用点 flow.ts
 * submitFirstMessage，无参调用）：仅直聚 core KV 双源（lastUsedModel KV + 记忆表，
 * 模块单例直接 import）；presets 就绪由调用方并行 await 壳侧 launchPort.ensureReady()
 * （renderer usePiPresets.loadPresets）；providers 不等待（偏差 #15：settings providers
 * 经 WS initial-state 订阅推送，先于任何用户发送交互到达，占位窗口实践不可达）。
 * deps 形参 = 预留聚合形态（生产零消费，仅测试锚定注入语义）。全部已加载时同步返回
 * resolved promise（onLoaded 立即触发路径）；任一未加载则等到全部完成。
 *
 * 各源加载失败在模块内部已按 E1/E2/E4 收敛（KV 读失败 → undefined/空表 + 状态推进
 * loaded + 触发回调），本函数不 reject；调用方（U2b submitFirstMessage）await 后
 * 再 resolve，加载窗口内的占位值不会固化进新 session。
 */
export function ensureLaunchDataReady(deps: LaunchDataDeps = {}): Promise<void> {
  const sources: LaunchDataSource[] = [
    { loadOnce: loadLastUsedOnce, onLoaded: onLastUsedLoaded },
    { loadOnce: loadMemoryOnce, onLoaded: onMemoryLoaded },
  ]
  if (deps.presets) sources.push(deps.presets)
  if (deps.providers) sources.push(deps.providers)
  // waitSourceLoaded 永不 reject（失败在源内收敛为 resolve），allSettled 与 all 在此
  // 语义等价——用 allSettled 显式表达「任一源的状态不影响其余源的等待完成」
  return Promise.allSettled(sources.map(waitSourceLoaded)).then(() => undefined)
}
