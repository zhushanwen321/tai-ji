<script setup lang="ts">
/**
 * ChoiceQuestion —— choice 问题渲染器（AskUserOverlay 主体逐字继承，设计 D5）。
 *
 * 单选 / 多选 / Other 卡片化（选项末尾追加输入框）的呈现与 toggle 逻辑；
 * 状态经 v-model 上报壳（QuestionState），单选选中普通选项后 emit advance 由壳
 * 前进到下一题（对齐 pi TUI advanceAfterAnswer）。
 *
 * 交互细节继承：
 * - 单选选中后自动前进到下一题；Other 选中不前进，展开 input 并自动聚焦
 * - 选普通选项清 Other 文本（互斥）；取消 Other 选中清其文本
 * - Other input 的 Enter/Space 不冒泡到卡片容器；IME 组合输入中的 Enter 不拦截
 *   （交给浏览器确认候选词，与 Composer 的 isComposing 守护一致）
 */
import { computed, nextTick, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import type { ChoiceQuestion } from '@zhushanwen/extension-protocol'
import { OTHER_VALUE, type QuestionState } from './question-state'

const props = defineProps<{
  question: ChoiceQuestion
  modelValue: QuestionState
}>()
const emit = defineEmits<{
  'update:modelValue': [state: QuestionState]
  /** 单选选中普通选项后自动前进（壳切换 activeIdx） */
  advance: []
  /** Other input 的 Enter（已过 IME isComposing 守卫）：壳决定前进到下一题或提交 */
  'other-enter': []
}>()

const { t } = useI18n()

/** 问题 key（answers 编码 / testid 派生用，与壳 qKey 同规则：header 缺省 fallback 到 question 全文） */
const qKey = computed(() => props.question.header ?? props.question.question)

/** 局部更新并上报（保持 QuestionState 不可变更新，v-model 单向数据流） */
function update(patch: Partial<QuestionState>): void {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}

// ── 选项 key 解析（FormOption 无 value 字段，label 即唯一标识）──
function optValue(label: string): string {
  return label
}

// ── 单选 / 多选 toggle（AskUserOverlay toggleOption 逐字语义）──
function toggleOption(value: string): void {
  const st = props.modelValue
  if (props.question.multi) {
    const idx = st.selectedValues.indexOf(value)
    if (idx >= 0) {
      // 取消选中；取消 Other 时清文本
      update({
        selectedValues: st.selectedValues.filter((_, i) => i !== idx),
        otherText: value === OTHER_VALUE ? '' : st.otherText,
      })
    } else {
      update({ selectedValues: [...st.selectedValues, value] })
      if (value === OTHER_VALUE) focusOtherInput() // 选中 Other 聚焦 input
    }
    return
  }
  // 单选：再点同一项 = 取消
  const deselect = st.selectedValues[0] === value
  const selectedValues = deselect ? [] : [value]
  if (!deselect && value !== OTHER_VALUE) {
    update({ selectedValues, otherText: '' }) // 选普通选项清 Other（互斥）
    emit('advance') // 选 Other 时不 auto-advance（用户要输入文本），不前进
  } else {
    update({ selectedValues })
    if (!deselect && value === OTHER_VALUE) focusOtherInput()
  }
}

function isSelected(value: string): boolean {
  return props.modelValue.selectedValues.includes(value)
}

/** Other 选项是否选中（控制输入框展开）*/
function isOtherSelected(): boolean {
  return isSelected(OTHER_VALUE)
}

// 是否在选项末尾追加 Other 输入框（有 options 且 allowOther !== false）
function showOther(): boolean {
  return props.question.options != null && props.question.allowOther !== false
}

/** Other input 组件实例引用（选中展开后自动聚焦）*/
const otherInputComp = ref<{ $el: HTMLInputElement } | null>(null)

/** Other 选中后聚焦 input（等 v-if 渲染完成）*/
function focusOtherInput(): void {
  void nextTick(() => {
    // shadcn Input 根元素就是 <input>，$el 直接是原生 input
    otherInputComp.value?.$el?.focus()
  })
}

/** Other 文本双向绑定（v-model 代理到状态上报） */
const otherText = computed({
  get: () => props.modelValue.otherText,
  set: (v: string) => update({ otherText: v }),
})

/** Other input 的 Enter：IME 组合输入中（拼音未确认）不拦截，交给浏览器确认候选词，
 *  否则上抛 other-enter 由壳决定前进/提交。 */
function onOtherEnter(e: KeyboardEvent): void {
  if (e.isComposing) return
  emit('other-enter')
}
</script>

<template>
  <!-- 选项列表（单选/多选）：inline 布局，无边框，hover/selected 用 bg -->
  <div class="flex flex-col gap-1">
    <div
      v-for="opt in question.options"
      :key="optValue(opt.label)"
      :data-testid="`form-option-${optValue(opt.label)}`"
      :role="question.multi ? 'checkbox' : 'radio'"
      :tabindex="0"
      :aria-checked="isSelected(optValue(opt.label))"
      :class="[
        'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
        isSelected(optValue(opt.label))
          ? 'bg-accent-soft'
          : 'hover:bg-white/[0.04]',
      ]"
      @click="toggleOption(optValue(opt.label))"
      @keydown.enter="toggleOption(optValue(opt.label))"
      @keydown.space.prevent="toggleOption(optValue(opt.label))"
    >
      <!-- indicator：钉首行文字中线 -->
      <Checkbox
        v-if="question.multi"
        :model-value="isSelected(optValue(opt.label))"
        class="mt-0.5"
        @update:model-value="toggleOption(optValue(opt.label))"
      />
      <!-- v6 §6.5：单选 radio checked=accent 实心 + inset 2px bg-input 形成环 -->
      <div
        v-else
        :class="[
          'mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors',
          isSelected(optValue(opt.label))
            ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--bg-input)]'
            : 'border-border-strong',
        ]"
      />
      <!-- 内容：label + desc inline 同行 -->
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            data-testid="form-option-label"
            class="text-[13px] font-normal leading-1.5 text-neutral-fg"
          >{{ opt.label }}</span>
          <span
            v-if="opt.description"
            data-testid="form-option-desc"
            class="text-[12px] leading-1.5 text-neutral-dim"
          >{{ opt.description }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Other 卡片化选项（有 options 且 allowOther !== false）。
       作为最后一个选项卡片，选中后 label 下方展开输入框 -->
  <div
    v-if="showOther()"
    :data-testid="`form-option-${OTHER_VALUE}`"
    :role="question.multi ? 'checkbox' : 'radio'"
    :tabindex="0"
    :aria-checked="isOtherSelected()"
    :class="[
      'flex cursor-pointer items-start gap-2 rounded px-2.5 py-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent',
      isOtherSelected() ? 'bg-accent-soft' : 'hover:bg-white/[0.04]',
    ]"
    @click="toggleOption(OTHER_VALUE)"
    @keydown.enter="toggleOption(OTHER_VALUE)"
    @keydown.space.prevent="toggleOption(OTHER_VALUE)"
  >
    <Checkbox
      v-if="question.multi"
      :model-value="isOtherSelected()"
      class="mt-0.5"
      @update:model-value="toggleOption(OTHER_VALUE)"
    />
    <!-- v6 §6.5：单选 radio checked=accent 实心 + inset 2px bg-input 形成环 -->
    <div
      v-else
      :class="[
        'mt-0.5 size-4 shrink-0 rounded-full border-2 transition-colors',
        isOtherSelected() ? 'border-accent bg-accent shadow-[inset_0_0_0_2px_var(--bg-input)]' : 'border-border-strong',
      ]"
    />
    <div class="flex min-w-0 flex-1 flex-col">
      <span class="text-[13px] font-normal leading-1.5 text-neutral-fg">{{ t('extensionUI.other') }}</span>
      <!-- 选中时展开输入框（独立成行，自动聚焦）。
           @keydown.stop 阻止冒泡到卡片容器；Enter 单独处理（IME 守卫后上抛） -->
      <Input
        v-if="isOtherSelected()"
        ref="otherInputComp"
        v-model="otherText"
        :placeholder="t('extensionUI.customAnswerPlaceholder')"
        :data-testid="`form-other-${qKey}`"
        class="mt-1.5"
        @click.stop
        @keydown.enter.stop="onOtherEnter"
        @keydown.space.stop
      />
    </div>
  </div>
</template>
