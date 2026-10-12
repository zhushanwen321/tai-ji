/**
 * zcode 引擎 provider 启动同步模块（engine-provider-unification §3.3 D2/D4/D7）。
 *
 * runtime 启动段把 pi 侧 provider 配置映射为一份 zcode 校验源可读的副本（瘦形态，
 * 2026-10-12 D3 换轨后：纯 pi 侧产物载体，不透传真实文件内容——providerRules 仅含
 * pi 映射条目与 zai 关联条目、providerOrder 仅含 pi 追加序；真实条目的合并在读取时
 * 由 wrapper fs 拦截 merge 完成，本模块只负责生成侧）。
 *
 * 分层（映射纯函数零 IO，编排层收敛全部文件访问）：
 *   - mapPiProvidersToZcodeRules / buildZaiLinkedEntry：纯函数（数据进数据出，可字段级断言）
 *   - collectZcodeOccupiedProviderIds：让位判定四源并集（读真实 zcode 文件）
 *   - syncZcodeProviders：编排（resolver 单通道取凭据 → 纯映射 → 幂等落盘）
 *   - deriveZcodeEngineModels：settings 模型清单派生（真实 ∪ 副本 id 级聚合，真实优先）
 *
 * 凭据读取红线（C-proc-14）：pi 侧凭据只经 ProviderCredentialResolver 单通道，
 * 禁止自建解析链（守卫 scripts/check-provider-credential-reads.mjs）。
 * 跨包红线：runtime 不 import zcode-subagent-cli——zcode-builtin.json 定位逻辑与
 * preparer.ts locateZcodeBuiltinCatalog 同源复制（本文件 locateZcodeBuiltinCatalogSync，
 * 语义对齐 preparer.ts:246-294；漂移防线 = u2b 侧对账）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProviderConfigView, ModelsConfigView } from '../infra/pi/pi-provider-store.js'
import { atomicWrite } from '../utils/fs-utils.js'
import type { IConfigStore } from './ports/config.js'
import type {
  IProviderCredentialResolver,
  ResolvedProviderCredential,
} from './ports/provider-credential-resolver.js'
import { deriveEnabled, type MergedCatalogView } from './provider-catalog.js'

// ── 类型（副本条目形态：对齐真实 ~/.zcode/v2/provider_config.json 个人条目，锚点 5）──

/** 副本 providerRules 条目（zcode 个人 provider 单条形态）。 */
export interface ZcodeProviderRule { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly providerId: string
  readonly providerName: string
  readonly config: {
    readonly group: 'standard-personal'
    readonly access: { readonly type: 'api-key'; readonly apiKey: string }
    readonly api: { readonly type: string; readonly baseUrl: string }
    readonly personalModelIds: readonly string[]
    readonly modelOrder: readonly string[]
  }
}

/** 副本 providerModelRules 条目（per-model contextWindow 载体，D2 字段转换表）。 */
export interface ZcodeProviderModelRule { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly providerId: string
  readonly modelId: string
  readonly config: { readonly properties: { readonly contextWindow: number } }
}

/** 同步副本文件形态（顶层字段与真实 provider_config.json 同构，仅承载 pi 侧产物）。 */
export interface SyncedProviderConfigFile { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly schemaVersion: 1
  readonly config: {
    readonly providerOrder: readonly string[]
    readonly providerConfigRules: { readonly providerRules: readonly ZcodeProviderRule[] }
    readonly modelConfigRules: { readonly providerModelRules: readonly ZcodeProviderModelRule[] }
  }
}

/** 与 @taiji/shared protocol 的 SubagentEngineModelInfo 同构（shared 为显式 allowlist
 * 出口，该类型尚未登记——u7-rpc 消费时经桥接对齐，字段名 id/name 一致）。 */
export interface ZcodeEngineModelEntry { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly id: string
  readonly name?: string
}

/** 单条跳过登记（判定分支码 + 可读细节；六条判定对齐 D2 编号）。 */
export interface ProviderSyncSkip { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly providerId: string
  readonly rule:
    | 'no-credential' // ① 凭据不可得
    | 'unsupported-credential' // ① 凭据形态不支持（command / unresolved-env）
    | 'provider-disabled' // ② provider 级禁用（enabled:false 或白名单禁用）
    | 'no-base-url' // ③ baseUrl 三链全空
    | 'no-supported-api' // ④ 生效协议无 zcode 对应
    | 'per-model-mismatch' // ⑤ 模型级 api/baseUrl 覆盖与 provider 级生效值不一致
    | 'no-models' // 边界：过滤白名单/禁用后参与模型为空
    | 'yield-to-zcode' // ⑥ 同名让位（zcode 侧保留）
  readonly detail: string
}

/** 同步结果（D7 失败语义的出参载体）。 */
export interface ZcodeProviderSyncOutcome { // oe-exempt:20261012:framework:同步编排结果形态契约,单实现常态(类型契约先行)
  /** written=落盘；skipped-empty=pi 映射条目空（旧副本已删）；aborted=失败中止（保留上次产物） */
  readonly status: 'written' | 'skipped-empty' | 'aborted'
  readonly copyPath: string
  readonly ruleCount: number
  readonly skips: readonly ProviderSyncSkip[]
}

