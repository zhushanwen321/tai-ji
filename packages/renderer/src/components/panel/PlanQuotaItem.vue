<template>
  <!-- 单项套餐（plan-quota-item）：紧凑化定稿（方案 C）——名称行 + 窗口格行两行制。
       名称行只留显示名与「当前」标记（providerId 已随定稿退场）；窗口格数 = 查询结果里
       pct 非 null 的周期数（平台不返回的周期整格去掉，不留占位——「无该窗口」与「0%」
       语义不同，与 ContextCapacityCard visibleWindows 同判据），可见格等分宽度，增减
       周期只改格数、行高不变。每格两行：标签行上置，值行 = 百分比 + 环 + 剩余时间
       （行内省「剩」前缀，明细仍在格 tooltip）。百分比三档分色（<70 accent / 70-89 warn /
       ≥90 danger 提亮档 --danger-text——原色小字不足 AA，环保持 --danger 原色；分档与
       ContextCapacityCard 同口径）。百分比经 formatQuotaPct 定点两位（SSOT，防浮点尾数
       撑爆行宽）。 -->
  <section :data-testid="`plan-quota-item-${providerId}`" class="leading-[1.3]">
    <div class="flex min-w-0 items-center gap-1.5">
      <span class="min-w-0 flex-1 truncate text-[length:var(--text-2xs)] font-medium text-neutral-fg">{{ label }}</span>
      <span
        v-if="current"
        class="flex-none rounded-[var(--radius-sm)] bg-accent-soft px-[5px] py-px font-mono text-[length:var(--text-3xs)] leading-[1.4] text-accent"
        data-testid="plan-quota-current-tag"
      >{{ t('panel.quotaFloat.current') }}</span>
      <!-- 查询失败且有旧缓存：头部紧凑失败标记——error 与旧数据并存：可见窗口保留 + 失败标记可见
           （与 ContextCapacityCard「error 行与余量行并存」同口径，C-proc-21）；失败原因经 title /
           aria-label 给出。无旧缓存的失败态由下方整行提示承担，两者互斥，共用 plan-quota-error testid
           = 「任一失败态都有可见失败反馈」的单一判据 -->
      <span
        v-if="row !== null && error !== null"
        class="flex shrink-0 text-danger"
        role="img"
        :title="failText"
        :aria-label="failText"
        data-testid="plan-quota-error"
      ><TriangleAlert class="size-3" aria-hidden="true" /></span>
    </div>
    <!-- 查询失败且无旧缓存：整行显式失败提示（不静默空值，C-proc-21） -->
    <p
      v-if="row === null && error !== null"
      class="mt-1.5 text-[length:var(--text-xs)] text-danger"
      data-testid="plan-quota-error"
    >{{ t('panel.quotaFloat.fetchFailed') }}</p>
    <!-- 窗口格行：有数据（含失败态保留的旧数据）时渲染可见窗口（pct=null 整格隐藏）；
         从未查询 / 在途（row 无缓存且无失败）显示查询中占位，防空行闪现。
         查询已完成但全部窗口 pct 为 null 的态不渲染占位（与 ContextCapacityCard
         quotaRow 为真时占位分支不触发同口径）——此时「查询中」是失真文案 -->
    <div v-else-if="windows.length > 0" class="mt-[5px] flex gap-1.5">
      <div
        v-for="w in windows"
        :key="w.idx"
        class="grid min-w-0 flex-1 gap-px justify-items-start"
        :title="w.tip"
        role="progressbar"
        :aria-label="`${label} ${w.key} ${t('panel.quotaFloat.usedPct', { pct: formatQuotaPct(w.pct) })}`"
        :aria-valuenow="w.pct"
        aria-valuemin="0"
        aria-valuemax="100"
        :data-testid="`plan-quota-cell-${providerId}-${w.idx}`"
      >
        <span class="text-[length:var(--text-3xs)] text-neutral-mid">{{ w.key }}</span>
        <span class="flex items-center gap-0.5">
          <span
            class="font-mono text-[length:var(--text-3xs)] font-semibold tabular-nums"
            :class="PCT_TONE_CLASS[w.tone]"
            data-testid="plan-quota-pct"
          >{{ formatQuotaPct(w.pct) }}%</span>
          <!-- 环形（几何与 ContextUsageRing 同源：底环轨道 + 顶部顺时针弧；stroke 4 适配
               12px 显示档）。弧长随 pct 变化；0% 不渲染弧——round 端帽会画出假弧点 -->
          <svg
            viewBox="0 0 24 24"
            fill="none"
            class="size-3 flex-none"
            :class="RING_TONE_CLASS[w.tone]"
            aria-hidden="true"
            :data-testid="`plan-quota-ring-${providerId}-${w.idx}`"
          >
            <circle cx="12" cy="12" :r="RING_RADIUS" stroke="currentColor" stroke-width="4" stroke-opacity="0.22" />
            <circle
              v-if="w.pct > 0"
              cx="12"
              cy="12"
              :r="RING_RADIUS"
              stroke="currentColor"
              stroke-width="4"
              stroke-linecap="round"
              transform="rotate(-90 12 12)"
              :stroke-dasharray="`${w.dash} ${RING_CIRCUMFERENCE}`"
            />
          </svg>
          <span class="font-mono text-[length:var(--text-3xs)] text-neutral-mid">{{ w.resetInline }}</span>
        </span>
      </div>
    </div>
    <p
      v-else-if="row === null && error === null"
      class="mt-1.5 text-[length:var(--text-2xs)] text-neutral-dim"
      data-testid="plan-quota-querying"
    >{{ t('panel.context.quotaQuerying') }}</p>
  </section>
