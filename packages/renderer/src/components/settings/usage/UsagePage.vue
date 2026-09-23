<!--
  UsagePage · 用量统计页（W3 编排组件）。
  数据拉取 → 页面局部状态 → aggregate 切片 → 七组件分发 props/events。
  保留 W2 占位版的 onMounted + 错误态重试骨架。
-->
<template>
  <div class="flex max-w-[1064px] flex-col gap-1">
    <!-- page-head（对齐 settings 页共享范式） -->
    <div class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.usage') }}</h1>
        <p class="desc">{{ t('settings.menu.usageDesc') }}</p>
      </div>
      <!-- 数据截至 -->
      <div v-if="data" class="shrink-0 text-[11px] text-[var(--neutral-dim)] font-mono">
        {{ t('settings.usage.scannedAt') }} {{ formattedTime }}
      </div>
    </div>

    <!-- 加载态 -->
    <div v-if="loading" class="flex items-center gap-2 py-8 text-[13px] text-[var(--neutral-mid)]">
      <Loader2 class="size-4 animate-spin" />
      <span>{{ t('settings.usage.loading') }}</span>
    </div>

    <!-- 错误态 -->
    <div
      v-else-if="error"
      data-testid="usage-error-state"
      class="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-4"
    >
      <p class="text-[13px] text-[var(--danger)]">{{ error }}</p>
      <Button variant="secondary" size="sm" class="w-fit" data-testid="usage-retry-btn" @click="fetchData">
        {{ t('settings.usage.retry') }}
      </Button>
    </div>

    <!-- 空态：无任何 session；或有 session 文件但零 usage 行（补扫过数量一行） -->
    <div
      v-else-if="data && data.rows.length === 0"
      data-testid="usage-empty-state"
      class="flex flex-col items-center gap-3 py-16 text-center"
    >
      <div class="grid size-16 place-items-center rounded-full border-2 border-dashed border-[var(--border-strong)]">
        <BarChart3 class="size-7 text-[var(--neutral-dim)]" />
      </div>
      <p class="text-[14px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.emptyTitle') }}</p>
      <p class="text-[12px] text-[var(--neutral-mid)]">{{ t('settings.usage.emptyDesc') }}</p>
      <p v-if="data.sessionCount > 0" class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.emptyScanned', { count: data.sessionCount }) }}</p>
    </div>

    <!-- 数据态 -->
    <template v-else-if="data && agg">
      <!-- 摘要台账行 -->
      <UsageLedger
        :tot="agg.tot"
        :msgs="agg.msgs"
        :active-days="agg.activeDays"
        :n-days="agg.nDays"
        :peak="agg.peak"
        :range="filter.range"
        :metric="filter.metric"
      />

      <!-- 工具栏：图例 + 指标/范围切换 -->
      <div class="mt-6 flex flex-wrap items-center gap-2">
        <!-- 图例 chips（数据源 = perProvFull 全量聚合恒显；关闭仅置灰保留原位） -->
        <div class="flex flex-nowrap items-center gap-2 overflow-x-auto">
          <Button
            v-for="[pid, u] in sortedProviders"
            :key="pid"
            variant="ghost"
            :data-testid="`usage-legend-${pid}`"
            class="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11px] transition-all"
            :class="filter.offProv.has(pid)
              ? 'border-[var(--border)] text-[var(--neutral-dim)] opacity-[0.38]'
              : 'border-[var(--border)] text-[var(--neutral-mid)] hover:border-[var(--border-strong)] hover:text-[var(--neutral-fg)]'"
            @click="toggleProvider(pid)"
          >
            <span class="size-[9px] shrink-0 rounded-[2px]" :style="{ background: getProviderColor(agg.providerColors, pid) }" />
            <span>{{ pid }}</span>
            <span class="text-[var(--neutral-dim)]">{{ fmtProvShare(u) }}</span>
          </Button>
          <!-- 重置（文本按钮：不套 size=icon 定宽，尺寸自管） -->
          <Button
            v-if="filter.offProv.size > 0 || filter.isolate"
            variant="ghost"
            data-testid="usage-legend-reset"
            class="h-6 shrink-0 px-1.5 text-[11px] text-[var(--accent)] hover:text-[var(--accent-hover)]"
            @click="resetFilters"
          >
            {{ t('settings.usage.legendReset') }}
          </Button>
        </div>

        <!-- 单看 chip（isolate 为复合键，展示拆 provider/model 分量，不显示裸复合键串） -->
        <span v-if="filter.isolate" data-testid="usage-isolate-chip" class="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] text-neutral-fg ring-1 ring-inset ring-accent-ring">
          <span v-if="isolateParts?.provider" class="text-[var(--neutral-dim)]">{{ isolateParts.provider }}/</span><span>{{ isolateParts?.model }}</span>
          <Button
            variant="ghost"
            size="icon"
            data-testid="usage-isolate-clear"
            class="inline-flex h-6 w-6 text-[var(--neutral-mid)] hover:text-[var(--neutral-fg)]"
            :aria-label="t('settings.usage.isolateClear')"
            @click="filter.isolate = null"
          >
            <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Button>
        </span>

        <span class="flex-1" />

        <!-- 指标切换 -->
        <div data-testid="usage-metric-toggle" class="seg inline-flex shrink-0 items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-0.5">
          <Button
            v-for="m in (['tokens', 'cost'] as const)"
            :key="m"
            variant="ghost"
            :data-testid="`usage-metric-${m}`"
            class="h-6 rounded px-2.5 text-[11px] whitespace-nowrap transition-colors"
            :class="filter.metric === m
              ? 'bg-[var(--bg-elevated)] text-[var(--neutral-fg)]'
              : 'text-[var(--neutral-dim)] hover:text-[var(--neutral-fg)]'"
            @click="filter.metric = m"
          >
            {{ m === 'tokens' ? t('settings.usage.metricToken') : t('settings.usage.metricCost') }}
          </Button>
        </div>

        <!-- 范围切换 -->
        <div data-testid="usage-range-toggle" class="seg inline-flex shrink-0 items-center gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-input)] p-0.5">
          <Button
            v-for="r in RANGE_OPTIONS"
            :key="r"
            variant="ghost"
            class="h-6 rounded px-2.5 text-[11px] whitespace-nowrap transition-colors"
            :class="filter.range === r
              ? 'bg-[var(--bg-elevated)] text-[var(--neutral-fg)]'
              : 'text-[var(--neutral-dim)] hover:text-[var(--neutral-fg)]'"
            @click="filter.range = r"
          >
            {{ r === 0 ? t('settings.usage.rangeAll') : t('settings.usage.rangeDays', { n: r }) }}
          </Button>
        </div>
      </div>

      <!-- 每日消耗 -->
      <section class="section mt-5 border-t border-[var(--hairline)] pt-5">
        <div class="mb-4 flex items-baseline justify-between">
          <span class="text-[13px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.sectionDaily') }}</span>
          <span class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.sectionDailyMeta') }}</span>
        </div>
        <UsageDailyChart
          :per-day="agg.perDay"
          :per-prov="agg.perProv"
          :metric="filter.metric"
          :provider-colors="agg.providerColors"
        />
      </section>

      <!-- 热力日历 + 模型谱（双栏） -->
      <section class="section mt-5 border-t border-[var(--hairline)] pt-5">
        <div class="mb-4 flex items-baseline justify-between">
          <span class="text-[13px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.sectionHeat') }}</span>
          <span class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.sectionHeatMeta') }}</span>
        </div>
        <div class="grid gap-12" style="grid-template-columns: auto 1fr">
          <UsageHeatCalendar :heatmap-data="heatmapData" />
          <div>
            <div class="mb-2.5 flex items-baseline justify-between">
              <span class="text-[13px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.sectionModel') }}</span>
              <span class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.sectionModelMeta') }}</span>
            </div>
            <UsageModelRank
              :per-model="agg.perModel"
              :metric="filter.metric"
              :isolate="filter.isolate"
              :provider-colors="agg.providerColors"
              @update:isolate="filter.isolate = $event"
            />
          </div>
        </div>
      </section>

      <!-- 项目谱 + 缓存构成（双栏） -->
      <section class="section mt-5 border-t border-[var(--hairline)] pt-5">
        <div class="mb-4 flex items-baseline justify-between">
          <span class="text-[13px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.sectionProject') }}</span>
          <span class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.sectionProjectMeta') }}</span>
        </div>
        <div class="grid gap-12" style="grid-template-columns: 1.25fr 1fr">
          <UsageProjectRank
            :projects="projectData"
            :metric="filter.metric"
            :total-metric="totalMetricVal"
            :provider-colors="agg.providerColors"
          />
          <div>
            <div class="mb-2.5 flex items-baseline justify-between">
              <span class="text-[13px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.sectionCache') }}</span>
              <span class="text-[11px] text-[var(--neutral-dim)]">{{ t('settings.usage.sectionCacheMeta') }}</span>
            </div>
            <UsageCacheMix :cache-data="cacheMixData" />
          </div>
        </div>
      </section>

      <!-- 明细台账 -->
      <section data-testid="usage-detail-section" class="section mt-5 border-t border-[var(--hairline)] pt-5">
        <div class="mb-4 flex items-baseline justify-between">
          <span class="text-[13px] font-medium text-[var(--neutral-fg)]">{{ t('settings.usage.sectionDetail') }}</span>
          <span class="text-[11px] text-[var(--neutral-dim)]">{{ detailMeta }}</span>
        </div>
        <UsageDetailTable
          :groups="detailGroups"
          :tot="agg.tot"
          :provider-colors="agg.providerColors"
        />
      </section>

      <!-- 脚注 -->
      <div class="mt-10 border-t border-[var(--hairline)] pt-3.5 text-[11px] leading-[1.8] text-[var(--neutral-dim)]">
        {{ t('settings.usage.footnote') }}
        <span v-if="data.skippedLines > 0" class="ml-2">{{ t('settings.usage.footnoteSkipped', { count: data.skippedLines }) }}</span>
        <!-- RT-8#12：读取失败的 session 文件数据点不在统计内——聚合偏低须显形，与「无用量」区分 -->
        <span v-if="failedFiles > 0" class="ml-2">{{ t('settings.usage.footnoteFailedFiles', { count: failedFiles }) }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, BarChart3 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { getUsageStats } from '@taiji/core/transport/api/domains/usage'
import type { UsageStatsResult } from '@taiji/shared'

import UsageLedger from './UsageLedger.vue'
import UsageDailyChart from './UsageDailyChart.vue'
import UsageHeatCalendar from './UsageHeatCalendar.vue'
import UsageModelRank from './UsageModelRank.vue'
import UsageProjectRank from './UsageProjectRank.vue'
import UsageCacheMix from './UsageCacheMix.vue'
import UsageDetailTable from './UsageDetailTable.vue'

import {
  type FilterState,
  type AggMetrics,
  getProviderColor,
  metricValue,
  fmtPct,
  aggregate,
  aggregateHeatmap,
  aggregateProjects,
  aggregateCacheMix,
  aggregateDetailGroups,
} from './aggregate'

const { t } = useI18n()

/* ── 范围选项 ── */
// eslint-disable-next-line no-magic-numbers -- UI 时间范围档位（近 7/30/90 天 + 全部），产品设计对齐
const RANGE_OPTIONS = [7, 30, 90, 0] as const

/* ── 时间格式化位宽 ── */
const TIME_PAD_WIDTH = 2

/* ── 数据拉取（保留 W2 骨架） ── */

const loading = ref(true)
const error = ref<string | null>(null)
const data = ref<UsageStatsResult | null>(null)

const formattedTime = computed(() => {
  if (!data.value) return ''
  const d = new Date(data.value.scannedAt)
  const hh = String(d.getHours()).padStart(TIME_PAD_WIDTH, '0')
  const mm = String(d.getMinutes()).padStart(TIME_PAD_WIDTH, '0')
  return `${hh}:${mm}`
})

/** 读取失败的 session 文件数（RT-8#12）：旧 runtime 不带该字段（可选），缺省 0。 */
const failedFiles = computed(() => data.value?.failedFiles ?? 0)

async function fetchData(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    data.value = await getUsageStats()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  fetchData()
})

