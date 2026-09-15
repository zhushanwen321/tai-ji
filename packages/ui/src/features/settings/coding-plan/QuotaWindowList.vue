<template>
  <!-- 双轨：有绝对量（used/limit）时「已用 N / M 单位 · pct%」，无则维持 pct 单轨。
       两处消费（当前成功数据 / 「查看上次成功数据」折叠区）仅色调不同（tone）。 -->
  <div
    v-for="win in windows"
    :key="win.idx"
    class="flex items-center justify-between py-0.5 text-[11px]"
  >
    <span class="font-mono text-[10px] text-neutral-mid">{{ labels[win.idx] }}</span>
    <span v-if="win.pct !== null" :class="['font-semibold tabular-nums', tone === 'current' ? 'text-neutral-fg' : 'text-neutral-mid']">
      <template v-if="win.used != null && win.limit != null">
        {{ t('settings.providerEdit.quotaUsedOf', { used: formatAmount(win.used), limit: formatAmount(win.limit) }) }}
        <span v-if="unitLabel(win.unit)" :class="['font-normal', tone === 'current' ? 'text-neutral-mid' : 'text-neutral-dim']">{{ unitLabel(win.unit) }}</span>
        ·
      </template>
      {{ Math.round(win.pct) }}%
      <span v-if="win.resetSec !== null" class="ml-1 font-normal text-neutral-dim">· {{ formatResetSec(win.resetSec) }}</span>
    </span>
    <span v-else class="text-neutral-dim">∞</span>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

defineProps<{
  windows: Array<{
    idx: number
    pct: number | null
    resetSec: number | null
    used?: number | null
    limit?: number | null
    unit?: 'requests' | 'tokens' | 'credits' | null
  }>
  labels: string[]
  /** 数值色调：current = 当前成功数据（fg 主色），muted = 上次成功数据（mid 弱化）。 */
  tone: 'current' | 'muted'
}>()

const { t } = useI18n()

const SEC_PER_MIN = 60
const MIN_PER_HOUR = 60
const HOUR_PER_DAY = 24
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR

/** 绝对量数字格式化（千分位，等宽 tabular-nums 下对齐友好） */
function formatAmount(n: number): string {
  return n.toLocaleString()
}

/** 平台计费单位 i18n 标签（无单位 → 空串不渲染） */
function unitLabel(unit: 'requests' | 'tokens' | 'credits' | null | undefined): string {
  if (unit === 'requests') return t('settings.providerEdit.quotaUnitRequests')
  if (unit === 'tokens') return t('settings.providerEdit.quotaUnitTokens')
  if (unit === 'credits') return t('settings.providerEdit.quotaUnitCredits')
  return ''
}

/** 格式化剩余秒数为紧凑时间（i18n 化，如 '1h23m' / '3d12h'）。 */
function formatResetSec(sec: number): string {
  if (sec <= 0) return t('settings.providerEdit.quotaResetEmpty')
  const h = Math.floor(sec / SEC_PER_HOUR)
  if (h >= HOUR_PER_DAY) {
    const d = Math.floor(h / HOUR_PER_DAY)
    const rh = h % HOUR_PER_DAY
    return t('settings.providerEdit.quotaResetDays', { d, h: rh })
  }
  const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN)
  return t('settings.providerEdit.quotaResetHours', { h, m })
}
</script>
