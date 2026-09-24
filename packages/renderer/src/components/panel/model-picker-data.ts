/**
 * model-picker-data —— 模型选择列表的数据面（ModelSelectPopover 与 ModelThinkingAggregate 共用）。
 *
 * W3a 从 ModelSelectPopover 提取（深模块纪律：禁止两处复制）：裸 id 拆分 / provider 分组 +
 * enabled 过滤 / ModelPickerPanel 分组形状 / 选中反查 providerId 四件逻辑收敛于此。
 * 语义不得漂移——特别是「反查失败静默忽略」的兜底（渲染与点击之间列表被刷新时，
 * 不发伪造 provider 的 select，见 resolveProviderId 的消费方注释）。
 *
 * 零 vue 组件依赖：纯函数 + settingsStore 订阅（分组形状为结构化类型，与 ModelPickerPanel
 * 的 ModelPickerGroup 结构兼容，不从 .vue import 类型）。
 */
import { computed, toValue } from 'vue'
import type { ComputedRef, MaybeRefOrGetter } from 'vue'
import { getSettingsStore } from '@taiji/core'
import type { ModelInfo, ProviderId } from '@taiji/shared'

/** provider 分组（providerId 用于选中反查，provider 名仅用于分组标题显示） */
export interface ModelGroup {
  providerId: ProviderId
  provider: string
  models: ModelInfo[]
}

/** ModelPickerPanel 分组形状（provider 名 + {id,name} 列表；providerId 不进表现层） */
export interface PickerGroupRef {
  provider: string
  models: { id: string; name?: string }[]
}

/**
 * 拆出裸 modelId：selected 可能是 "provider/modelId" 复合串
 * （SessionSummary.modelId / config.defaults.defaultModel 均为此格式），
 * 但 ModelInfo.id 是裸 modelId。匹配列表项时取 `/` 后段。
 */
export function bareModelId(v: string): string {
  const i = v.lastIndexOf('/')
  return i >= 0 ? v.slice(i + 1) : v
}

/**
 * 按 provider 分组（搜索过滤与空态判定在 ModelPickerPanel 内）。空分组不渲染。
 * 同时过滤 enabled===false 的 model：runtime aggregateModels 已过滤一遍，
 * 但 settingsStore.models 与 providers 同源广播，若某次广播未过滤则会泄漏禁用模型到切换器，
 * 故前端兜底再过滤一次（双保险）。
 * providerFilter 限定展示的 provider（ProviderPage 默认 pill 传 [p.id]；聚合页不传 = 全量）。
 */
export function buildModelGroups(
  models: readonly ModelInfo[],
  providerFilter?: readonly ProviderId[],
): ModelGroup[] {
  const map = new Map<string, ModelGroup>()
  for (const m of models) {
    if (m.enabled === false) continue
    if (providerFilter && !providerFilter.includes(m.providerId)) continue
    const key = m.providerId
    let g = map.get(key)
    if (!g) {
      g = { providerId: key, provider: m.providerName, models: [] }
      map.set(key, g)
    }
    g.models.push(m)
  }
  return [...map.values()]
}

/** ModelPickerPanel 分组形状映射（providerId 不进表现层） */
export function toPickerGroups(groups: readonly ModelGroup[]): PickerGroupRef[] {
  return groups.map((g) => ({
    provider: g.provider,
    models: g.models.map((m) => ({ id: m.id, name: m.name })),
  }))
}

/**
 * 裸 modelId → providerId 反查。渲染与点击之间 groups 被刷新（模型禁用/移除、
 * providerFilter 变化）时返回 undefined——消费方必须静默忽略该次选择，
 * 不得伪造空串 provider（会穿品牌类型，下游拼出 `/modelId` 畸形复合 id）。
 */
export function resolveProviderIdFromGroups(
  groups: readonly ModelGroup[],
  modelId: string,
): ProviderId | undefined {
  return groups.find((g) => g.models.some((m) => m.id === modelId))?.providerId
}

/**
 * 数据面 composable：settingsStore.models 常驻订阅读取（init 在 AppShell 根注册，
 * 不随组件卸载断开——旧实现组件内 onMounted 订阅会错过 sendInitialState 一次性推送，
 * 2026-07-01 竞态修复的现形态）。
 *
 * @param providerFilter 限定展示的 provider 分组（响应式取值；undefined = 全量）
 */
export function useModelPickerData(
  providerFilter?: MaybeRefOrGetter<ProviderId[] | undefined>,
): {
  /** 过滤 providerFilter + enabled 的全量候选（未做搜索过滤，供 panel 区分空态） */
  groups: ComputedRef<ModelGroup[]>
  /** 模型池是否非空（enabled 过滤 + providerFilter 限定），空态区分依据 */
  hasAnyModel: ComputedRef<boolean>
  /** ModelPickerPanel 分组形状 */
  pickerGroups: ComputedRef<PickerGroupRef[]>
  /** 裸 modelId → providerId 反查（undefined = 反查失败，消费方静默忽略） */
  resolveProviderId: (modelId: string) => ProviderId | undefined
} {
  const settingsStore = getSettingsStore()

  const groups = computed<ModelGroup[]>(() =>
    buildModelGroups(
      settingsStore.models.value,
      providerFilter === undefined ? undefined : toValue(providerFilter),
    ),
  )

  const resolveProviderId = (modelId: string): ProviderId | undefined =>
    resolveProviderIdFromGroups(groups.value, modelId)

  return {
    groups,
    hasAnyModel: computed(() => groups.value.length > 0),
    pickerGroups: computed(() => toPickerGroups(groups.value)),
    resolveProviderId,
  }
}
