<!--
  FindBar —— 表面内查找框（find-in-surface 第一期）。挂在各可搜表面（right-drawer /
  bottom-drawer / overlay）顶部，消费 useFindInSurface 模块单例；surfaceKind prop 决定
  本实例归属哪个表面——根节点显隐 = 「find 开着且开着的是本表面」，防换表面时双实例同显。

  Esc 全部按键在根上 stopPropagation：防止输入框聚焦态的 Esc 冒泡到 window 被
  key-orchestrator 消费成「关容器」（FindBar 是表面上的临时覆盖层，先于容器关闭）。
  非聚焦态的 Esc 兜底归 orchestrator（find 开着 → 关 find 的判定在编排器 Esc 分支）。
-->
<template>
  <div
    v-if="find.isOpen.value && find.surfaceKind.value === surfaceKind"
    class="absolute right-2 top-2 z-[var(--z-popover)] flex items-center gap-1 rounded-md border border-border bg-elevated p-1 shadow-[var(--shadow-1)]"
    role="search"
    data-testid="find-bar"
    @keydown.stop
    @keydown.esc.prevent="onEsc"
    @keydown.enter.prevent="onEnter"
  >
    <div ref="inputWrapEl" class="w-52">
      <Input
        v-model="find.query.value"
        :aria-label="t('find.placeholder')"
        :placeholder="t('find.placeholder')"
        class="h-7 text-[length:var(--text-xs)]"
        data-testid="find-bar-input"
      />
    </div>
    <span
      class="min-w-9 text-center font-mono text-[length:var(--text-2xs)] tabular-nums text-neutral-dim"
      data-testid="find-bar-count"
    >{{ activeOrdinal }}/{{ find.hitCount.value }}</span>
    <Button
      variant="ghost"
      size="icon"
      class="size-6 shrink-0 text-neutral-mid"
      :title="t('find.prevHit')"
      :disabled="find.hitCount.value === 0"
      data-testid="find-bar-prev"
      @click="find.prev()"
    >
      <ChevronUp class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-6 shrink-0 text-neutral-mid"
      :title="t('find.nextHit')"
      :disabled="find.hitCount.value === 0"
      data-testid="find-bar-next"
      @click="find.next()"
    >
      <ChevronDown class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-6 shrink-0 text-neutral-dim"
      :title="t('find.close')"
      data-testid="find-bar-close"
      @click="onEsc"
    >
      <X class="size-3.5" aria-hidden="true" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { focusComposer } from '@/composables/features/app/key-orchestrator'
import { useFindInSurface } from '@/composables/features/find/useFindInSurface'

const props = defineProps<{
  /** 归属表面 kind（与表面根元素 data-find-surface 一致） */
  surfaceKind: string
}>()

const { t } = useI18n()
const find = useFindInSurface()

const activeOrdinal = computed(() =>
  find.hitCount.value === 0 ? 0 : find.activeIndex.value + 1,
)

// 输入即搜，无防抖（时间平抑红线）：query 是唯一事实源，高亮是搜索结果的纯投影
watch(() => find.query.value, () => {
  if (find.isOpen.value) find.search()
})

// 聚焦输入框：打开即聚焦（焦点契约——查找框是输入优先的临时层）；同 kind 重复 Ctrl+F
// 走 focusTick（isOpen/surfaceKind 均不变，单纯 watch 开态收不到「重新聚焦」意图）
const inputWrapEl = ref<HTMLElement | null>(null)
function focusInput(): void {
  // Input 组件（script setup 默认封闭，未 expose 元素 ref）拿不到原生 input——
  // 经包裹容器查询；该组件单根透传，内部原生 input 形态稳定
  inputWrapEl.value?.querySelector<HTMLInputElement>('input')?.focus()
}
watch(() => find.focusTick.value, () => {
  void nextTick(focusInput)
})
watch(() => find.isOpen.value, (open) => {
  if (open) void nextTick(focusInput)
})

/** Enter / Shift+Enter 上下导航（活动命中循环） */
function onEnter(e: KeyboardEvent): void {
  if (e.shiftKey) find.prev()
  else find.next()
}

/** 关闭并清空；焦点回 composer（§6.7 焦点契约同款——输入框随即卸载，不接续会流失到 body） */
function onEsc(): void {
  find.close()
  focusComposer()
}

// 卸载即清（表面被关 / 换表面实例卸载时兜底清高亮与状态）。kind 判断防误伤：
// 换表面时旧实例因 kind 不匹配而卸载，但 find 已被 open() 切到新表面——此时清空会
// 把新表面的搜索现场一起毁掉
onUnmounted(() => {
  if (find.surfaceKind.value === props.surfaceKind) find.close()
})
</script>