// ── 协议映射表（D2：zcode api.type 值域未从官方 schema 核实，仅两协议参与，宁缺毋错）──

/** pi api → zcode api.type（其余 KnownApi 8 种与未知串一律跳过）。 */
const ZCODE_API_TYPE_MAP: Readonly<Record<string, string>> = {
  'openai-completions': 'openai-chat-completions',
  'anthropic-messages': 'anthropic-messages',
}

// ── zai 关联特例常量（D4）──

/** zai 系官方 provider（前置分流：不进通用映射，走 coding-plan 网关关联）。 */
const ZAI_OFFICIAL_PROVIDER_IDS = ['zai-coding-cn', 'zai'] as const
type ZaiOfficialProviderId = (typeof ZAI_OFFICIAL_PROVIDER_IDS)[number]

/** 关联条目固定 id（个人条目形态——zcode Registry 对外部 spawn 只装载个人 provider）。 */
const ZAI_LINKED_ENTRY_ID = 'zai-coding-plan'

/** pi 侧 provider id → zcode 家族（决定 v2 builtin 条目与目录 coding-plan 条目的配对）。 */
const ZAI_FAMILY_OF: Readonly<Record<ZaiOfficialProviderId, 'bigmodel' | 'zai'>> = {
  'zai-coding-cn': 'bigmodel',
  'zai': 'zai',
}

/** v2 config.json 内 zcode 签发特有 token 的条目 id（本机实测形态，D4 前置①）。 */
const ZCODE_BUILTIN_TOKEN_ENTRY_ID: Readonly<Record<'bigmodel' | 'zai', string>> = {
  bigmodel: 'builtin:bigmodel-coding-plan',
  zai: 'builtin:zai-coding-plan',
}

// ── 依赖注入面 ─────────────────────────────────────────────────

/** 同步涉及的真实 zcode 文件路径与副本落盘路径（生产缺省由组合根拼装：真实文件在
 *  ~/.zcode 树下，副本路径按 engineDataDir 派生——接线单元实装）。 */
export interface ZcodeProviderSyncPaths { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly realProviderConfigPath: string
  readonly v2ConfigPath: string
  readonly cliConfigPath: string
  readonly syncedCopyPath: string
}

export interface ZcodeProviderSyncDeps { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly configStore: Pick<IConfigStore, 'readModels' | 'getEnabledModels'>
  /** pi 凭据唯一通道（C-proc-14）：明文解析（async）+ 存在性（sync，zai 前置）+ provider 级 baseUrl 两级解析 */
  readonly credentialResolver: Pick<
    IProviderCredentialResolver,
    'resolveProviderCredential' | 'hasProviderCredential' | 'resolveProviderBaseUrl'
  >
  readonly paths: ZcodeProviderSyncPaths
  /** models.json 损坏降级态判定（D7①：真抛错或损坏态 → 中止保留产物）。 */
  readonly isModelsCorrupted: () => boolean
  /** catalog 合并视图单点（getMergedCatalogModels 直传；纯函数注入便于测试）。 */
  readonly getMergedCatalogModels: (providerId: string) => MergedCatalogView | undefined
  /** zcode-builtin.json 定位覆盖（测试注入；缺省 = locateZcodeBuiltinCatalogSync）。 */
  readonly locateBuiltinCatalog?: () => string | undefined
  /** 日志通道（缺省 console.warn；skip/让位/中止 warn 全走此处）。 */
  readonly warn?: (message: string) => void
}

// ── 纯函数层：映射（D2 六条判定）──────────────────────────────

export interface ProviderMappingInput { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly providers: Record<string, ProviderConfigView>
  /** resolver 预解析结果（undefined = 无凭据；编排层单通道取得后传入，纯函数不做 IO）。 */
  readonly credentials: ReadonlyMap<string, ResolvedProviderCredential | undefined>
  /** provider 级生效 baseUrl（resolver.resolveProviderBaseUrl 两级语义直传）。 */
  readonly providerBaseUrlOf: (providerId: string) => string | undefined
  /** catalog 合并视图模型集（getMergedCatalogModels 直传形态）。 */
  readonly catalogModelsOf: (providerId: string) => readonly MappingModelSource[] | undefined
  readonly enabledModels: string[]
  /** 让位判定四源并集（collectZcodeOccupiedProviderIds 产物）。 */
  readonly occupiedProviderIds: ReadonlySet<string>
}

/** 参与模型的最小视图（models.json 模型与 catalog 模型统一到该形态进判定）。 */
export interface MappingModelSource { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly id: string
  readonly api?: string
  readonly baseUrl?: string
  readonly contextWindow?: number
  readonly enabled?: boolean
}

export interface ProviderMappingResult { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly rules: ZcodeProviderRule[]
  readonly modelRules: ZcodeProviderModelRule[]
  /** pi 追加序（models.json 声明序；让位条目不进）。 */
  readonly providerOrder: string[]
  readonly skips: ProviderSyncSkip[]
}