</template>

<script setup lang="ts">
/**
 * PlanQuotaItem —— 套餐浮层的单项（一个 quota.enabled provider 的窗口用量）。
 *
 * 每实例独立 useQuotaQuery（per-provider 实例安全：pending 并发保护在 composable
 * 内部）；挂载即触发一次快照查询——挂载域 = 浮层挂载（宿主 Panel 进
 * conversation/trace 分支且清单非空，含 drawer 已开/trace 激活的不可见形态）；
 * 收起是 v-show 切换不卸载本组件，收起→展开不重复查询。
 * 格 tooltip 承载明细（used/limit/计量单位 + 重置倒计时，带「剩」前缀），行内只留
 * 百分比 + 环 + 紧凑剩余时间。
 *
 * 重查通道两条（都收敛到 onHoverEnter，pending 并发保护在 composable + runtime 双层）：
 * ① quota store 缓存被清（设置页 typeChanged / 关闭再开启额度）→ entry 有→无沿触发；
 * ② 浮层定时统一刷新 bump tick（provide/inject，plan-quota-float.ts SSOT）。
 */
import { computed, inject, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from '@lucide/vue'
import type { QuotaWindow } from '@taiji/shared'
import { formatQuotaPct } from '@taiji/shared'
import { useQuotaQuery } from '@/composables/features/model/useQuotaQuery'
import { formatResetSec, QUOTA_USAGE_DANGER_THRESHOLD, QUOTA_USAGE_HIGH_THRESHOLD } from '@/composables/features/model/useQuotaDisplay'
import { useQuotaStore } from '@/stores/quota'
import { QUOTA_FLOAT_REFRESH_TICK_KEY } from './plan-quota-float'

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
const quotaStore = useQuotaStore()

onMounted(() => {
  void onHoverEnter()
})

// 通道①：缓存清除（entry 有→无）自动重查。挂载首查期间 entry 本为 undefined，
// 只认「有→无」沿，首查不重复触发；查询完成必写 entry（成功 setCache / 失败 setError），
// 不会因「失败无数据」造成 undefined 循环重查。
const entry = computed(() => quotaStore.getEntry(props.providerId))
watch(entry, (now, prev) => {
  if (now === undefined && prev !== undefined) void onHoverEnter()
})

// 通道②：浮层定时统一刷新 tick。独立挂载（单测）无 provider 时回落常量 ref，watch 永不触发。
const refreshTick = inject(QUOTA_FLOAT_REFRESH_TICK_KEY, null)
watch(refreshTick ?? computed(() => 0), () => {
  void onHoverEnter()
})

/** row 供模板失败态判据（null = 无任何缓存数据 → 整行失败提示；非 null = 窗口 + 头部失败标记）。 */
const row = computed(() => data.value)

/**
 * 失败标记的 title / aria-label 文案。error 已是 quotaFailReasonText 本地化后的简短原因，
 * 句式复用 ContextCapacityCard 的 queryFailed（「查询失败：{error}」），不新增 i18n 键。
 */
const failText = computed(() => t('panel.context.queryFailed', { error: error.value ?? '' }))

const WINDOW_LABEL_KEYS = [
  'panel.context.window5h',
  'panel.context.windowWeek',
  'panel.context.windowMonth',
] as const

/** 用量三档（与 ContextCapacityCard 分档同口径）：百分比文字色与环形色分开登记——
 *  文字档 danger 用提亮档（--danger-text，原色小字不足 AA），环保持原色。 */
type UsageTone = 'ok' | 'warn' | 'danger'

const PCT_TONE_CLASS: Record<UsageTone, string> = {
  ok: 'text-accent',
  warn: 'text-warn',
  danger: 'text-[color:var(--danger-text)]',
}

const RING_TONE_CLASS: Record<UsageTone, string> = {
  ok: 'text-accent',
  warn: 'text-warn',
  danger: 'text-danger',
}

/** 环形几何（24 viewBox 基准，与 ContextUsageRing 同源 r=9；stroke 4 适配 12px 显示档） */
const RING_RADIUS = 9
/** 百分比刻度（pct 0..100 → 弧长比例，同 ContextUsageRing PERCENT_SCALE） */
const PERCENT_SCALE = 100
// eslint-disable-next-line no-magic-numbers -- 圆周公式 2πr 的常数 2（数学常数，非领域数值）
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 单窗口渲染模型（等分一格，标签行 + 值行）。idx 保留 wins 原始下标（testid / 排序锚点）。 */
interface WindowCell {
  idx: number
  key: string
  pct: number
  tone: UsageTone
  /** 环形弧长（pct 比例 × 周长；模板 stroke-dasharray 消费） */
  dash: number
  /** 格 tooltip 明细（used/limit/单位 · 剩余，带「剩」前缀） */
  tip: string
  /** 行内紧凑剩余时间（省「剩」前缀，`2h31m` 形态） */
  resetInline: string
}

/** tip 明细：有 used/limit 时展示绝对量 + 计量单位，否则只有百分比。 */
function tipUsage(w: QuotaWindow | undefined, pct: number): string {
  if (w?.limit != null) return `${w.used ?? 0}/${w.limit} ${w.unit ?? ''}`
  return t('panel.quotaFloat.usedPct', { pct: formatQuotaPct(pct) })
}

/**
 * 可见窗口渲染模型：pct=null 的窗口整格不渲染（类型契约：null = 无限/未订阅，
 * 与 ContextCapacityCard visibleWindows 同判据）；全 null（该套餐无任何窗口数据）
 * 时 windows 为空，模板不渲染占位行——「查询中」只覆盖未查询/在途态。数字经
 * formatQuotaPct 定点两位（浮点尾数不出现在行内）。
 */
const windows = computed<WindowCell[]>(() => {
  const rowValue = data.value
  if (!rowValue) return []
  const cells: WindowCell[] = []
  rowValue.wins.forEach((w, i) => {
    if (w.pct == null) return
    cells.push({
      idx: i,
      key: t(WINDOW_LABEL_KEYS[i]),
      pct: w.pct,
      tone: w.pct >= QUOTA_USAGE_DANGER_THRESHOLD ? 'danger' : w.pct >= QUOTA_USAGE_HIGH_THRESHOLD ? 'warn' : 'ok',
      dash: (w.pct / PERCENT_SCALE) * RING_CIRCUMFERENCE,
      tip: `${tipUsage(w, w.pct)} · ${formatResetSec(w.resetSec)}`,
      resetInline: formatResetSec(w.resetSec, true),
    })
  })
  return cells
})
</script>
