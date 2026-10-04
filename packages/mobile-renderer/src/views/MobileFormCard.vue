<script setup lang="ts">
/**
 * MobileFormCard —— 移动壳 form/planReview 类请求呈现面（remote-use D7 form 行恢复）。
 *
 * 被 C4 门排除出 CompanionBand 的两类请求在此承接（通道装配在 companion-bridge form 通道，
 * 回传经 App 编排走 extension.ui_response 既有通路）：
 * - form 帧（新 form / legacy askUser / scheduleCreate 归一后）：堆叠单列渲染 choice / text /
 *   schedule 回显三类问题（触控形态；桌面 FormOverlay 是 tab 逐题形态——真差异，编码契约
 *   同构，纯逻辑单点在 shell/form-protocol）。legacy scheduleCreate draft 源包装为单 schedule
 *   题直挂（桌面 FormOverlay.draftQuestion 同式），submit 回传扁平 ScheduleFormResult JSON；
 *   questions 源 submit 回传 FormAnswers JSON envelope。
 * - planReview 审批帧：自审结论展示 + 批准 / 搁置双键（payload 与桌面 PlanReviewBar 同契约
 *   JSON，经 submit 通道回传）；revise 键不呈现——修订须携带评论草稿（桌面经 plan docs
 *   drawer 收集），移动壳无该机制（D7 Phase 2+ 面），与桌面「零草稿时 revise 禁用」语义同向。
 *
 * Submit 门与桌面同语义（allAnswered）；schedule 回显不可构造（无 initial / prompt 空 /
 * once cron 非法）→ 该题未答 → 仅可取消（请求方得 cancelled 应答，不无限等待）。
 * 取消按钮按 allowCancel 显隐（协议缺省 true）。
 */
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Textarea } from '@taiji/ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { isFormQuestion, type FormQuestion, type ScheduleDraft, type ScheduleQuestion } from '@zhushanwen/extension-protocol'
import { onceCronToDate } from '@zhushanwen/extension-protocol'
import type { PlanReviewFrameForView } from '../shell/companion-bridge'
import {
  OTHER_VALUE,
  draftToScheduleFormResult,
  encodeFormAnswers,
  initialQuestionState,
  isQuestionAnswered,
  isScheduleEchoReady,
  questionKey,
  scheduleDraftOf,
  scheduleEchoResult,
  type QuestionState,
} from '../shell/form-protocol'

const props = defineProps<{
  /** 队首 form 类请求（undefined = 该节不渲染） */
  request?: ExtensionUIRequest
  /** 队首 planReview 审批请求（undefined = 该节不渲染） */
  planReview?: PlanReviewFrameForView
  /** 作答回传未送达的 requestId（App 编排持有；与当前展示请求匹配时渲染内联错误行） */
  respondFailedId?: string | null
}>()

const emit = defineEmits<{
  /** 作答回传：questions 源 = FormAnswers JSON envelope；draft 源 = 扁平 ScheduleFormResult JSON；planReview 裁决 = {decision} JSON */
  submit: [payload: { requestId: string; result: string }]
  /** 取消（App 侧转 respond(requestId, null) → select resolve undefined = cancelled） */
  cancel: [payload: { requestId: string }]
}>()

const { t } = useI18n()

// ── 挂载源分型（桌面 Panel.overlaySource 同式三分）────────────────────────

const legacyDraft = computed<ScheduleDraft | null>(() => {
  const req = props.request
  if (!req || req.scheduleCreate !== true) return null
  return scheduleDraftOf(req)
})

/** draft 守卫失败留痕（正常路径不可达——runtime isScheduleDraft 预检后才产帧；移动壳不静默：
 *  cancel-only 卡片承接，请求方可得取消应答） */
watch(() => props.request, (req) => {
  if (req?.scheduleCreate === true && scheduleDraftOf(req) === null) {
    console.warn(`[MobileFormCard] scheduleCreate draft guard failed, cancel-only (requestId=${req.requestId})`)
  }
})

/** isFormQuestion 复核过滤后的问题集（滤除留痕对齐桌面 Panel 复核守卫；draft 源不含问题） */
const questions = computed<FormQuestion[]>(() => {
  const req = props.request
  if (!req || req.form !== true || req.scheduleCreate === true) return []
  const raw = req.formQuestions ?? []
  const valid = raw.filter(isFormQuestion)
  const dropped = raw.length - valid.length
  if (dropped > 0) {
    console.warn(`[MobileFormCard] formQuestions guard dropped ${dropped}/${raw.length} (requestId=${req.requestId})`)
  }
  return valid
})