function isUsableUrl(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * 参与模型集（override ∪ catalog 去重追加，过滤白名单模型级 pattern 与 enabled:false）。
 * 序 = override 声明序在前、catalog 追加在后（pi-provider-store effectiveModelList 同款）。
 */
function participatingModels(
  providerId: string,
  cfg: ProviderConfigView,
  input: ProviderMappingInput,
): MappingModelSource[] {
  const overrides = (cfg.models ?? []).map(m => ({ ...m }))
  const catalog = input.catalogModelsOf(providerId) ?? []
  const merged = [
    ...overrides,
    ...catalog.filter(cm => !overrides.some(om => om.id === cm.id)),
  ]
  return merged.filter(m => {
    if (m.enabled === false) return false
    if (input.enabledModels.length === 0) return true
    return input.enabledModels.some(p => p === `${providerId}/*` || p === `${providerId}/${m.id}`)
  })
}

/**
 * 通用映射纯函数：pi providers → zcode providerRules（D2 判定①-⑥ 逐条，先命中先跳过）。
 * zai 系官方 provider 前置分流（D4），不经本函数。
 */
export function mapPiProvidersToZcodeRules(input: ProviderMappingInput): ProviderMappingResult {
  const rules: ZcodeProviderRule[] = []
  const modelRules: ZcodeProviderModelRule[] = []
  const providerOrder: string[] = []
  const skips: ProviderSyncSkip[] = []

  for (const [id, cfg] of Object.entries(input.providers)) {
    if ((ZAI_OFFICIAL_PROVIDER_IDS as readonly string[]).includes(id)) continue

    // ① 凭据可得 → 继续（resolver 单通道语义：unsupported 不降级、不映射为 api-key 条目）
    const cred = input.credentials.get(id)
    if (cred === undefined) {
      skips.push({ providerId: id, rule: 'no-credential', detail: 'resolver 两源（auth.json/models.json）均无凭据，跳过 zcode 同步' })
      continue
    }
    if ('unsupported' in cred) {
      skips.push({ providerId: id, rule: 'unsupported-credential', detail: `凭据形态不支持（${cred.unsupported}），不做 api-key 映射，请修正 pi 侧凭据配置` })
      continue
    }

    // ② provider 级禁用（models.json enabled:false 遗留形态 + enabledModels 白名单派生）→ 整条跳过
    if (cfg.enabled === false || !deriveEnabled(id, input.enabledModels)) {
      skips.push({ providerId: id, rule: 'provider-disabled', detail: 'provider 禁用（enabled:false 或白名单未启用），不同步' })
      continue
    }

    const models = participatingModels(id, cfg, input)
    if (models.length === 0) {
      skips.push({ providerId: id, rule: 'no-models', detail: '过滤白名单/禁用后无参与模型，跳过 zcode 同步' })
      continue
    }

    // ③⑤ baseUrl 判定：每模型生效值 = 模型级覆盖 ?? provider 级两级网关（pi provider-composer
    // `definition.baseUrl ?? config.baseUrl ?? defaults.baseUrl` 三链同构）；全空 → ③；不一致 → ⑤
    const providerBaseUrl = input.providerBaseUrlOf(id)
    const effectiveBaseUrls = new Set<string>()
    for (const m of models) {
      if (isUsableUrl(m.baseUrl)) effectiveBaseUrls.add(m.baseUrl)
      else if (isUsableUrl(providerBaseUrl)) effectiveBaseUrls.add(providerBaseUrl)
    }
    if (effectiveBaseUrls.size === 0) {
      skips.push({ providerId: id, rule: 'no-base-url', detail: 'baseUrl 三链全空（模型级/provider 级/catalog 级），跳过 zcode 同步——请在 taiji settings 补全 baseUrl 后重启' })
      continue
    }
    if (effectiveBaseUrls.size > 1) {
      skips.push({ providerId: id, rule: 'per-model-mismatch', detail: `模型级 baseUrl 覆盖与 provider 级生效值不一致（${[...effectiveBaseUrls].join(' vs ')}），zcode providerRule 是 provider 级单值，整条跳过` })
      continue
    }
    const baseUrl = [...effectiveBaseUrls][0]!

    // ④⑤ api 判定：每模型生效协议 = m.api ?? cfg.api；不一致 → ⑤；一致值无映射 → ④
    const effectiveApis = new Set<string>()
    for (const m of models) {
      if (typeof m.api === 'string' && m.api !== '') effectiveApis.add(m.api)
      else if (typeof cfg.api === 'string' && cfg.api !== '') effectiveApis.add(cfg.api)
    }
    if (effectiveApis.size > 1) {
      skips.push({ providerId: id, rule: 'per-model-mismatch', detail: `模型级协议覆盖与 provider 级不一致（${[...effectiveApis].join(' vs ')}），整条跳过` })
      continue
    }
    const effectiveApi = effectiveApis.size === 1 ? [...effectiveApis][0]! : undefined
    const zcodeApiType = effectiveApi !== undefined ? ZCODE_API_TYPE_MAP[effectiveApi] : undefined
    if (zcodeApiType === undefined) {
      skips.push({ providerId: id, rule: 'no-supported-api', detail: `生效协议 ${effectiveApi ?? '(未声明)'} 无 zcode 对应（仅映射 openai-completions/anthropic-messages），跳过` })
      continue
    }

    // ⑥ 同名让位（zcode 侧保留，pi 映射不进副本——运行时 merge 真实条目优先为第二道防线）
    if (input.occupiedProviderIds.has(id)) {
      skips.push({ providerId: id, rule: 'yield-to-zcode', detail: 'zcode 侧已有同名条目（四源并集命中），pi 映射让位' })
      continue
    }

    const modelIds = models.map(m => m.id)
    rules.push({
      providerId: id,
      providerName: isUsableUrl(cfg.name) ? cfg.name : id,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: cred.key },
        api: { type: zcodeApiType, baseUrl },
        personalModelIds: modelIds,
        modelOrder: modelIds,
      },
    })
    for (const m of models) {
      if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
        modelRules.push({ providerId: id, modelId: m.id, config: { properties: { contextWindow: m.contextWindow } } })
      }
    }
    providerOrder.push(id)
  }

  return { rules, modelRules, providerOrder, skips }
}

