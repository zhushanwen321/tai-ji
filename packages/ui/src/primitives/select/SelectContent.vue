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
import { cn } from '../../lib/utils'
import { registerUiModalSurface, uiSurfaceRectOf } from '../../modal-surface-registrar'

/**
 * SelectContent —— 下拉浮层。样式与 PopoverContent 对齐（composer 同源底色，
 * 2026-10-13 用户裁决 demo 方案 A 全族迁移）。
 * 默认 popper 模式：position="popper"，跟随触发器对齐。
 *
 * z-index = --z-dialog(1100)：demo .pg-set .sel-pop 同消费 var(--z-dialog)（tokens.css
 * 梯队注释：dialog 档承载「浮于 modal 的浮层」）。高于 DialogContent（--z-modal 1000），
 * 保证嵌在 Dialog 内的 Select（如 ProviderEditModal 类型/上下文/思考策略）下拉时不被压住。
 * sideOffset 4px：demo .sel-pop top calc(100% + 4px) 实测锚距。
 * [HISTORICAL] 底色/边框曾为 elevated + border-strong 浮层档（反向对比度 + 与已迁移的
 * CommandPopover 不一致），随本次全族迁移切换为 bg-bg + border；--bg-elevated token
 * 本身保留（segmented active 凹陷槽范式等非浮层消费方不变）。
 *
 * inheritAttrs=false + $attrs 手动绑到内部 reka SelectContent：本封装模板单根是
 * SelectPortal（渲染为 Teleport，非普通元素根），Vue 对 Teleport 根不继承 fallthrough
 * attrs——消费方传的 data-testid / 额外事件监听会在 Portal 边界被静默丢弃（Vue
 * "Extraneous non-props attributes" 警告），显式转发后落到真正的浮层 DOM（与 PopoverContent
 * 已修形态一致）。
 */
const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes['class'] }>(),
  { position: 'popper', sideOffset: 4 },
)
defineOptions({ inheritAttrs: false })
const emits = defineEmits<SelectContentEmits>()
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)

// 模态表面聚合注册（§6.7 弹出层族，经 renderer 注册桥——层级方向见
// modal-surface-registrar.ts 文件头）：本原语常驻挂载（消费方模板恒含），开合态绑 reka
// SelectRoot context 的 open ref 状态本体（动作时刻直读，§6.7 R4 时序前提）；未在
// SelectRoot 内使用时 context 为 null。旗标组由登记表按 id 读取（Esc 让位、⌘W 不让位、
// shieldsView intersecting——view 遮蔽联动按几何相交，rect 读内容根元素实测）。
const selectRootContext = injectSelectRootContext(null)

/** 内容根元素读点（view 遮蔽几何上报用）：内层 reka SelectContent 单根渲染，实例 $el
 *  即浮层 DOM；未挂载（关态）/非元素时 uiSurfaceRectOf 返回 null → 上报不带 rect
 *  （主进程保守按相交）。 */
const contentRef = ref<{ $el?: unknown } | null>(null)

const disposeSurfaceRegistration = registerUiModalSurface({
  surface: 'select-content',
  key: `select-content-${getCurrentInstance()?.uid ?? 0}`,
  isOpen: () => selectRootContext?.open.value ?? false,
  rect: () => uiSurfaceRectOf(contentRef.value),
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>

<template>
  <SelectPortal>
    <SelectContent
      ref="contentRef"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'relative z-[var(--z-dialog)] max-h-[var(--reka-select-content-available-height)] min-w-[var(--reka-select-trigger-width)] overflow-hidden rounded-md border border-border bg-bg text-neutral-fg shadow-2 outline-none reka-popover-transition',
          props.class,
        )
      "
    >
      <SelectViewport class="p-[4px]">
        <slot />
      </SelectViewport>
    </SelectContent>
  </SelectPortal>
</template>
