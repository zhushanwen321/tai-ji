/**
 * useQuotaDisplay —— ContextCapacityPopover 的 coding-plan 额度展示逻辑。
 *
 * 从 ContextCapacityPopover.vue 抽出，使 script setup ≤300 行。
 * 职责：
 * - 从 settingsStore.providers 派生 matchedProviderId（quota enabled 的 provider）
 * - 计算 matchedPresetLabel（手动 fetcher 优先，fallback 自动匹配）
 * - 调 useQuotaQuery 拿 data/lastFetchAt/error/isPending
 * - visibleWindows / quotaWarning / quotaDanger
 * - i18n 化的 windowLabels / formatReset / formatLastFetch
 *
 * 不持 UI 状态，纯 computed 派生（受控范式）。
 */
import { computed, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Ref } from 'vue'
import type { NormalizedQuotaRow } from '@taiji/shared'
import { matchQuotaPreset, QUOTA_PRESETS } from '@taiji/shared'
import { getSettingsStore } from '@taiji/core'
import { useQuotaQuery } from './useQuotaQuery'

/** 分档阈值（复用现有规则）。 */
const HIGH_THRESHOLD = 70
const DANGER_THRESHOLD = 90

/** 时间换算常量。 */
const MS_PER_SEC = 1000
const SEC_PER_MIN = 60
const MIN_PER_HOUR = 60
const HOUR_PER_DAY = 24
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR
const SEC_PER_DAY = HOUR_PER_DAY * SEC_PER_HOUR

/** 可见窗口项（过滤 pct=null 的 ∞ 窗口）。 */
export interface VisibleWindow {
  idx: number
  pct: number
  resetSec: number | null
}

export interface UseQuotaDisplayReturn {
  matchedProviderId: Ref<string | null>
  matchedPresetLabel: Ref<string | null>
  quotaRow: Ref<NormalizedQuotaRow | null>
  lastFetchAt: Ref<number | null>
  /** 最近一次查询错误（非空 = 失败，UI 显提示）。 */
  error: Ref<string | null>
  isPending: Ref<boolean>
  visibleWindows: Ref<VisibleWindow[]>
  quotaWarning: Ref<boolean>
  quotaDanger: Ref<boolean>
  /** 三窗口标签（i18n 化）。 */
  windowLabels: string[]
  /** 格式化剩余秒数（i18n 化）。 */
  formatReset: (sec: number | null) => string
  /** 格式化 lastFetchAt 为相对时间（i18n 化）。 */
  formatLastFetch: (ts: number) => string
  /** hover-enter 查询（受 throttle，fire-and-forget）。 */
  onHoverEnter: () => void
}

/**
 * @param modelIdRef - 受控复合 modelId（"provider/modelId"），由 Composer 下发。
 *   landing 态 fallback 到 defaultModel 已在 Composer 完成。
 */