// ── 纯函数层：zai 关联特例（D4）────────────────────────────────

/** zcode-builtin.json coding-plan 目录条目的提取形态（关联条目 baseUrl/模型清单来源）。 */
export interface ZaiCodingPlanCatalogEntry { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly providerName?: string
  readonly baseUrl?: string
  readonly modelIds: readonly string[]
}

/** zai 特例输入（编排层读好 v2 token 与目录条目后传入；纯函数不做 IO）。 */
export interface ZaiLinkedEntryInput { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  /** pi 侧已配判定的 resolver 存在性结果（per zai 系 id）。 */
  readonly piConfigured: Readonly<Record<ZaiOfficialProviderId, boolean>>
  /** v2 config.json builtin 条目特有 token（apiKey 非空才有值；只读引用）。 */
  readonly builtinTokens: Readonly<Partial<Record<'bigmodel' | 'zai', string>>>
  /** zcode-builtin.json coding-plan 目录条目（per 家族；定位失败整族缺键）。 */
  readonly catalogEntries: Readonly<Partial<Record<'bigmodel' | 'zai', ZaiCodingPlanCatalogEntry>>>
  readonly occupiedProviderIds: ReadonlySet<string>
}

export type ZaiLinkedEntryResult =
  | { readonly entry: ZcodeProviderRule }
  | { readonly skip: ProviderSyncSkip }

/**
 * zai 关联条目（D4）：前置两条件（ZCode 端 builtin 条目 apiKey 非空 + pi 侧已配）齐备
 * 才生成；两家族同时满足时取 ZAI_OFFICIAL_PROVIDER_IDS 声明序首个（bigmodel 国内主力
 * 场景优先，裁决记 runlog）。缺任一前置 → 不生成 + warn 指引；同名让位同 ⑥。
 */
export function buildZaiLinkedEntry(input: ZaiLinkedEntryInput): ZaiLinkedEntryResult {
  for (const piId of ZAI_OFFICIAL_PROVIDER_IDS) {
    const family = ZAI_FAMILY_OF[piId]
    const token = input.builtinTokens[family]
    const catalog = input.catalogEntries[family]
    if (!input.piConfigured[piId] || token === undefined || catalog === undefined) continue

    if (input.occupiedProviderIds.has(ZAI_LINKED_ENTRY_ID)) {
      return {
        skip: {
          providerId: ZAI_LINKED_ENTRY_ID,
          rule: 'yield-to-zcode',
          detail: 'zcode 侧已有 zai-coding-plan 同名条目，关联条目让位',
        },
      }
    }
    if (!isUsableUrl(catalog.baseUrl)) {
      return {
        skip: {
          providerId: ZAI_LINKED_ENTRY_ID,
          rule: 'no-base-url',
          detail: 'zcode-builtin.json coding-plan 条目缺 baseUrl，关联条目不生成（zcode 目录形态变更？）',
        },
      }
    }
    if (catalog.modelIds.length === 0) {
      return {
        skip: {
          providerId: ZAI_LINKED_ENTRY_ID,
          rule: 'no-models',
          detail: 'zcode-builtin.json coding-plan 条目模型清单为空，关联条目不生成',
        },
      }
    }
    return {
      entry: {
        providerId: ZAI_LINKED_ENTRY_ID,
        providerName: catalog.providerName !== undefined && catalog.providerName.trim() !== ''
          ? catalog.providerName
          : ZAI_LINKED_ENTRY_ID,
        config: {
          group: 'standard-personal',
          access: { type: 'api-key', apiKey: token },
          api: { type: 'anthropic-messages', baseUrl: catalog.baseUrl },
          personalModelIds: catalog.modelIds,
          modelOrder: catalog.modelIds,
        },
      },
    }
  }

  // 无任何家族满足前置：按主力序给出缺哪个前置的指引（首个 zai 系 id 的缺失面描述）
  const first = ZAI_OFFICIAL_PROVIDER_IDS[0]
  const firstFamily = ZAI_FAMILY_OF[first]
  const missing = !input.piConfigured[first]
    ? `pi 侧未配置 ${first}（到 taiji settings 配置后重启生效）`
    : input.builtinTokens[firstFamily] === undefined
      ? 'ZCode 桌面端未完成 zai plan 设置（特有 token 未生成，请提前在 ZCode 端设置）'
      : 'zcode-builtin.json coding-plan 条目不可得（定位失败或形态变更），关联条目不生成'
  return {
    skip: { providerId: ZAI_LINKED_ENTRY_ID, rule: 'no-credential', detail: `zai 关联前置不齐备：${missing}` },
  }
}

