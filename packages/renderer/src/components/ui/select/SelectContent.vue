<script setup lang="ts">
import type { SelectContentEmits, SelectContentProps } from 'reka-ui'
import { getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  injectSelectRootContext,
  useForwardPropsEmits,
} from 'reka-ui'
import { cn } from '@/lib/utils'
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'

/**
 * SelectContent —— 下拉浮层。样式与 PopoverContent 对齐（冷蓝暗色 elevated 浮层）。
 * 默认 popper 模式：position="popper"，跟随触发器对齐。
 *
 * z-index 取 1100：高于 Dialog（z-1000），保证嵌在 Dialog 内的 Select（如
 * ProviderEditModal 类型/上下文/思考策略）下拉时不被 DialogContent 压住。
 * 与 PopoverContent 同属「浮层」层级，统一规则。
 */
const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(),
  { position: 'popper', sideOffset: 6 },
)
const emits = defineEmits<SelectContentEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)

// 模态表面聚合注册（§6.7 弹出层族）：本包装组件常驻挂载（消费方模板恒含），开合态绑
// reka SelectRoot context 的 open ref 状态本体（动作时刻直读，§6.7 R4 时序前提——编排器
// window bubble 先行判定、DismissableLayer 后行 dismiss）。未在 SelectRoot 内使用时
// context 为 null（开合态恒 false）。旗标组由登记表按 id 读取（Esc 让位、⌘W 不让位、
// shieldsView intersecting——view 遮蔽联动按几何相交）。
const selectRootContext = injectSelectRootContext(null)

/** 内容根元素读点（view 遮蔽几何上报用）：内层 reka SelectContent 单根渲染，组件实例
 *  $el 即浮层 DOM；未挂载（关态）/非元素时 null → 上报不带 rect（主进程保守按相交）。 */
const contentRef = ref<{ $el?: unknown } | null>(null)
function contentRect(): { x: number; y: number; width: number; height: number } | null {
  const el = contentRef.value?.$el
  if (!(el instanceof HTMLElement)) return null
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

const disposeSurfaceRegistration = registerModalSurface({
  surface: 'select-content',
  key: `select-content-${getCurrentInstance()?.uid ?? 0}`,
  isOpen: () => selectRootContext?.open.value ?? false,
  rect: contentRect,
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>

<template>
  <SelectPortal>
    <SelectContent
      ref="contentRef"
      v-bind="forwarded"
      :class="
        cn(
          'relative z-[1100] max-h-[var(--reka-select-content-available-height)] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border-strong bg-bg-elevated text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <SelectViewport class="p-1">
        <slot />
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</template>