/* ── 过滤器状态（页面局部 ref，不进 Pinia） ── */

const filter = reactive<FilterState>({
  offProv: new Set<string>(),
  isolate: null,
  range: 30,
  metric: 'tokens',
})

/* ── 图例交互 ── */

function toggleProvider(pid: string): void {
  if (filter.offProv.has(pid)) {
    filter.offProv.delete(pid)
  } else {
    // 「至少保留一个」守卫：基数 = perProvFull（range 内全量 provider），拦截最后一个启用 provider 的关闭
    const enabledCount = fullProviders.value.filter((k) => !filter.offProv.has(k)).length
    if (enabledCount <= 1) return
    filter.offProv.add(pid)
    // 如果单看的模型（复合键）属于被关闭的 provider，清除单看（查全量 rows 派生的复合键表）
    if (filter.isolate && modelProviderMap.value[filter.isolate] === pid) {
      filter.isolate = null
    }
  }
}

function resetFilters(): void {
  filter.offProv.clear()
  filter.isolate = null
}

/* ── 复合键 -> provider 映射（toggleProvider 联动清 isolate 守卫用） ── */

// 派生源必须 = 全量 data.rows（设计 §3.3 ⑤）：computed 只依赖 data，不随 offProv/isolate 重算——
// toggleProvider 先 offProv.add 再查表的时序下，从过滤后 perModel/perProvFull 派生会确定性丢键、守卫失效（R2 反例）
const modelProviderMap = computed(() => {
  const map: Record<string, string> = {}
  if (data.value) {
    for (const row of data.value.rows) {
      const key = `${row.provider}/${row.model}`
      if (!map[key]) map[key] = row.provider
    }
  }
  return map
})

