/**
 * zcode 引擎 provider 启动同步模块（engine-provider-unification §3.3 D2/D4/D7）。
 *
 * runtime 启动段把 pi 侧 provider 配置映射为一份 zcode 校验源可读的副本（瘦形态，
 * 2026-10-12 D3 换轨后：纯 pi 侧产物载体，不透传真实文件内容——providerRules 仅含
 * pi 映射条目、providerOrder 仅含 pi 追加序；真实条目的合并在读取时由 wrapper fs
 * 拦截 merge 完成，本模块只负责生成侧）。
 *
 * [engine-ref-translation]（2026-10-14 用户裁决）：pi 的 zai-coding-cn（智谱 GLM
 * coding plan 通道）不再映射条目进 zcode——它与 zcode 的
 * account:bigmodel-individual-coding-plan 是同一通道的两个名字，等价由派发期翻译
 * 承载（zcode-subagent-cli preparer translatePiModelRefToZcode，经
 * EnginePort.translateModelRef 接线）；GLM plan 凭据完全归 zcode 账号体系，零 key
 * 注入。其余 provider 1:1 完全原样映射（id/模型清单直传）。ADR-0132 的 zai 关联
 * 条目（id=zai-coding-plan）及其 2026-10-13 key 来源修订已退役。
 *
 * 分层（映射纯函数零 IO，编排层收敛全部文件访问）：
 *   - mapPiProvidersToZcodeRules：纯函数（数据进数据出，可字段级断言）
 *   - collectZcodeOccupiedProviderIds：让位判定四源并集（读真实 zcode 文件）
 *   - syncZcodeProviders：编排（resolver 单通道取凭据 → 纯映射 → 幂等落盘）
 *   - deriveZcodeEngineModels：settings 模型清单派生（真实 ∪ 副本 id 级聚合真实优先
 *     ∪ 内建目录 account: 直通家族）
 *
 * 凭据读取红线（C-proc-14）：pi 侧凭据只经 ProviderCredentialResolver 单通道，
 * 禁止自建解析链（检查 scripts/check-provider-credential-reads.mjs）。
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
    | 'translation-channel' // [engine-ref-translation] pi GLM plan 通道走派发期翻译，不映射条目
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

// ── 翻译通道常量（engine-ref-translation，2026-10-14 用户裁决）──

/**
 * pi GLM plan 通道（翻译通道，不进通用映射）：zai-coding-cn 与 zcode 的
 * account:bigmodel-individual-coding-plan 是同一通道的两个名字，等价由派发期翻译
 * 承载（zcode-subagent-cli preparer translatePiModelRefToZcode）；在 zcode 造同义
 * 条目、注入 pi 侧 key 均属退役形态（ADR-0132 zai 关联条目 + 2026-10-13 key 来源
 * 修订，均已删除）。pi 侧 `zai`（国际 API-key provider）按 1:1 通用映射直传。
 */
const TRANSLATION_CHANNEL_PROVIDER_IDS = ['zai-coding-cn'] as const

// ── 依赖注入范围 ─────────────────────────────────────────────────

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
  /** pi 凭据唯一通道（C-proc-14）：明文解析（async）+ provider 级 baseUrl 两级解析。 */
  readonly credentialResolver: Pick<
    IProviderCredentialResolver,
    'resolveProviderCredential' | 'resolveProviderBaseUrl'
  >
  readonly paths: ZcodeProviderSyncPaths
  /** models.json 损坏降级态判定（D7①：真抛错或损坏态 → 中止保留产物）。 */
  readonly isModelsCorrupted: () => boolean
  /** catalog 合并视图单点（getMergedCatalogModels 直传；纯函数注入便于测试）。 */
  readonly getMergedCatalogModels: (providerId: string) => MergedCatalogView | undefined
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

/** ③ 每模型生效 baseUrl 集合 = 模型级覆盖 ?? provider 级两级网关（pi provider-composer
 *  `definition.baseUrl ?? config.baseUrl ?? defaults.baseUrl` 三链同构）。 */