// ── zcode 侧文件读取（让位四源 + zai 前置；ENOENT 与损坏分流见各函数）──────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((m): m is string => typeof m === 'string' && m.trim() !== '') : []
}

/** 读 JSON 文件的三态：ENOENT = 'absent'；读取/解析失败 = 'unreadable'（D7④分流依据）。 */
type JsonReadOutcome<T> = { readonly state: 'ok'; readonly value: T } | { readonly state: 'absent' } | { readonly state: 'unreadable' }

function readJsonFile<T = unknown>(absPath: string): JsonReadOutcome<T> {
  let raw: string
  try {
    raw = readFileSync(absPath, 'utf-8')
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'absent' }
    }
    return { state: 'unreadable' }
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) as T }
  } catch {
    return { state: 'unreadable' }
  }
}

/** 让位四源并集（D2⑥，谓词逐源对齐 wrapper 实装 appserver-launcher.ts:79-160）。 */
export interface ZcodeOccupiedIds { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly all: Set<string>
  /** 源①② 真实 provider_config.json（providerRules 键存在即算 + providerOrder 成员）。 */
  readonly personalConfig: Set<string>
  /** 源③ v2 config.json provider 字典（带 key 才算——wrapper hasKey 判定）。 */
  readonly v2WithKey: Set<string>
  /** 源④ cli config.json provider 字典（键存在即算、不看 key——wrapper realProviders 形态）。 */
  readonly cliAny: Set<string>
}

/**
 * 让位四源并集（同步侧）。provider_config ENOENT = 空集继续（D7③）；任何源读取异常
 * （非 ENOENT / JSON 损坏）抛错由编排层按 D7④中止——让位判定缺任何一源都会造成
 * 「校验链放行 × CLI 拒载」视图分叉（2026-08-25 事故同形态），中止保留旧副本更安全。
 */
export function collectZcodeOccupiedProviderIds(paths: Pick<ZcodeProviderSyncPaths, 'realProviderConfigPath' | 'v2ConfigPath' | 'cliConfigPath'>): ZcodeOccupiedIds {
  const personalConfig = new Set<string>()
  const providerConfig = readJsonFile(paths.realProviderConfigPath)
  if (providerConfig.state === 'unreadable') {
    throw new Error(`[zcode-provider-sync] 真实 provider_config.json 读取异常（${paths.realProviderConfigPath}），同步中止保留上次产物`)
  }
  if (providerConfig.state === 'ok' && isRecord(providerConfig.value)) {
    const config = providerConfig.value['config']
    if (isRecord(config)) {
      // 源①：providerRules 键存在即算（不看 apiKey——校验链按条目在册判 model_not_available）
      const rules = isRecord(config['providerConfigRules']) ? config['providerConfigRules']['providerRules'] : undefined
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          if (isRecord(rule) && typeof rule['providerId'] === 'string' && rule['providerId'] !== '') {
            personalConfig.add(rule['providerId'])
          }
        }
      }
      // 源②：providerOrder 成员
      for (const id of strArray(config['providerOrder'])) personalConfig.add(id)
    }
  }

  // 源③：v2 字典带 key 才算（wrapper injectable 判定 hasKey = options.apiKey 非空）
  const v2WithKey = new Set<string>()
  const v2 = readJsonFile(paths.v2ConfigPath)
  if (v2.state === 'unreadable') {
    throw new Error(`[zcode-provider-sync] v2 config.json 读取异常（${paths.v2ConfigPath}），同步中止保留上次产物`)
  }
  if (v2.state === 'ok' && isRecord(v2.value) && isRecord(v2.value['provider'])) {
    for (const [id, entry] of Object.entries(v2.value['provider'])) {
      if (!isRecord(entry)) continue
      const options = entry['options']
      if (isRecord(options) && typeof options['apiKey'] === 'string' && options['apiKey'] !== '') {
        v2WithKey.add(id)
      }
    }
  }

  // 源④：cli 字典键存在即算、不看 key（GUI-only 宿主可能从未写过，ENOENT = 空集）
  const cliAny = new Set<string>()
  const cli = readJsonFile(paths.cliConfigPath)
  if (cli.state === 'unreadable') {
    throw new Error(`[zcode-provider-sync] cli config.json 读取异常（${paths.cliConfigPath}），同步中止保留上次产物`)
  }
  if (cli.state === 'ok' && isRecord(cli.value) && isRecord(cli.value['provider'])) {
    for (const id of Object.keys(cli.value['provider'])) cliAny.add(id)
  }

  const all = new Set<string>([...personalConfig, ...v2WithKey, ...cliAny])
  return { all, personalConfig, v2WithKey, cliAny }
}

/**
 * v2 config.json 的 zai 系特有 token（builtin 条目 apiKey 非空才有值；只读引用，D4）。
 * absent = 文件 ENOENT——设计 §2 前提表行 6 / D3 效果段的前置缺失形态（wrapper fs 拦截
 * 整体不安装），编排层须据此 warn 提示，不静默。
 */
