<script setup lang="ts">
/**
 * FormOverlay —— 统一提问表单壳（AskUserOverlay 泛化，设计 D5）。
 *
 * 三 extension（ask-user / scheduler / plan）的提问经 UI_FORM_MARKER 收口为一个表单协议，
 * 本组件为 GUI 唯一渲染面：壳负责表头（脉冲点 + 单问标题 | 多问 tab 条）/ Submit 门 /
 * 取消；按问题 type 分派渲染器——choice（单选 auto-advance / 多选 / Other 卡片化）、
 * text（纯自由文本）、schedule（ScheduleForm 整表单）。
 *
 * Submit 门语义（AskUserOverlay:161-186 逐字继承）：
 * - choice/text = allAnswered（普通选项选中 ≥1，或 Other 选中且有文本）
 * - schedule = 渲染器 canSubmit 委托（预填草稿视为有效 → 打开即可一键确认）
 *
 * 挂载源分流（D7 上三角窗口，接线在 u4）：
 * - questions 源（新 form 帧 / legacy askUser 归一后）→ submit 回传 FormAnswers JSON
 *   envelope（choice/text 部分与 AskUserAnswers 逐字兼容）；schedule 题 value =
 *   JSON.stringify(ScheduleFormResult)（D2）
 * - draft 源（legacy scheduler 帧直挂）→ submit 回传扁平 ScheduleFormResult JSON
 *   （今日 Panel onScheduleCreateSubmit 路径字节等价）；cancel 双源统一
 *
 * testid 正名（有意变更，非回归）：ask-user-\* → form-\*、schedule-create-overlay →
 * form-overlay（壳根）。
 */
