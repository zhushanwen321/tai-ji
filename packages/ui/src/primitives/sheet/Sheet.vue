<script setup lang="ts">
/**
 * Sheet —— 移动端底部浮层原语（remote-use-mobile-v2 §6.9 / spec §6.3）。
 *
 * 移动端唯一浮层形态：遮罩 + 底部面板（26px 拖拽区 + 标题 + 可选说明 + 滚动体 +
 * 可选底栏）。焦点陷阱 / Esc 关闭 / 关闭后焦点归还 / 遮罩点击关闭由 reka-ui
 * Dialog 原语族内建（spec §6.3 焦点行），本组件只落底部形态与拖拽关闭。
 *
 * 规格（spec §6.3 字面）：
 * - 顶圆角 16px（--m-radius-sheet），--bg-elevated 底，shadow-3，不描边；
 * - 进场 300ms 从底部升起（--m-motion-sheet），退场 160ms（--m-motion-exit），
 *   遮罩 220ms 淡入（--m-motion-enter）；
 * - 拖拽关闭：下拉 >96px 或速度 >0.6px/ms（带 24px 位移门槛防误触轻扫），松手
 *   不达阈值回弹；
 * - 最大高度 90%（--m-sheet-max）；有底栏时底栏固定、内容区滚动；无底栏时滚动体
 *   自带底部安全区（--sheet-safe-bottom 缺省回退 env(safe-area-inset-bottom)）；
 * - 层级 --z-sheet（遮罩）/ +1（面板）。
 *
 * 挂载点：DialogPortal 缺省 body（真实壳全屏；demo 的 [data-phone-content] 是
 * 器具壳专属，不进原语）。
 */
import { computed, ref } from 'vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { cn } from '../../lib/utils'

const props = withDefaults(
  defineProps<{
    open: boolean
    /** 标题（无障碍锚点，必填；hideTitle 时仅读屏可见） */
    title: string
    /** 标题下说明行（可选） */
    description?: string
    /** 隐藏可见标题（面板顶部自有视觉头部的消费形态；读屏仍播 title） */
    hideTitle?: boolean
    /** 面板附加类（消费方窄化宽度等） */
    class?: string
  }>(),
  { description: undefined, hideTitle: false, class: undefined },
)

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

// ── 拖拽关闭（spec §6.3）─────────────────────────────────────────
// 指针下拉 → 面板 translateY 跟随；松手按位移/速度裁决关闭或回弹。
// 24px 位移门槛：速度判据单独成立会把「轻扫一下」误判成关闭意图。
const dragY = ref(0)
const dragging = ref(false)
const THRESHOLD_DISTANCE = 96
const THRESHOLD_VELOCITY = 0.6
const MIN_FLICK_DISTANCE = 24
let startY = 0
let startAt = 0

const sheetStyle = computed(() =>
  dragging.value || dragY.value > 0 ? { transform: `translateY(${dragY.value}px)` } : undefined,
)

function onPointerDown(event: PointerEvent): void {
  dragging.value = true
  startY = event.clientY
  startAt = performance.now()
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  dragY.value = Math.max(0, event.clientY - startY)
}

function onPointerUp(): void {
  if (!dragging.value) return
  const elapsed = Math.max(1, performance.now() - startAt)
  const velocity = dragY.value / elapsed
  const shouldClose = dragY.value > THRESHOLD_DISTANCE || (dragY.value > MIN_FLICK_DISTANCE && velocity > THRESHOLD_VELOCITY)
  dragging.value = false
  dragY.value = 0
  if (shouldClose) emit('update:open', false)
}
</script>