function effectiveBaseUrlsOf(
  models: readonly MappingModelSource[],
  providerBaseUrl: string | undefined,
): Set<string> {
  const effectiveBaseUrls = new Set<string>()
  for (const m of models) {
    if (isUsableUrl(m.baseUrl)) effectiveBaseUrls.add(m.baseUrl)
    else if (isUsableUrl(providerBaseUrl)) effectiveBaseUrls.add(providerBaseUrl)
  }
  return effectiveBaseUrls
}

/** ③⑤ baseUrl 判定：集合空 → ③（三链全空）；集合多值 → ⑤（模型级覆盖与 provider 级不一致）。 */
function effectiveBaseUrlOf(
  id: string,
  models: readonly MappingModelSource[],
  providerBaseUrl: string | undefined,
): { readonly skip: ProviderSyncSkip } | { readonly baseUrl: string } {
  const effectiveBaseUrls = effectiveBaseUrlsOf(models, providerBaseUrl)
  if (effectiveBaseUrls.size === 0) {
    return { skip: { providerId: id, rule: 'no-base-url', detail: 'baseUrl 三链全空（模型级/provider 级/catalog 级），跳过 zcode 同步——请在 taiji settings 补全 baseUrl 后重启' } }
  }
  if (effectiveBaseUrls.size > 1) {
    return { skip: { providerId: id, rule: 'per-model-mismatch', detail: `模型级 baseUrl 覆盖与 provider 级生效值不一致（${[...effectiveBaseUrls].join(' vs ')}），zcode providerRule 是 provider 级单值，整条跳过` } }
  }
  return { baseUrl: [...effectiveBaseUrls][0]! }
}

/** ④ 每模型生效协议集合 = m.api ?? cfg.api。 */
function effectiveApisOf(models: readonly MappingModelSource[], cfg: ProviderConfigView): Set<string> {
  const effectiveApis = new Set<string>()
  for (const m of models) {
    if (typeof m.api === 'string' && m.api !== '') effectiveApis.add(m.api)
    else if (typeof cfg.api === 'string' && cfg.api !== '') effectiveApis.add(cfg.api)
  }
  return effectiveApis
}

/** ④⑤ api 判定：集合多值 → ⑤（协议不一致）；一致值无 zcode 映射 → ④；否则返回映射值。 */
function zcodeApiTypeOf(
  id: string,
  models: readonly MappingModelSource[],
  cfg: ProviderConfigView,
): { readonly skip: ProviderSyncSkip } | { readonly apiType: string } {
  const effectiveApis = effectiveApisOf(models, cfg)
  if (effectiveApis.size > 1) {
    return { skip: { providerId: id, rule: 'per-model-mismatch', detail: `模型级协议覆盖与 provider 级不一致（${[...effectiveApis].join(' vs ')}），整条跳过` } }
  }
  const effectiveApi = effectiveApis.size === 1 ? [...effectiveApis][0]! : undefined
  const zcodeApiType = effectiveApi !== undefined ? ZCODE_API_TYPE_MAP[effectiveApi] : undefined
  if (zcodeApiType === undefined) {
    return { skip: { providerId: id, rule: 'no-supported-api', detail: `生效协议 ${effectiveApi ?? '(未声明)'} 无 zcode 对应（仅映射 openai-completions/anthropic-messages），跳过` } }
  }
  return { apiType: zcodeApiType }
}

/** 正条附带的 per-model 规则（contextWindow 正数才产出——D2 字段转换表）。 */
function modelRulesOf(
  providerId: string,
  models: readonly MappingModelSource[],
): ZcodeProviderModelRule[] {
  const modelRules: ZcodeProviderModelRule[] = []
  for (const m of models) {
    if (typeof m.contextWindow === 'number' && m.contextWindow > 0) {
      modelRules.push({ providerId, modelId: m.id, config: { properties: { contextWindow: m.contextWindow } } })
    }
  }
  return modelRules
}

