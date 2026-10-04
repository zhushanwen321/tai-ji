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
import { cn } from "@/lib/utils"
import { registerModalSurface } from '@/composables/features/app/modal-surface-registry'

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

// 模态表面聚合注册（§6.7 弹层/模态族）：本包装组件常驻挂载（消费方模板恒含），开合态
// 绑 reka DialogRoot context 的 open ref 状态本体（动作时刻直读——编排器 window bubble
// 先行判定、reka DismissableLayer 后行 dismiss，时序前提见 §6.7 R4）。未在 DialogRoot
// 内使用时 context 为 null（开合态恒 false，不影响渲染）。旗标组由登记表按 id 读取。
// 实例级 key = Vue 实例 uid（同 app 内唯一；同 key 重复注册走 refCount，HMR 重挂换 uid）。
const dialogRootContext = injectDialogRootContext(null)
const disposeSurfaceRegistration = registerModalSurface({
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
    <DialogContent
      v-bind="mergedAttrs"
      :class="
        cn(
          'fixed left-1/2 top-1/2 z-[1000] grid w-full max-w-lg gap-4 border bg-surface p-6 shadow-lg select-text reka-dialog-transition sm:rounded-lg',
          props.class,
        )"
      >
      <slot />

      <!-- 关闭按钮：默认 absolute 右上角。消费者提供 hideClose 时隐藏（自行在内容内渲染 DialogClose） -->
      <DialogClose
        v-if="!props.hideClose"
        class="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-surface-hover data-[state=open]:text-neutral-mid"
      >
        <X class="w-4 h-4" />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
