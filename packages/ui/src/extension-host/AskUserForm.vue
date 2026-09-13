<script setup lang="ts">
/**
 * AskUserForm —— ask-user extension 的富交互表单（CompanionBand 内部子组件，W2 · T2）。
 *
 * 迁移自旧 renderer AskUserOverlay.vue（P3 逐域绞杀时旧文件删除，本组件是 ui 包新建终态）：
 * 去掉 overlay 外壳容器（容器由 CompanionBand 提供 bg-input 无边框一体化根），
 * 交互逻辑逐字继承（answers 编码 / IME 守卫 / auto-advance / Other 卡片化）。
 *
 * 交互能力（对齐 TUI 版 AskUserComponent）：
 * - tab 切换（多问题来回修改）
 * - 单选 / 多选
 * - Other 自由文本（选项末尾追加输入框）
 * - Submit 汇总提交 / Cancel 取消
 *
 * answers 格式（AskUserAnswers）：
 * - 单选：value = 选中项 label
 * - 多选：value = JSON.stringify(label[])
 * - Other：独立 key `${header}__other`
 *
 * 样式对齐 demo v3（docs/architecture/v3-specs/ask-user/inline-ask-user-demo-v3.html）：
 * 无边框一体化、head 行脉冲点 + 单问题标题(或 tab)、选项 indicator+label+desc 同行流式、
 * Other 卡片化（选中后 label 下方展开输入框）。
 */
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { Button } from '../primitives/button'
import { Input } from '../primitives/input'
import { Textarea } from '../primitives/textarea'
import { Checkbox } from '../primitives/checkbox'
import type { AskUserQuestion, AskUserOption } from '@xyz-agent/extension-protocol'

const props = withDefaults(
  defineProps<{
    questions: AskUserQuestion[]
    allowCancel?: boolean
  }>(),
  {},
)
const emit = defineEmits<{
  submit: [answers: string] // JSON.stringify(AskUserAnswers)
  cancel: []
}>()

const { t } = useI18n()

// ── 问题 key（header 缺失时用 question 文本）──
function qKey(q: AskUserQuestion): string {
  return q.header ?? q.question
}

// ── tab 状态 ──
const activeIdx = ref(0)
const activeQuestion = computed(() => props.questions[activeIdx.value])

// ── 每个问题的答案状态 ──
interface QState {
  selectedValues: string[] // 选中的 option value（单选长度 0/1，多选任意）
  otherText: string // Other 自由文本
}
const states = ref<Record<string, QState>>({})

// 初始化 / 重置状态（props.questions 变化时）
watch(
  () => props.questions,
  (qs) => {
    const next: Record<string, QState> = {}
    for (const q of qs) {
      const key = qKey(q)
      next[key] = states.value[key] ?? { selectedValues: [], otherText: '' }
    }
    states.value = next
    activeIdx.value = 0
  },
  { immediate: true },
)

// ── 选项 value 解析（label 即选中值，D1：proto 无独立 value）──
function optValue(o: AskUserOption): string {
  return o.label
}

/** Other 特殊选项的 value（卡片化，选中后展开输入框） */
const OTHER_VALUE = '__other__'

/** Other 选项是否选中（控制输入框展开） */
function isOtherSelected(q: AskUserQuestion): boolean {
  return isSelected(q, OTHER_VALUE)
}

// ── 单选 / 多选 toggle ──
// 单选选中后自动前进到下一题（对齐 pi TUI advanceAfterAnswer），多选不前进。
// Other 是特殊选项（OTHER_VALUE）：选中不 auto-advance，展开 input 并自动聚焦。
function toggleOption(q: AskUserQuestion, value: string): void {
  const st = states.value[qKey(q)]
  if (!st) return
  if (q.multiSelect) {
    const idx = st.selectedValues.indexOf(value)
    if (idx >= 0) {
      st.selectedValues.splice(idx, 1)
      if (value === OTHER_VALUE) st.otherText = '' // 取消 Other 清文本
    } else {
      st.selectedValues.push(value)
      if (value === OTHER_VALUE) focusOtherInput() // 选中 Other 聚焦 input
    }
  } else {
    st.selectedValues = st.selectedValues[0] === value ? [] : [value]
    if (st.selectedValues.length > 0 && value !== OTHER_VALUE) {
      st.otherText = '' // 选普通选项清 Other（互斥）
      advanceToNext()
    } else if (value === OTHER_VALUE && st.selectedValues.length > 0) {
      focusOtherInput() // 选中 Other 聚焦 input
    }
    // 选 Other 时不 auto-advance（用户要输入文本），不前进
  }
}

