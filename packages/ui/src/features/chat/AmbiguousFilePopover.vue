<template>
  <!--
    歧义文件选择浮层（裸 basename 多匹配时弹出，如 design.md 在项目里有多个匹配）。

    克隆 CommandPopover 三件套模式：
    - Popover + PopoverAnchor as-child：锚定到点击的 <a> 元素（由 v-model:open 受控开关，
      不像 CommandPopover 的 slot 模式——这里 anchor 是具体 DOM 元素，用 :anchor 传入）
    - window capture 键盘导航（↑↓⏎ Esc）：与 CommandPopover 同模式，不依赖焦点位置
    - file 两行渲染（basename 主行 + 父目录暗行）：天然适合歧义区分（同名文件靠路径区分）

    数据源：candidates 由调用方从 fileSearchStore 按 basename 反查传入（FileNode[]）。
    选中后 emit('select', path) → 调用方走 selectFile(path) + drawer.open('detail') + 关浮层。
  -->
  <Popover v-model:open="controlledOpen">
    <!-- PopoverAnchor reference：传外部点击的 <a> DOM 元素作锚点（virtual anchor 模式，
         不需要 slot 包裹）。reka-ui PopoverAnchor.reference 透传给 PopperAnchor.onAnchorChange。 -->
    <PopoverAnchor :reference="anchorEl ?? undefined" />
    <PopoverContent
      v-if="open && candidates.length > 0"
      side="bottom"
      align="start"
      :side-offset="6"
      :collision-padding="8"
      class="w-[360px] max-w-[calc(100vw-16px)] overflow-hidden p-0"
      @open-auto-focus.prevent
    >
      <!-- 标题行：basename + 匹配数 -->
      <div class="border-b border-border px-2.5 py-1.5 text-[length:var(--text-xs)] text-neutral-dim">
        {{ t('panel.ambiguous.title', { basename, count: candidates.length }) }}
      </div>
      <!-- 候选列表 -->
      <div class="max-h-[220px] overflow-y-auto py-1">
        <Button
          v-for="(node, i) in candidates"
          :key="node.path"
          variant="ghost"
          class="flex w-full items-center gap-2 rounded-none px-2.5 py-1.5 text-left text-[length:var(--text-sm)] leading-[1.4] transition-colors"
          :class="i === activeIndex ? 'bg-accent-soft text-accent' : 'text-neutral-mid hover:bg-surface-hover hover:text-neutral-fg'"
          @click="onSelect(node)"
          @mouseenter="activeIndex = i"
        >
          <FileIcon class="size-[15px] shrink-0" :class="i === activeIndex ? 'text-accent' : 'text-neutral-dim'" />
          <!-- 两行：basename 主行 + 父目录路径暗行（区分同名文件位置） -->
          <div class="min-w-0 flex-1">
            <div class="truncate font-mono text-[length:var(--text-sm)]" :class="i === activeIndex ? 'text-accent' : 'text-neutral-fg'">{{ node.name }}</div>
            <div v-if="dirPathOf(node.path)" class="truncate font-mono text-[length:var(--text-2xs)] leading-tight text-neutral-dim">{{ dirPathOf(node.path) }}</div>
          </div>
        </Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
/**
 * 歧义文件选择浮层。
 *
 * 触发：markdown 裸 basename（如 design.md）点击时，若 fileSearchStore 反查到多个匹配，
 * 同包 MarkdownRenderer.vue 的路径点击分支（onClick ③）设 ambiguousState → 渲染本组件。
 *
 * 交互：↑↓ 切换高亮、⏎/Tab 选中、Esc 关闭（window capture 键盘导航，与 CommandPopover 同模式）。
 * 选中后 emit('select', path)，调用方负责 selectFile + drawer.open + 清 ambiguousState。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { File as FileIcon } from '@lucide/vue'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import { Popover, PopoverAnchor, PopoverContent } from '../../primitives/popover'
import type { FileNode } from '@taiji/shared'

const { t } = useI18n()

const props = defineProps<{
  /** 浮层开关（v-model:open） */
  open: boolean
  /** 歧义 basename（标题展示用） */
  basename: string
  /** 候选文件列表（按 basename 反查 fileSearchStore 的结果） */
  candidates: FileNode[]
  /** 锚点 DOM 元素（点击的 <a>，PopoverAnchor reference 模式，不要求在 slot 内） */
  anchorEl?: HTMLElement | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [path: string]
}>()

/** 受控 open：双向同步 */
const controlledOpen = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v),
})

const activeIndex = ref(0)

/** IME 组合态（window capture compositionstart/end 维护，对齐 contenteditable.ts composing 范式）：
 * 与 CommandPopover 同款双保险——事件属性 e.isComposing 在部分引擎存在乱序面，需 boolean 兜底。 */
const composingRef = ref(false)

/** 取文件路径的父目录（供第二行展示，区分同名文件位置） */
function dirPathOf(path: string): string {
  const slashIdx = path.lastIndexOf('/')
  return slashIdx >= 0 ? path.slice(0, slashIdx + 1) : ''
}

function onSelect(node: FileNode): void {
  emit('select', node.path)
  controlledOpen.value = false
}

/**
 * 键盘导航（与 CommandPopover 同模式）：↑↓ 切换、⏎/Tab 选中、Esc 关闭。
 * 幂等守卫 e.defaultPrevented 防双入口重复处理。
 */
function handleKeydown(e: KeyboardEvent): boolean {
  if (!props.open) return false
  if (e.defaultPrevented) return false
  const list = props.candidates
  if (list.length === 0) return false
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % list.length
    return true
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + list.length) % list.length
    return true
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    // 时序契约（composer-chip-insertion-semantics 设计 D2 同款模式）：本分支多经 window
    // capture 进入，消费 Enter/Tab 后必须 stopPropagation 截断事件向 target 的传播——
    // 否则 capture 选中 + target 阶段 Enter 双触发。选中链路仅 emit('select')（调用方
    // selectFile + drawer.open，无 composer 参与），截断安全。勿删。
    if (composingRef.value || e.isComposing) return false // IME 双保险：组合中 Enter 是确认候选词，放行
    e.preventDefault()
    e.stopPropagation()
    onSelect(list[activeIndex.value])
    return true
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    controlledOpen.value = false
    return true
  }
  return false
}

/** window capture 监听（不依赖焦点位置，浮层 open 时稳定命中键盘导航） */
function onWindowKeydown(e: KeyboardEvent): void {
  if (!props.open) return
  handleKeydown(e)
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onWindowKeydown, true)
  // composingRef 维护：组合发生在消息区外的输入面，window capture 感知组合起止
  const onCompositionStart = (): void => { composingRef.value = true }
  const onCompositionEnd = (): void => { composingRef.value = false }
  window.addEventListener('compositionstart', onCompositionStart, true)
  window.addEventListener('compositionend', onCompositionEnd, true)
  onBeforeUnmount(() => {
    window.removeEventListener('keydown', onWindowKeydown, true)
    window.removeEventListener('compositionstart', onCompositionStart, true)
    window.removeEventListener('compositionend', onCompositionEnd, true)
  })
}

// 浮层打开/候选变化时重置高亮到第一项
watch(
  () => [props.open, props.candidates],
  () => {
    activeIndex.value = 0
  },
)
</script>
