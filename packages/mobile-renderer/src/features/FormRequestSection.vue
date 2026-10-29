<script setup lang="ts">
// FormRequestSection —— FormSheet 的 form 类请求节（form 帧 / legacy askUser / scheduleCreate
// 归一帧的自包含呈现与作答节；remote-use-mobile-v2 §6.5 FormSheet 泛化承接的 form 半）。
//
// 逻辑与形态自 v1 MobileFormCard form 节整体迁移（该组件随 Sheet 化退役呈现，题型渲染/
// Submit 门/编码契约零变化）：堆叠单列 choice / text / schedule 回显三类问题（触控形态；
// 桌面 FormOverlay 是 tab 逐题形态——真差异；编码契约单点在 @taiji/ui/form-protocol 双壳共享）。
// legacy scheduleCreate draft 源包装为单 schedule 题直挂（桌面 FormOverlay.draftQuestion 同式），
// submit 回传扁平 ScheduleFormResult JSON；questions 源 submit 回传 FormAnswers JSON envelope。
//
// Submit 门与桌面同语义（allAnswered）；schedule 回显不可构造（无 initial / prompt 空 /
// once cron 非法）→ 该题未答 → 仅可取消（请求方得 cancelled 应答，不无限等待）。
// 取消按钮按 allowCancel 显隐（协议缺省 true）。提交禁用的第二输入 = suspended prop
// （§6.23 restart 提交挂起：对账完成前 FormSheet 全节禁答）。
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button, Input, Textarea } from '@taiji/ui'
import type { ExtensionUIRequest } from '@taiji/core/transport/api/domains/extension'
import { isFormQuestion, onceCronToDate, type FormQuestion, type ScheduleDraft, type ScheduleQuestion } from '@zhushanwen/extension-protocol'
import { scheduleDraftOf } from '../shell/form-protocol'
import {
  OTHER_VALUE,
  draftToScheduleFormResult,
  encodeFormAnswers,
  initialQuestionState,
  isQuestionAnswered,
  isScheduleEchoReady,
  questionKey,
  scheduleEchoResult,
  type QuestionState,
} from '@taiji/ui/form-protocol'

const props = defineProps<{
  /** 队首 form 类请求（undefined = 该节不渲染） */
  request?: ExtensionUIRequest
  /** §6.23 提交挂起（restart 重连对账完成前禁答） */
  suspended?: boolean
}>()

const emit = defineEmits<{
  /** 作答回传：questions 源 = FormAnswers JSON envelope；draft 源 = 扁平 ScheduleFormResult JSON */
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

/** draft 检查失败留痕（正常路径不可达——runtime isScheduleDraft 预检后才产帧；移动壳不静默：
 *  cancel-only 卡片承接，请求方可得取消应答） */
watch(() => props.request, (req) => {
  if (req?.scheduleCreate === true && scheduleDraftOf(req) === null) {
    console.warn(`[FormRequestSection] scheduleCreate draft guard failed, cancel-only (requestId=${req.requestId})`)
  }
})

/** isFormQuestion 复核过滤后的问题集（滤除留痕对齐桌面 Panel 复核检查；draft 源不含问题） */
const questions = computed<FormQuestion[]>(() => {
  const req = props.request
  if (!req || req.form !== true || req.scheduleCreate === true) return []
  const raw = req.formQuestions ?? []
  const valid = raw.filter(isFormQuestion)
  const dropped = raw.length - valid.length
  if (dropped > 0) {
    console.warn(`[FormRequestSection] formQuestions guard dropped ${dropped}/${raw.length} (requestId=${req.requestId})`)
  }
  return valid
})

const isDraftMount = computed(() => props.request !== undefined && legacyDraft.value !== null)
/** draft 源包装为单 schedule 题（question 留空——标题由 head 按 schedule 类型本地化承担） */
const draftQuestion = computed<ScheduleQuestion | null>(() =>
  legacyDraft.value ? { type: 'schedule', question: '', initial: legacyDraft.value } : null,
)

/** 渲染问题集（draft 源 → 单 schedule 题；questions 源原样） */
const questionsList = computed<FormQuestion[]>(() =>
  isDraftMount.value && draftQuestion.value ? [draftQuestion.value] : questions.value,
)

/** 请求在场但无可渲染内容（空问题集 / draft 检查失败）：cancel-only 节，不静默吞帧 */
const showCancelOnly = computed(() => props.request !== undefined && !isDraftMount.value && questions.value.length === 0)
const allowCancel = computed(() => props.request?.allowCancel !== false)

/** 表头标题：schedule 题（含 draft 直挂）= 本地化「新建定时任务」；其余 = 首题问题文本 */
const headTitle = computed(() => {
  if (showCancelOnly.value) return t('mobile.formCard.emptyForm')
  const first = questionsList.value[0]
  if (!first) return ''
  return first.type === 'schedule' ? t('extensionUI.scheduleCreateFormTitle') : first.question
})

// ── choice/text 答案状态（节内持有；问题集变化按 key 保留已输入）────────────────

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
  if (!req || !allAnswered.value || props.suspended) return
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
  if (req && !props.suspended) emit('cancel', { requestId: req.requestId })
}