/** Other input 组件实例引用（选中展开后自动聚焦） */
const otherInputComp = ref<{ $el: HTMLInputElement } | null>(null)

/** Other 选中后聚焦 input（等 v-if 渲染完成） */
function focusOtherInput(): void {
  nextTick(() => {
    // shadcn Input 根元素就是 <input>，$el 直接是原生 input
    otherInputComp.value?.$el?.focus()
  })
}

function isSelected(q: AskUserQuestion, value: string): boolean {
  return states.value[qKey(q)]?.selectedValues.includes(value) ?? false
}

/** 单选选中后自动前进到下一题；已是最后一题则停（Submit 常驻底部 action bar） */
function advanceToNext(): void {
  if (activeIdx.value < props.questions.length - 1) {
    activeIdx.value++
  }
}

/** 当前问题是否为最后一题（决定按钮显示"下一题"还是"提交"） */
const isLastQuestion = computed(() => activeIdx.value >= props.questions.length - 1)

/** Other input 的 Enter 处理：非最后一题前进到下一题，最后一题不拦截（让按钮提交）。
 *  IME 组合输入中（中文/日文输入法拼音未确认）的 Enter 不拦截，交给浏览器确认候选词，
 *  否则会把拼音未确认状态下的 Enter 当成提交/前进，导致用户还没选字就提交了。
 *  与 Composer.vue 的 `if (e.isComposing) return` 守护一致。 */
function onOtherEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (!isLastQuestion.value) {
    advanceToNext()
  } else if (allAnswered.value) {
    onSubmit()
  }
}

/** 点击"下一题"按钮：前进到下一题 */
function onNextQuestion(): void {
  advanceToNext()
}

/** 问题是否已作答（普通选项选中 ≥1，或 Other 选中且有文本，或无选项问题 otherText 有值）
 *  —— tab 绿点 + allAnswered 共用 */
function isQuestionAnswered(q: AskUserQuestion): boolean {
  const st = states.value[qKey(q)]
  if (!st) return false
  // 无选项的纯自由文本问题：otherText 有值即答完
  if (!q.options?.length) return st.otherText.trim().length > 0
  // 有选项：Other 选中必须有文本才算答完
  const otherSelected = st.selectedValues.includes(OTHER_VALUE)
  if (otherSelected && !st.otherText.trim()) {
    // Other 选中但没文本：检查是否还选了其他选项（多选场景）
    return st.selectedValues.some((v) => v !== OTHER_VALUE)
  }
  return st.selectedValues.length > 0
}

/** 全部问题已作答（Submit 启用守卫，对齐 pi TUI allAnswered） */
const allAnswered = computed(() => props.questions.every(isQuestionAnswered))
/** 未答题数（disabled tooltip 文案） */
const unansweredCount = computed(() => props.questions.filter((q) => !isQuestionAnswered(q)).length)

/** Tab / Shift+Tab 在问题间循环导航（多问题时生效）。
 *  IME 组合输入中（中文/日文输入法拼音未确认）按 Tab 可能是候选词选择操作，
 *  此时拦截 Tab 做问题切换会打断用户的输入法操作，故加 isComposing 守卫。 */
function onTabKey(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (props.questions.length <= 1) return
  e.preventDefault()
  const total = props.questions.length
  if (e.shiftKey) {
    activeIdx.value = (activeIdx.value - 1 + total) % total
  } else {
    activeIdx.value = (activeIdx.value + 1) % total
  }
}

// 是否在选项末尾追加 Other 输入框（有 options 且 allowOther !== false）
function showOther(q: AskUserQuestion): boolean {
  return q.options != null && q.allowOther !== false
}

