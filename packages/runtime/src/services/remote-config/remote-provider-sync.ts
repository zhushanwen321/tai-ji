/**
 * taiji 远程配置 — provider 清单域（域 1）：taiji 自有 provider 模板 + 模型热更新。
 *
 * 三层更新通道的 taiji 自有层（设计 .tmp/tech-design/remote-config-and-quota.md §4.2）：
 * - pi catalog 层走 pi.dev overlay（provider-catalog-refresh.ts，不在此列）；
 * - 本域清单是「添加供应商」模板的**新增来源**（与 pi catalog 快照拼接展示）；
 * - 用户从本清单添加的 provider：models.json 里同 custom 形态落盘，extras 记
 *   remoteSource 标记（「参与远程模型更新」的唯一判据）；远程清单变化 → 按「同 id
 *   覆盖 + 新 id 追加 + 不删除本地」合并写盘（写路径 = setProvider，复用全部既有
 *   防线：mergeProviderModel / applyModelsWritePolicy / modelStates 保留）。
 * - 用户手动添加的 custom provider 无 remoteSource 标记，不参与任何自动更新。
 */
import type { BuiltinProviderTemplate } from '@taiji/shared'
import type { IConfigStore } from '../ports/config.js'
import type { CredentialWriter } from '../auth/auth-storage.js'
import type {
  AuthStorageAccessors,
  ProviderExtrasAccessors,
  ProviderExtrasServiceDeps,
  SetProviderInput,
} from '../provider-config-helper.js'
import { setProvider as setProviderImpl } from '../provider-config-helper.js'
import { isRecord, isOptionalField } from '../quota-providers/types.js'
import { loadRemoteConfig, refreshRemoteConfig } from './remote-config-fetch.js'

/** BuiltinModelSummary 同形（shared 未从 index 导出该名，沿用 provider-config-helper 惯用法）。 */
type BuiltinModelSummary = BuiltinProviderTemplate['models'][number]

/** 远程清单域缓存名（<getDataDir()>/remote-config/builtin-providers.json）。 */
const DOMAIN = 'builtin-providers' as const

/** 远程清单模型条目（字段即 SetProviderData.models 元素的受控子集）。 */
export interface RemoteProviderModel { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: Array<'text' | 'image'>
  thinkingLevelMap?: Record<string, string | null>
}

/** 远程清单 provider 条目（模板 + 权威模型列表）。 */
export interface RemoteProviderEntry { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  id: string
  name: string
  api?: string
  baseUrl?: string
  helpUrl?: string
  helpText?: string
  models: RemoteProviderModel[]
}

export interface RemoteProvidersConfig { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  version: 1
  providers: RemoteProviderEntry[]
}

/** 形状 guard（字段级：决策依赖字段类型不符即拒，整体拒用回退缓存——RT-7#5 同纪律）。 */
export function isRemoteProvidersConfig(v: unknown): v is RemoteProvidersConfig {
  if (!isRecord(v)) return false
  if (v.version !== 1) return false
  if (!Array.isArray(v.providers)) return false
  return v.providers.every((p) => {
    if (!isRecord(p) || typeof p.id !== 'string' || p.id === '' || typeof p.name !== 'string') return false
    if (!Array.isArray(p.models)) return false
    if (!p.models.every((m) => isRecord(m) && typeof m.id === 'string' && m.id !== '')) return false
    return (
      isOptionalField(p.api, 'string') &&
      isOptionalField(p.baseUrl, 'string') &&
      isOptionalField(p.helpUrl, 'string') &&
      isOptionalField(p.helpText, 'string')
    )
  })
}

/** 远程模型条目 → BuiltinModelSummary（模板展示形状；展示缺省填充不落盘，对齐 overlayToCatalogModel 的 ?? 0 惯例）。 */
function remoteModelToSummary(m: RemoteProviderModel): BuiltinModelSummary {
  return {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: m.input ?? ['text'],
    contextWindow: m.contextWindow ?? 0,
    maxTokens: m.maxTokens ?? null,
    ...(m.thinkingLevelMap !== undefined ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
  }
}

/**
 * 远程清单 → 模板列表（与 pi catalog 快照同形拼接；authMode 恒 api_key——本清单
 * provider 是凭据输入形态，无 oauth/env 模板语义，ProviderTemplatePicker 零改动渲染）。
 */
function configToTemplates(config: RemoteProvidersConfig): BuiltinProviderTemplate[] {
  return config.providers.map((p) => ({
    id: p.id,
    name: p.name,
    ...(p.api !== undefined ? { api: p.api } : {}),
    ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}),
    authMode: 'api_key' as const,
    envVars: [],
    oauthSupported: false,
    modelCount: p.models.length,
    models: p.models.map(remoteModelToSummary),
    ...(p.helpUrl !== undefined ? { helpUrl: p.helpUrl } : {}),
    // remoteSource = 清单条目 id：前端 QuickSetup 据此走「落盘 baseUrl/api/models」分支，
    // runtime 据此写 extras 标记（参与远程更新的唯一判据）
    remoteSource: p.id,
  }))
}

