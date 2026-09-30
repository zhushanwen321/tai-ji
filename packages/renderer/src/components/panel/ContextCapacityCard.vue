<!--
  ContextCapacityCard —— 上下文容量浮层的**纯内容卡**（W3a 拆分：原 ContextCapacityPopover 的
  HoverCardContent 完整内容原样迁移，head / bar / stats / coding-plan quota 段结构与文案不变）。

  拆分动机：三步聚合的指标聚合页（ComposerMetricsAggregate）要把「容量 + 速度 + 缓存」三张卡
  纵向拼进同一个浮层——若沿用「Popover 包内容」的形态，聚合页会嵌套 HoverCard / Popover，
  触发器重复渲染且交互打架。故内容独立成本卡：聚合页直拼本卡，既有触发器（本卡的原宿主）
  也改挂本卡，删掉重复渲染。

  契约：props = { sessionId?, modelId? }（受控，语义与原 Popover 一致——sessionId 为可选是
  为兼容 ContextCapacityPopover 的可选透传），无 emits。数据纯读（useContextUsage 分区 +
  useQuotaDisplay 派生），quota 查询触发不在本卡（hover-enter 查询仍挂在各自触发器上，
  store 全局共享、双实例同源收敛）。
-->
<template>
  <!-- head -->
  <div
    class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
  >
    <span>{{ t('panel.context.capacity') }}</span>
    <!-- modelId 无 runtime 来源（D9）：占位「—」 -->
    <span>—</span>
  </div>
  <!-- bar（仅 contextWindow 已知时显示） -->
  <div v-if="hasPercent" class="mx-2.5 mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
    <div
      :class="cn('h-full rounded-full transition-[width,background-color]', usageBarClass(usage.percent))"
      :style="{ width: `${usage.percent}%` }"
    />
  </div>
  <!-- stats -->
  <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
    <div class="flex flex-col gap-0.5">
      <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.used') }}</span>
      <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-fg">{{ usedDisplay }}</span>
    </div>
    <div class="flex flex-col gap-0.5">
      <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.total') }}</span>
      <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-fg">{{ hasPercent ? totalDisplay : t('panel.context.unknown') }}</span>
    </div>
    <div class="flex flex-col gap-0.5">
      <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.usageRate') }}</span>
      <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-fg">{{ hasPercent ? `${usage.percent}%` : '—' }}</span>
    </div>
    <div class="flex flex-col gap-0.5">
      <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.cacheHit') }}</span>
      <!-- cacheHit 无 runtime 来源（D9）：占位「—」 -->
      <span class="font-sans text-[14px] font-semibold tabular-nums text-neutral-dim">—</span>
    </div>
  </div>

  <!-- coding-plan 区（仅 provider 命中 quota preset 时显示） -->
  <template v-if="matchedProviderId">
    <div class="mx-2.5 h-px bg-border" />
    <div class="px-2.5 pt-2">
      <!-- section label + provider tag -->
      <div class="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-neutral-dim">
        <span>Coding Plan</span>
        <span
          v-if="matchedPresetLabel"
          :class="cn(
            'rounded-sm px-1 py-px text-[9px] font-semibold tracking-[0.03em]',
            quotaDanger ? 'bg-danger-soft text-danger' : quotaWarning ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent',
          )"
        >{{ matchedPresetLabel }}</span>
      </div>

      <!-- 查询失败提示（B2：区分「从未查询」vs「查询失败」） -->
      <div v-if="error" class="py-1.5 text-center text-[10.5px] text-danger">
        {{ t('panel.context.queryFailed', { error }) }}
      </div>

      <!-- 3 窗口行（4 列 grid） -->
      <template v-else-if="quotaRow">
        <div
          v-for="(win, idx) in visibleWindows"
          :key="idx"
          class="grid items-center py-0.5"
          style="grid-template-columns: 32px 1fr 32px 52px; column-gap: 8px; font-size: 11px; line-height: 1.4;"
        >
          <span class="font-sans text-[10.5px] text-neutral-mid">{{ windowLabels[win.idx] }}</span>
          <div class="relative h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              :class="cn('h-full rounded-full transition-[width,background-color]', win.pct >= DANGER_THRESHOLD ? 'bg-danger' : win.pct >= HIGH_THRESHOLD ? 'bg-warn' : 'bg-gradient-to-r from-accent to-accent-hover')"
              :style="{ width: `${win.pct}%` }"
            />
          </div>
          <span
            :class="cn(
              'text-right font-semibold tabular-nums',
              win.pct >= DANGER_THRESHOLD ? 'text-danger' : win.pct >= HIGH_THRESHOLD ? 'text-warn' : 'text-neutral-fg',
            )"
          >{{ win.pct }}%</span>
          <span class="truncate text-right font-mono text-[9.5px] tabular-nums text-neutral-dim">
            {{ formatReset(win.resetSec) }}
          </span>
        </div>
      </template>

      <!-- 无数据时的占位 -->
      <div v-else class="py-1.5 text-center text-[10.5px] text-neutral-dim">
        {{ isPending ? t('panel.context.quotaQuerying') : t('panel.context.noQuotaData') }}
      </div>
    </div>
  </template>

  <!-- footer -->
  <div class="flex items-center justify-between border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
    <span v-if="matchedProviderId && lastFetchAt">
      {{ formatLastFetch(lastFetchAt) }}
    </span>
    <span v-else-if="matchedProviderId">
      {{ t('panel.context.noCodingPlanData') }}
    </span>
    <span v-else>
      {{ t('panel.context.noCodingPlan') }}
    </span>
    <!--
      按钮组：两个按钮必须同属一个容器，才在 justify-between 下整体成组贴右端。
      组与组的语义理由——D11 的「刷新」「配置」是同一处失败态的两个互补恢复动作（重试 / 去修凭证），
      散成 footer 的直接子项会被 justify-between 与状态文字均分到中间，既与成功态单按钮位置不一致，
      又让两个恢复动作视觉上互不相关（用户读不出它们解决同一问题）。
    -->
    <div class="flex items-center gap-1" data-testid="quota-footer-actions">
      <Button
        v-if="matchedProviderId"
        variant="secondary"
        class="h-5 rounded-sm px-1.5 font-mono text-[9.5px]"
        :disabled="refreshing"
        data-testid="quota-refresh-btn"
        @click.stop="onRefresh"
      >
        {{ refreshing ? t('panel.context.refreshing') : t('panel.context.refresh') }}
      </Button>
      <!--
        D11：失败态 footer 同时给「刷新」与「配置」。现状是 v-if matchedProviderId / v-else 二选一
        ——「已启用但凭证缺失」的 provider 必有 matchedProviderId，只会拿到「刷新」，而刷新在凭证
        缺失时只会再失败一次，形成死路。error 非空即查询失败态，此时补上跳设置页的恢复入口。
      -->
      <Button
        v-if="!matchedProviderId || error"
        variant="secondary"
        class="h-5 rounded-sm px-1.5 font-mono text-[9.5px]"
        data-testid="quota-configure-btn"
        @click.stop="openSettings"
      >
        {{ t('panel.context.configureCodingPlan') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * ContextCapacityCard 脚本 —— 原 ContextCapacityPopover 的浮层内容逻辑整体迁移
 * （用量读映射 / quota 展示派生 / refreshQuota 刷新腿），触发器相关（hover-enter 查询 /
 * 触发器文案着色）留在原 Popover——quota 查询不进本卡的原因：store 全局共享、
 * 双实例同源收敛，而查询触发语义属于「hover 指标 chip」这一交互面（聚合触发器同样挂）。
 */
import { ref, computed, toRef, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useContextUsage } from '@/composables/features/model/useContextUsage'
import { useQuotaStore } from '@/stores/quota'
import { useQuotaDisplay } from '@/composables/features/model/useQuotaDisplay'
import { quotaFailReasonText } from '@/composables/features/model/useQuotaQuery'
import { formatTokens, usageBarClass } from './context-usage-display'
import * as quotaApi from '@taiji/core/transport/api/domains/quota'

const props = defineProps<{
  /** session 分区键 + 恢复腿触发源（context-consistency D2：用量状态在 useContextUsage 分区，组件纯读） */
  sessionId?: string
  /** 当前复合 modelId（"provider/modelId"），受控 prop，由消费方（Popover / 聚合页）下发 */
  modelId?: string
}>()

const { t } = useI18n()
const quotaStore = useQuotaStore()

// Settings 模态框打开（AppShell 经 provide('openSettings') 注入；未提供时 no-op）。
// 未配置态「配置 Coding Plan」按钮跳转 Settings → Provider 页（偏差 #D）。
const openSettings = inject<() => void>('openSettings', () => {})

// ── 上下文用量（context-consistency D2 终态）：per-session 分区纯读 ──
// 订阅（context.update）/ 切回恢复腿（session.getContext）/ 0 帧哨兵全在 composable 内，
// 组件只做 status → 显示映射：ok → 真值；no-value（合法无值，如 compact 后无新 turn）与
// unknown（首拉在途且无缓存）→ 「—」。切走再切回显示分区缓存值，不闪横线不串台。
const { current: usage } = useContextUsage(toRef(props, 'sessionId'))

// ── coding-plan 额度展示（逻辑抽到 useQuotaDisplay）──
const {
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
} = useQuotaDisplay(toRef(props, 'modelId'))

// 阈值常量（与 useQuotaDisplay 一致，模板分档用）
const HIGH_THRESHOLD = 70
const DANGER_THRESHOLD = 90

/** 刷新中（refreshQuota 路径独立于 hover-enter 的 isPending）。 */
const refreshing = ref(false)

/**
 * 刷新按钮点击（W1：改用 refreshQuota 绕过 10s throttle）。
 * 不走 onHoverEnter→fetchQuota（受 throttle，10s 内刷新拿缓存）。
 */
async function onRefresh(): Promise<void> {
  const pid = matchedProviderId.value
  if (!pid) return
  refreshing.value = true
  try {
    // refreshQuota 失败时 runtime 返回失败态（ok=true + data=null + reason，A2-4 契约），不抛错：
    // 带 reason → 保留旧 data、写 error 让 UI 显失败提示（与 useQuotaQuery 一致）；
    // rejected（连接层错误）同样保留旧 data 写 error
    const result = await quotaApi.refreshQuota(pid)
    if (result.reason) {
      quotaStore.setError(pid, quotaFailReasonText(result.reason))
    } else {
      quotaStore.setCache(pid, result.data, result.lastFetchAt)
    }
  } catch (e) {
    quotaStore.setError(pid, e instanceof Error ? e.message : String(e))
  } finally {
    refreshing.value = false
  }
}

// ── 容量区计算（原 Popover 迁移）──

const usedDisplay = computed(() => formatTokens(usage.value.used))
const totalDisplay = computed(() => formatTokens(usage.value.total))

/** contextWindow 已知（provider 未配 contextWindow 时 total=0：只显用量不显百分比） */
const hasPercent = computed(() => usage.value.status === 'ok' && usage.value.total > 0)
</script>