// ── Submit：构造 answers JSON ──
// 编码对齐 answer-codec.ts encodeAnswer（协议 SSOT）：主 key 写选中项 label（过滤 OTHER_VALUE），
// Other 自由文本写独立 key `${key}__other`，不混进主 key（AskUserAnswers 契约 + getAskUserOther 解码依据）。
function onSubmit(): void {
  const answers: Record<string, string> = {}
  for (const q of props.questions) {
    const key = qKey(q)
    const st = states.value[key]
    if (!st) continue

    if (q.options?.length) {
      // 有选项的问题：主 key = 过滤 OTHER_VALUE 后的选中项（单选首个 label / 多选 JSON 数组）
      const vals = st.selectedValues.filter((v) => v !== OTHER_VALUE)
      if (vals.length > 0) {
        answers[key] = q.multiSelect ? JSON.stringify(vals) : vals[0]
      }
      // Other 自由文本：独立 key `${key}__other`，即使同时选中普通选项也互不覆盖
      if (st.otherText) {
        answers[`${key}__other`] = st.otherText
      }
    } else {
      // 无选项的纯自由文本问题：输入文本作为主答案
      if (st.otherText) {
        answers[key] = st.otherText
      }
    }
  }
  emit('submit', JSON.stringify(answers))
}
</script>

