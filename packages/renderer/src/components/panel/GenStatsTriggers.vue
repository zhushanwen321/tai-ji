<template>
  <!--
    composer-gen-stats 三触发器（D4/D5 + composer-genstats-ttft U4）。
    组件内顺序（左→右）：TTFT 首字延迟 · TOKEN 速度（t/s）· 缓存命中率（%），整组位于
    上下文容量触发器左侧。独立判定 null → 「—」（无值编码纪律：null=无数据，0=真实
    测量值，D4）。语义色三档（项目语义色 token，纯灰体系既有档）：
      命中率（正向）：≥80 success · 50–80 warn · <50 danger；
      TTFT（反向延迟）：<1500ms success · 1500–3000ms warn · >3000ms danger（阈值为初值，
      无历史校准源，重审触发 = 用户反馈档位与体感系统性不符，设计 §3.1）；null 恒中性灰。
    hover 出各自浮层：速度/TTFT 四行（本次/今日/7天/30天）+ 口径说明；缓存两行（本次/今日
    加权）+ bar + 口径说明。「本次」= 本会话最近一次请求样本（会话视角，runtime per-session
    槽）；今日/7天/30天 = 该模型跨会话全局聚合（模型视角；速度为加权平均，TTFT 为 p50
    中位数——延迟重尾，均值被偶发慢请求拉飞）。数据纯读 useGenStats 分区（订阅/恢复腿/
    model 校验兜底全在 composable）。
  -->
  <div class="flex items-center gap-0">
    <!-- TTFT 触发器（速度左侧，composer-genstats-ttft） -->
    <HoverCard>
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          :class="
            cn(
              'h-7 gap-1 rounded-sm px-2 text-[11px] transition-colors',
              ttftTriggerClass,
            )
          "
          :title="t('panel.context.genStatsTtftTitle')"
        >
          <span class="tabular-nums" data-testid="genstats-ttft-value">{{ ttftDisplay }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        class="w-[260px] p-0"
        data-testid="genstats-ttft-popover"
      >
        <!-- head -->
        <div
          class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
        >
          <span>{{ t('panel.context.genStatsTtftTitle') }}</span>
          <span class="max-w-[140px] truncate" data-testid="genstats-ttft-model">{{ frame?.model ?? '—' }}</span>
        </div>
        <!-- 无合法帧：暂无数据（§3.1——从未有帧与有帧无值的 UX 差异落在浮层） -->
        <div v-if="!frame" class="px-2.5 py-3 text-center text-[10.5px] text-neutral-dim">
          {{ t('panel.context.genStatsNoData') }}
        </div>
        <template v-else>
          <!-- 四行聚合（2×2 grid）：本次 / 今日 p50 / 近 7 天 p50 / 近 30 天 p50 -->
          <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
            <div v-for="row in ttftRows" :key="row.label" class="flex flex-col gap-0.5">
              <!-- 「本次」label 复用 C4 hover 补句（同「本会话最近一次请求」语义，速度侧共用） -->
              <span
                class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim"
                :title="row.note ?? undefined"
              >{{ row.label }}</span>
              <span
                class="font-sans text-[14px] font-semibold tabular-nums"
                :class="row.value == null ? 'text-neutral-dim' : 'text-neutral-fg'"
              >{{ row.display }}</span>
            </div>
          </div>
          <!-- 口径说明 -->
          <div class="border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
            {{ t('panel.context.genStatsTtftNote') }}
          </div>
        </template>
      </HoverCardContent>
    </HoverCard>

    <!-- 速度触发器 -->
    <HoverCard>
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          class="h-7 gap-1 rounded-sm px-2 text-[11px] text-neutral-dim transition-colors hover:text-neutral-mid"
          :title="t('panel.context.genStatsSpeedTitle')"
        >
          <span class="tabular-nums" data-testid="genstats-speed-value">{{ speedDisplay }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        class="w-[260px] p-0"
      >
        <!-- head -->
        <div
          class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
        >
          <span>{{ t('panel.context.genStatsSpeedTitle') }}</span>
          <span class="max-w-[140px] truncate" data-testid="genstats-speed-model">{{ frame?.model ?? '—' }}</span>
        </div>
        <!-- 无合法帧：暂无数据（§3.4——从未有帧与有帧无值的 UX 差异落在浮层） -->
        <div v-if="!frame" class="px-2.5 py-3 text-center text-[10.5px] text-neutral-dim">
          {{ t('panel.context.genStatsNoData') }}
        </div>
        <template v-else>
          <!-- 四行聚合（2×2 grid）：本次 / 今日均值 / 近 7 天 / 近 30 天 -->
          <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
            <div v-for="row in speedRows" :key="row.label" class="flex flex-col gap-0.5">
              <!-- 「本次」label 带 hover 补句（C4）：current 无窗口过滤且为会话私有样本，澄清样本来自本会话最近一次请求 -->
              <span
                class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim"
                :title="row.note ?? undefined"
              >{{ row.label }}</span>
              <span class="font-sans text-[14px] font-semibold tabular-nums" :class="row.value == null ? 'text-neutral-dim' : 'text-neutral-fg'">
                {{ row.value == null ? '—' : `${row.value} t/s` }}
              </span>
            </div>
          </div>
          <!-- 口径说明 -->
          <div class="border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
            {{ t('panel.context.genStatsSpeedNote') }}
          </div>
        </template>
      </HoverCardContent>
    </HoverCard>

    <!-- 缓存命中率触发器 -->
    <HoverCard>
      <HoverCardTrigger as-child>
        <Button
          variant="ghost"
          :class="
            cn(
              'h-7 gap-1 rounded-sm px-2 text-[11px] transition-colors',
              cacheTriggerClass,
            )
          "
          :title="t('panel.context.genStatsCacheTitle')"
        >
          <span class="tabular-nums" data-testid="genstats-cache-value">{{ cacheDisplay }}</span>
        </Button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        class="w-[260px] p-0"
      >
        <!-- head -->
        <div
          class="flex items-center justify-between border-b border-border bg-white/[0.015] px-2.5 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-neutral-dim"
        >
          <span>{{ t('panel.context.genStatsCacheTitle') }}</span>
          <span class="max-w-[140px] truncate" data-testid="genstats-cache-model">{{ frame?.model ?? '—' }}</span>
        </div>
        <!-- 无合法帧：暂无数据 -->
        <div v-if="!frame" class="px-2.5 py-3 text-center text-[10.5px] text-neutral-dim">
          {{ t('panel.context.genStatsNoData') }}
        </div>
        <template v-else>
          <!-- 两行聚合：本次请求 / 今日加权 -->
          <div class="grid grid-cols-2 gap-x-3.5 gap-y-2 px-2.5 py-2.5">
            <div class="flex flex-col gap-0.5">
              <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.genStatsCurrentReq') }}</span>
              <span class="font-sans text-[14px] font-semibold tabular-nums" :class="frame.cacheRatio.current == null ? 'text-neutral-dim' : 'text-neutral-fg'">
                {{ cachePercentDisplay(frame.cacheRatio.current) }}
              </span>
            </div>
            <div class="flex flex-col gap-0.5">
              <span class="font-mono text-[10px] uppercase tracking-[0.05em] text-neutral-dim">{{ t('panel.context.genStatsDayShort') }}</span>
              <span class="font-sans text-[14px] font-semibold tabular-nums" :class="frame.cacheRatio.day == null ? 'text-neutral-dim' : 'text-neutral-fg'">
                {{ cachePercentDisplay(frame.cacheRatio.day) }}
              </span>
            </div>
          </div>
          <!-- bar（仅本次命中率有值时显示；宽度/颜色按三档语义色） -->
          <div v-if="frame.cacheRatio.current != null" class="mx-2.5 mt-0.5 h-1 overflow-hidden rounded-full bg-surface-2">
            <div
              :class="cn('h-full rounded-full transition-[width,background-color]', cacheBarClass)"
              :style="{ width: `${frame.cacheRatio.current}%` }"
              data-testid="genstats-cache-bar"
            />
          </div>
          <!-- 口径说明 -->
          <div class="mt-2 border-t border-border px-2.5 py-1.5 font-mono text-[10px] text-neutral-dim">
            {{ t('panel.context.genStatsCacheNote') }}
          </div>
        </template>
      </HoverCardContent>
    </HoverCard>
  </div>
</template>

<script lang="ts">
/**
 * TTFT 展示纯函数与阈值常量（composer-genstats-ttft U4，设计 §3.1）——经普通 script 块
 * 命名导出供单测直连（照 AsyncErrorFallback.vue 双 script 块先例；数值格式化与三档色
 * 判定不依赖组件实例/reactive 状态，抽纯函数是实施计划 U4 的显式要求）。
 */

/** 三档语义色阈值（ms，延迟反向指标）。**初值**——无历史校准源（cacheRatio 三档色先例），
 *  重审触发 = 用户反馈显示档位与体感系统性不符（设计 §3.1，同速度口径 D1 重审模式）。 */
export const TTFT_WARN_THRESHOLD_MS = 1500
export const TTFT_DANGER_THRESHOLD_MS = 3000

/** 秒级显示阈值（ms）：< 该值显整数毫秒「820ms」，≥ 该值转 1 位小数秒（设计 §3.1） */
const TTFT_SECONDS_DISPLAY_THRESHOLD_MS = 1000
/** 秒级取整步长（ms）：100ms = 0.1s 粒度，四舍五入到 1 位小数 */
const TTFT_SECONDS_ROUNDING_STEP_MS = 100
/** 十分位/秒换算：10 个 0.1s = 1s */
const TENTHS_PER_SECOND = 10

/** TTFT 时长格式化（设计 §3.1）：<1000ms → 整数毫秒「820ms」；≥1000 →「1.2s」（1 位小数
 *  四舍五入、去尾 0：1000 →「1s」）。null 判定归调用方（触发器/浮层行显「—」，无值纪律
 *  null 禁 ?? 0）。 */
export function formatTtftDuration(ms: number): string {
  if (ms < TTFT_SECONDS_DISPLAY_THRESHOLD_MS) return `${ms}ms`
  const seconds = Math.round(ms / TTFT_SECONDS_ROUNDING_STEP_MS) / TENTHS_PER_SECOND
  return `${seconds}s`
}

/** TTFT 三档语义色档位（设计 §3.1，延迟反向——值越大越差）：null 恒中性；
 *  <1500 success · 1500–3000 warn · >3000 danger。 */
export type TtftTier = 'success' | 'warn' | 'danger' | 'neutral'

export function ttftTier(ms: number | null): TtftTier {
  if (ms == null) return 'neutral'
  if (ms < TTFT_WARN_THRESHOLD_MS) return 'success'
  if (ms <= TTFT_DANGER_THRESHOLD_MS) return 'warn'
  return 'danger'
}

/** 档位 → 触发器 class 映射。字面量静态串（Tailwind JIT 按源码扫描生成类；模板字符串
 *  拼接动态类名不在扫描集，样式会静默丢失——映射表而非 `text-${tier}` 拼接）。 */
export const TTFT_TRIGGER_TIER_CLASSES: Record<TtftTier, string> = {
  success: 'text-success hover:text-success',
  warn: 'text-warn hover:text-warn',
  danger: 'text-danger hover:text-danger',
  neutral: 'text-neutral-dim hover:text-neutral-mid',
}
</script>

<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { useGenStats } from '@/composables/features/model/useGenStats'

/**
 * 纯读组件（D5）：per-session 分区状态在 useGenStats composable，组件只做帧 → 显示映射。
 * session 分区键 + 恢复腿触发源 = sessionId；modelId（复合 "provider/modelId"）供 composable
 * 做帧 model 校验兜底（D4 前端防线），由 Composer 下发（对齐 ContextCapacityPopover 受控范式）。
 */
const props = defineProps<{
  sessionId?: string
  modelId?: string
}>()

const { t } = useI18n()

// 订阅（session.stats_update）/ 恢复腿（session.getGenStats）/ model 校验全在 composable 内
const { current: frame } = useGenStats(toRef(props, 'sessionId'), toRef(props, 'modelId'))

// ── TTFT 触发器（composer-genstats-ttft）：current →「820ms / 1.2s」，null →「—」 ──
const ttftCurrent = computed(() => frame.value?.ttft.current ?? null)

const ttftDisplay = computed(() => (ttftCurrent.value == null ? '—' : formatTtftDuration(ttftCurrent.value)))

/** 三档语义色（延迟反向，阈值常量集中定义于上方命名导出；null 恒中性灰） */
const ttftTriggerClass = computed(() => TTFT_TRIGGER_TIER_CLASSES[ttftTier(ttftCurrent.value)])

/** TTFT 浮层四行（display 预格式化：null →「—」；<1000ms →「820ms」；≥1000 →「1.2s」）。
 *  p50 行 label 用 TTFT 专属 key（「今日 p50」），不复用 genStatsDay（「今日均值」与 p50
 *  中位数语义矛盾，设计 §3.1）；「本次」行 label/hover 补句复用速度侧 key（语义相同）。 */
const ttftRows = computed(() => {
  const v = frame.value?.ttft
  return [
    { label: t('panel.context.genStatsCurrent'), note: t('panel.context.genStatsCurrentNote'), value: v?.current ?? null },
    { label: t('panel.context.genStatsTtftDay'), value: v?.day ?? null },
    { label: t('panel.context.genStatsTtftD7'), value: v?.d7 ?? null },
    { label: t('panel.context.genStatsTtftD30'), value: v?.d30 ?? null },
  ].map((row) => ({ ...row, display: row.value == null ? '—' : formatTtftDuration(row.value) }))
})

// ── 速度触发器：current →「N t/s」，null →「—」 ──
const speedDisplay = computed(() => {
  const v = frame.value?.speed.current
  return v == null ? '—' : `${v} t/s`
})

/** 速度浮层四行（label + 聚合值；null → 浮层行显「—」）。note = label 的原生
 *  title 补句（仅「本次」有——C4 current 无窗口过滤语义澄清）。 */
const speedRows = computed(() => {
  const s = frame.value?.speed
  return [
    { label: t('panel.context.genStatsCurrent'), note: t('panel.context.genStatsCurrentNote'), value: s?.current ?? null },
    { label: t('panel.context.genStatsDay'), value: s?.day ?? null },
    { label: t('panel.context.genStatsD7'), value: s?.d7 ?? null },
    { label: t('panel.context.genStatsD30'), value: s?.d30 ?? null },
  ]
})

// ── 缓存命中率：三档语义色阈值（设计 §3.1：≥80 绿 / 50–80 黄 / <50 红） ──
const CACHE_SUCCESS_THRESHOLD = 80
const CACHE_WARN_THRESHOLD = 50

const cacheCurrent = computed(() => frame.value?.cacheRatio.current ?? null)

const cacheTriggerClass = computed(() => {
  const v = cacheCurrent.value
  if (v == null) return 'text-neutral-dim hover:text-neutral-mid'
  if (v >= CACHE_SUCCESS_THRESHOLD) return 'text-success hover:text-success'
  if (v >= CACHE_WARN_THRESHOLD) return 'text-warn hover:text-warn'
  return 'text-danger hover:text-danger'
})

const cacheBarClass = computed(() => {
  const v = cacheCurrent.value
  if (v == null) return 'bg-neutral-dim'
  if (v >= CACHE_SUCCESS_THRESHOLD) return 'bg-success'
  if (v >= CACHE_WARN_THRESHOLD) return 'bg-warn'
  return 'bg-danger'
})

/** 百分比统一显示：null →「—」，否则「N%」 */
function cachePercentDisplay(v: number | null | undefined): string {
  return v == null ? '—' : `${v}%`
}

const cacheDisplay = computed(() => cachePercentDisplay(cacheCurrent.value))
</script>