const isDraftMount = computed(() => props.request !== undefined && legacyDraft.value !== null)
/** draft 源包装为单 schedule 题（question 留空——标题由 head 按 schedule 类型本地化承担） */
const draftQuestion = computed<ScheduleQuestion | null>(() =>
  legacyDraft.value ? { type: 'schedule', question: '', initial: legacyDraft.value } : null,
)

// 回传未送达错误行（role=alert 形态对齐 TokenInputView 错误行）：requestId 匹配当前展示
// 请求才渲染——请求被摘除（卡片收口）或新请求到达时旧错误不残留
const showRespondError = computed(() => {
  const failedId = props.respondFailedId
  if (failedId === null || failedId === undefined) return false
  return props.request?.requestId === failedId || props.planReview?.requestId === failedId
})

/** 渲染问题集（draft 源 → 单 schedule 题；questions 源原样） */
const questionsList = computed<FormQuestion[]>(() =>
  isDraftMount.value && draftQuestion.value ? [draftQuestion.value] : questions.value,
)

/** 请求在场但无可渲染内容（空问题集 / draft 守卫失败）：cancel-only 卡片，不静默吞帧 */
const showCancelOnly = computed(() => props.request !== undefined && !isDraftMount.value && questions.value.length === 0)
const allowCancel = computed(() => props.request?.allowCancel !== false)

/** 表头标题：schedule 题（含 draft 直挂）= 本地化「新建定时任务」；其余 = 首题问题文本 */
const headTitle = computed(() => {
  if (showCancelOnly.value) return t('mobile.formCard.emptyForm')
  const first = questionsList.value[0]
  if (!first) return ''
  return first.type === 'schedule' ? t('extensionUI.scheduleCreateFormTitle') : first.question
})

// ── choice/text 答案状态（壳持有；问题集变化按 key 保留已输入）────────────────

const states = reactive<Record<string, QuestionState>>({})

watch(questionsList, (qs) => {
  for (const q of qs) {
    if (q.type === 'schedule') continue
    const key = questionKey(q)
    if (states[key] === undefined) states[key] = initialQuestionState()
  }
}, { immediate: true })

// ── schedule 回显呈现（问题源 schedule 题 + legacy draft 源共用）────────────────