import { computed, ref, shallowReactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '@/components/ui/button'
import type { ComponentPublicInstance } from 'vue'
import type { FormQuestion, ScheduleDraft, ScheduleQuestion } from '@zhushanwen/extension-protocol'
import ChoiceQuestion from './ChoiceQuestion.vue'
import TextQuestion from './TextQuestion.vue'
import ScheduleForm from './ScheduleForm.vue'
import { OTHER_VALUE, initialQuestionState, type QuestionState } from './question-state'

const props = withDefaults(defineProps<{
  /** form 源问题集（新 form 帧 / legacy askUser 归一后）；提供时优先于 draft */
  questions?: FormQuestion[]
  /** legacy scheduleCreate 挂载源直传（D7 窗口）：draft 包装为单 schedule 问题直挂 */
  draft?: ScheduleDraft
  /** 是否允许取消（协议缺省 true；显式 false 隐藏取消按钮） */
  allowCancel?: boolean
}>(), {
  allowCancel: true,
})
const emit = defineEmits<{
  /** questions 源 = FormAnswers JSON；draft 源 = 扁平 ScheduleFormResult JSON（见文件头） */
  submit: [payload: string]
  cancel: []
}>()

const { t } = useI18n()

/** legacy draft 直挂标记（表头只余脉冲点——legacy 帧不携带问题文本） */
const draftMount = computed(() => props.questions === undefined && props.draft !== undefined)

/** draft 源包装为单 schedule 问题（initial 直传；question 留空 = 无表头标题） */
const draftQuestion = computed<ScheduleQuestion>(() => ({ type: 'schedule', question: '', initial: props.draft }))

/** 渲染问题集（draft 源 → 单 schedule 问题；questions 源原样） */
const questionsList = computed<FormQuestion[]>(() =>
  props.questions ?? (draftMount.value ? [draftQuestion.value] : []),
)

// ── 问题 key（header 缺省时用 question 文本——与协议 askUserKey fallback 同规则）──
function qKey(q: FormQuestion): string {
  return q.header ?? q.question
}

// ── tab 状态 ──
const activeIdx = ref(0)
const activeQuestion = computed(() => questionsList.value[activeIdx.value])
const multiQuestion = computed(() => questionsList.value.length > 1)

// ── choice/text 的答案状态（壳持有；渲染器经 v-model 编辑）──
const states = ref<Record<string, QuestionState>>({})

// 初始化 / 重置状态（问题集变化时；schedule 题状态在渲染器内部，不进 states）
watch(questionsList, (qs) => {
  const next: Record<string, QuestionState> = {}
  for (const q of qs) {
    if (q.type === 'schedule') continue
    const key = qKey(q)
    next[key] = states.value[key] ?? initialQuestionState()
  }
  states.value = next
  activeIdx.value = 0
}, { immediate: true })

// ── schedule 渲染器句柄（canSubmit 提交门 + submit 确认入口；shallowReactive 保
//    挂载/卸载触发 Submit 门重算）──
type ScheduleFormHandle = InstanceType<typeof ScheduleForm>
const scheduleRefs = shallowReactive(new Map<string, ScheduleFormHandle>())

/** v-for 函数 ref：登记/注销 schedule 渲染器句柄（key 与 answers 编码键一致） */
function setScheduleRef(key: string, el: Element | ComponentPublicInstance | null): void {
  if (el === null || el instanceof Element) {
    scheduleRefs.delete(key)
    return
  }
  // 已排除 null 与 DOM Element 分支，剩余即 ScheduleForm 组件实例（自引用，形状由模板保证）
  scheduleRefs.set(key, el as ScheduleFormHandle)
}

// ── 已答判定 + Submit 门（AskUserOverlay:161-186 逐字继承；schedule 委托 canSubmit）──
/** 问题是否已作答（choice：普通选项选中 ≥1 或 Other 选中且有文本；text：非空；
 *  schedule：渲染器 canSubmit——预填草稿视为有效） */
function isQuestionAnswered(q: FormQuestion): boolean {
  if (q.type === 'schedule') return scheduleRefs.get(qKey(q))?.canSubmit ?? false
  const st = states.value[qKey(q)]
  if (!st) return false
  // text 题 / 空 options 的退化 choice：otherText 有值即答完
  if (q.type === 'text' || q.options.length === 0) return st.otherText.trim().length > 0
  // 有选项：Other 选中必须有文本才算答完
  const otherSelected = st.selectedValues.includes(OTHER_VALUE)
  if (otherSelected && !st.otherText.trim()) {
    // Other 选中但没文本：检查是否还选了其他选项（多选场景）
    return st.selectedValues.some((v) => v !== OTHER_VALUE)
  }
  return st.selectedValues.length > 0
}

/** 全部问题已作答（Submit 启用守卫） */
const allAnswered = computed(() => questionsList.value.every(isQuestionAnswered))
/** 未答题数（disabled tooltip 文案） */
const unansweredCount = computed(() => questionsList.value.filter((q) => !isQuestionAnswered(q)).length)

/** 单选选中后自动前进到下一题；已是最后一题则停（末题显示 Submit，非末题显示下一题——见 isLastQuestion 与 action bar 互斥分支） */
function advanceToNext(): void {
  if (activeIdx.value < questionsList.value.length - 1) {
    activeIdx.value++
  }
}

/** 当前问题是否为最后一题（决定按钮显示"下一题"还是"提交"）*/
const isLastQuestion = computed(() => activeIdx.value >= questionsList.value.length - 1)

/** Tab / Shift+Tab 在问题间循环导航（多问题时生效）。
 *  IME 组合输入中（中文/日文输入法拼音未确认）按 Tab 可能是候选词选择操作，
 *  此时拦截 Tab 做问题切换会打断用户的输入法操作，故加 isComposing 守卫。 */
function onTabKey(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (questionsList.value.length <= 1) return
  e.preventDefault()
  const total = questionsList.value.length
  if (e.shiftKey) {
    activeIdx.value = (activeIdx.value - 1 + total) % total
  } else {
    activeIdx.value = (activeIdx.value + 1) % total
  }
}

/** Other input Enter（渲染器已过 IME isComposing 守卫）：非最后一题前进到下一题，
 *  最后一题不拦截（全答则提交，让按钮守卫语义一致）。 */
function onOtherEnter(): void {
  if (!isLastQuestion.value) {
    advanceToNext()
  } else if (allAnswered.value) {
    onSubmit()
  }
}

// ── Submit：按挂载源构造应答形状（见文件头分流说明）──
function onSubmit(): void {
  // legacy scheduleCreate 挂载源：扁平 ScheduleFormResult JSON 直传
  if (draftMount.value) {
    const result = scheduleRefs.get(qKey(draftQuestion.value))?.submit() ?? null
    if (result !== null) emit('submit', result)
    return
  }
  const answers: Record<string, string> = {}
  for (const q of questionsList.value) {
    const key = qKey(q)
    if (q.type === 'schedule') {
      const result = scheduleRefs.get(key)?.submit() ?? null
      if (result === null) return // 提交瞬间复核未过（once 时刻已过等）——整表中止
      answers[key] = result // value = JSON.stringify(ScheduleFormResult)（D2）
      continue
    }
    const st = states.value[key]
    if (!st) continue
    if (q.type === 'choice' && q.options.length > 0) {
      // selected 只含真实选项 label（过滤 OTHER_VALUE 占位符）
      const vals = st.selectedValues.filter((v) => v !== OTHER_VALUE)
      if (vals.length > 0) {
        answers[key] = q.multi ? JSON.stringify(vals) : vals[0]
      }
    }
    // Other 自由文本写独立 key `${key}__other`；text 题答案只写 __other 不写主 key（D2）
    if (st.otherText) {
      answers[`${key}__other`] = st.otherText
    }
  }
  emit('submit', JSON.stringify(answers))
}
</script>

<template>
  <!-- v3 无边框一体化：单容器靠间距分区，head 行含脉冲点+标题/tab（AskUserOverlay 形态继承；
       schedule 源的 border/shadow 浮起样式随统一有意退役）。宽度：content-col（居中 +
       封顶 --content-max-w），与 Composer 同一内容列——overlay 与 composer 互斥替换时宽度不跳变。 -->
  <div
    data-testid="form-overlay"
    class="content-col relative flex flex-col animate-ask-user-slide-up overflow-hidden rounded-lg bg-bg-input motion-reduce:animate-none"
    @keydown.tab="onTabKey"
  >
    <!-- head 行：脉冲点 + (单问题标题 | 多问题 tab) -->
    <div
      data-testid="form-head"
      class="relative flex items-center gap-2 px-3.5 pt-2.5"
    >
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <!-- 单问题：标题提到 head 行，单行 truncate（draft 直挂无问题文本 → 只余脉冲点） -->
      <span
        v-if="!multiQuestion"
        class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium text-neutral-fg"
        data-testid="form-question-text"
      >
        {{ activeQuestion?.question }}
      </span>
      <!-- 多问题：tab 整合到 head 行 -->
      <div v-else class="flex items-center gap-0.5">
        <Button
          v-for="(q, i) in questionsList"
          :key="qKey(q)"
          variant="ghost"
          :class="[
            'rounded-sm px-2.5 py-1 text-[12px] font-normal transition-colors',
            i === activeIdx
              ? 'bg-accent-soft font-medium text-neutral-fg'
              : 'text-neutral-dim hover:text-neutral-mid',
          ]"
          :data-testid="`form-tab-${i}`"
          @click="activeIdx = i"
        >
          {{ q.header ?? q.question.slice(0, 12) }}
          <!-- v6 §6.5：已答 tab 显 7px success 绿点 -->
          <span
            v-if="isQuestionAnswered(q)"
            data-testid="form-tab-answered"
            class="size-[7px] rounded-full bg-success"
          />
        </Button>
      </div>
      <span class="flex-1" />
    </div>

    <!-- body ①：choice/text 活跃题（仅活跃题渲染；状态在壳 states，切 tab 不丢） -->
    <div v-if="activeQuestion && activeQuestion.type !== 'schedule'" class="flex flex-col gap-2 px-3.5 pb-1 pt-2.5">
      <!-- v6 §6.5：context 降中性 bg-surface-hover（去 reasoning 软底彩色，v6 降噪） -->
      <p
        v-if="activeQuestion.context"
        data-testid="form-context"
        class="rounded bg-surface-hover px-2.5 py-1.5 text-[12px] leading-1.5 text-neutral-mid"
      >
        {{ activeQuestion.context }}
      </p>

      <!-- 多问题时的问题文本（单问题已在 head 行） -->
      <p
        v-if="multiQuestion"
        class="py-0.5 text-[13px] font-medium text-neutral-fg"
        data-testid="form-question-text-multi"
      >
        {{ activeQuestion.question }}
      </p>

      <ChoiceQuestion
        v-if="activeQuestion.type === 'choice'"
        v-model="states[qKey(activeQuestion)]"
        :question="activeQuestion"
        @advance="advanceToNext"
        @other-enter="onOtherEnter"
      />
      <TextQuestion
        v-else
        v-model="states[qKey(activeQuestion)]"
        :question="activeQuestion"
      />
    </div>

    <!-- body ②：schedule 题全部常挂 v-show（表单状态在渲染器内部，切 tab 不重置）；
         context 行由壳补（渲染器整表单迁移不含 context 呈现） -->
    <template v-for="(q, i) in questionsList" :key="qKey(q)">
      <template v-if="q.type === 'schedule'">
        <p
          v-if="q.context && i === activeIdx"
          data-testid="form-context"
          class="px-3.5 pt-2.5 text-[12px] leading-1.5 text-neutral-mid"
        >
          {{ q.context }}
        </p>
        <ScheduleForm
          v-show="i === activeIdx"
          :ref="(el) => setScheduleRef(qKey(q), el)"
          :question="q"
          @cancel="emit('cancel')"
        />
      </template>
    </template>

    <!-- actions：无边框，透明继承根。非最后一题显示"下一题"，最后一题显示"提交"(守卫 allAnswered) -->
    <div class="flex items-center justify-end gap-2 px-3.5 pb-2.5 pt-1">
      <Button
        v-if="allowCancel"
        variant="ghost"
        data-testid="form-cancel"
        @click="emit('cancel')"
      >
        {{ t('common.cancel') }}
      </Button>
      <Button
        v-if="!isLastQuestion"
        variant="default"
        data-testid="form-next"
        :disabled="!isQuestionAnswered(activeQuestion!)"
        @click="advanceToNext"
      >
        {{ t('common.next') }}
      </Button>
      <Button
        v-else
        variant="default"
        data-testid="form-submit"
        :disabled="!allAnswered"
        :title="allAnswered ? t('common.submit') : t('extensionUI.unansweredHint', { count: unansweredCount })"
        @click="onSubmit"
      >
        {{ t('common.submit') }}
      </Button>
    </div>
  </div>
</template>