/** isolate 复合键拆分量（chip 展示 provider 灰前缀 + 裸 model，不显示裸复合键串） */
const isolateParts = computed<{ provider: string; model: string } | null>(() => {
  const key = filter.isolate
  if (!key) return null
  const i = key.indexOf('/')
  if (i < 0) return { provider: '', model: key }
  return { provider: key.slice(0, i), model: key.slice(i + 1) }
})

/* ── 聚合结果 ── */

const agg = computed(() => {
  if (!data.value) return null
  return aggregate(data.value.rows, filter)
})

/* ── range 内全量 provider 集合（图例恒显 + 守卫基数；忽略 offProv/isolate） ── */

const fullProviders = computed<string[]>(() => {
  if (!agg.value) return []
  return Object.keys(agg.value.perProvFull)
})

/* ── 图例排序（数据源 = perProvFull 全量聚合，按当前 metric 用量降序） ── */

const sortedProviders = computed<[string, AggMetrics][]>(() => {
  if (!agg.value) return []
  return Object.entries(agg.value.perProvFull).sort(
    (a, b) => metricValue(b[1], filter.metric) - metricValue(a[1], filter.metric),
  )
})

/** chip 占比 = 该 provider 全量 / perProvFull 总量（range 内，不随 offProv/isolate 变化，设计 ⑥） */
function fmtProvShare(u: AggMetrics): string {
  if (!agg.value) return '0%'
  const total = Object.values(agg.value.perProvFull).reduce(
    (sum, m) => sum + metricValue(m, filter.metric),
    0,
  )
  return total > 0 ? fmtPct(metricValue(u, filter.metric) / total) : '0%'
}

