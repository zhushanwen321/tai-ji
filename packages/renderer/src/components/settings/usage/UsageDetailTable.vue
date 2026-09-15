<!--
  UsageDetailTable · 明细台账：按 provider 分组的可折叠表格。
  前两个分组默认展开，其余收起。
-->
<template>
  <div data-testid="usage-detail-table" class="flex flex-col gap-0">
    <!-- 表头 -->
    <div class="grid grid-cols-[minmax(180px,1fr)_84px_84px_84px_84px_104px_76px_108px] items-center gap-1 px-2 py-1 border-b border-border font-mono text-[11px] text-neutral-dim">
      <span class="col-model">{{ t('settings.usage.colModel') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colInput') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colCacheRead') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colCacheWrite') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colOutput') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colTokens') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colCost') }}</span>
      <span class="text-right font-mono text-xs tabular-nums">{{ t('settings.usage.colShare') }}</span>
    </div>

    <!-- 分组行 + 模型行 -->
    <template v-for="group in groups" :key="group.pid">
      <!-- 分组头 -->
      <div class="grid grid-cols-[minmax(180px,1fr)_84px_84px_84px_84px_104px_76px_108px] items-center gap-1 px-2 py-1 cursor-pointer border-t border-hairline bg-[color-mix(in_oklch,var(--bg-sunken)_50%,transparent)] transition-colors hover:bg-[var(--row-hover)]" @click="toggle(group.pid)">
        <span class="flex min-w-0 items-center gap-1.5">
          <span class="inline-block size-2 shrink-0 rounded-[2px]" :style="{ background: getProviderColor(providerColors, group.pid) }" />
          <span class="truncate text-[12px] font-medium text-[var(--neutral-fg)]">{{ group.pid }}</span>
          <span class="shrink-0 text-[10px] text-[var(--neutral-dim)]">{{ group.models.length }} {{ t('settings.usage.modelsLabel') }}</span>
          <!-- 展开/收起箭头 -->
          <svg
            class="size-3.5 shrink-0 text-[var(--neutral-dim)] transition-transform"
            :class="{ '-rotate-90': !expandedGroups.has(group.pid) }"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
        <span />
        <span class="text-right font-mono text-xs tabular-nums text-neutral-dim">{{ fmtCompact(group.u.cacheRead) }}</span>
        <span />
        <span />
        <span class="text-right font-mono text-xs tabular-nums">{{ fmtCompact(totalTokens(group.u)) }}</span>
        <span class="text-right font-mono text-xs tabular-nums" :class="group.u.cost ? 'text-[var(--neutral-fg)]' : 'text-[var(--neutral-dim)]'">
          {{ group.u.cost ? fmtUSD(group.u.cost) : '—' }}
        </span>
        <span class="flex items-center gap-1.5">
          <span class="inline-block h-[6px] w-[50px] overflow-hidden rounded-[3px] bg-[var(--hairline)]">
            <span
              class="inline-block h-full rounded-[2px]"
              :style="{ width: (totTokens > 0 ? totalTokens(group.u) / totTokens * 100 : 0) + '%', background: getProviderColor(providerColors, group.pid) }"
            />
          </span>
          <span class="font-mono text-[11px] tabular-nums text-[var(--neutral-dim)]">{{ fmtPct(totTokens > 0 ? totalTokens(group.u) / totTokens : 0) }}</span>
        </span>
      </div>

      <!-- 模型行（展开时显示） -->
      <template v-if="expandedGroups.has(group.pid)">
        <div
          v-for="m in group.models"
          :key="m.model"
          class="grid grid-cols-[minmax(180px,1fr)_84px_84px_84px_84px_104px_76px_108px] items-center gap-1 px-2 py-1 text-xs text-neutral-fg"
        >
          <span class="col-model pl-[26px]">{{ m.model }}</span>
          <span class="text-right font-mono text-xs tabular-nums text-neutral-dim">{{ fmtCompact(m.u.input) }}</span>
          <span class="text-right font-mono text-xs tabular-nums text-neutral-dim">{{ fmtCompact(m.u.cacheRead) }}</span>
          <span class="text-right font-mono text-xs tabular-nums text-neutral-dim">{{ m.u.cacheWrite ? fmtCompact(m.u.cacheWrite) : '·' }}</span>
          <span class="text-right font-mono text-xs tabular-nums text-neutral-dim">{{ fmtCompact(m.u.output) }}</span>
          <span class="text-right font-mono text-xs tabular-nums">{{ fmtInt(totalTokens(m.u)) }}</span>
          <span class="text-right font-mono text-xs tabular-nums" :class="m.u.cost ? 'text-[var(--neutral-fg)]' : 'text-[var(--neutral-dim)]'">
            {{ m.u.cost ? fmtUSD(m.u.cost) : '—' }}
          </span>
          <span class="flex items-center gap-1.5">
            <span class="inline-block h-[6px] w-[50px] overflow-hidden rounded-[3px] bg-[var(--hairline)]">
              <span
                class="inline-block h-full rounded-[2px]"
                :style="{ width: (totTokens > 0 ? totalTokens(m.u) / totTokens * 100 : 0) + '%', background: getProviderColor(providerColors, group.pid) }"
              />
            </span>
            <span class="font-mono text-[11px] tabular-nums text-[var(--neutral-dim)]">{{ fmtPct(totTokens > 0 ? totalTokens(m.u) / totTokens : 0) }}</span>
          </span>
        </div>
      </template>
    </template>

    <!-- 合计行 -->
    <div class="grid grid-cols-[minmax(180px,1fr)_84px_84px_84px_84px_104px_76px_108px] items-center gap-1 px-2 py-1 border-t border-border text-xs font-medium text-neutral-fg">
      <span>{{ t('settings.usage.total') }}</span>
      <span />
      <span />
      <span />
      <span />
      <span class="text-right font-mono text-xs tabular-nums">{{ fmtInt(totTokens) }}</span>
      <span class="text-right font-mono text-xs tabular-nums" :class="tot.cost ? 'text-[var(--neutral-fg)]' : 'text-[var(--neutral-dim)]'">{{ tot.cost ? fmtUSD(tot.cost) : '—' }}</span>
      <span />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  getProviderColor,
  fmtCompact,
  fmtUSD,
  fmtInt,
  fmtPct,
  totalTokens,
} from './aggregate'
import type { AggMetrics } from './aggregate'

const { t } = useI18n()

const props = defineProps<{
  groups: { pid: string; u: AggMetrics; models: { model: string; u: AggMetrics }[] }[]
  tot: AggMetrics
  /** pid -> CSS 变量色映射（aggregate() 结果的 providerColors） */
  providerColors: Record<string, string>
}>()

const DEFAULT_EXPANDED_COUNT = 2

/** 默认展开态：前两组展开（挂载初始化与 groups 刷新重置共用同一逻辑，设计 D5） */
function defaultExpanded(groups: typeof props.groups): Set<string> {
  return new Set(groups.slice(0, DEFAULT_EXPANDED_COUNT).map((g) => g.pid))
}

const expandedGroups = ref(defaultExpanded(props.groups))

// groups 随重试/筛选变化刷新（新数组引用）→ 展开态重置为前两组展开，不残留旧组状态
watch(() => props.groups, (groups) => {
  expandedGroups.value = defaultExpanded(groups)
})

const totTokens = computed(() => totalTokens(props.tot))

function toggle(pid: string): void {
  if (expandedGroups.value.has(pid)) {
    expandedGroups.value.delete(pid)
  } else {
    expandedGroups.value.add(pid)
  }
}
</script>

