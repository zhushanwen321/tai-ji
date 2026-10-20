/**
 * taiji 远程配置 — provider 清单域（域 1）写侧：模型合并写盘。
 *
 * 三层更新通道的 taiji 自有层（设计 .tmp/tech-design/remote-config-and-quota.md §4.2）：
 * - pi catalog 层走 pi.dev overlay（provider-catalog-refresh.ts，不在此列）；
 * - 清单域模板读侧（形状 guard + listRemoteProviderTemplates）在
 *   remote-provider-templates.ts——读侧无 setProvider 依赖，provider-config-helper
 *   只消费读侧，避免 helper ↔ sync 经写路径成环；
 * - 用户从本清单添加的 provider：models.json 里同 custom 形态落盘，extras 记
 *   remoteSource 标记（「参与远程模型更新」的唯一判据）；远程清单变化 → 按「同 id
 *   覆盖 + 新 id 追加 + 不删除本地」合并写盘（写路径 = setProvider，复用全部既有
 *   防线：mergeProviderModel / applyModelsWritePolicy / modelStates 保留）。
 * - 用户手动添加的 custom provider 无 remoteSource 标记，不参与任何自动更新。
 */
import type { IConfigStore } from '../ports/config.js'
import type { CredentialWriter } from '../auth/auth-storage.js'
import type {
  AuthStorageAccessors,
  ProviderExtrasAccessors,
  ProviderExtrasServiceDeps,
  SetProviderInput,
} from '../provider-config-helper.js'
import { setProvider as setProviderImpl } from '../provider-config-helper.js'
import { refreshRemoteConfig } from './remote-config-fetch.js'
import {
  DOMAIN,
  isRemoteProvidersConfig,
  type RemoteProviderEntry,
  type RemoteProviderModel,
  type RemoteProvidersConfig,
} from './remote-provider-templates.js'

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
  // 内容未变化时仍走逐 provider 重算（内部与现值比对后 no-op），不依赖 domain 级
  // 变更标记——正确性不建立在「refreshed 判定精确」上，代价是变化时多一次逐字段比对
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
    const currentById = new Map<string, Record<string, unknown>>(current.map((m) => [String(m['id']), m]))
    const byId = new Map<string, Record<string, unknown>>(currentById)
    for (const rm of entry.models) {
      byId.set(rm.id, remoteModelToDefinition(rm) as unknown as Record<string, unknown>)
    }
    const models = [...byId.values()]
    // 无变化 no-op（refreshed 但该 provider 模型未变的常态路径）。
    // 判据对齐 setProvider 写路径语义（mergeProviderModel：base spread + 远程字段覆盖）：
    // 远程字段全部与现值相同且无新 id → 写后与现值一致。不能 stringify 比较「合并形态 vs
    // 现值」——远程条目省略的可选字段（reasoning/input/contextWindow 等）在 QuickSetup
    // 落盘形态里已由 remoteModelToSummary 补默认值（reasoning ?? false / input ?? ['text']
    // / contextWindow ?? 0），裸形态替换会让内容相同的 models.json 每轮 atomicWrite 重写
    // 并触发 mtime 广播。
    const noChange = entry.models.every((rm) => {
      const cur = currentById.get(rm.id)
      if (!cur) return false // 新 id = 追加，非 no-op
      return Object.entries(remoteModelToDefinition(rm)).every(
        ([k, v]) => JSON.stringify(cur[k]) === JSON.stringify(v),
      )
    })
    if (noChange) continue

    await setProviderImpl(deps.configStore, deps.authStorage, deps.extrasStore, deps.credentialWriter, providerId, {
      models: models as NonNullable<SetProviderInput['models']>,
    })
    result.updatedProviders.push(providerId)
  }
  return result
}
