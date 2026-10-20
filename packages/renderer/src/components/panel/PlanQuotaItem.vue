<template>
  <!-- 单项套餐（plan-quota-item）：头部（显示名 + 当前标记 + providerId）+ 三窗口用量行
       （5h / 周 / 月，顺序对齐 QuotaWins）。pct=null = 该 provider 无此窗口数据（显示 —）；
       已用 ≥90% 红、70-89% 黄（与 useQuotaDisplay 分档阈值同口径）。 -->
  <section :data-testid="`plan-quota-item-${providerId}`">
    <div class="flex items-baseline gap-1.5">
      <span class="truncate text-[length:var(--text-sm)] font-medium text-neutral-fg">{{ label }}</span>
      <span
        v-if="current"
        class="shrink-0 text-[length:var(--text-xs)] text-success"
        data-testid="plan-quota-current-tag"
      >{{ t('panel.quotaFloat.current') }}</span>
      <span class="ml-auto shrink-0 font-mono text-[length:var(--text-xs)] text-neutral-dim">{{ providerId }}</span>
    </div>
    <!-- 查询失败且无旧缓存：显式失败行（不静默；有旧 data 时仍展示旧数据，error 仅存 store） -->
    <p
      v-if="row === null && error !== null"
      class="mt-1 text-[length:var(--text-xs)] text-danger"
      data-testid="plan-quota-error"
    >{{ t('panel.quotaFloat.fetchFailed') }}</p>
    <div v-else class="mt-1 flex gap-2">
      <div
        v-for="(w, i) in windows"
        :key="w.key"
        class="flex min-w-0 flex-1 items-center gap-1"
      >
        <span class="shrink-0 text-[length:var(--text-xs)] text-neutral-dim">{{ w.key }}</span>
        <div
          class="h-1 min-w-[10px] flex-1 overflow-hidden rounded-full bg-neutral-faint"
          :title="w.tip"
          role="progressbar"
          :aria-label="`${label} ${w.key} ${w.pct === null ? t('panel.quotaFloat.noWindowData') : t('panel.quotaFloat.usedPct', { pct: w.pct })}`"
          :aria-valuenow="w.pct ?? undefined"
          aria-valuemin="0"
          aria-valuemax="100"
          :data-testid="`plan-quota-bar-${providerId}-${i}`"
        >
          <div
            class="h-full rounded-full transition-[width] duration-300"
            :class="w.pct === null ? '' : w.pct >= 90 ? 'bg-danger' : w.pct >= 70 ? 'bg-warn' : 'bg-neutral-mid'"
            :style="{ width: `${w.pct ?? 0}%` }"
          />
        </div>
        <span
          class="w-9 shrink-0 text-right font-mono text-[length:var(--text-xs)] text-neutral-mid"
          data-testid="plan-quota-pct"
        >{{ w.pct === null ? '—' : `${w.pct}%` }}</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * PlanQuotaItem —— 套餐浮层的单项（一个 quota.enabled provider 的三窗口用量）。
 *
 * 每实例独立 useQuotaQuery（per-provider 实例安全：pending 并发保护在 composable
 * 内部）；挂载即触发一次快照查询——挂载域 = 浮层挂载（宿主 Panel 进
 * conversation/trace 分支且清单非空，含 drawer 已开/trace 激活的不可见形态）；
 * 收起是 v-show 切换不卸载本组件，收起→展开不重复查询。
 * tooltip 承载明细（used/limit/计量单位 + 重置倒计时），行内只留百分比保持紧凑。
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { QuotaWindow } from '@taiji/shared'
import { useQuotaQuery } from '@/composables/features/model/useQuotaQuery'
import { formatResetSec } from '@/composables/features/model/useQuotaDisplay'

const props = defineProps<{
  providerId: string
  /** 展示名（preset label 优先，回退 provider name；容器解析下发） */
  label: string
  /** 是否当前会话生效模型所属 provider（容器判定下发） */
  current: boolean
}>()

const { t } = useI18n()
const providerIdRef = computed(() => props.providerId)
const { data, error, onHoverEnter } = useQuotaQuery(providerIdRef)

onMounted(() => {
  void onHoverEnter()
})

/** row 供模板失败态判据（null = 无任何缓存数据）。 */
const row = computed(() => data.value)

const WINDOW_LABEL_KEYS = [
  'panel.context.window5h',
  'panel.context.windowWeek',
  'panel.context.windowMonth',
] as const

/** 单窗口渲染模型（三行横排一格）。 */
interface WindowCell {
  key: string
  pct: number | null
  tip: string
}

/** tip 明细：有 used/limit 时展示绝对量 + 计量单位，否则只有百分比。 */
function tipUsage(w: QuotaWindow | undefined, pct: number | null): string {
  if (pct === null) return t('panel.quotaFloat.noWindowData')
  if (w?.limit != null) return `${w.used ?? 0}/${w.limit} ${w.unit ?? ''}`
  return t('panel.quotaFloat.usedPct', { pct })
}

/** 三窗口渲染模型（wins 顺序对齐 5h/周/月；pct=null = 无此窗口数据）。 */
const windows = computed<WindowCell[]>(() => {
  const rowValue = data.value
  return WINDOW_LABEL_KEYS.map((key, i) => {
    const w = rowValue?.wins[i]
    const pct = w?.pct ?? null
    return {
      key: t(key),
      pct,
      tip: `${tipUsage(w, pct)} · ${formatResetSec(w?.resetSec ?? null)}`,
    }
  })
})
</script>
