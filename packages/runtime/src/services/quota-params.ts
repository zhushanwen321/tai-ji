/**
 * QuotaService 用户维度参数（quotaParams）纯函数（2026-10 泛化波次从 quota-service.ts
 * 抽取，该文件行数门 ≤500）：param spec 查找、逐键归一化、旧版 workspace 单字段读映射。
 * 纯函数无 IO——QuotaService 持 presets 视图调用，测试可直射。
 */

import type { QuotaParamSpec } from '@taiji/shared'
import { normalizeQuotaParamValue } from '@taiji/shared'
import { logger } from '../infra/logger.js'

/** 目标 fetcher 的 param spec 映射（key → spec）；无 preset/无声明 = 空 Map（raw 透传）。 */
export function paramSpecsForFetcher(
  fetcherId: string | undefined,
  presets: readonly { fetcher: string; params?: readonly QuotaParamSpec[] }[],
): Map<string, QuotaParamSpec> {
  const specs = new Map<string, QuotaParamSpec>()
  if (!fetcherId) return specs
  const preset = presets.find((p) => p.fetcher === fetcherId)
  for (const spec of preset?.params ?? []) specs.set(spec.key, spec)
  return specs
}

/**
 * params 逐键归一化：null = 清除该键（透传）；空串同清除语义；非空串按 spec.normalize
 * 分流归一化（opencode-workspace / opendesign-workspace / raw 透传）。未知键（远程 preset
 * 先行 / 自定义参数）按 raw 透传——不阻断保存。非法输入返回 error 文案（调用方 fail-fast）。
 */
export function normalizeQuotaParams(
  providerId: string,
  params: Record<string, string | null>,
  specs: Map<string, QuotaParamSpec>,
): { value: Record<string, string | null> } | { error: string } {
  const normalized: Record<string, string | null> = {}
  for (const [key, raw] of Object.entries(params)) {
    if (raw === null) {
      normalized[key] = null
      continue
    }
    const trimmed = raw.trim()
    if (!trimmed) {
      normalized[key] = null
      continue
    }
    const kind = specs.get(key)?.normalize ?? 'raw'
    const result = normalizeQuotaParamValue(kind, trimmed)
    if (!result.ok) {
      logger.warn('[quota] invalid param input', { providerId, key, error: result.error })
      return { error: result.error }
    }
    normalized[key] = result.value
  }
  return { value: normalized }
}

/**
 * 旧版 workspace 单字段（2026-10 泛化前持久化）→ params.workspaceUrl 读映射。
 * opencode/opendesign 的 param key 恒为 workspaceUrl，映射无损。
 */
export function mapLegacyWorkspaceParams(
  quota: { params?: Record<string, string>; workspace?: string } | undefined,
): Record<string, string> | undefined {
  if (!quota) return undefined
  if (quota.params) return quota.params
  return quota.workspace ? { workspaceUrl: quota.workspace } : undefined
}

/**
 * params 逐键三态继承：undefined = 本次不动（继承既有值）；Record = 逐键合并
 * （null = 删键，string = 写入）；合并后空表落 undefined（与旧 workspace 清除态一致）。
 * 继承基座：providers.json 既有 params → 旧版 workspace 映射 → models.json legacy 两路。
 */
export function resolveParamsValue(
  params: Record<string, string | null> | undefined,
  current: { params?: Record<string, string>; workspace?: string } | undefined,
  legacyQuota: { params?: Record<string, string>; workspace?: string } | undefined,
): Record<string, string> | undefined {
  const base = mapLegacyWorkspaceParams(current) ?? mapLegacyWorkspaceParams(legacyQuota)
  if (params === undefined) return base
  const merged: Record<string, string> = { ...(base ?? {}) }
  for (const [key, value] of Object.entries(params)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