// ── choice 选项交互（单选互斥 / 多选 toggle / Other 合成选项卡；桌面 ChoiceQuestion 同语义）──

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

/** Other 合成选项卡显隐（对齐桌面 ChoiceQuestion.showOther：有 options 且 allowOther !== false；
 *  无 options 退化 choice 不合成，自由文本走 Textarea 分支） */
function showOtherTab(q: FormQuestion): boolean {
  return q.type === 'choice' && q.options.length > 0 && q.allowOther !== false
}

/** Other 输入框显隐（绑定 Other 选中态——选中占位符即展开） */
function showOtherInput(q: FormQuestion): boolean {
  return showOtherTab(q) && isOptionSelected(q, OTHER_VALUE)
}
</script>

<template>
  <div
    v-if="request"
    class="flex flex-col gap-2"
    data-testid="form-sheet-form-section"
  >
    <!-- head：脉冲点 + 标题（schedule 类 = 新建定时任务；questions 源 = 首题问题文本） -->
    <div class="flex items-center gap-2" data-testid="form-sheet-form-head">
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
      <span class="min-w-0 flex-1 text-[length:var(--m-text-sub)] font-medium text-neutral-fg" data-testid="form-sheet-form-title">
        {{ headTitle }}
      </span>
    </div>

    <!-- cancel-only：空问题集 / draft 检查失败（不静默吞帧，请求方可得取消应答） -->
    <p v-if="showCancelOnly" class="text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid" data-testid="form-sheet-form-empty">
      {{ t('mobile.formCard.emptyForm') }}
    </p>

    <!-- 题目堆叠（单列触控形态；schedule 题渲染草稿回显摘要） -->
    <template v-else>
      <div
        v-for="(q, i) in questionsList"
        :key="questionKey(q)"
        class="flex flex-col gap-1.5"
        :data-testid="`form-sheet-question-${i}`"
      >
        <p
          v-if="q.context"
          class="rounded bg-surface-hover px-2.5 py-1.5 text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid"
          data-testid="form-sheet-context"
        >
          {{ q.context }}
        </p>
        <p
          v-if="questionsList.length > 1 && q.type !== 'schedule'"
          class="text-[length:var(--m-text-sub)] font-medium text-neutral-fg"
          data-testid="form-sheet-question-text"
        >
          {{ q.question }}
        </p>

        <!-- choice：选项卡片（multi=复选 / 单选互斥）+ Other 卡片 -->
        <template v-if="q.type === 'choice' && q.options.length > 0">
          <div
            v-for="opt in q.options"
            :key="opt.label"
            :data-testid="`form-sheet-option-${opt.label}`"
            role="checkbox"
            :aria-checked="isOptionSelected(q, opt.label)"
            :tabindex="0"
            class="flex min-h-[var(--m-tap)] cursor-pointer items-start gap-2 rounded px-2.5 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="isOptionSelected(q, opt.label) ? 'bg-accent-soft' : 'bg-surface-2'"
            @click="toggleOption(q, opt.label)"
          >
            <span
              class="mt-0.5 size-4 shrink-0 border-2 transition-colors"
              :class="[q.multi ? 'rounded-sm' : 'rounded-full', isOptionSelected(q, opt.label) ? 'border-accent bg-accent' : 'border-border-strong']"
            />
            <span class="min-w-0 flex-1 text-[length:var(--m-text-sub)] leading-1.5 text-neutral-fg">{{ opt.label }}</span>
            <span v-if="opt.description" class="text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid">{{ opt.description }}</span>
          </div>
          <!-- Other 合成选项卡（allowOther !== false 时合成于选项末尾；桌面 ChoiceQuestion
               同语义：toggle 交互与普通选项同构，选中后展开输入框） -->
          <div
            v-if="showOtherTab(q)"
            :data-testid="`form-sheet-option-${OTHER_VALUE}`"
            role="checkbox"
            :aria-checked="isOptionSelected(q, OTHER_VALUE)"
            :tabindex="0"
            class="flex min-h-[var(--m-tap)] cursor-pointer items-start gap-2 rounded px-2.5 py-2 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
            :class="isOptionSelected(q, OTHER_VALUE) ? 'bg-accent-soft' : 'bg-surface-2'"
            @click="toggleOption(q, OTHER_VALUE)"
          >
            <span
              class="mt-0.5 size-4 shrink-0 border-2 transition-colors"
              :class="[q.multi ? 'rounded-sm' : 'rounded-full', isOptionSelected(q, OTHER_VALUE) ? 'border-accent bg-accent' : 'border-border-strong']"
            />
            <span class="min-w-0 flex-1 text-[length:var(--m-text-sub)] leading-1.5 text-neutral-fg">{{ t('extensionUI.other') }}</span>
          </div>
          <div v-if="showOtherInput(q)" class="px-0.5">
            <Input
              v-model="states[questionKey(q)].otherText"
              :placeholder="t('extensionUI.inputPlaceholder')"
              data-testid="form-sheet-other-input"
            />
          </div>
        </template>

        <!-- text / 空 options 退化 choice：自由文本 -->
        <Textarea
          v-else-if="q.type === 'text' || q.type === 'choice'"
          v-model="states[questionKey(q)].otherText"
          rows="3"
          :placeholder="t('extensionUI.inputPlaceholder')"
          :data-testid="`form-sheet-text-input-${i}`"
        />

        <!-- schedule：草稿回显摘要 + 确认门（预填即确认语义；编辑回桌面） -->
        <div v-else class="flex flex-col gap-1.5" data-testid="form-sheet-schedule">
          <template v-if="q.initial">
            <div class="flex flex-col gap-1 rounded bg-surface-2 px-2.5 py-2 text-[length:var(--m-text-sub)] leading-1.6 text-neutral-mid" data-testid="form-sheet-schedule-summary">
              <div class="flex gap-2">
                <span class="shrink-0 text-neutral-mid">{{ q.initial.kind === 'once' ? t('extensionUI.scheduleCreateKindOnce') : t('extensionUI.scheduleCreateKindRecurring') }}</span>
                <span class="min-w-0 break-all font-mono">{{ scheduleText(q.initial) }}</span>
              </div>
              <p class="break-words text-neutral-fg">{{ q.initial.prompt }}</p>
              <p v-if="q.initial.name" class="text-neutral-mid">{{ q.initial.name }}</p>
            </div>
            <p class="text-[length:var(--m-text-sub)] leading-1.5 text-neutral-mid">{{ t('mobile.formCard.scheduleEchoNote') }}</p>
            <p
              v-if="!isScheduleEchoReady(q)"
              class="text-[length:var(--m-text-sub)] leading-1.5 text-warn"
              data-testid="form-sheet-schedule-not-ready"
            >
              {{ t('mobile.formCard.scheduleNotReady') }}
            </p>
          </template>
          <p v-else class="text-[length:var(--m-text-sub)] leading-1.5 text-warn" data-testid="form-sheet-schedule-not-ready">
            {{ t('mobile.formCard.scheduleNotReady') }}
          </p>
        </div>
      </div>
    </template>

    <!-- actions：取消 + 提交（Submit 门禁用态带未答题数提示；§6.23 挂起期双禁） -->
    <div class="flex items-center justify-end gap-2 pt-1">
      <Button
        v-if="allowCancel"
        variant="ghost"
        data-testid="form-sheet-form-cancel"
        :disabled="suspended"
        @click="onCancel"
      >
        {{ t('common.cancel') }}
      </Button>
      <Button
        v-if="!showCancelOnly"
        variant="default"
        data-testid="form-sheet-form-submit"
        :disabled="suspended || !allAnswered"
        :title="allAnswered ? submitLabel : t('extensionUI.unansweredHint', { count: unansweredCount })"
        @click="onSubmit"
      >
        {{ submitLabel }}
      </Button>
    </div>
  </div>
</template>
