/**
 * Quota fetcher 注册表（基线 ⊕ 远程合并视图，remote-config 域 2）。
 *
 * 5 家内置 fetcher 已从硬编码 TS 迁移为声明式配置：
 * - 基线 = baseline-fetchers.json（随发版更新，恒可用兜底）；
 * - 远程 = configs/remote/quota-fetchers.json（热更新，同 fetcherId 整体覆盖基线）；
 * - 执行 = declarative-engine 按配置运行（fetchQuota(credential, kind, config) 契约不变）。
 *
 * 混合形态例外（引擎设计裁决）：opendesign 的窗口数组按 durationSeconds 值选取，超出
 * 声明式窗口原语的固定路径模型 → 该 fetcher 留内置 TS（HANDWRITTEN_FETCHERS），不为
 * 个案扩语言。
 *
 * fetcher id 是持久化契约（providers.json extras.quota.fetcher 存用户盘上的 id 字符串）：
 * **只增不改名**。远程配置下线某 fetcher → 查注册表返回 null，quota-service 显式失败
 * （不静默回退旧缓存）。
 */
import type { QuotaPreset } from '@taiji/shared'
import { isQuotaPreset, QUOTA_PRESETS } from '@taiji/shared'
import type { ProviderQuotaFetcher } from '@taiji/shared'
import { isRecord } from './types.js'
import { isDeclarativeFetcherConfig, runDeclarativeFetcher, type DeclarativeFetcherConfig } from './declarative-engine.js'
import { loadRemoteConfig } from '../remote-config/remote-config-fetch.js'
import { opendesignFetcher } from './opendesign.js'

/** 基线 fetcher 配置（编译期 import，guard 校验一次；损坏 = 构建期错误随 CI 暴露）。 */
import baselineData from './baseline-fetchers.json'

/** 远程 quota-fetchers 域配置形状（presets 整体替换基线；fetchers 按 id 覆盖）。 */
export interface QuotaFetchersRemoteConfig {
  version: 1
  fetchers?: Record<string, DeclarativeFetcherConfig>
  presets?: QuotaPreset[]
}

export function isQuotaFetchersRemoteConfig(v: unknown): v is QuotaFetchersRemoteConfig {
  if (!isRecord(v) || v['version'] !== 1) return false
  if (v['fetchers'] !== undefined) {
    if (!isRecord(v['fetchers'])) return false
    if (!Object.values(v['fetchers']).every(isDeclarativeFetcherConfig)) return false
  }
  // presets 元素逐个校验形状（与 fetchers 段同强度）：畸形元素（如缺 match）若放行，
  // 会经 listQuotaPresets 下发前端/进入匹配链，matchQuotaPreset 对其解构即 TypeError
  // （额度 label computed / 自动开启判定渲染期抛错）。拒 = 整体拒用回退基线 QUOTA_PRESETS。
  if (v['presets'] !== undefined) {
    if (!Array.isArray(v['presets']) || !v['presets'].every(isQuotaPreset)) return false
  }
  return true
}

/** 基线配置表（模块加载时校验一次；条目畸形 = 仓库内基线文件错误，fail-fast 暴露）。 */
const BASELINE_FETCHERS: ReadonlyMap<string, DeclarativeFetcherConfig> = new Map(
  Object.entries(baselineData.fetchers as unknown as Record<string, DeclarativeFetcherConfig>).filter(([, v]) => {
    if (!isDeclarativeFetcherConfig(v)) {
      throw new Error(`[quota-providers] baseline-fetchers.json: malformed fetcher config (see console)`)
    }
    return true
  }),
)

/**
 * 手写 fetcher 注册表（声明式原语集覆盖不住的平台——引擎设计裁决的混合形态回退）。
 * 查序在手写优先：远程声明式配置即便声明同 id 也无法表达该平台的窗口选取逻辑，
 * 内置实现恒胜（远程覆盖语义只对声明式 fetcher 成立）。
 */
const HANDWRITTEN_FETCHERS: ReadonlyMap<string, ProviderQuotaFetcher> = new Map([
  [opendesignFetcher.id, opendesignFetcher],
])

/** 合并视图：基线全部 + 远程 fetchers 同 id 整体覆盖（纯缓存读侧，零网络）。 */
export function getQuotaFetcherConfigs(): Map<string, DeclarativeFetcherConfig> {
  const merged = new Map(BASELINE_FETCHERS)
  const remote = loadRemoteConfig('quota-fetchers', isQuotaFetchersRemoteConfig)
  if (remote?.fetchers) {
    for (const [id, config] of Object.entries(remote.fetchers)) merged.set(id, config)
  }
  return merged
}

/** id → 可执行 fetcher（引擎封装；id 不存在 = null，quota-service 显式失败不静默）。 */
export function getQuotaFetcher(id: string): ProviderQuotaFetcher | null {
  const handwritten = HANDWRITTEN_FETCHERS.get(id)
  if (handwritten) return handwritten
  const config = getQuotaFetcherConfigs().get(id)
  if (!config) return null
  return {
    id,
    auth: config.auth,
    fetchQuota: (credential, _kind, fetcherConfig) => runDeclarativeFetcher(config, credential, fetcherConfig),
  }
}

/**
 * presets 合并视图：远程 presets 整体替换 ?? 基线 QUOTA_PRESETS（shared 常量降级为基线
 * 数据源，不再是运行时权威）。runtime 匹配链与前端下发共用本函数（单一权威）。
 */
export function listQuotaPresets(): QuotaPreset[] {
  const remote = loadRemoteConfig('quota-fetchers', isQuotaFetchersRemoteConfig)
  return remote?.presets ?? QUOTA_PRESETS
}