/** once 时刻人性化呈现（本地墙钟；还原失败回落原文），recurring 原文（cron/duration） */
const PAD_WIDTH = 2 // 本地墙钟两位补零（yyyy-MM-dd HH:mm 呈现）
function scheduleText(draft: ScheduleDraft): string {
  if (draft.kind === 'once') {
    const d = onceCronToDate(draft.schedule)
    if (d) {
      const pad = (n: number): string => String(n).padStart(PAD_WIDTH, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
  }
  return draft.schedule
}

// ── Submit 门（桌面 FormOverlay.allAnswered 同语义）─────────────────────────

const allAnswered = computed(() =>
  questionsList.value.every((q) =>
    isQuestionAnswered(q, states[questionKey(q)], q.type === 'schedule' && isScheduleEchoReady(q)),
  ),
)

/** 未答题数（禁用态 tooltip 文案，桌面 unansweredHint 同消费） */
const unansweredCount = computed(() =>
  questionsList.value.filter((q) => !isQuestionAnswered(q, states[questionKey(q)], q.type === 'schedule' && isScheduleEchoReady(q))).length,
)

/** 主按钮文案：含 schedule（draft 源或 schedule 题）=「创建任务」，否则通用「提交」 */
const submitLabel = computed(() =>
  questionsList.value.some((q) => q.type === 'schedule')
    ? t('extensionUI.scheduleCreateSubmit')
    : t('common.submit'),
)

/** Submit：按挂载源构造应答形状（不可构造 = 门未过，按钮已禁用，此处再兜一道） */
function onSubmit(): void {
  const req = props.request
  if (!req || !allAnswered.value) return
  if (isDraftMount.value) {
    const draft = legacyDraft.value
    if (!draft) return
    const result = draftToScheduleFormResult(draft)
    if (result === null) return
    emit('submit', { requestId: req.requestId, result: JSON.stringify(result) })
    return
  }
  const answers = encodeFormAnswers(questions.value, states, (q: ScheduleQuestion) => {
    const result = scheduleEchoResult(q)
    return result === null ? null : JSON.stringify(result)
  })
  if (answers === null) return
  emit('submit', { requestId: req.requestId, result: JSON.stringify(answers) })
}

function onCancel(): void {
  const req = props.request
  if (req) emit('cancel', { requestId: req.requestId })
}

// ── choice 选项交互（单选互斥 / 多选 toggle / Other 卡片化；桌面 ChoiceQuestion 同语义）──

function isOptionSelected(q: FormQuestion, label: string): boolean {
  return q.type === 'choice' && (states[questionKey(q)]?.selectedValues.includes(label) ?? false)
}

function toggleOption(q: FormQuestion, label: string): void {
  if (q.type !== 'choice') return
  const key = questionKey(q)
  const st = states[key]
  if (!st) return
  if (q.multi) {
    const selected = st.selectedValues.includes(label)
      ? st.selectedValues.filter((v) => v !== label)
      : [...st.selectedValues, label]
    states[key] = {
      selectedValues: selected,
      // 取消 Other 选中时清其文本；普通选项与 Other 文本多选场景可并存
      otherText: label === OTHER_VALUE && !selected.includes(OTHER_VALUE) ? '' : st.otherText,
    }
    return
  }
  const deselect = st.selectedValues[0] === label
  // 选普通选项清 Other 文本（互斥）；Other 选中保留其文本（展开输入框）
  const otherText = !deselect && label !== OTHER_VALUE ? '' : st.otherText
  states[key] = { selectedValues: deselect ? [] : [label], otherText }
}

/** Other 输入框显隐（选中占位符即展开；无 options 退化 choice 无 Other） */
function showOtherInput(q: FormQuestion): boolean {
  return q.type === 'choice' && q.options.length > 0 && q.allowOther !== false && isOptionSelected(q, OTHER_VALUE)
}
</script>

<template>
  <div
    v-if="request || planReview"
    class="flex flex-col gap-2"
    data-testid="mobile-form-card"
  >
    <!-- ── form 类请求 ── -->
    <div
      v-if="request"
      class="flex flex-col gap-2 rounded-lg bg-bg-input px-3.5 pb-2.5 pt-2.5"
      data-testid="mobile-form-section"
    >
      <!-- head：脉冲点 + 标题（schedule 类 = 新建定时任务；questions 源 = 首题问题文本） -->
      <div class="flex items-center gap-2" data-testid="mobile-form-head">
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-fg" data-testid="mobile-form-title">
          {{ headTitle }}
        </span>
      </div>

      <!-- cancel-only：空问题集 / draft 守卫失败（不静默吞帧，请求方可得取消应答） -->
      <p v-if="showCancelOnly" class="text-[12px] leading-1.5 text-neutral-mid" data-testid="mobile-form-empty">
        {{ t('mobile.formCard.emptyForm') }}
      </p>

      <!-- 题目堆叠（单列触控形态；schedule 题渲染草稿回显摘要） -->
      <template v-else>
        <div
          v-for="(q, i) in questionsList"
          :key="questionKey(q)"
          class="flex flex-col gap-1.5"
          :data-testid="`mobile-form-question-${i}`"
        >
          <p
            v-if="q.context"
            class="rounded bg-surface-hover px-2.5 py-1.5 text-[12px] leading-1.5 text-neutral-mid"
            data-testid="mobile-form-context"
          >
            {{ q.context }}
          </p>
          <p
            v-if="questionsList.length > 1 && q.type !== 'schedule'"
            class="text-[13px] font-medium text-neutral-fg"
            data-testid="mobile-form-question-text"
          >
            {{ q.question }}
          </p>

          <!-- choice：选项卡片（multi=复选 / 单选互斥）+ Other 卡片 -->
          <template v-if="q.type === 'choice' && q.options.length > 0">
            <div
              v-for="opt in q.options"
              :key="opt.label"
              :data-testid="`mobile-form-option-${opt.label}`"
              role="checkbox"
              :aria-checked="isOptionSelected(q, opt.label)"
              :tabindex="0"
              class="flex cursor-pointer items-start gap-2 rounded px-2.5 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
              :class="isOptionSelected(q, opt.label) ? 'bg-accent-soft' : 'bg-surface-2'"
              @click="toggleOption(q, opt.label)"
            >
              <span
                class="mt-0.5 size-4 shrink-0 border-2 transition-colors"
                :class="[q.multi ? 'rounded-sm' : 'rounded-full', isOptionSelected(q, opt.label) ? 'border-accent bg-accent' : 'border-border-strong']"
              />
              <span class="min-w-0 flex-1 text-[13px] leading-1.5 text-neutral-fg">{{ opt.label }}</span>
              <span v-if="opt.description" class="text-[12px] leading-1.5 text-neutral-dim">{{ opt.description }}</span>
            </div>
            <div v-if="showOtherInput(q)" class="px-0.5">
              <Input
                v-model="states[questionKey(q)].otherText"
                :placeholder="t('extensionUI.inputPlaceholder')"
                data-testid="mobile-form-other-input"
              />
            </div>
          </template>

          <!-- text / 空 options 退化 choice：自由文本 -->
          <Textarea
            v-else-if="q.type === 'text' || q.type === 'choice'"
            v-model="states[questionKey(q)].otherText"
            rows="3"
            :placeholder="t('extensionUI.inputPlaceholder')"
            :data-testid="`mobile-form-text-input-${i}`"
          />

          <!-- schedule：草稿回显摘要 + 确认门（预填即确认语义；编辑回桌面） -->
          <div v-else class="flex flex-col gap-1.5" data-testid="mobile-form-schedule">
            <template v-if="q.initial">
              <div class="flex flex-col gap-1 rounded bg-surface-2 px-2.5 py-2 text-[12px] leading-1.6 text-neutral-mid" data-testid="mobile-form-schedule-summary">
                <div class="flex gap-2">
                  <span class="shrink-0 text-neutral-dim">{{ q.initial.kind === 'once' ? t('extensionUI.scheduleCreateKindOnce') : t('extensionUI.scheduleCreateKindRecurring') }}</span>
                  <span class="min-w-0 break-all font-mono">{{ scheduleText(q.initial) }}</span>
                </div>
                <p class="break-words text-neutral-fg">{{ q.initial.prompt }}</p>
                <p v-if="q.initial.name" class="text-neutral-dim">{{ q.initial.name }}</p>
              </div>
              <p class="text-[12px] leading-1.5 text-neutral-dim">{{ t('mobile.formCard.scheduleEchoNote') }}</p>
              <p
                v-if="!isScheduleEchoReady(q)"
                class="text-[12px] leading-1.5 text-warn"
                data-testid="mobile-form-schedule-not-ready"
              >
                {{ t('mobile.formCard.scheduleNotReady') }}
              </p>
            </template>
            <p v-else class="text-[12px] leading-1.5 text-warn" data-testid="mobile-form-schedule-not-ready">
              {{ t('mobile.formCard.scheduleNotReady') }}
            </p>
          </div>
        </div>
      </template>

      <!-- 回传未送达内联错误行（App 编排置 respondFailedId，提交/取消失败同源） -->
      <p
        v-if="showRespondError"
        class="text-xs text-neutral-fg"
        role="alert"
        data-testid="mobile-form-respond-error"
      >
        {{ t('mobile.formCard.respondFailed') }}
      </p>

      <!-- actions：取消 + 提交（Submit 门禁用态带未答题数提示） -->
      <div class="flex items-center justify-end gap-2 pt-1">
        <Button v-if="allowCancel" variant="ghost" data-testid="mobile-form-cancel" @click="onCancel">
          {{ t('common.cancel') }}
        </Button>
        <Button
          v-if="!showCancelOnly"
          variant="default"
          data-testid="mobile-form-submit"
          :disabled="!allAnswered"
          :title="allAnswered ? submitLabel : t('extensionUI.unansweredHint', { count: unansweredCount })"
          @click="onSubmit"
        >
          {{ submitLabel }}
        </Button>
      </div>
    </div>

    <!-- ── planReview 审批（自审结论 + 批准/搁置；revise 不呈现，见文件头登记）── -->
    <div
      v-if="planReview"
      class="flex flex-col gap-2 rounded-lg bg-bg-input px-3.5 pb-2.5 pt-2.5"
      data-testid="mobile-plan-review"
    >
      <div class="flex items-center gap-2">
        <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-fg" data-testid="mobile-plan-review-title">
          {{ t('mobile.formCard.planReviewTitle') }}
        </span>
      </div>
      <p
        v-if="planReview.selfReview"
        class="whitespace-pre-wrap break-words rounded bg-surface-hover px-2.5 py-1.5 text-[12px] leading-1.5 text-neutral-mid"
        data-testid="mobile-plan-review-self-review"
      >
        {{ planReview.selfReview }}
      </p>
      <!-- 回传未送达内联错误行（批准/搁置同走 respond 回传通道） -->
      <p
        v-if="showRespondError"
        class="text-xs text-neutral-fg"
        role="alert"
        data-testid="mobile-plan-review-respond-error"
      >
        {{ t('mobile.formCard.respondFailed') }}
      </p>
      <div class="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" data-testid="mobile-plan-review-dismiss" @click="emit('submit', { requestId: planReview.requestId, result: JSON.stringify({ decision: 'dismiss' }) })">
          {{ t('mobile.formCard.dismiss') }}
        </Button>
        <Button variant="default" data-testid="mobile-plan-review-approve" @click="emit('submit', { requestId: planReview.requestId, result: JSON.stringify({ decision: 'approve' }) })">
          {{ t('mobile.formCard.approve') }}
        </Button>
      </div>
    </div>
  </div>
</template>