export function readZcodeBuiltinPlanTokens(
  v2ConfigPath: string,
): { readonly tokens: Partial<Record<'bigmodel' | 'zai', string>>; readonly readable: boolean; readonly absent: boolean } {
  const outcome = readJsonFile(v2ConfigPath)
  if (outcome.state !== 'ok' || !isRecord(outcome.value) || !isRecord(outcome.value['provider'])) {
    return {
      tokens: {},
      readable: outcome.state === 'ok' || outcome.state === 'absent',
      absent: outcome.state === 'absent',
    }
  }
  const tokens: Partial<Record<'bigmodel' | 'zai', string>> = {}
  for (const family of ['bigmodel', 'zai'] as const) {
    const entry = outcome.value['provider'][ZCODE_BUILTIN_TOKEN_ENTRY_ID[family]]
    if (!isRecord(entry)) continue
    const options = entry['options']
    if (isRecord(options) && typeof options['apiKey'] === 'string' && options['apiKey'] !== '') {
      tokens[family] = options['apiKey']
    }
  }
  return { tokens, readable: true, absent: false }
}

// ── zcode-builtin.json 定位（与 preparer.ts locateZcodeBuiltinCatalog 同源复制，跨包红线）──

/** semver 数值比较覆盖的版本段数（major.minor.patch，同源 preparer SEMVER_SEGMENTS）。 */
const SEMVER_SEGMENTS = 3

/** 副本 JSON 缩进（对齐真实 provider_config.json 的 2 空格形态）。 */
const COPY_JSON_INDENT = 2

/**
 * 内建 provider 目录定位：ZCODE_BUILTIN_PROVIDER_CONFIG_FILE env > `~/.zcode/v2/runtime/provider`
 * 平台目录 × semver 最大 × endpoint-* 扫描（语义同源复制自 zcode-subagent-cli preparer.ts
 * locateZcodeBuiltinCatalog:246-294——runtime 不 import 该包；漂移由 u2b 对账锁步）。
 * 找不到返回 undefined（zai 关联条目不生成 + warn）。
 */
export function locateZcodeBuiltinCatalogSync(explicitPath?: string): string | undefined {
  if (explicitPath !== undefined) return explicitPath
  const fromEnv = process.env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE']?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  try {
    const providerRoot = join(homedir(), '.zcode', 'v2', 'runtime', 'provider')
    const prefix = `${process.platform}-`
    const platDirs = readdirSync(providerRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith(prefix))
      .map(d => d.name)
    const byVerDesc = (a: string, b: string): number => {
      const pa = a.split('.')
      const pb = b.split('.')
      for (let i = 0; i < SEMVER_SEGMENTS; i++) {
        const na = Number.parseInt(pa[i] ?? '', 10) || 0
        const nb = Number.parseInt(pb[i] ?? '', 10) || 0
        if (na !== nb) return nb - na
      }
      return 0
    }
    for (const plat of platDirs) {
      const rtRoot = join(providerRoot, plat)
      let versions: string[] = []
      try {
        versions = readdirSync(rtRoot).filter(v => /^\d+\.\d+/.test(v)).sort(byVerDesc)
      } catch {
        continue
      }
      for (const ver of versions) {
        const verDir = join(rtRoot, ver)
        let endpoints: string[] = []
        try {
          endpoints = readdirSync(verDir).filter(e => e.startsWith('endpoint-')).sort()
        } catch {
          continue
        }
        for (const ep of endpoints) {
          const candidate = join(verDir, ep, 'zcode-builtin.json')
          if (existsSync(candidate)) return candidate
        }
      }
    }
  } catch {
    return undefined
  }
  return undefined
}

/** 目录 coding-plan 条目提取：access.accountType 匹配家族且 mode=individual-coding-plan。 */
export function readCodingPlanCatalogEntry(
  catalogPath: string,
  family: 'bigmodel' | 'zai',
): ZaiCodingPlanCatalogEntry | undefined {
  const outcome = readJsonFile(catalogPath)
  if (outcome.state !== 'ok' || !isRecord(outcome.value)) return undefined
  const config = outcome.value['config']
  const rules = isRecord(config) && isRecord(config['providerConfigRules'])
    ? config['providerConfigRules']['providerRules']
    : undefined
  if (!Array.isArray(rules)) return undefined
  for (const rule of rules) {
    if (!isRecord(rule)) continue
    const cfg = isRecord(rule['config']) ? rule['config'] : undefined
    if (!cfg) continue
    const access = isRecord(cfg['access']) ? cfg['access'] : undefined
    if (!access || access['accountType'] !== family || access['mode'] !== 'individual-coding-plan') continue
    const api = isRecord(cfg['api']) ? cfg['api'] : undefined
    return {
      providerName: typeof rule['providerName'] === 'string' ? rule['providerName'] : undefined,
      baseUrl: isRecord(api) && typeof api['baseUrl'] === 'string' ? api['baseUrl'] : undefined,
      modelIds: strArray(cfg['builtinModelIds']),
    }
  }
  return undefined
}

// ── 编排层：启动同步（D1 时机由组合根接线；D7 失败语义）────────

/** catalog 合并视图 → 纯函数模型源视图（MappingModelSource 的桥接形态）。 */
export function catalogViewToModelSources(view: MergedCatalogView | undefined): readonly MappingModelSource[] | undefined {
  return view?.models.map(m => ({
    id: m.id,
    api: typeof m.api === 'string' ? m.api : undefined,
    baseUrl: typeof m.baseUrl === 'string' ? m.baseUrl : undefined,
    contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : undefined,
  }))
}