/* ── 总量指标值 ── */

const totalMetricVal = computed(() => {
  if (!agg.value) return 0
  return metricValue(agg.value.tot, filter.metric)
})

/* ── 热力日历数据（独立于 range，全量） ── */

const heatmapData = computed(() => {
  if (!data.value) return new Map<string, number>()
  return aggregateHeatmap(data.value.rows, filter)
})

/* ── 项目谱数据 ── */

const projectData = computed(() => {
  if (!data.value) return []
  return aggregateProjects(data.value.rows, filter)
})

/* ── 缓存构成数据 ── */

const cacheMixData = computed(() => {
  if (!agg.value) return []
  return aggregateCacheMix(agg.value.perModel)
})

/* ── 明细台账分组 ── */

const detailGroups = computed(() => {
  if (!agg.value || !data.value) return []
  return aggregateDetailGroups(agg.value.perProv, agg.value.perModel, data.value.rows, filter.metric)
})

/* ── 明细台账 meta 文案 ── */

const detailMeta = computed(() => {
  if (!agg.value) return ''
  const rangeStr = filter.range === 0
    ? t('settings.usage.sectionDetailMetaRangeAll')
    : t('settings.usage.sectionDetailMetaRangeDays', { n: filter.range })
  return t('settings.usage.sectionDetailMeta', { groups: detailGroups.value.length, range: rangeStr })
})
</script>

<style scoped>
/* 后代伪类选择器属样式三层约定的 scoped escape hatch 范围 */
.section:first-of-type {
  margin-top: 0;
  border-top: none;
  padding-top: 0;
}
</style>
