<!--
  UsagePage · 用量统计页（W3 编排组件）。
  数据拉取 → 页面局部状态 → aggregate 切片 → 七组件分发 props/events。
  保留 W2 占位版的 onMounted + 错误态重试骨架。

  [w3] demo 对照（UsageSection.vue + pages.css .pg-set）：页面容器无 gap（卡距由 GroupCard
  相邻 margin 16px / 网格行显式 mt-[16px] 承担，W2 决 1 同款）；分区 = gcard 族（gc-title
  卡头 + 右侧 srow-desc 注记 + tight 卡体）；空态 = demo .empty（py 40 / ring 64 dashed 1.5 /
  标题 14 600 / 描述 13 mid）；工具栏 seg = .u-seg（surface-2 凹底 / hairline 边 / 26px 钮）。
-->
<template>
  <div class="flex flex-col">
    <!-- page-head（对齐 settings 页共享范式） -->
    <div class="page-head">
      <div class="head-text">
        <h1 class="title">{{ t('settings.menu.usage') }}</h1>
        <p class="desc">{{ t('settings.menu.usageDesc') }}</p>
      </div>
      <!-- 数据截至 -->
      <div v-if="data" class="shrink-0 font-mono text-[length:var(--text-xs)] text-[var(--neutral-mid)]">
        {{ t('settings.usage.scannedAt') }} {{ formattedTime }}
      </div>
    </div>

    <!-- 加载态 -->
    <div v-if="loading" class="flex items-center gap-2 py-8 text-[length:var(--text-sm)] text-[var(--neutral-mid)]">
      <Loader2 class="size-4 animate-spin" />
      <span>{{ t('settings.usage.loading') }}</span>
    </div>

    <!-- 错误态 -->
    <div
      v-else-if="error"
      data-testid="usage-error-state"
      class="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--danger-soft)] bg-[var(--danger-soft)] p-4"
    >
      <p class="text-[length:var(--text-sm)] text-[var(--danger)]">{{ error }}</p>
      <Button
        variant="secondary"
        class="h-[32px] w-fit px-[12px] text-[length:var(--text-sm)]"
        data-testid="usage-retry-btn"
        @click="fetchData"
      >
        {{ t('settings.usage.retry') }}
      </Button>
    </div>

    <!-- 空态：无任何 session；或有 session 文件但零 usage 行（补扫过数量一行）。形态 = demo .empty -->
    <div
      v-else-if="data && data.rows.length === 0"
      data-testid="usage-empty-state"
      class="flex flex-col items-center px-[16px] py-[40px] text-center"
    >
      <div class="mb-[12px] grid size-[64px] place-items-center rounded-full border-[1.5px] border-dashed border-[var(--border-strong)] text-[var(--neutral-mid)]">
        <BarChart3 class="size-[26px]" />
      </div>
      <p class="text-[length:var(--text-base)] font-semibold text-neutral-fg">{{ t('settings.usage.emptyTitle') }}</p>
      <p class="mt-[6px] max-w-[360px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.emptyDesc') }}</p>
      <p v-if="data.sessionCount > 0" class="mt-[6px] text-[length:var(--text-sm)] text-neutral-mid">{{ t('settings.usage.emptyScanned', { count: data.sessionCount }) }}</p>
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

      <!-- 工具栏：图例 + 指标/范围切换（gap 10px = demo 工具栏 flex gap） -->
      <div class="flex flex-wrap items-center gap-[10px]">
        <!-- 图例 chips（数据源 = perProvFull 全量聚合恒显；关闭仅置灰保留原位）。
             chip 形态 = demo 图例钮：无边框 / r-sm / padding 4px 8px / text-xs mid / 9px 色块 -->
        <div class="flex flex-nowrap items-center gap-[10px] overflow-x-auto">
          <Button
            v-for="[pid, u] in sortedProviders"
            :key="pid"
            variant="ghost"
            :data-testid="`usage-legend-${pid}`"
            class="inline-flex h-auto shrink-0 items-center gap-[6px] rounded-[var(--radius-sm)] px-[8px] py-[4px] font-mono text-[length:var(--text-xs)]"
            :class="filter.offProv.has(pid) ? 'opacity-[0.38]' : 'text-neutral-mid'"
            @click="toggleProvider(pid)"
          >
            <span class="size-[9px] shrink-0 rounded-[2px]" :style="{ background: getProviderColor(agg.providerColors, pid) }" />
            <span>{{ pid }}</span>
            <span class="text-[var(--neutral-dim)]">{{ fmtProvShare(u) }}</span>
          </Button>
          <!-- 重置（demo btn ghost 24px 档：text-2xs mid） -->
          <Button
            v-if="filter.offProv.size > 0 || filter.isolate"
            variant="ghost"
            data-testid="usage-legend-reset"
            class="h-[24px] shrink-0 rounded-[var(--radius-sm)] px-[12px] text-[length:var(--text-2xs)] text-neutral-mid"
            @click="resetFilters"
          >
            {{ t('settings.usage.legendReset') }}
          </Button>
        </div>

        <!-- 单看 chip（isolate 为复合键，展示拆 provider/model 分量；demo isolate pill：
             accent-soft 底 / r-full / padding 2px 10px / text-2xs，清除钮 7px 命中 -4px 负边距） -->
        <span
          v-if="filter.isolate"
          data-testid="usage-isolate-chip"
          class="inline-flex items-center gap-[6px] rounded-full bg-accent-soft py-[2px] pl-[10px] pr-[2px] font-mono text-[length:var(--text-2xs)] text-accent"
        >
          <span v-if="isolateParts?.provider">{{ isolateParts.provider }}/</span><span>{{ isolateParts?.model }}</span>
          <Button
            variant="ghost"
            size="icon"
            data-testid="usage-isolate-clear"
            class="m-[-4px] inline-flex h-auto w-auto rounded-full p-[7px] text-accent hover:text-accent [&_svg]:size-[10px]"
            :aria-label="t('settings.usage.isolateClear')"
            @click="filter.isolate = null"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </Button>
        </span>

        <span class="flex-1" />

        <!-- 指标切换（.u-seg 分段形态，W1 决 8 McpSection 同款）。槽底引 --bg-input（凹陷档）：
             demo --surface-2 = var(--card-inset) 凹陷档，real --surface-2 浮起档（登记见
             docs/DESIGN.md §4.1 背景层级）同名分叉，复刻消费点按 demo 方向引凹陷档 -->
        <div data-testid="usage-metric-toggle" class="seg inline-flex shrink-0 items-center gap-[2px] rounded-md border border-hairline bg-bg-input p-[2px]">
          <Button
            v-for="m in (['tokens', 'cost'] as const)"
            :key="m"
            variant="ghost"
            :data-testid="`usage-metric-${m}`"
            class="h-[26px] whitespace-nowrap rounded-[var(--radius-sm)] px-[10px] text-[length:var(--text-xs)] hover:bg-transparent"
            :class="filter.metric === m
              ? 'bg-surface-hover font-semibold text-neutral-fg'
              : 'text-neutral-mid'"
            @click="filter.metric = m"
          >
            {{ m === 'tokens' ? t('settings.usage.metricToken') : t('settings.usage.metricCost') }}
          </Button>
        </div>

        <!-- 范围切换（槽底 --bg-input 分叉说明同上指标切换处） -->
        <div data-testid="usage-range-toggle" class="seg inline-flex shrink-0 items-center gap-[2px] rounded-md border border-hairline bg-bg-input p-[2px]">
          <Button
            v-for="r in RANGE_OPTIONS"
            :key="r"
            variant="ghost"
            class="h-[26px] whitespace-nowrap rounded-[var(--radius-sm)] px-[10px] text-[length:var(--text-xs)] hover:bg-transparent"
            :class="filter.range === r
              ? 'bg-surface-hover font-semibold text-neutral-fg'
              : 'text-neutral-mid'"
            @click="filter.range = r"
          >
            {{ r === 0 ? t('settings.usage.rangeAll') : t('settings.usage.rangeDays', { n: r }) }}
          </Button>
        </div>
      </div>

      <!-- 每日消耗（gcard：卡头 gc-title + 右注记，卡体 12/16） -->
      <GroupCard class="mt-[16px]">
        <template #head>
          <div class="gc-head-text">
            <h3 class="gc-title">{{ t('settings.usage.sectionDaily') }}</h3>
          </div>
        </template>
        <template #actions>
          <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.usage.sectionDailyMeta') }}</span>
        </template>
        <div class="px-[16px] py-[12px]">
          <UsageDailyChart
            :per-day="agg.perDay"
            :per-prov="agg.perProv"
            :metric="filter.metric"
            :provider-colors="agg.providerColors"
          />
        </div>
      </GroupCard>

      <!-- 热力日历 + 模型谱（双栏 auto 1fr · gap 16px；duo-grid 抵消 GroupCard 相邻纵向 margin） -->
      <div class="usage-duo-grid mt-[16px] grid gap-[16px]" style="grid-template-columns: auto 1fr">
        <GroupCard>
          <template #head>
            <div class="gc-head-text">
              <h3 class="gc-title">{{ t('settings.usage.sectionHeat') }}</h3>
            </div>
          </template>
          <template #actions>
            <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.usage.sectionHeatMeta') }}</span>
          </template>
          <div class="px-[16px] py-[12px]">
            <UsageHeatCalendar :heatmap-data="heatmapData" />
          </div>
        </GroupCard>
        <GroupCard>
          <template #head>
            <div class="gc-head-text">
              <h3 class="gc-title">{{ t('settings.usage.sectionModel') }}</h3>
            </div>
          </template>
          <template #actions>
            <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.usage.sectionModelMeta') }}</span>
          </template>
          <div class="px-[10px] pb-[8px] pt-[4px]">
            <UsageModelRank
              :per-model="agg.perModel"
              :metric="filter.metric"
              :isolate="filter.isolate"
              :provider-colors="agg.providerColors"
              @update:isolate="filter.isolate = $event"
            />
          </div>
        </GroupCard>
      </div>

      <!-- 项目谱 + 缓存构成（双栏 1.25fr 1fr · gap 16px） -->
      <div class="usage-duo-grid mt-[16px] grid gap-[16px]" style="grid-template-columns: 1.25fr 1fr">
        <GroupCard>
          <template #head>
            <div class="gc-head-text">
              <h3 class="gc-title">{{ t('settings.usage.sectionProject') }}</h3>
            </div>
          </template>
          <template #actions>
            <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.usage.sectionProjectMeta') }}</span>
          </template>
          <div class="px-[10px] pb-[8px] pt-[4px]">
            <UsageProjectRank
              :projects="projectData"
              :metric="filter.metric"
              :total-metric="totalMetricVal"
              :provider-colors="agg.providerColors"
            />
          </div>
        </GroupCard>
        <GroupCard>
          <template #head>
            <div class="gc-head-text">
              <h3 class="gc-title">{{ t('settings.usage.sectionCache') }}</h3>
            </div>
          </template>
          <template #actions>
            <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ t('settings.usage.sectionCacheMeta') }}</span>
          </template>
          <div class="px-[10px] pb-[8px] pt-[4px]">
            <UsageCacheMix :cache-data="cacheMixData" />
          </div>
        </GroupCard>
      </div>

      <!-- 明细台账（卡体 tight；脚注 = demo 卡内 srow-desc 尾注） -->
      <GroupCard class="mt-[16px]" data-testid="usage-detail-section">
        <template #head>
          <div class="gc-head-text">
            <h3 class="gc-title">{{ t('settings.usage.sectionDetail') }}</h3>
          </div>
        </template>
        <template #actions>
          <span class="text-[length:var(--text-sm)] text-[color:var(--neutral-fg-2)]">{{ detailMeta }}</span>
        </template>
        <div class="px-[10px] pb-[8px] pt-[4px]">
          <UsageDetailTable
            :groups="detailGroups"
            :tot="agg.tot"
            :provider-colors="agg.providerColors"
          />
          <div class="setting-row-desc px-[4px] pb-[2px] pt-[8px] text-[length:var(--text-sm)]">
            {{ t('settings.usage.footnote') }}
            <span v-if="data.skippedLines > 0" class="ml-2">{{ t('settings.usage.footnoteSkipped', { count: data.skippedLines }) }}</span>
            <!-- RT-8#12：读取失败的 session 文件数据点不在统计内——聚合偏低须显形，与「无用量」区分 -->
            <span v-if="failedFiles > 0" class="ml-2">{{ t('settings.usage.footnoteFailedFiles', { count: failedFiles }) }}</span>
          </div>
        </div>
      </GroupCard>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, BarChart3 } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { GroupCard } from '@taiji/ui/features/settings'
import { getSettingsTransport } from '@taiji/core'
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
} from '@taiji/core'

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
    data.value = await getSettingsTransport().getUsageStats()
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
/* 后代选择器属样式三层约定的 scoped escape hatch 范围：
   GroupCard 相邻 margin（.group-card + .group-card，16px 纵向）只在纵向卡片流生效；
   双栏网格行内行距由 column gap 承担，第二张卡的纵向 margin 归零防错位
   （.usage-duo-grid[data-v] > .group-card + .group-card specificity (0,4,0) 压过 GroupCard scoped (0,3,0)）。 */
.usage-duo-grid > :deep(.group-card + .group-card) {
  margin-top: 0;
}
</style>