/**
 * 启动同步编排（async：凭据明文经 resolver 单通道 async 解析）。
 * D7：任何失败中止都保留上次产物（不删不写）；落盘条件 = pi 映射条目（含 zai 关联）非空，
 * 空则删旧副本回落真实文件；幂等 = 同字节跳写 + tmp+rename 原子替换。
 */
export async function syncZcodeProviders(deps: ZcodeProviderSyncDeps): Promise<ZcodeProviderSyncOutcome> {
  const warn = deps.warn ?? ((msg: string) => console.warn(msg))
  const abort = (reason: string): ZcodeProviderSyncOutcome => {
    warn(`[zcode-provider-sync] 同步中止（保留上次产物）：${reason}`)
    return { status: 'aborted', copyPath: deps.paths.syncedCopyPath, ruleCount: 0, skips: [] }
  }

  // D7①：readModels 真抛错（IO 异常）或损坏态 → 中止保留产物（ENOENT 是 readModels
  // 内建容错返回空骨架，不在此列——按零配置继续）
  let models: ModelsConfigView
  try {
    models = deps.configStore.readModels()
  } catch (err) {
    return abort(`readModels 抛错：${err instanceof Error ? err.message : String(err)}`)
  }
  if (deps.isModelsCorrupted()) return abort('models.json 处于损坏降级态（已隔离）')

  // 让位四源（D7③④：ENOENT 容错空集；其余读取异常在此抛出 → 中止）
  let occupied: ZcodeOccupiedIds
  try {
    occupied = collectZcodeOccupiedProviderIds(deps.paths)
  } catch (err) {
    return abort(err instanceof Error ? err.message : String(err))
  }

  // zai 关联前置读取（v2 token + 目录条目；v2 unreadable 按 D7④中止——token 引用源失真）
  const { tokens, readable: v2Readable, absent: v2Absent } = readZcodeBuiltinPlanTokens(deps.paths.v2ConfigPath)
  if (!v2Readable) return abort(`v2 config.json 读取异常（${deps.paths.v2ConfigPath}）`)
  // 设计 §2 前提表行 6 / D3 效果段：v2 缺失时 wrapper 凭据注入整体不安装（appserver-launcher
  // injectedConfigText 对 ENOENT 返回 null），副本条目仅进校验链不进 Registry——显式 warn，
  // 不静默（防 N1/P-cli-eat 在该环境失败时无信号可归因）
  if (v2Absent) {
    warn(`[zcode-provider-sync] v2 config.json 缺失（${deps.paths.v2ConfigPath}）——wrapper 凭据注入不安装，同步副本条目仅进校验链不进 Registry；ZCode 桌面端完成设置后该文件自动出现，重启 taiji 生效`)
  }

  // zcode-builtin.json 定位（deps 注入了 locator 就完全信注入结果——含 undefined =
  // 定位失败；未注入走本模块同源扫描实现）
  const catalogPath = deps.locateBuiltinCatalog !== undefined
    ? deps.locateBuiltinCatalog()
    : locateZcodeBuiltinCatalogSync()
  if (catalogPath === undefined) {
    warn('[zcode-provider-sync] zcode-builtin.json 定位不到，zai 关联条目不生成（zcode 端未安装或目录形态变更）')
  }
  const catalogEntries: Partial<Record<'bigmodel' | 'zai', ZaiCodingPlanCatalogEntry>> = {}
  if (catalogPath !== undefined) {
    const parsed = readJsonFile(catalogPath)
    if (parsed.state === 'unreadable') return abort(`zcode-builtin.json 读取异常（${catalogPath}）`)
    if (parsed.state === 'ok') {
      for (const family of ['bigmodel', 'zai'] as const) {
        const entry = readCodingPlanCatalogEntry(catalogPath, family)
        if (entry !== undefined) catalogEntries[family] = entry
      }
    }
  }

  // 凭据单通道解析（只解析非 zai 系的通用映射候选；zai 系走存在性判定）
  const credentials = new Map<string, ResolvedProviderCredential | undefined>()
  for (const id of Object.keys(models.providers)) {
    if ((ZAI_OFFICIAL_PROVIDER_IDS as readonly string[]).includes(id)) continue
    credentials.set(id, await deps.credentialResolver.resolveProviderCredential(id))
  }

  const enabledModels = deps.configStore.getEnabledModels()
  const mapping = mapPiProvidersToZcodeRules({
    providers: models.providers,
    credentials,
    providerBaseUrlOf: id => deps.credentialResolver.resolveProviderBaseUrl(id),
    catalogModelsOf: id => catalogViewToModelSources(deps.getMergedCatalogModels(id)),
    enabledModels,
    occupiedProviderIds: occupied.all,
  })

  const zai = buildZaiLinkedEntry({
    piConfigured: {
      'zai-coding-cn': deps.credentialResolver.hasProviderCredential('zai-coding-cn'),
      'zai': deps.credentialResolver.hasProviderCredential('zai'),
    },
    builtinTokens: tokens,
    catalogEntries,
    occupiedProviderIds: occupied.all,
  })

  const skips = [...mapping.skips]
  const rules = [...mapping.rules]
  const modelRules = [...mapping.modelRules]
  const providerOrder = [...mapping.providerOrder]
  if ('entry' in zai) {
    rules.push(zai.entry)
    providerOrder.push(ZAI_LINKED_ENTRY_ID)
  } else {
    skips.push(zai.skip)
  }
  for (const skip of skips) {
    warn(`[zcode-provider-sync] provider "${skip.providerId}" ${skip.rule}：${skip.detail}`)
  }

  // 落盘条件（D7）：pi 映射条目（含 zai 关联）非空；空 → 删旧副本回落真实文件
  if (rules.length === 0) {
    if (existsSync(deps.paths.syncedCopyPath)) {
      try {
        rmSync(deps.paths.syncedCopyPath)
      } catch (err) {
        return abort(`旧副本删除失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return { status: 'skipped-empty', copyPath: deps.paths.syncedCopyPath, ruleCount: 0, skips }
  }

  const file: SyncedProviderConfigFile = {
    schemaVersion: 1,
    config: {
      providerOrder,
      providerConfigRules: { providerRules: rules },
      modelConfigRules: { providerModelRules: modelRules },
    },
  }
  const text = `${JSON.stringify(file, null, COPY_JSON_INDENT)}\n`
  try {
    // atomicWrite 不自建父目录（JsonStore 的 mkdirSync 职责在各自 store）——副本目录
    // 首次落盘时可能不存在（engines/zcode/），此处补建
    mkdirSync(dirname(deps.paths.syncedCopyPath), { recursive: true })
    if (existsSync(deps.paths.syncedCopyPath) && readFileSync(deps.paths.syncedCopyPath, 'utf-8') === text) {
      return { status: 'written', copyPath: deps.paths.syncedCopyPath, ruleCount: rules.length, skips }
    }
    atomicWrite(deps.paths.syncedCopyPath, text)
  } catch (err) {
    return abort(`副本落盘失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return { status: 'written', copyPath: deps.paths.syncedCopyPath, ruleCount: rules.length, skips }
}

// ── settings 清单派生（D5：真实 ∪ 副本 id 级聚合，真实优先；u7-rpc 复用）──────

/** 个人条目的清单派生最小视图（真实与副本统一形态）。 */
interface ModelListEntry { // oe-exempt:20261012:framework:清单派生内部聚合形态,单实现常态
  readonly providerId: string
  readonly providerName?: string
  readonly apiKey?: string
  readonly models: readonly string[]
}

function toModelListEntry(rule: unknown): ModelListEntry | undefined {
  if (!isRecord(rule)) return undefined
  const providerId = rule['providerId']
  if (typeof providerId !== 'string' || providerId.trim() === '') return undefined
  const cfg = isRecord(rule['config']) ? rule['config'] : {}
  const access = isRecord(cfg['access']) ? cfg['access'] : {}
  const personal = strArray(cfg['personalModelIds'])
  return {
    providerId,
    providerName: typeof rule['providerName'] === 'string' ? rule['providerName'] : undefined,
    apiKey: typeof access['apiKey'] === 'string' && access['apiKey'] !== '' ? access['apiKey'] : undefined,
    models: personal.length > 0 ? personal : strArray(cfg['modelOrder']),
  }
}

function readPersonalRules(absPath: string): ModelListEntry[] {
  const outcome = readJsonFile(absPath)
  if (outcome.state !== 'ok' || !isRecord(outcome.value)) return []
  const config = outcome.value['config']
  const rules = isRecord(config) && isRecord(config['providerConfigRules'])
    ? config['providerConfigRules']['providerRules']
    : undefined
  if (!Array.isArray(rules)) return []
  const entries: ModelListEntry[] = []
  for (const rule of rules) {
    const entry = toModelListEntry(rule)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * settings per-engine 模型清单派生：真实 provider_config.json 条目 ∪ 副本条目，
 * id 级聚合真实优先（同名时真实条目整条胜出——与 D3 merge 视图同语义）；仅聚合带
 * apiKey 的条目（与 zcode 校验链 listZcodeModels 同判据）；任一源不可读按空集继续
 * （查询面失败安全，非同步面）。
 */
export function deriveZcodeEngineModels(
  paths: Pick<ZcodeProviderSyncPaths, 'realProviderConfigPath' | 'syncedCopyPath'>,
): ZcodeEngineModelEntry[] {
  const byId = new Map<string, ModelListEntry>()
  for (const entry of readPersonalRules(paths.realProviderConfigPath)) byId.set(entry.providerId, entry)
  for (const entry of readPersonalRules(paths.syncedCopyPath)) {
    if (!byId.has(entry.providerId)) byId.set(entry.providerId, entry)
  }
  const out: ZcodeEngineModelEntry[] = []
  for (const entry of byId.values()) {
    if (entry.apiKey === undefined) continue
    const providerName = entry.providerName !== undefined && entry.providerName.trim() !== ''
      ? entry.providerName.trim()
      : undefined
    for (const model of entry.models) {
      out.push({
        id: `${entry.providerId}/${model}`,
        ...(providerName !== undefined ? { name: `${providerName} · ${model}` } : {}),
      })
    }
  }
  return out
}
