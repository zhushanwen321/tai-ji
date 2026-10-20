/**
 * taiji 远程配置 — provider 清单域（域 1）读模板侧：远程清单形状 + 模板映射。
 *
 * 从 remote-provider-sync 拆出的读侧（无 setProvider 依赖）：provider-config-helper
 * 拼接「添加供应商」模板列表只消费本模块，避免 helper ↔ sync 经写路径成环
 * （sync 的合并写盘仍经 setProvider 回指 helper，读侧必须与写侧分文件）。
 */
import type { BuiltinProviderTemplate } from '@taiji/shared'
import { isRecord, isOptionalField } from '../quota-providers/types.js'
import { loadRemoteConfig } from './remote-config-fetch.js'

/** BuiltinModelSummary 同形（shared 未从 index 导出该名，沿用 provider-config-helper 惯用法）。 */
type BuiltinModelSummary = BuiltinProviderTemplate['models'][number]

/** 远程清单域缓存名（<getDataDir()>/remote-config/builtin-providers.json）。 */
export const DOMAIN = 'builtin-providers' as const

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
