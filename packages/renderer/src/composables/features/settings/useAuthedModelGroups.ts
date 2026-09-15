/**
 * useAuthedModelGroups —— 设置页「按 provider 分组的可选模型」共享 composable。
 *
 * 消费方：SystemAutoRenameSection（renameModel）/ SystemSmartContextSection（compactModel），
 * 两处此前各自维护逐字同构的 modelGroups/availableValues/sentinel 逻辑。
 *
 * 数据源：settingsStore.providers（全量广播）派生，**不用 settingsStore.models**——
 * 后者是 runtime aggregateModelsWithScoped 产出，被 scopedModels 白名单过滤+重排，
 * 语义是「Composer 切换器候选」（settings-store models ref 注释为契约）。
 * extension 模型配置（rename/compact）的解析走 pi 全量 modelRegistry，与 scoped
 * 无关，候选也必须是全量（scoped 外可选，design scoped-model-extension-candidates）。
 *
 * 只列已配凭证且未禁用的模型——extension 的 resolveModel 对无凭证模型
 * hasConfiguredAuth 不通过，选了也不工作，不如不列；禁用口径与 Composer 候选
 * （runtime W2 enabled 过滤）一致。凭证过滤用 providers 的 apiKeySet。
 */
import { computed } from 'vue'
import { getSettingsStore } from '@taiji/core'

interface AuthedModelOption {
  value: string
  label: string
}
export interface AuthedModelGroup {
  providerId: string
  providerName: string
  models: AuthedModelOption[]
}

export function useAuthedModelGroups() {
  const settingsStore = getSettingsStore()

  const modelGroups = computed<AuthedModelGroup[]>(() => {
    const groups: AuthedModelGroup[] = []
    for (const p of settingsStore.providers.value) {
      // 过滤口径 D1：禁用 provider（enabled===false）整体不列；未配凭证不列
      if (p.enabled === false) continue
      if (!p.apiKeySet) continue
      const models = p.models
        .filter((m) => m.enabled !== false)
        .map((m) => ({ value: `${p.id}/${m.id}`, label: m.name || m.id }))
      if (models.length === 0) continue // 空分组不渲染（与原实现一致：无可选模型的 provider 不占分组）
      groups.push({ providerId: p.id, providerName: p.name, models })
    }
    return groups
  })

  /** 可选模型值集合（判断当前 ref 是否 stale）。 */
  const availableValues = computed(() => new Set(modelGroups.value.flatMap((g) => g.models.map((m) => m.value))))

  return { modelGroups, availableValues }
}

/**
 * 「未设置」项 sentinel value。reka-ui 禁止 SelectItem value=""（空串是 Select
 * 清空选择的保留值），与 SystemPage 提示音 SOUND_DEFAULT='__default__' 同款处理：
 * change 时映射回空串持久化（空串 = extension 的 model.ref 默认值）。
 * 不会与真实模型 ref 冲突（ref 必含 '/'，'__unset__' 不含）。
 */
export const MODEL_UNSET_SENTINEL = '__unset__'

/** Select 受控值：空串 → sentinel；否则原样 ref（不在列表时由 staleRef 项兜底显示）。 */
export function toSelectValue(model: string): string {
  return model === '' ? MODEL_UNSET_SENTINEL : model
}

/** Select change 值 → 持久化值：非 sentinel 字符串原样，其余（sentinel / 非字符串）→ 空串。 */
export function fromSelectValue(value: unknown): string {
  return typeof value === 'string' && value !== MODEL_UNSET_SENTINEL ? value : ''
}

/** 当前 ref 不在可选列表时返回该 ref（渲染 disabled 兜底项），否则 null。 */
export function staleModelRef(model: string, availableValues: ReadonlySet<string>): string | null {
  return model !== '' && !availableValues.has(model) ? model : null
}
