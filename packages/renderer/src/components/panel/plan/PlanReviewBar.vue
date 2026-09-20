<template>
  <!--
    审批条（plan 模式重设计 u1-banner，设计 D5 / G3 / G4；u-plan-bar 起挂 PlanModeBar 右区）。
    显示驱动公式（D5）：(reviewState ∈ {awaiting, revising} ∪ 挂起 planReview 请求) ∩ isActive。
    isActive=false 整体不渲染（分支④）——退出后挂起请求缓存残留（abort 不发撤回帧，已接受
    代价）由本门兜住不外显。挂载位 = PlanModeBar 行内右区（原主面板底部独立行已随
    PlanModeBar 合并拆除；hairline 由宿主行 border-b 承担，本组件只做行内内容布局）。
    props/emits 无位置耦合，保留独立可测形态。
  -->
  <div
    v-if="mode"
    data-testid="plan-review-bar"
    class="flex min-w-0 flex-1 items-center justify-end gap-2"
  >
    <!-- 分支① 全功能三键（isActive 且有挂起请求；正常时序 reviewState=awaiting 同真） -->
    <template v-if="mode === 'ready'">
      <span
        data-testid="plan-review-summary"
        class="flex items-center gap-1.5 text-[length:var(--text-2xs)] text-neutral-dim"
      >
        <MessageSquare class="size-3 text-warn" aria-hidden="true" />
        <span>{{ t('plan.reviewBar.commentsCount', { count: drafts.length }) }}</span>
      </span>
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
      <Button
        variant="secondary"
        size="sm"
        data-testid="plan-review-revise"
        :disabled="submitting"
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
    <!-- 分支③ 降级态（awaiting 无挂起：explain 后 / 崩溃恢复后，等待 agent 重调 submit-review） -->
    <div
      v-else
      data-testid="plan-review-degraded"
      class="flex items-center gap-2 text-[length:var(--text-xs)] text-neutral-dim"
    >
      <Hourglass class="size-3" aria-hidden="true" />
      {{ t('plan.reviewBar.waitingResubmit') }}
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
import { usePlanState } from '@/composables/use-plan-sync'
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

const { t } = useI18n()

const sessionIdRef = computed(() => props.sessionId)
const { view, drafts, clearDrafts } = usePlanState(sessionIdRef)
const { currentPlanReviewRequests, respond } = useExtensionUI(sessionIdRef, planReviewFilter)

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
