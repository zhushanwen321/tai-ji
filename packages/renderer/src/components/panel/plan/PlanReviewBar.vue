<template>
  <!--
    审批条（plan 模式重设计 u1-banner，设计 D5 / G3 / G4；u-plan-bar 起挂 PlanModeBar 右区；
    u-review-source-ui 起 degraded 分支按 reviewStateSource 三分 + 0 评论守卫 + 计数回看）。
    显示驱动公式（D5）：(reviewState ∈ {awaiting, revising} ∪ 挂起 planReview 请求) ∩ isActive。
    isActive=false 整体不渲染（分支④）——退出后挂起请求缓存残留（abort 不发撤回帧，已接受
    代价）由本门兜住不外显。挂载位 = PlanModeBar 行内右区（原主面板底部独立行已随
    PlanModeBar 合并拆除；hairline 由宿主行 border-b 承担，本组件只做行内内容布局）。
    props/emits 无位置耦合，保留独立可测形态（exit 事件归宿主退出确认 Popover）。
  -->
  <div
    v-if="mode"
    data-testid="plan-review-bar"
    class="flex min-w-0 flex-1 items-center justify-end gap-2"
  >
    <!-- 分支① 全功能三键（isActive 且有挂起请求；正常时序 reviewState=awaiting 同真） -->
    <template v-if="mode === 'ready'">
      <!-- 评论计数可点（§3.5 草稿回看）：打开/聚焦 drawer 计划产物 tab + 滚动到草稿列表
           （滚动消费在 PlanDocsPanel，经 plan-store 回看请求信号跨挂载补消费） -->
      <Button
        variant="ghost"
        size="sm"
        data-testid="plan-review-summary"
        class="h-auto shrink-0 gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[length:var(--text-2xs)] text-neutral-dim hover:bg-surface-hover hover:text-neutral-mid"
        :title="t('plan.reviewBar.viewDrafts')"
        @click="onViewDrafts"
      >
        <MessageSquare class="size-3 text-warn" aria-hidden="true" />
        <span>{{ t('plan.reviewBar.commentsCount', { count: drafts.length }) }}</span>
      </Button>
      <span class="flex-1" aria-hidden="true" />
      <Button
        variant="ghost"
        size="sm"
        data-testid="plan-review-explain"
        :disabled="submitting"
        @click="submit('explain')"
      >
        {{ t('plan.reviewBar.requestExplanation') }}
      </Button>
      <!-- 0 评论守卫（§3.5）：无草稿时禁用 + tooltip 说明（禁用态天然不可点，不设二次确认） -->
      <Button
        variant="secondary"
        size="sm"
        data-testid="plan-review-revise"
        :disabled="submitting || drafts.length === 0"
        :title="drafts.length === 0 ? t('plan.reviewBar.reviseEmptyDisabled') : undefined"
        @click="submit('revise')"
      >
        {{ t('plan.reviewBar.submitRevise') }}
        <span
          v-if="drafts.length > 0"
          class="rounded-full bg-warn-soft px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-bold text-warn"
        >{{ drafts.length }}</span>
      </Button>
      <Button
        variant="default"
        size="sm"
        class="gap-1.5 font-semibold"
        data-testid="plan-review-approve"
        :disabled="submitting"
        @click="submit('approve')"
      >
        <Check class="size-3" aria-hidden="true" />
        {{ t('plan.reviewBar.confirmExecute') }}
      </Button>
    </template>
    <!-- 分支② 修订中状态条（按钮不可用；评论追加在 revising 态禁用是 v1 设计内简化） -->
    <div
      v-else-if="mode === 'revising'"
      data-testid="plan-review-revising"
      class="flex items-center gap-2 text-[length:var(--text-xs)] text-warn"
    >
      <span class="size-1.5 animate-pulse rounded-full bg-warn" aria-hidden="true" />
      {{ t('plan.reviewBar.revising') }}
    </div>
    <!-- 分支③ 降级态（awaiting 无挂起）三分支重写（plan-mode-ux-refactor §3.4）：
         reviewStateSource 两源文案 + 旧 entry 缺省通用中性；三分支共用恢复入口指引
         （「发任意消息提醒 agent」，复用既有会话输入语义，无独立按钮）+ 无填充描边
         退出按钮（触发宿主 PlanModeBar 的退出确认 Popover，确认后才 abortPlan——
         用户主动操作路径统一走 §3.5 确认守卫）；耗时显示不做（设计裁决） -->
    <div
      v-else
      data-testid="plan-review-degraded"
      class="flex min-w-0 items-center justify-end gap-2 text-[length:var(--text-xs)] text-neutral-dim"
    >
      <Hourglass class="size-3 shrink-0" aria-hidden="true" />
      <span class="flex min-w-0 flex-col items-end leading-snug">
        <span data-testid="plan-review-degraded-reason">{{ degradedReason }}</span>
        <span
          data-testid="plan-review-degraded-hint"
          class="text-[length:var(--text-2xs)] text-neutral-dim opacity-70"
        >{{ t('plan.reviewBar.degradedRecoverHint') }}</span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        data-testid="plan-review-degraded-exit"
        class="shrink-0"
        @click="emit('exit')"
      >
        {{ t('plan.reviewBar.degradedExit') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PlanReviewBar —— 审批条（三键裁决 + 修订中/降级两非交互态），PlanModeBar 行内右区。
 *
 * 状态源：usePlanState（reviewState 驱动分支 + 评论草稿打包）+ useExtensionUI 的
 * planReviewFilter 实例（挂起请求按 requestId 枚举 + respond 回传，D5 marker select 通道）。
 * 挂载与订阅分工（plan-mode-ux-refactor u-plan-bar，承接清单①）：宿主 PlanModeBar 组件
 * 常驻挂载（isActive=false 时其 template 根 v-if 不渲染 DOM，本组件随之未创建）；
 * isActive=false 期间的订阅存活由 PlanModeBar setup 自持的 useExtensionUI 实例兜底，
 * 请求恒入 extensionUIStore（模块级 refCount 订阅 + store requestId dedup，双实例幂等）。
 * isActive=true 后本组件创建，自持实例承担 getPendingRequests 快照补拉（晚订阅窗口）。
 * 挂起可枚举语义不依赖审批条当前是否可见。
 *
 * 回传 payload = PlanReviewResponse（extension-protocol core/types 契约，本地同形——renderer
 * 不依赖 extension-protocol，与 plan-store 的 PlanReviewComment 同惯例）序列化 JSON 字符串，
 * extension 侧 JSON.parse 消费（解析失败走 E5，不进对话流）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Hourglass, MessageSquare } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { openDrawerTab } from '@taiji/core/domain/drawer'
import { usePlanState } from '@/composables/use-plan-sync'
import { usePlanStore } from '@/stores/plan-store'
import { useExtensionUI, planReviewFilter, type PlanReviewUIRequest } from '@/composables/useExtensionUI'

/** PlanReviewResponse 本地同形（与 extension-protocol core/types 判别联合同构） */
type PlanReviewResponse =
  | { decision: 'approve' }
  | { decision: 'revise'; comments: Array<{ quote: string; comment: string }> }
  | { decision: 'explain'; comments: Array<{ quote: string; comment: string }> }

const props = defineProps<{
  /** 焦点 session（panel store 的 focusedSessionId；审批条只服务焦点 session，D1） */
  sessionId: string | null
}>()

/** exit = degraded 退出按钮请求退出（§3.5：确认守卫归宿主 PlanModeBar 的退出确认 Popover） */
const emit = defineEmits<{ (e: 'exit'): void }>()

const { t } = useI18n()

const sessionIdRef = computed(() => props.sessionId)
const { view, drafts, clearDrafts } = usePlanState(sessionIdRef)
const { currentPlanReviewRequests, respond } = useExtensionUI(sessionIdRef, planReviewFilter)
// 草稿回看请求信号（§3.5）：本组件只发请求，滚动消费在 drawer 侧 PlanDocsPanel
const planStore = usePlanStore()

const isActive = computed(() => view.value?.isActive === true)
const reviewState = computed(() => view.value?.reviewState)
const hasPending = computed(() => currentPlanReviewRequests.value.length > 0)

/** 显示公式（D5）∪ 半边：挂起请求本身独立触发渲染（select 挂起是唯一可靠交互通道） */
const shouldRender = computed(
  () => isActive.value && (hasPending.value || reviewState.value === 'awaiting' || reviewState.value === 'revising'),
)

/**
 * 分支模式（优先级即竞态安全序）：
 * - revising 优先：挂起已被消费的常态；race 窗口（revising+挂起共存）取禁用安全侧
 * - 有挂起请求 → ready：正常时序 awaiting 先落 entry 再挂 select（分支①）；瞬态
 *   「挂起已到、awaiting 帧未到」窗口收敛到 ready——挂起 select 在等用户响应，
 *   不渲染则 agent 永挂
 * - awaiting 无挂起 → degraded（explain 后 / 崩溃恢复后，E3/D5 降级态）
 * - isActive=false / 无值 → null（整体不渲染，分支④）
 */
type BarMode = 'ready' | 'revising' | 'degraded'
const mode = computed<BarMode | null>(() => {
  if (!shouldRender.value) return null
  if (reviewState.value === 'revising') return 'revising'
  if (hasPending.value) return 'ready'
  return 'degraded'
})

const submitting = ref(false)

/**
 * 降级态主文案三分支（§3.4）：reviewStateSource==='explain' → 解答后重提；==='resubmit'
 * → 会话重启（E3）尚未重提；缺省（旧 entry 无字段，LEGACY 形态）→ 通用中性「等待 agent
 * 重新提交审批」，不猜测来源（D4 兼容契约：字段缺省 = 来源未知）。恢复入口与退出按钮
 * 两态共有，在 template 分支外共用。
 */
const degradedReason = computed(() => {
  const source = view.value?.reviewStateSource
  if (source === 'explain') return t('plan.reviewBar.degradedExplain')
  if (source === 'resubmit') return t('plan.reviewBar.degradedResubmit')
  return t('plan.reviewBar.waitingResubmit')
})

/**
 * 草稿回看（§3.5）：评论计数可点 → 打开/聚焦 drawer 计划产物 tab（openDrawerTab 既有
 * core API）+ 发回看请求（plan-store 信号）；滚动到草稿列表由 PlanDocsPanel 消费——
 * drawer 关闭时该面板未挂载，consumed 标记让请求跨挂载保留到消费为止。
 */
function onViewDrafts(): void {
  openDrawerTab('plan')
  planStore.requestDraftsReveal()
}

/**
 * 三键裁决回传（D5）：payload 序列化 JSON 经 respond（extension.ui_response）回 pi select
 * resolve；revise/explain 打包评论草稿（拷贝快照，不传响应式引用）；三键回传后一律清草稿
 * （D6：草稿生命周期到提交为止——revise/explain 注入对话流、approve 终局同样清（C-U2：
 * 否则跨 plan run 残留，同 session 再次 /plan 时审批条显旧评论计数、误触 revise 注入旧
 * 评论）。取首个挂起请求——正常时序恒单条（extension 单挂起），requestId 精确回传。
 */
function submit(decision: 'approve' | 'revise' | 'explain'): void {
  const request: PlanReviewUIRequest | undefined = currentPlanReviewRequests.value[0]
  if (!request || submitting.value) return
  submitting.value = true
  try {
    const comments = drafts.value.map((d) => ({ quote: d.quote, comment: d.comment }))
    const payload: PlanReviewResponse =
      decision === 'approve' ? { decision: 'approve' } : { decision, comments }
    respond(request.requestId, JSON.stringify(payload))
    clearDrafts()
  } finally {
    submitting.value = false
  }
}
</script>