<template>
  <!-- 纯内容流表单（容器由 CompanionBand 提供）：head 行脉冲点+标题/tab、选项 inline、
       Other 卡片化、actions 行。v3 无边框一体化，靠间距分区。 -->
  <div data-testid="ask-user-form" class="flex flex-col" @keydown.tab="onTabKey">
    <!-- head 行：脉冲点 + (单问题标题 | 多问题 tab) -->
    <div data-testid="ask-user-head" class="relative flex items-center gap-2 px-3.5 pt-2.5">
      <span class="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
      <!-- 单问题：标题提到 head 行，单行 truncate -->
      <span
        v-if="questions.length <= 1"
        data-testid="ask-user-question-text"
        class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium text-neutral-fg"
      >
        {{ activeQuestion?.question }}
      </span>
      <!-- 多问题：tab 整合到 head 行 -->
      <div v-else class="flex items-center gap-0.5">
        <Button
          v-for="(q, i) in questions"
          :key="qKey(q)"
          variant="ghost"
          :class="[
            'rounded-sm px-2.5 py-1 text-[12px] font-normal transition-colors',
            i === activeIdx
              ? 'bg-accent-soft font-medium text-neutral-fg'
              : 'text-neutral-dim hover:text-neutral-mid',
          ]"
          :data-testid="`ask-user-tab-${i}`"
          @click="activeIdx = i"
        >
          {{ q.header ?? q.question.slice(0, 12) }}
          <!-- v6 §6.5：已答 tab 显 7px success 绿点 -->
          <span v-if="isQuestionAnswered(q)" data-testid="ask-user-tab-answered" class="size-[7px] rounded-full bg-success" />
        </Button>
      </div>
      <span class="flex-1" />
    </div>

    <!-- body：问题内容 + 选项，紧凑间距 -->
    <div class="flex flex-col gap-2 px-3.5 pb-1 pt-2.5">
      <template v-if="activeQuestion">
        <!-- v6 §6.5：context 降中性 bg-surface-hover（去 reasoning 软底彩色，v6 降噪） -->
        <p
          v-if="activeQuestion.context"
          data-testid="ask-user-context"
          class="rounded bg-surface-hover px-2.5 py-1.5 text-[12px] leading-1.5 text-neutral-mid"
        >
          {{ activeQuestion.context }}
        </p>

        <!-- 多问题时的问题文本（单问题已在 head 行） -->
        <p
          v-if="questions.length > 1"
          data-testid="ask-user-question-text-multi"
          class="py-0.5 text-[13px] font-medium text-neutral-fg"
        >
          {{ activeQuestion.question }}
        </p>

        <!-- 选项列表（单选/多选）：inline 布局，无边框，hover/selected 用 bg -->
        <div v-if="activeQuestion.options?.length" class="flex flex-col gap-1">
          <div
            v-for="opt in activeQuestion.options"
            :key="optValue(opt)"
            :data-testid="`ask-user-option-${optValue(opt)}`"
            :role="activeQuestion.multiSelect ? 'checkbox' : 'radio'"
            :tabindex="0"
            :aria-checked="isSelected(activeQuestion, optValue(opt))"
            :class="[
              'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
              isSelected(activeQuestion, optValue(opt)) ? 'bg-accent-soft' : 'hover:bg-white/[0.04]',
            ]"
            @click="toggleOption(activeQuestion, optValue(opt))"
            @keydown.enter="toggleOption(activeQuestion, optValue(opt))"
            @keydown.space.prevent="toggleOption(activeQuestion, optValue(opt))"
          >
            <!-- indicator：钉首行文字中线 -->
            <Checkbox
              v-if="activeQuestion.multiSelect"
              :model-value="isSelected(activeQuestion, optValue(opt))"
              class="mt-0.5"
              @update:model-value="toggleOption(activeQuestion, optValue(opt))"
            />
            <!-- v6 §6.5：单选 radio checked=accent 实心 + inset 2px bg-input 形成环 -->
            <div
              v-else
              :class="[
                'mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors',
                isSelected(activeQuestion, optValue(opt)) ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--bg-input)]' : 'border-border-strong',
              ]"
            />
            <!-- 内容：label + desc inline 同行 -->
            <div class="flex min-w-0 flex-1 flex-col">
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span data-testid="ask-user-option-label" class="text-[13px] font-normal leading-1.5 text-neutral-fg">{{ opt.label }}</span>
                <span v-if="opt.description" data-testid="ask-user-option-desc" class="text-[12px] leading-1.5 text-neutral-dim">{{ opt.description }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Other 卡片化选项（有 options 且 allowOther !== false）。
             作为最后一个选项卡片，选中后 label 下方展开输入框 -->
        <div
          v-if="showOther(activeQuestion)"
          :data-testid="`ask-user-option-${OTHER_VALUE}`"
          :role="activeQuestion.multiSelect ? 'checkbox' : 'radio'"
          :tabindex="0"
          :aria-checked="isOtherSelected(activeQuestion)"
          :class="[
            'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
            isOtherSelected(activeQuestion) ? 'bg-accent-soft' : 'hover:bg-white/[0.04]',
          ]"
          @click="toggleOption(activeQuestion, OTHER_VALUE)"
          @keydown.enter="toggleOption(activeQuestion, OTHER_VALUE)"
          @keydown.space.prevent="toggleOption(activeQuestion, OTHER_VALUE)"
        >
          <Checkbox
            v-if="activeQuestion.multiSelect"
            :model-value="isOtherSelected(activeQuestion)"
            class="mt-0.5"
            @update:model-value="toggleOption(activeQuestion, OTHER_VALUE)"
          />
          <!-- v6 §6.5：单选 radio checked=accent 实心 + inset 2px bg-input 形成环 -->
          <div
            v-else
            :class="[
              'mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors',
              isOtherSelected(activeQuestion) ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--bg-input)]' : 'border-border-strong',
            ]"
          />
          <div class="flex min-w-0 flex-1 flex-col">
            <span class="text-[13px] font-normal leading-1.5 text-neutral-fg">{{ t('extensionUI.other') }}</span>
            <!-- 选中时展开输入框（独立成行，自动聚焦）。
                 @keydown.stop 阻止冒泡到卡片容器；Enter 单独处理前进到下一题 -->
            <Input
              v-if="isOtherSelected(activeQuestion)"
              ref="otherInputComp"
              v-model="states[qKey(activeQuestion)].otherText"
              :placeholder="t('extensionUI.customAnswerPlaceholder')"
              :data-testid="`ask-user-other-${qKey(activeQuestion)}`"
              class="mt-1.5"
              @click.stop
              @keydown.enter.stop="onOtherEnter"
              @keydown.space.stop
            />
          </div>
        </div>

        <!-- 无 options 的纯自由文本输入 -->
        <Textarea
          v-if="!activeQuestion.options?.length"
          v-model="states[qKey(activeQuestion)].otherText"
          rows="3"
          :placeholder="t('extensionUI.inputPlaceholder')"
          data-testid="ask-user-free-text"
        />
      </template>
    </div>

    <!-- actions：无边框，透明继承根。非最后一题显示"下一题"，最后一题显示"提交"(守卫 allAnswered) -->
    <div class="flex items-center justify-end gap-2 px-3.5 pb-2.5 pt-1">
      <Button
        v-if="allowCancel !== false"
        variant="ghost"
        data-testid="ask-user-cancel"
        @click="emit('cancel')"
      >
        {{ t('common.cancel') }}
      </Button>
      <Button
        v-if="!isLastQuestion"
        variant="default"
        data-testid="ask-user-next"
        :disabled="!isQuestionAnswered(activeQuestion!)"
        @click="onNextQuestion"
      >
        {{ t('common.next') }}
      </Button>
      <Button
        v-else
        variant="default"
        data-testid="ask-user-submit"
        :disabled="!allAnswered"
        :title="allAnswered ? t('common.submit') : t('extensionUI.unansweredHint', { count: unansweredCount })"
        @click="onSubmit"
      >
        {{ t('common.submit') }}
      </Button>
    </div>
  </div>
</template>
