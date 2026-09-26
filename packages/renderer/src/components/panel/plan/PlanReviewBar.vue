<template>
  <!--
    审批条（plan 模式状态机显式化 D3/D4/D8/D9）。
    显示驱动公式（D4 单源，derivePlanReviewBarMode 承载）：ready ⇔ 挂起 planReview 请求
    （runtime 注册表投影，唯一交互权威；presence 语义——ready 恒优先渲染）；revising ⇔
    state=revising；degraded ⇔ state=reviewing ∧ 无挂起 ∧ 稳定窗放行（组合持续 ≥2s 或
    冷拉真值豁免）；「已应答抑制窗」标记压制 degraded/revising；state=dispatching/approved
    不进审批条（执行方式表单是其唯一交互面）；其余不渲染。
    isActive=false 整体不渲染——退出后挂起请求缓存残留（abort 不发撤回帧，已接受代价；
    runtime 失效链 P2-2 起在非 respond 终结点广播失效帧做主清理）由 isActive 门兜住不外显。
    挂载位 = PlanModeBar 行内右区（hairline 由宿主行 border-t 承担，本组件只做行内内容布局）。
    行内布局契约（F-R2-2 窄窗反重叠）：右区 = grow + flex-wrap + min-w-0（basis 走
    max-content）——窄窗一行放不下时右区整体换行到宿主行第二行（行内再 flex-wrap 兜底
    极窄窗），左区 shrink-0 优先保全。禁止改回 flex-1：basis 0% 使换行判定的假想主尺寸
    恒 0、宿主行 flex-wrap 永不触发，min-w-0 收缩后 justify-end 内容左溢覆盖左区
    （r2-s10 验收事故形态：右区按键矩形覆盖左区文字/退出，pointer 拦截三键全不可点）。
    props/emits 无位置耦合，保留独立可测形态。
  -->
  <div
    v-if="mode"
    data-testid="plan-review-bar"
    class="flex min-w-0 grow flex-wrap items-center justify-end gap-2"
  >
    <!-- 重新提交失败（D8：发送失败/agent 未响应）：就近错误行 + 保留降级态可重试（失败要出声）；
         退出兜底入口在左区常驻 -->
    <p
      v-if="resubmitError"
      data-testid="plan-review-resubmit-error"
      role="alert"
      class="w-full text-right text-[length:var(--text-2xs)] text-danger"
    >
      {{ resubmitError }}
    </p>
    <!-- 分支① 全功能审批键（挂起请求在场即渲染——presence 语义）。
         D13⑦ 0 草稿不渲染评论计数键（常态归零）；D13② 评论计数图标/角标去 warn 色
         （warn 语义回归 §5.6 异常待处理），图标 accent / 角标 neutral -->
    <template v-if="mode === 'ready'">
      <!-- 评论计数可点（§3.5 草稿回看）：打开/聚焦 drawer 计划产物 tab + 滚动到草稿列表
           （滚动消费在 PlanDocsPanel，经 plan-store 回看请求信号跨挂载补消费） -->
      <Button
        v-if="drafts.length > 0"
        variant="ghost"
        size="sm"
        data-testid="plan-review-summary"
        class="h-auto shrink-0 gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[length:var(--text-2xs)] text-neutral-dim hover:bg-surface-hover hover:text-neutral-mid"
        :title="t('plan.reviewBar.viewDrafts')"
        @click="onViewDrafts"
      >
        <MessageSquare class="size-3 text-accent" aria-hidden="true" />
        <span>{{ t('plan.reviewBar.commentsCount', { count: drafts.length }) }}</span>
      </Button>
      <!-- D9③ agent 自审结论行（截断 + 点击 Popover 看全文）；旧扩展不携带 selfReview →
           不渲染（降级形态，不伪造空行）。Popover 受控开合（PlanModeBar 退出确认同款形态） -->
      <Popover v-if="selfReview" :open="selfReviewOpen" @update:open="selfReviewOpen = $event">
        <PopoverTrigger as-child>
          <Button
            variant="ghost"
            size="sm"
            data-testid="plan-review-self-review"
            class="h-auto min-w-0 shrink-0 gap-1.5 rounded-[var(--radius-sm)] px-1.5 py-0.5 text-[length:var(--text-2xs)] text-neutral-dim hover:bg-surface-hover hover:text-neutral-mid"
            :title="t('plan.reviewBar.selfReviewLabel')"
            :aria-label="t('plan.reviewBar.selfReviewLabel')"
          >
            <Info class="size-3 shrink-0 text-accent" aria-hidden="true" />
            <span class="max-w-56 truncate">{{ selfReview }}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" :collision-padding="8" class="w-80 p-3">
          <div data-testid="plan-review-self-review-full" class="flex flex-col gap-1.5">
            <p class="text-[length:var(--text-2xs)] font-medium text-neutral-fg">
              {{ t('plan.reviewBar.selfReviewLabel') }}
            </p>
            <p class="whitespace-pre-wrap break-words text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">
              {{ selfReview }}
            </p>
          </div>
        </PopoverContent>
      </Popover>
      <span class="flex-1" aria-hidden="true" />
      <!-- 0 评论守卫（§3.5）：无草稿时禁用 + tooltip 说明（禁用态天然不可点，不设二次确认） -->
      <Button
        variant="secondary"
        size="sm"
        data-testid="plan-review-revise"
        :disabled="drafts.length === 0"
        :title="drafts.length === 0 ? t('plan.reviewBar.reviseEmptyDisabled') : undefined"
        @click="submit('revise')"
      >
        {{ t('plan.reviewBar.submitRevise') }}
        <span
          v-if="drafts.length > 0"
          class="rounded-full bg-surface-hover px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-bold text-neutral-mid"
        >{{ drafts.length }}</span>
      </Button>
      <Button
        variant="default"
        size="sm"
        class="gap-1.5 font-semibold"
        data-testid="plan-review-approve"
        @click="submit('approve')"
      >
        <Check class="size-3" aria-hidden="true" />
        {{ t('plan.reviewBar.confirmExecute') }}
      </Button>
      <!-- 搁置（D3 协议级 dismiss 决策，取代「忽略 = 杀 turn」）：非破坏动作——不杀 turn、
           不丢状态，计划进度与评论草稿保留（暂存待办），经 respond 同通道回传
           {decision:'dismiss'}；无需确认（守卫配重不对称 F16 随之消解），不作危险色 -->
      <Button
        variant="ghost"
        size="sm"
        data-testid="plan-review-dismiss"
        class="text-neutral-dim hover:bg-surface-hover hover:text-neutral-mid"
        :title="t('plan.reviewBar.dismissTip')"
        @click="submit('dismiss')"
      >
        {{ t('plan.reviewBar.dismiss') }}
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
    <!-- 分支③ 降级态（D8 可行动化：一句成因说明 + [重新提交审批] 按钮）：state=reviewing 而
         进程已换（E3 重启/挂起已消亡）——按钮经消息发送通道注入固定文案 user 消息（D8 写入面
         已穷举登记），agent 在提示词纪律下重调 submit-review；文案分源（resumeHint）。
         退出入口收敛到左区常驻退出按钮；耗时显示不做（设计裁决） -->
    <div
      v-else
      data-testid="plan-review-degraded"
      class="flex min-w-0 items-center justify-end gap-2 text-[length:var(--text-xs)] text-neutral-dim"
    >
      <Hourglass class="size-3 shrink-0" aria-hidden="true" />
      <span class="flex min-w-0 flex-col items-end leading-snug">
        <span data-testid="plan-review-degraded-reason">{{ degradedReason }}</span>
      </span>
      <Button
        variant="secondary"
        size="sm"
        data-testid="plan-review-resubmit"
        class="shrink-0"
        :disabled="resubmitting"
        @click="onResubmit"
      >
        {{ t('plan.reviewBar.resubmit') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * PlanReviewBar —— 审批条（三键裁决 + 修订中/降级两非交互态），PlanModeBar 行内右区。
 *
 * 状态源：usePlanState（view 驱动分支 + 评论草稿打包）+ useExtensionUI 的 planReviewFilter
 * 实例（挂起请求按 requestId 枚举 + respond 回传，D5 marker select 通道）+ plan-store 的
 * 审批窗口位（已应答抑制窗标记 / degraded 稳定窗放行）。分支公式单源 = derivePlanReviewBarMode
 *（D4：交互认挂起、文案认 state，各认其主——不回退两事实源并集）。
 * 挂载与订阅分工（承接清单①）：宿主 PlanModeBar 组件常驻挂载（isActive=false 时其 template
 * 根 v-if 不渲染 DOM，本组件随之未创建）；isActive=false 期间的订阅存活由 PlanModeBar setup
 * 自持的 useExtensionUI 实例兜底，请求恒入 extensionUIStore（模块级 refCount 订阅 + store
 * requestId dedup，双实例幂等）。isActive=true 后本组件创建，自持实例承担 getPendingRequests
 * 快照补拉（晚订阅窗口）。挂起可枚举语义不依赖审批条当前是否可见。
 *
 * 回传 payload = PlanReviewResponse（@zhushanwen/extension-protocol 直接 import——D2/D3④
 * regime，本地同形副本已删除迁移）序列化 JSON 字符串，extension 侧 JSON.parse 消费
 * （解析失败走 E5，不进对话流）。三键：修订（revise+评论）/ 确认执行（approve）/
 * 搁置（dismiss，D3 非破坏——不走 message.abort、不杀 turn）。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Hourglass, Info, MessageSquare } from '@lucide/vue'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@taiji/ui'
import { openDrawerTab } from '@taiji/core/domain/drawer'
import { send as sendChatMessage } from '@taiji/core/transport/api/domains/chat'
import { toErrorMessage } from '@taiji/core'
import type { PlanReviewResponse } from '@zhushanwen/extension-protocol'
import { usePlanState } from '@/composables/use-plan-sync'
import { useSessionEvents } from '@/composables/features/chat/useSessionEvents'
import {
  usePlanStore,
  derivePlanReviewBarMode,
  resolvePlanLifecycleState,
  resolveResumeHint,
  type PlanReviewBarMode,
} from '@/stores/plan-store'
import { useExtensionUI, planReviewFilter, type PlanReviewUIRequest } from '@/composables/useExtensionUI'

const props = defineProps<{
  /** 焦点 session（panel store 的 focusedSessionId；审批条只服务焦点 session，D1） */
  sessionId: string | null
}>()

const { t } = useI18n()

const sessionIdRef = computed(() => props.sessionId)
const { view, drafts, clearDrafts } = usePlanState(sessionIdRef)
const { currentPlanReviewRequests, respond } = useExtensionUI(sessionIdRef, planReviewFilter)
// 草稿回看请求信号（§3.5）：本组件只发请求，滚动消费在 drawer 侧 PlanDocsPanel；
// 审批窗口位（抑制窗标记 / 稳定窗放行）同店透出
const planStore = usePlanStore()

const isActive = computed(() => view.value?.isActive === true)
const hasPending = computed(() => currentPlanReviewRequests.value.length > 0)
/** 队首挂起请求（正常时序恒单条，extension 单挂起；requestId 精确回传不假设队首语义）。 */
const activeRequest = computed<PlanReviewUIRequest | undefined>(
  () => currentPlanReviewRequests.value[0],
)
/** agent 自审结论（D9③；旧扩展不携带 → undefined，自审行不渲染）。 */
const selfReview = computed(() => activeRequest.value?.selfReview)

/**
 * 分支模式（D4 单源公式，plan-store derivePlanReviewBarMode）：
 * ready 恒优先（presence）→ 抑制窗压制 state 分支 → revising → degraded（稳定窗放行）。
 */
const mode = computed<PlanReviewBarMode | null>(() =>
  derivePlanReviewBarMode({
    isActive: isActive.value,
    hasPending: hasPending.value,
    state: resolvePlanLifecycleState(view.value),
    ackMarked: planStore.planReviewAckMarked,
    degradedGate: planStore.planReviewDegradedGate,
  }),
)

/** 自审结论 Popover 开合（受控，同 PlanModeBar 退出确认形态） */
const selfReviewOpen = ref(false)

/**
 * 降级态成因文案（D8 分源）：resumeHint==='resubmit'（E3 会话重启后 agent 尚未重提）
 * → 「审批提问已随会话重启失效」；其余（来源未知/挂起已消亡）→ 「审批提问未挂起」，
 * 不猜测来源。
 */
const degradedReason = computed(() =>
  resolveResumeHint(view.value) === 'resubmit'
    ? t('plan.reviewBar.degradedResubmit')
    : t('plan.reviewBar.degradedMissing'),
)

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
 * 三键裁决回传（D3/D5）：payload 序列化 JSON 经 respond（extension.ui_response）回 pi select
 * resolve——搁置与评论/批准同通道、同延迟、同可靠性（不再经 message.abort）。
 * revise 打包评论草稿（拷贝快照，不传响应式引用）；revise/approve 回传后清草稿（D6：草稿
 * 生命周期到提交为止——revise 注入对话流、approve 终局同清（C-U2：否则跨 plan run 残留））；
 * dismiss = 暂存待办（D3 非破坏：草稿不随应答消费，保留待下一轮审阅）。
 * 取首个挂起请求——正常时序恒单条（extension 单挂起），requestId 精确回传。
 */
function submit(decision: 'approve' | 'revise' | 'dismiss'): void {
  const request: PlanReviewUIRequest | undefined = activeRequest.value
  if (!request) return
  const payload: PlanReviewResponse =
    decision === 'revise'
      ? { decision, comments: drafts.value.map((d) => ({ quote: d.quote, comment: d.comment })) }
      : { decision }
  respond(request.requestId, JSON.stringify(payload))
  if (decision !== 'dismiss') clearDrafts()
}

/**
 * 重新提交审批（D8 降级态可行动化）：经 renderer 既有消息发送通道（message.send，与用户
 * 在 composer 直发同链）注入一条固定文案的 user 可见消息（「请重新提交计划审批」——D8
 * 写入面穷举已登记：rename-session / smart-context / session-reader / fork / 回放审计等
 * 消费方同真实用户消息语义），agent 在 plan 模式提示词纪律下重调 submit-review。
 * 失败双分支（设计 D8 明文「发送失败/agent 未响应」）就近错误行 + 左区退出常驻兜底：
 * ① 发送失败 = message.send 抛错（WS/超时）；② agent 未响应 = 发送成功但预期重挂未发生
 *（见下方无响应检测）。
 */
const resubmitting = ref(false)
/**
 * 就近错误行（D8 失败双分支的呈现面）：分区级状态（plan-store reviewNudgeError）——
 * turn 事件 handler 经 store action 写「消息所属 sid」分区（updateFor(capturedSid) 语义），
 * 无实例级 session 状态（ADR-0049；焦点切换后错误随分区保留/隔离）。
 */
const resubmitError = computed(() => planStore.planReviewNudgeError)

/**
 * 「agent 未响应」检测（D8 失败契约②）——**turn 生命周期信号驱动，非墙钟超时**
 *（AGENTS.md 超时默认原则：任务级正常路径不设墙钟——nudge 的正常路径 = 开轮 → agent 调
 * submit-review 重挂，耗时随 turn 长度自然波动，固定窗口必误杀长思考轮）：
 * - 成功收口 = 新 planReview 挂起登记到达（重挂发生）→ 内含于 plan-store
 *   setPlanReviewPending(true)（关检测窗 + 清旧错误，同轮先重挂后收尾不误报）；
 * - 失败判定 = 检测窗开着时 turn 结束（message.complete / message.error）而重挂未至，
 *   或发送被预检拒绝未进轮（send.rejected）→ endPlanReviewNudge 落错误行提示可重试；
 *   未开窗（未点重提）/ 已收口的 turn 信号由 action no-op；
 * - WS 断连无信号的形态不判死（fail-safe 不误导，与评论/批准同风险面 R1）；
 * - 切 session 无串台：检测窗在 per-session 分区（非实例 ref），事件按 capturedSid 写旧
 *   分区，新焦点分区天然是干净基线（ADR-0049 Map 分区，免 watch(sessionId) 手动清空）。
 */
const onMessage = useSessionEvents(sessionIdRef)
onMessage(['message.complete', 'message.error', 'send.rejected'], (_msg, sid) => {
  planStore.endPlanReviewNudge(sid, t('plan.reviewBar.resubmitNoResponse'))
})

async function onResubmit(): Promise<void> {
  const sid = props.sessionId
  if (!sid || resubmitting.value) return
  resubmitting.value = true
  planStore.setPlanReviewNudgeError(sid, null) // 清旧错误（重试入口）
  try {
    await sendChatMessage(sid, t('plan.reviewBar.resubmitNudge'))
    planStore.beginPlanReviewNudge(sid) // 开检测窗（失败契约②的判定窗）
  } catch (e) {
    planStore.setPlanReviewNudgeError(sid, t('plan.reviewBar.resubmitError', { message: toErrorMessage(e) }))
  } finally {
    resubmitting.value = false
  }
}
</script>