/** 单 provider 映射产物：skip = D2 判定命中；rule = 正向映射条目（含 per-model 规则）。 */
type SingleProviderMapping =
  | { readonly skip: ProviderSyncSkip }
  | { readonly rule: ZcodeProviderRule; readonly modelRules: ZcodeProviderModelRule[] }

/** 单 provider 判定链（D2 判定①-⑥ 逐条，先命中先跳过；分支体判定段见上方各 helper）。 */
function mapSingleProviderToZcodeRule(
  id: string,
  cfg: ProviderConfigView,
  input: ProviderMappingInput,
): SingleProviderMapping {
  if ((TRANSLATION_CHANNEL_PROVIDER_IDS as readonly string[]).includes(id)) {
    return {
      skip: {
        providerId: id,
        rule: 'translation-channel',
        detail: 'pi GLM plan 通道不映射条目——与 zcode account:bigmodel-individual-coding-plan 的等价由派发期翻译承载（2026-10-14 用户裁决）',
      },
    }
  }

  // ① 凭据可得 → 继续（resolver 单通道语义：unsupported 不降级、不映射为 api-key 条目）
  const cred = input.credentials.get(id)
  if (cred === undefined) {
    return { skip: { providerId: id, rule: 'no-credential', detail: 'resolver 两源（auth.json/models.json）均无凭据，跳过 zcode 同步' } }
  }
  if ('unsupported' in cred) {
    return { skip: { providerId: id, rule: 'unsupported-credential', detail: `凭据形态不支持（${cred.unsupported}），不做 api-key 映射，请修正 pi 侧凭据配置` } }
  }

  // ② provider 级禁用（models.json enabled:false 遗留形态 + enabledModels 白名单派生）→ 整条跳过
  if (cfg.enabled === false || !deriveEnabled(id, input.enabledModels)) {
    return { skip: { providerId: id, rule: 'provider-disabled', detail: 'provider 禁用（enabled:false 或白名单未启用），不同步' } }
  }

  const models = participatingModels(id, cfg, input)
  if (models.length === 0) {
    return { skip: { providerId: id, rule: 'no-models', detail: '过滤白名单/禁用后无参与模型，跳过 zcode 同步' } }
  }

  const baseUrlStep = effectiveBaseUrlOf(id, models, input.providerBaseUrlOf(id))
  if ('skip' in baseUrlStep) return baseUrlStep

  const apiStep = zcodeApiTypeOf(id, models, cfg)
  if ('skip' in apiStep) return apiStep

  // ⑥ 同名让位（zcode 侧保留，pi 映射不进副本——运行时 merge 真实条目优先为第二道防线）
  if (input.occupiedProviderIds.has(id)) {
    return { skip: { providerId: id, rule: 'yield-to-zcode', detail: 'zcode 侧已有同名条目（四源并集命中），pi 映射让位' } }
  }

  const modelIds = models.map(m => m.id)
  return {
    rule: {
      providerId: id,
      providerName: isUsableUrl(cfg.name) ? cfg.name : id,
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: cred.key },
        api: { type: apiStep.apiType, baseUrl: baseUrlStep.baseUrl },
        personalModelIds: modelIds,
        modelOrder: modelIds,
      },
    },
    modelRules: modelRulesOf(id, models),
  }
}

/**
 * 通用映射纯函数：pi providers → zcode providerRules（D2 判定①-⑥ 逐条，先命中先跳过；
 * 单 provider 判定链在 mapSingleProviderToZcodeRule）。翻译通道（zai-coding-cn）不进
 * 本函数映射面——等价由派发期翻译承载（engine-ref-translation，2026-10-14 用户裁决）。
 */
export function mapPiProvidersToZcodeRules(input: ProviderMappingInput): ProviderMappingResult {
  const rules: ZcodeProviderRule[] = []
  const modelRules: ZcodeProviderModelRule[] = []
  const providerOrder: string[] = []
  const skips: ProviderSyncSkip[] = []

  for (const [id, cfg] of Object.entries(input.providers)) {
    const mapped = mapSingleProviderToZcodeRule(id, cfg, input)
    if ('skip' in mapped) {
      skips.push(mapped.skip)
      continue
    }
    rules.push(mapped.rule)
    for (const modelRule of mapped.modelRules) modelRules.push(modelRule)
    providerOrder.push(id)
  }

  return { rules, modelRules, providerOrder, skips }
}