export function useQuotaDisplay(modelIdRef: Ref<string | undefined>): UseQuotaDisplayReturn {
  const { t } = useI18n()
  const settingsStore = getSettingsStore()

  /**
   * RD-4#13：相对时间（「x 分钟前」）定时重算 tick（per-instance）。渲染期裸 Date.now() 且无
   * 定时重算 → 长驻页永久陈旧。每 30s 推进 nowTick，formatLastFetch 读 nowTick.value 建立
   * 响应式依赖，tick 变化驱动模板重算。scope dispose 清理定时器（对齐 autocheck 模式）。
   */
  const LAST_FETCH_TICK_MS = 30_000
  const nowTick = ref(Date.now())
  const lastFetchTimer: ReturnType<typeof setInterval> = setInterval(() => {
    nowTick.value = Date.now()
  }, LAST_FETCH_TICK_MS)
  onScopeDispose(() => {
    clearInterval(lastFetchTimer)
  })

  /** 从受控 modelId 派生 providerId，命中 quota preset 且 enabled 才启用 coding-plan 区。 */
  const matchedProviderId = computed<string | null>(() => {
    const compositeModelId = modelIdRef.value
    if (!compositeModelId) return null
    const provider = compositeModelId.split('/')[0]
    if (!provider) return null
    const providerInfo = settingsStore.providers.value.find((p) => p.id === provider)
    if (!providerInfo) return null
    if (!providerInfo.quota?.enabled) return null
    return provider
  })

  /** 匹配到的 quota preset 显示名（手动 fetcher 优先，fallback 自动匹配）。 */
  const matchedPresetLabel = computed<string | null>(() => {
    const pid = matchedProviderId.value
    if (!pid) return null
    const providerInfo = settingsStore.providers.value.find((p) => p.id === pid)
    if (!providerInfo) return null
    const manualFetcher = providerInfo.quota?.fetcher
    const preset = manualFetcher
      ? QUOTA_PRESETS.find((p) => p.fetcher === manualFetcher)
      : matchQuotaPreset({ baseUrl: providerInfo.baseUrl, name: providerInfo.name })
    return preset?.label ?? null
  })

  const { data: quotaData, lastFetchAt, error, isPending, onHoverEnter: queryOnHoverEnter } = useQuotaQuery(matchedProviderId)

  const quotaRow = computed<NormalizedQuotaRow | null>(() => quotaData.value)

  /** 三窗口标签（i18n 化，与 QuotaWins 顺序对齐）。 */
  const windowLabels = [
    t('panel.context.window5h'),
    t('panel.context.windowWeek'),
    t('panel.context.windowMonth'),
  ]

  const visibleWindows = computed<VisibleWindow[]>(() => {
    const row = quotaRow.value
    if (!row) return []
    return row.wins
      .map((w, i) => (w.pct != null ? { idx: i, pct: w.pct, resetSec: w.resetSec } : null))
      .filter((w): w is VisibleWindow => w != null)
  })

  const quotaWarning = computed(() => visibleWindows.value.some((w) => w.pct >= HIGH_THRESHOLD && w.pct < DANGER_THRESHOLD))
  const quotaDanger = computed(() => visibleWindows.value.some((w) => w.pct >= DANGER_THRESHOLD))

  /** 格式化剩余秒数（i18n 化）。null/<=0 → '--'。 */
  function formatReset(sec: number | null): string {
    if (sec == null || sec <= 0) return t('panel.context.resetEmpty')
    const d = Math.floor(sec / SEC_PER_DAY)
    const h = Math.floor((sec % SEC_PER_DAY) / SEC_PER_HOUR)
    const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN)
    if (d > 0) return t('panel.context.resetRemainingDays', { d, h })
    if (h > 0) return t('panel.context.resetRemainingHours', { h, m })
    if (m > 0) return t('panel.context.resetRemainingMinutes', { m })
    return t('panel.context.resetRemainingSoon')
  }

  /** 格式化 lastFetchAt 为相对时间（i18n 化）。 */
  function formatLastFetch(ts: number): string {
    // RD-4#13：读 nowTick.value 建立响应式依赖——tick 每 30s 推进驱动模板重算相对时间，
    // 替代渲染期裸 Date.now()（无定时重算 → 长驻页「x 分钟前」永久陈旧）。
    const sec = Math.floor((nowTick.value - ts) / MS_PER_SEC)
    if (sec < SEC_PER_MIN) return t('panel.context.timeAgoNow')
    const m = Math.floor(sec / SEC_PER_MIN)
    if (m < MIN_PER_HOUR) return t('panel.context.timeAgoMinutes', { n: m })
    const h = Math.floor(m / MIN_PER_HOUR)
    if (h < HOUR_PER_DAY) return t('panel.context.timeAgoHours', { n: h })
    const d = Math.floor(h / HOUR_PER_DAY)
    return t('panel.context.timeAgoDays', { n: d })
  }

  /** hover-enter 触发查询（fire-and-forget）。 */
  function onHoverEnter(): void {
    if (matchedProviderId.value) {
      void queryOnHoverEnter()
    }
  }

  return {
    matchedProviderId,
    matchedPresetLabel,
    quotaRow,
    lastFetchAt,
    error,
    isPending,
    visibleWindows,
    quotaWarning,
    quotaDanger,
    windowLabels,
    formatReset,
    formatLastFetch,
    onHoverEnter,
  }
}
