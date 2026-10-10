<script setup lang="ts">
import type { PopoverContentEmits, PopoverContentProps } from 'reka-ui'
import { getCurrentInstance, onBeforeUnmount, ref } from 'vue'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { PopoverContent, PopoverPortal, injectPopoverRootContext, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'
import { registerModalSurface, surfaceRectOf } from '@/composables/features/app/modal-surface-registry'

/**
 * PopoverContent —— composer 工具区浮层原语。
 * 默认浮层样式（bg-elevated/border-strong/shadow-2），向上开由调用方传 side="top"。
 * sideOffset 默认 6（draft .pop.float: bottom calc(100% + 6px)）。
 * z-index = --z-dialog(1100) 与 SelectContent 统一，高于 Dialog(--z-modal 1000)，
 * 确保嵌在 Dialog 内的 Popover 不被压住（demo .pg-set .sel-pop 同消费 --z-dialog 档；
 * demo 梯队 --z-popover(10) 只服务无嵌套场景的页内弹层，此处不降档防破坏嵌套消费方）。
 * 形态对照 demo：浮层底 --elevated + 边框 --border-strong + 阴影 --shadow-2 与
 * workbench.css .composer .popover / overlay.css .ctxmenu 一致；圆角取菜单族 --r-md(8px)
 * （composer 域弹层卡 demo 为 --r-lg 12px，归 M4b 域内经 class 追加）；容器 p-0 为既有
 * 契约（demo padding 4px 由消费方 p-1 自控，AddMenuPopover 等已自带）。
 *
 * inheritAttrs=false + $attrs 手动绑到内部 reka PopoverContent：本封装模板单根是
 * PopoverPortal（渲染为 Teleport，非普通元素根），Vue 对 Teleport 根不继承 fallthrough
 * attrs——消费方传的 data-testid / 额外事件监听（如面板 hover 开关）会在 Portal 边界
 * 被静默丢弃（Vue "Extraneous non-props attributes" 警告），显式转发后落到真正的浮层 DOM。
 */
const props = withDefaults(
  defineProps<PopoverContentProps & { class?: HTMLAttributes['class'] }>(),
  { sideOffset: 6 },
)
defineOptions({ inheritAttrs: false })
const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)

// 模态表面聚合注册（§6.7 弹出层族）：本包装组件常驻挂载（消费方模板恒含），开合态绑
// reka PopoverRoot context 的 open ref 状态本体（动作时刻直读——编排器 window bubble 先行
// 判定、reka DismissableLayer 后行 dismiss，§6.7 R4 时序前提）。未在 PopoverRoot 内使用时
// context 为 null（开合态恒 false）。旗标组由登记表按 id 读取（Esc 让位、⌘W 不让位、
// shieldsView intersecting——view 遮蔽联动按几何相交）。
const popoverRootContext = injectPopoverRootContext(null)

/** 内容根元素读点（view 遮蔽几何上报用）：内层 reka PopoverContent 单根渲染，组件实例
 *  $el 即浮层 DOM；未挂载（关态）/非元素时 surfaceRectOf 返回 null → 上报不带 rect
 *  （主进程保守按相交）。 */
const contentRef = ref<{ $el?: unknown } | null>(null)

const disposeSurfaceRegistration = registerModalSurface({
  surface: 'popover-content',
  key: `popover-content-${getCurrentInstance()?.uid ?? 0}`,
  isOpen: () => popoverRootContext?.open.value ?? false,
  rect: () => surfaceRectOf(contentRef.value),
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      ref="contentRef"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'z-[var(--z-dialog)] min-w-[240px] rounded-md border border-border-strong bg-bg-elevated p-0 text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