/** 读远程清单模板（纯缓存，不发网络；listBuiltinProviders 拼接源）。 */
export function listRemoteProviderTemplates(): BuiltinProviderTemplate[] {
  const config = loadRemoteConfig(DOMAIN, isRemoteProvidersConfig)
  return config ? configToTemplates(config) : []
}

/** 按 id 取远程清单条目（合并写盘用）。 */
function getRemoteEntry(config: RemoteProvidersConfig | undefined, entryId: string): RemoteProviderEntry | undefined {
  return config?.providers.find((p) => p.id === entryId)
}

/** 远程模型条目 → setProvider models 元素（受控字段白名单直映射，无用户输入透传）。 */
function remoteModelToDefinition(m: RemoteProviderModel): NonNullable<SetProviderInput['models']>[number] {
  return {
    id: m.id,
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
    ...(m.input !== undefined ? { input: m.input } : {}),
    ...(m.thinkingLevelMap !== undefined ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
  }
}

export interface RemoteProviderSyncDeps { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  configStore: IConfigStore
  /** sync 实际消费面（生产形态 = ConfigService 持有的全量 extras 能力的子集；setProvider
   * 形参位要求 ProviderExtrasAccessors 全集，故含 cleanScopedModelsResidue no-op 能力）。 */
  extrasStore?: ProviderExtrasAccessors & Pick<ProviderExtrasServiceDeps, 'readAllSync'>
  authStorage?: AuthStorageAccessors
  credentialWriter?: CredentialWriter
}

export interface RemoteProviderSyncResult { // oe-exempt:20261019:framework:taiji 远程配置域内形状/依赖注入面——接口先立单实现常态（本仓架构偏好），W3 quota-fetchers 域将复用同族形状
  /** 实际发生了模型合并写盘的 provider id 列表（no-op 的不在列）。 */
  updatedProviders: string[]
  /** 本次拉取未成功的原因（throttled/network/invalid），排障与测试断言用。 */
  fetchReason?: string
}

/**
 * 拉取远程清单并在内容变化时对全部 remoteSource 命中的 provider 执行模型合并写盘。
 *
 * 合并语义：同 id 覆盖 + 新 id 追加 + 不删除本地（含用户手动加的模型——不在远程清单
 * 也不删；删除不传播，防远程误删用户在用模型）。字段级远程权威：同 id 模型的字段值
 * 覆盖用户此前编辑（登记的已接受代价；modelStates 启停存 extras 不受影响）。
 * 写路径 = setProvider（models 分支），复用全部既有写防线与 modelStates 保留逻辑。
 */
export async function syncRemoteProviderModels(deps: RemoteProviderSyncDeps): Promise<RemoteProviderSyncResult> {
  const { data, refreshed, reason } = await refreshRemoteConfig(DOMAIN, isRemoteProvidersConfig)
  const result: RemoteProviderSyncResult = { updatedProviders: [], ...(reason !== undefined ? { fetchReason: reason } : {}) }
  if (!data) return result
  // 内容未变化时仍走逐 provider 重算（内部与现值 deep-equal 后 no-op），不依赖 domain 级
  // 变更标记——正确性不建立在「refreshed 判定精确」上，代价是变化时多一次 stringify 比较
  void refreshed

  // remoteSource 标记的 provider 集合（extras 全量读；未注入 extrasStore = 无标记，无同步对象）
  if (!deps.extrasStore) return result
  const extrasAll = deps.extrasStore.readAllSync()
  for (const [providerId, extras] of Object.entries(extrasAll)) {
    const entryId = extras.remoteSource
    if (typeof entryId !== 'string' || entryId === '') continue
    const entry = getRemoteEntry(data, entryId)
    // 远程清单已下线该条目 → 不动本地（不删除语义；provider 本体与模型原样保留）
    if (!entry) continue

    const current = (deps.configStore.getProviderConfig(providerId)?.models ?? []) as unknown as Array<Record<string, unknown>>
    const byId = new Map<string, Record<string, unknown>>(current.map((m) => [String(m['id']), m]))
    for (const rm of entry.models) {
      byId.set(rm.id, remoteModelToDefinition(rm) as unknown as Record<string, unknown>)
    }
    const models = [...byId.values()]
    // 无变化 no-op（refreshed 但该 provider 模型未变的常态路径）
    if (JSON.stringify(current) === JSON.stringify(models)) continue

    await setProviderImpl(deps.configStore, deps.authStorage, deps.extrasStore, deps.credentialWriter, providerId, {
      models: models as NonNullable<SetProviderInput['models']>,
    })
    result.updatedProviders.push(providerId)
  }
  return result
}