// ── zcode 侧文件读取（让位四源；ENOENT 与损坏分流见各函数）──────────

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

/** 源①②：真实 provider_config.json 的让位 id（providerRules 键存在即算 + providerOrder 成员；
 *  ENOENT = 空集继续 D7③，其余读取异常抛错由编排层按 D7④中止）。 */
function readPersonalConfigOccupiedIds(absPath: string): Set<string> {
  const personalConfig = new Set<string>()
  const providerConfig = readJsonFile(absPath)
  if (providerConfig.state === 'unreadable') {
    throw new Error(`[zcode-provider-sync] 真实 provider_config.json 读取异常（${absPath}），同步中止保留上次产物`)
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
  return personalConfig
}

/** 源③：v2 config.json provider 字典带 key 才算（wrapper injectable 判定 hasKey = options.apiKey 非空）。 */
function readV2ProviderIdsWithKey(absPath: string): Set<string> {
  const v2WithKey = new Set<string>()
  const v2 = readJsonFile(absPath)
  if (v2.state === 'unreadable') {
    throw new Error(`[zcode-provider-sync] v2 config.json 读取异常（${absPath}），同步中止保留上次产物`)
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
  return v2WithKey
}

/** 源④：cli config.json provider 字典键存在即算、不看 key（GUI-only 宿主可能从未写过，ENOENT = 空集）。 */
function readCliProviderIds(absPath: string): Set<string> {
  const cliAny = new Set<string>()
  const cli = readJsonFile(absPath)
  if (cli.state === 'unreadable') {
    throw new Error(`[zcode-provider-sync] cli config.json 读取异常（${absPath}），同步中止保留上次产物`)
  }
  if (cli.state === 'ok' && isRecord(cli.value) && isRecord(cli.value['provider'])) {
    for (const id of Object.keys(cli.value['provider'])) cliAny.add(id)
  }
  return cliAny
}

/**
 * 让位四源并集（同步侧）。provider_config ENOENT = 空集继续（D7③）；任何源读取异常
 * （非 ENOENT / JSON 损坏）抛错由编排层按 D7④中止——让位判定缺任何一源都会造成
 * 「校验链放行 × CLI 拒载」视图分叉（2026-08-25 事故同形态），中止保留旧副本更安全。
 */
export function collectZcodeOccupiedProviderIds(paths: Pick<ZcodeProviderSyncPaths, 'realProviderConfigPath' | 'v2ConfigPath' | 'cliConfigPath'>): ZcodeOccupiedIds {
  const personalConfig = readPersonalConfigOccupiedIds(paths.realProviderConfigPath)
  const v2WithKey = readV2ProviderIdsWithKey(paths.v2ConfigPath)
  const cliAny = readCliProviderIds(paths.cliConfigPath)
  const all = new Set<string>([...personalConfig, ...v2WithKey, ...cliAny])
  return { all, personalConfig, v2WithKey, cliAny }
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

/** v2 config JSON → providerRules 数组（缺键/形变 → undefined）。 */
function providerRulesOf(value: Record<string, unknown>): readonly unknown[] | undefined {
  const config = value['config']
  const rules = isRecord(config) && isRecord(config['providerConfigRules'])
    ? config['providerConfigRules']['providerRules']
    : undefined
  return Array.isArray(rules) ? rules : undefined
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

/** 编排步骤 helper 的两态产物：aborted = D7 中止 outcome（保留上次产物）；data = 继续编排。 */
type SyncStep<T> = { readonly aborted: ZcodeProviderSyncOutcome } | { readonly data: T }

/** 编排中止出口（闭包形态由 syncZcodeProviders 提供，helper 只产出 outcome）。 */
type SyncAbort = (reason: string) => ZcodeProviderSyncOutcome

/** D7① 步：readModels 真抛错（IO 异常）或损坏态 → 中止保留产物（ENOENT 是 readModels
 *  内建容错返回空骨架，不在此列——按零配置继续）。 */
function readModelsForSync(
  deps: ZcodeProviderSyncDeps,
  abort: SyncAbort,
): SyncStep<ModelsConfigView> {
  let models: ModelsConfigView
  try {
    models = deps.configStore.readModels()
  } catch (err) {
    return { aborted: abort(`readModels 抛错：${err instanceof Error ? err.message : String(err)}`) }
  }
  if (deps.isModelsCorrupted()) return { aborted: abort('models.json 处于损坏降级态（已隔离）') }
  return { data: models }
}

/** 让位四源步（D7③④：ENOENT 容错空集；其余读取异常在此捕获 → 中止）。 */
function collectOccupiedForSync(
  deps: ZcodeProviderSyncDeps,
  abort: SyncAbort,
): SyncStep<ZcodeOccupiedIds> {
  let occupied: ZcodeOccupiedIds
  try {
    occupied = collectZcodeOccupiedProviderIds(deps.paths)
  } catch (err) {
    return { aborted: abort(err instanceof Error ? err.message : String(err)) }
  }
  return { data: occupied }
}

/**
 * v2 config.json 可读性检查（编排前置 warn，非同步输入——engine-ref-translation 后本模块
 * 不再读 v2 token/目录条目，副本内容与 v2 无关）。v2 缺失 = wrapper 凭据注入整体不安装
 * （appserver-launcher injectedConfigText 对 ENOENT 返回 null），副本条目仅进校验链不进
 * Registry——显式 warn 不静默（防该环境失败时无信号可归因）；不可读同 warn（wrapper
 * 侧 hasKey 判定同样失败，后果同形态）。
 */
function checkV2ConfigForSync(deps: ZcodeProviderSyncDeps, warn: (message: string) => void): void {
  const outcome = readJsonFile(deps.paths.v2ConfigPath)
  if (outcome.state === 'absent' || outcome.state === 'unreadable') {
    warn(`[zcode-provider-sync] v2 config.json ${outcome.state === 'absent' ? '缺失' : '不可读'}（${deps.paths.v2ConfigPath}）——wrapper 凭据注入不安装，同步副本条目仅进校验链不进 Registry；ZCode 桌面端完成设置后重启 taiji 生效`)
  }
}

/** 凭据单通道解析步（只解析通用映射候选；翻译通道条目不映射、无凭据需求）。 */
async function resolveCredentialsForSync(
  deps: ZcodeProviderSyncDeps,
  providers: Record<string, ProviderConfigView>,
): Promise<Map<string, ResolvedProviderCredential | undefined>> {
  const credentials = new Map<string, ResolvedProviderCredential | undefined>()
  for (const id of Object.keys(providers)) {
    if ((TRANSLATION_CHANNEL_PROVIDER_IDS as readonly string[]).includes(id)) continue
    credentials.set(id, await deps.credentialResolver.resolveProviderCredential(id))
  }
  return credentials
}

/** 落盘载荷（纯映射产物四数组；skips 随 outcome 出参）。 */
interface SyncedCopyPayload { // oe-exempt:20261012:framework:映射链形态/ports 契约,单实现常态(类型契约先行)
  readonly rules: ZcodeProviderRule[]
  readonly modelRules: ZcodeProviderModelRule[]
  readonly providerOrder: string[]
  readonly skips: ProviderSyncSkip[]
}

/** 落盘载荷组装（映射产物直通 + skips 全量 warn——warn 通道同一出口）。 */
function buildSyncPayload(mapping: ProviderMappingResult, warn: (message: string) => void): SyncedCopyPayload {
  for (const skip of mapping.skips) {
    warn(`[zcode-provider-sync] provider "${skip.providerId}" ${skip.rule}：${skip.detail}`)
  }
  return {
    rules: [...mapping.rules],
    modelRules: [...mapping.modelRules],
    providerOrder: [...mapping.providerOrder],
    skips: mapping.skips,
  }
}

/** 落盘条件步（D7）：pi 映射条目（含 zai 关联）空 → 删旧副本回落真实文件并返回
 *  skipped-empty；非空返回 null 继续落盘。 */
function removeStaleCopyOrOutcome(
  deps: ZcodeProviderSyncDeps,
  payload: SyncedCopyPayload,
  abort: SyncAbort,
): ZcodeProviderSyncOutcome | null {
  if (payload.rules.length !== 0) return null
  if (existsSync(deps.paths.syncedCopyPath)) {
    try {
      rmSync(deps.paths.syncedCopyPath)
    } catch (err) {
      return abort(`旧副本删除失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { status: 'skipped-empty', copyPath: deps.paths.syncedCopyPath, ruleCount: 0, skips: payload.skips }
}

/** 落盘步：幂等 = 同字节跳写 + tmp+rename 原子替换（任何失败经 abort 保留上次产物）。 */
function writeSyncedCopy(
  deps: ZcodeProviderSyncDeps,
  payload: SyncedCopyPayload,
  abort: SyncAbort,
): ZcodeProviderSyncOutcome {
  const file: SyncedProviderConfigFile = {
    schemaVersion: 1,
    config: {
      providerOrder: payload.providerOrder,
      providerConfigRules: { providerRules: payload.rules },
      modelConfigRules: { providerModelRules: payload.modelRules },
    },
  }
  const text = `${JSON.stringify(file, null, COPY_JSON_INDENT)}\n`
  try {
    // atomicWrite 不自建父目录（JsonStore 的 mkdirSync 职责在各自 store）——副本目录
    // 首次落盘时可能不存在（engines/zcode/），此处补建
    mkdirSync(dirname(deps.paths.syncedCopyPath), { recursive: true })
    if (existsSync(deps.paths.syncedCopyPath) && readFileSync(deps.paths.syncedCopyPath, 'utf-8') === text) {
      return { status: 'written', copyPath: deps.paths.syncedCopyPath, ruleCount: payload.rules.length, skips: payload.skips }
    }
    atomicWrite(deps.paths.syncedCopyPath, text)
  } catch (err) {
    return abort(`副本落盘失败：${err instanceof Error ? err.message : String(err)}`)
  }
  return { status: 'written', copyPath: deps.paths.syncedCopyPath, ruleCount: payload.rules.length, skips: payload.skips }
}

/**
 * 启动同步编排（async：凭据明文经 resolver 单通道 async 解析）。
 * D7：任何失败中止都保留上次产物（不删不写）；落盘条件 = pi 映射条目非空，
 * 空则删旧副本回落真实文件；幂等 = 同字节跳写 + tmp+rename 原子替换。
 * 编排段拆分为上方 *ForSync helpers——调用顺序即原编排时序，中止点逐段保形。
 */
export async function syncZcodeProviders(deps: ZcodeProviderSyncDeps): Promise<ZcodeProviderSyncOutcome> {
  const warn = deps.warn ?? ((msg: string) => console.warn(msg))
  const abort = (reason: string): ZcodeProviderSyncOutcome => {
    warn(`[zcode-provider-sync] 同步中止（保留上次产物）：${reason}`)
    return { status: 'aborted', copyPath: deps.paths.syncedCopyPath, ruleCount: 0, skips: [] }
  }

  const modelsStep = readModelsForSync(deps, abort)
  if ('aborted' in modelsStep) return modelsStep.aborted
  const models = modelsStep.data

  const occupiedStep = collectOccupiedForSync(deps, abort)
  if ('aborted' in occupiedStep) return occupiedStep.aborted
  const occupied = occupiedStep.data

  checkV2ConfigForSync(deps, warn)

  const credentials = await resolveCredentialsForSync(deps, models.providers)

  const enabledModels = deps.configStore.getEnabledModels()
  const mapping = mapPiProvidersToZcodeRules({
    providers: models.providers,
    credentials,
    providerBaseUrlOf: id => deps.credentialResolver.resolveProviderBaseUrl(id),
    catalogModelsOf: id => catalogViewToModelSources(deps.getMergedCatalogModels(id)),
    enabledModels,
    occupiedProviderIds: occupied.all,
  })

  const payload = buildSyncPayload(mapping, warn)

  const emptyOutcome = removeStaleCopyOrOutcome(deps, payload, abort)
  if (emptyOutcome !== null) return emptyOutcome

  return writeSyncedCopy(deps, payload, abort)
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
  const rules = providerRulesOf(outcome.value)
  if (!rules) return []
  const entries: ModelListEntry[] = []
  for (const rule of rules) {
    const entry = toModelListEntry(rule)
    if (entry !== undefined) entries.push(entry)
  }
  return entries
}

/**
 * settings 模型清单派生路径（个人双源 + 内建目录；deps 注入优先，缺省同源拼装）。
 */
export interface ZcodeModelListPaths extends Pick<ZcodeProviderSyncPaths, 'realProviderConfigPath' | 'syncedCopyPath'> { // oe-exempt:20261012:framework:清单派生路径契约,单实现常态(类型契约先行)
  /** 内建目录路径（缺省 = locateZcodeBuiltinCatalogSync 现场定位；测试注入 fixture）。 */
  readonly builtinCatalogPath?: string
}

/**
 * settings per-engine 模型清单派生：真实 provider_config.json 条目 ∪ 副本条目，
 * id 级聚合真实优先（同名时真实条目整条胜出——与 D3 merge 视图同语义）；个人条目仅
 * 聚合带 apiKey 的（与 zcode 校验链 listZcodeModels 同判据）；∪ 内建目录 account:
 * 直通家族（[engine-ref-translation D3] 2026-10-13/14 用户裁决——account 条目凭据走
 * zcode CLI 账号体系不经个人 provider 表，无 apiKey 过滤；与 preparer listZcodeModels
 * 的 account 段对账锁步，跨包红线：runtime 不 import zcode-subagent-cli）。
 * 任一源不可读按空集继续（查询环节失败安全，非同步环节）。
 */
export function deriveZcodeEngineModels(paths: ZcodeModelListPaths): ZcodeEngineModelEntry[] {
  const byId = new Map<string, ModelListEntry>()
  for (const entry of readPersonalRules(paths.realProviderConfigPath)) byId.set(entry.providerId, entry)
  for (const entry of readPersonalRules(paths.syncedCopyPath)) {
    if (!byId.has(entry.providerId)) byId.set(entry.providerId, entry)
  }
  const out: ZcodeEngineModelEntry[] = []
  const push = (entry: ModelListEntry): void => {
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
  for (const entry of byId.values()) {
    if (entry.apiKey === undefined) continue
    push(entry)
  }
  for (const entry of readAccountFamilyRules(paths.builtinCatalogPath)) {
    if (byId.has(entry.providerId)) continue
    push(entry)
  }
  return out
}

/** 内建目录 account: 直通家族规则（与 preparer resolveAccountModelRef 同源判据；失败安全空集）。 */
function readAccountFamilyRules(builtinCatalogPath?: string): ModelListEntry[] {
  const catalogPath = builtinCatalogPath ?? locateZcodeBuiltinCatalogSync()
  if (catalogPath === undefined) return []
  const outcome = readJsonFile(catalogPath)
  if (outcome.state !== 'ok' || !isRecord(outcome.value)) return []
  const rules = providerRulesOf(outcome.value)
  if (!rules) return []
  const entries: ModelListEntry[] = []
  for (const rule of rules) {
    if (!isRecord(rule)) continue
    const providerId = rule['providerId']
    if (typeof providerId !== 'string' || !providerId.startsWith('account:')) continue
    const cfg = isRecord(rule['config']) ? rule['config'] : {}
    const builtin = strArray(cfg['builtinModelIds'])
    const personal = strArray(cfg['personalModelIds'])
    entries.push({
      providerId,
      providerName: typeof rule['providerName'] === 'string' ? rule['providerName'] : undefined,
      models: builtin.length > 0 ? builtin : personal,
    })
  }
  return entries
}