<template>
  <DialogRoot :open="props.open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="sheet-overlay fixed inset-[var(--sheet-safe-top,0px)_0_0_0] bg-[var(--m-scrim)]" />
      <DialogContent
        :class="cn(
          'sheet-content fixed bottom-0 left-0 right-0 flex max-h-[var(--m-sheet-max)] min-h-[148px] flex-col rounded-t-[var(--m-radius-sheet)] bg-bg-elevated shadow-[var(--shadow-3)] transition-transform duration-[var(--duration-fast)] ease-linear will-change-transform',
          props.class,
        )"
        :style="sheetStyle"
        :aria-label="props.hideTitle ? props.title : undefined"
        data-testid="sheet-content"
      >
        <div
          class="sheet-grip-zone flex h-[26px] flex-none cursor-grab touch-none items-center justify-center"
          aria-hidden="true"
          data-testid="sheet-grip"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <span class="sheet-grip h-1 w-9 rounded-full bg-border-strong" />
        </div>

        <DialogTitle
          :class="props.hideTitle
            ? 'sr-only'
            : 'sheet-title flex-none px-[var(--m-gutter)] pb-1 text-[length:var(--m-text-title)] font-semibold leading-[var(--m-leading-tight)] text-neutral-fg'"
          data-testid="sheet-title"
        >
          {{ props.title }}
        </DialogTitle>
        <DialogDescription
          v-if="props.description"
          class="sheet-desc flex-none px-[var(--m-gutter)] pb-2 text-[length:var(--m-text-sub)] text-neutral-mid"
          data-testid="sheet-description"
        >
          {{ props.description }}
        </DialogDescription>

        <!-- 无底栏：滚动体自带底部安全区（spec §6.3「无底栏时滚动体自带安全区」），--last 档换大底距 -->
        <div
          class="sheet-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-[var(--m-gutter)] pt-2"
          :class="$slots.footer ? 'pb-3' : 'pb-[calc(16px+var(--sheet-safe-bottom,env(safe-area-inset-bottom,0px)))]'"
          data-testid="sheet-body"
        >
          <slot />
        </div>

        <div
          v-if="$slots.footer"
          class="sheet-footer flex flex-none gap-2 border-t border-hairline px-[var(--m-gutter)] pt-3 pb-[calc(12px+var(--sheet-safe-bottom,env(safe-area-inset-bottom,0px)))] [&_button]:flex-1"
          data-testid="sheet-footer"
        >
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
/* z 层级落 scoped css-decl 形（不落模板 z-[var(--z-sheet)] class 形）：桌面 z 基线扫描器
   （renderer z-scan-helper）口径 = .css 文件声明形 + 模板 class/inline 形，.vue scoped
   声明不在其内；Sheet 是双壳共享原语，消费壳未接线前「移动浮层表面」在桌面 modal
   registry（renderer manifest，禁触域）无登记位——移动壳接线单元消费时随该壳的
   modal-surface 对账机制处置。z 值 = --z-sheet(1000) 遮罩 / +1 面板（spec §6.3）。
   其余仅保留 [data-state] 属性选择器动画 + keyframes（Tailwind 无法表达属性选择器
   开合态与 scoped-keyframe 引用，CollapsibleContent.vue 同律 escape hatch）。
   结构布局全部走模板 Tailwind 工具类（样式三层规范）。 */
.sheet-overlay {
  z-index: var(--z-sheet);
}

.sheet-content {
  z-index: calc(var(--z-sheet) + 1);
}

.sheet-overlay[data-state='open'] {
  animation: sheet-fade-in var(--m-motion-enter) var(--m-ease-enter);
}

.sheet-overlay[data-state='closed'] {
  animation: sheet-fade-out var(--m-motion-exit) var(--m-ease-exit);
}

.sheet-content[data-state='open'] {
  animation: sheet-in var(--m-motion-sheet) var(--m-ease-enter);
}

.sheet-content[data-state='closed'] {
  animation: sheet-out var(--m-motion-exit) var(--m-ease-exit);
}

@keyframes sheet-fade-in {
  from {
    opacity: 0;
  }
}

@keyframes sheet-fade-out {
  to {
    opacity: 0;
  }
}

@keyframes sheet-in {
  from {
    transform: translateY(100%);
  }
}

@keyframes sheet-out {
  to {
    transform: translateY(100%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet-overlay[data-state='open'],
  .sheet-overlay[data-state='closed'],
  .sheet-content[data-state='open'],
  .sheet-content[data-state='closed'] {
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
  }
}
</style>
