/**
 * useScopedModels —— Scoped Model 配置业务编排。
 *
 * 读 settingsStore.scopedModels + providers 派生渲染数据；操作函数调 RPC
 * （乐观更新 + 失败回滚，参照 ProviderPage onToggleEnabled 范式）。
 *
 * 数据流：
 *   settingsStore.scopedModels → scopedRenderItems（渲染列表）
 *   settingsStore.providers + settingsStore.models → selectableModels（添加面板全量可选）
 *   add/remove/move → config.setScopedModels（乐观 + 回滚）
 *
 * 依赖方向：@taiji/shared 类型 + @/api(config) + settingsStore。
 */
import { computed } from 'vue'
import { getSettingsStore, getSettingsTransport } from '@taiji/core'
import { optimisticUpdate, refCell } from '@taiji/core/foundation/optimistic-update'
import type { ScopedRenderItem, SelectableModel } from '@taiji/ui/features/settings'
import { useWool } from './useWool'

// 防重入：setScopedModels 是整列表覆写，in-flight 期间的新触发会拿含乐观值的快照当 old，
// 双失败时回滚互相错位 → 模块级 busy 检查，操作进行中忽略新触发（对齐 ProviderPage.vue
// toggling Set 的「in-flight 忽略」范式；不做按钮禁用态，避免 busy 状态穿透 ui 组件 props）。
let scopedMutationInFlight = false

export function useScopedModels() {
  const settingsStore = getSettingsStore()
  // 羊毛目录快照（已接入家族的 catalog.models）：白名单添加面板与白名单行渲染的羊毛
  // 候选源——羊毛条目不进 config.providers 帧（provider 通用列表与 provider 级操作面
  // 走 wool.action 专属通道，并入会产生重复卡与误操作面），不在此单独并入则白名单
  // 非空用户永远无法把羊毛模型加进白名单（model.list 按白名单硬过滤 → 选择器只对
  // 已加白名单者可见 → 死锁）。
  const wool = useWool()

  const woolSelectable = computed<SelectableModel[]>(() => {
    const snap = wool.snapshot.value
    if (!snap) return []
    const out: SelectableModel[] = []
    for (const f of snap.families) {
      if (!f.adopted || !f.catalog?.models.length) continue
      const providerId = `wool-${f.family}`
      for (const m of f.catalog.models) {
        out.push({
          fullId: `${providerId}/${m.id}`,
          providerId,
          providerName: f.displayName,
          modelId: m.id,
          name: m.name,
          apiKeySet: true,
        })
      }
    }
    return out
  })

  // ── 渲染数据：scopedModels 字符串列表 → ScopedRenderItem[] ──

  const scopedRenderItems = computed<ScopedRenderItem[]>(() => {
    const scoped = settingsStore.scopedModels.value
    if (!scoped.length) return []
    const providers = settingsStore.providers.value

    return scoped.map((fullId) => {
      const slashIdx = fullId.indexOf('/')
      if (slashIdx === -1) return { scoped: fullId, modelName: fullId, providerName: '', apiKeySet: true, missing: true }

      const providerId = fullId.substring(0, slashIdx)
      const modelId = fullId.substring(slashIdx + 1)
      const woolModel = woolSelectable.value.find((w) => w.fullId === fullId)
      const provider = providers.find((p) => p.id === providerId)
      const model = provider?.models.find((m) => m.id === modelId)

      // 羊毛模型行：凭据通道写入的 models.json 条目无 models 数组（目录在授权后才拉取），
      // provider 命中但 model 必然找不到——目录快照是行渲染的权威源，缺失才标「已不存在」。
      if (woolModel) {
        return { scoped: fullId, modelName: woolModel.name ?? modelId, providerName: provider?.name ?? woolModel.providerName, apiKeySet: true, missing: false }
      }
      if (!provider || !model) return { scoped: fullId, modelName: modelId, providerName: provider?.name ?? providerId, apiKeySet: provider?.apiKeySet ?? true, missing: !model }

      return {
        scoped: fullId,
        modelName: model?.name ?? modelId,
        providerName: provider.name,
        apiKeySet: provider.apiKeySet,
        missing: !model,
      }
    })
  })

  // ── 全量可选模型（添加面板数据源） ──

  const selectableModels = computed<SelectableModel[]>(() => {
    const providers = settingsStore.providers.value
    const result: SelectableModel[] = []
    for (const p of providers) {
      for (const m of p.models) {
        result.push({
          fullId: `${p.id}/${m.id}`,
          providerId: p.id,
          providerName: p.name,
          modelId: m.id,
          name: m.name,
          apiKeySet: p.apiKeySet,
        })
      }
    }
    return [...result, ...woolSelectable.value]
  })

  // ── 操作函数（乐观更新协议：失败回滚 + rethrow）──
  // 回滚后 rethrow：调用方（ProviderPage）统一反馈 inline error + toast，此处不做 UI 副作用。

  /** 公共 mutation 管线：busy 检查 → 协议化乐观写 next → RPC → 写回权威值 / 回滚 rethrow。 */
  async function mutateScoped(next: string[]): Promise<void> {
    if (scopedMutationInFlight) return
    scopedMutationInFlight = true
    try {
      const result = await optimisticUpdate(refCell(settingsStore.scopedModels), next, (applied) =>
        getSettingsTransport().setScopedModels(applied),
      )
      settingsStore.scopedModels.value = result
    } finally {
      scopedMutationInFlight = false
    }
  }

  /** 添加模型到 scoped 列表（去重保序）。 */
  async function addScopedModels(models: string[]): Promise<void> {
    const existing = new Set(settingsStore.scopedModels.value)
    const additions = models.filter((m) => !existing.has(m))
    if (additions.length === 0) return
    await mutateScoped([...settingsStore.scopedModels.value, ...additions])
  }

  /** 从 scoped 列表移除单个模型。 */
  async function removeScopedModel(scoped: string): Promise<void> {
    await mutateScoped(settingsStore.scopedModels.value.filter((s) => s !== scoped))
  }

  /** 上移/下移 scoped 模型。 */
  async function moveScopedModel(scoped: string, dir: 'up' | 'down'): Promise<void> {
    const current = settingsStore.scopedModels.value
    const idx = current.indexOf(scoped)
    if (idx === -1) return
    const targetIdx = dir === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= current.length) return
    const next = [...current]
    ;[next[idx], next[targetIdx]] = [next[targetIdx], next[idx]]
    await mutateScoped(next)
  }

  return {
    scopedRenderItems,
    selectableModels,
    addScopedModels,
    removeScopedModel,
    moveScopedModel,
  }
}
