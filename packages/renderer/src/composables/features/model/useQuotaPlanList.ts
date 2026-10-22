/**
 * useQuotaPlanList —— 套餐浮层的 provider 清单派生（全部 quota.enabled 的 provider）。
 *
 * 与 useQuotaDisplay（单 provider、composer 容量 chip）的差异：浮层要展示**全部**
 * 满足条件的套餐，故对 settingsStore.providers 全量过滤 quota?.enabled 并逐项解析
 * preset 显示名（resolveQuotaPresetLabel，无匹配回退 provider.name）。额度数据本身
 * 不在此拉取——每项由 PlanQuotaItem 内部的 useQuotaQuery 实例自管（浮层挂载时触发
 * 一次快照查询；挂载域 = 宿主 Panel 进 conversation/trace 分支且 entries 非空，收起
 * 是 v-show 切换不卸载、不重复请求）。
 */
import { computed } from 'vue'
import type { ComputedRef } from 'vue'
import { getSettingsStore } from '@taiji/core'
import { resolveQuotaPresetLabel } from './useQuotaDisplay'

/** 浮层清单条目：providerId + 展示名（preset label 优先，回退 provider name）。 */
export interface QuotaPlanEntry { // oe-exempt:20261020:wip:数据形状接口当前单消费（useQuotaPlanList 返回类型），浮层分项扩展后自然多消费
  providerId: string
  label: string
}

export function useQuotaPlanList(): { entries: ComputedRef<QuotaPlanEntry[]> } {
  const settingsStore = getSettingsStore()
  const entries = computed<QuotaPlanEntry[]>(() =>
    settingsStore.providers.value
      .filter((p) => p.quota?.enabled)
      .map((p) => ({ providerId: p.id, label: resolveQuotaPresetLabel(p) ?? p.name })),
  )
  return { entries }
}
