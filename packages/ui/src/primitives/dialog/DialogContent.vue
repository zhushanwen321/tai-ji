<script setup lang="ts">
import { computed, getCurrentInstance, onBeforeUnmount, useAttrs } from "vue"
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { X } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  injectDialogRootContext,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "../../lib/utils"
import { registerUiModalSurface } from "../../modal-surface-registrar"

// 禁用自动继承：模板根元素是 DialogPortal（reka-ui），它内部用 <Teleport> 渲染，
// Vue 无法在 Teleport 上继承 non-prop attrs（如 data-testid），会触发 warn。
// inheritAttrs:false 后，$attrs 不再 fallthrough 到 Portal，由内层 reka-ui
// DialogContent 的 v-bind="mergedAttrs" 显式接收（那才是渲染 DOM 面板的元素）。
defineOptions({ inheritAttrs: false })

const props = defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; hideClose?: boolean }>()
const emits = defineEmits<DialogContentEmits>()
const attrs = useAttrs()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
/** 合并 forwarded props + fallthrough attrs（如 data-testid），一次性绑到内层 reka-ui DialogContent */
const mergedAttrs = computed(() => ({ ...forwarded, ...attrs }))

// 模态表面聚合注册（§6.7 modal-dialog 族，经 renderer 注册桥——层级方向见
// modal-surface-registrar.ts 文件头）：本原语常驻挂载（消费方模板恒含），开合态绑 reka
// DialogRoot context 的 open ref 状态本体（动作时刻直读，§6.7 R4 时序前提）；未在
// DialogRoot 内使用时 context 为 null。实例级 key = Vue 实例 uid。未装配桥静默跳过。
const dialogRootContext = injectDialogRootContext(null)
const disposeSurfaceRegistration = registerUiModalSurface({
  surface: 'dialog-confirm',
  key: `dialog-content-${getCurrentInstance()?.uid ?? 0}`,
  isOpen: () => dialogRootContext?.open.value ?? false,
})
onBeforeUnmount(disposeSurfaceRegistration)
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      class="fixed inset-0 z-[1000] bg-black/80 backdrop-blur-sm reka-overlay-transition"
    />
    <!-- 形态收敛（settings 确认弹层统一，与 renderer 侧 @/components/ui/dialog/DialogContent
         同源同形态，对齐 demo pages.css .pg-set .cpop）：盒底 = 浮层级 --bg-elevated（遮罩上
         的面板不沉入内容层）+ --hairline 边框 + --shadow-3 + 无条件圆角 12px + 内边距 20px。
         z 保持裸数字 1000（manifest zAnchors class-raw 对账锚，令牌化随 ui 包波次另行裁决）。 -->
    <DialogContent
      v-bind="mergedAttrs"
      :class="
        cn(
          'fixed left-1/2 top-1/2 z-[1000] grid w-full max-w-lg gap-4 border border-hairline bg-bg-elevated p-[20px] shadow-[var(--shadow-3)] select-text reka-dialog-transition rounded-lg',
          props.class,
        )"
      >
      <slot />

      <!-- 关闭按钮：默认 absolute 右上角。消费者提供 hideClose 时隐藏（自行在内容内渲染 DialogClose）。
           形态对齐 demo overlay.css .rmodal-x/.rmodal-xic（与 renderer 副本同款）：24px 热区 +
           --radius 圆角 + dim 色，hover = --hover 底提亮字，焦点走 --focus-ring outline 内缩通道 -->
      <DialogClose
        v-if="!props.hideClose"
        class="absolute right-4 top-4 flex size-6 items-center justify-center rounded-[var(--radius)] text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color:var(--focus-ring)] focus-visible:-outline-offset-1 disabled:pointer-events-none data-[state=open]:bg-surface-hover data-[state=open]:text-neutral-mid"
      >
        <X class="size-[15px]" />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
