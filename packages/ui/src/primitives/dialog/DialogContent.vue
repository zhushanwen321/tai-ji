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

// 形态对照 demo（pages.css .pg-set .croot/.cpop 确认弹窗 + overlay.css .rmodal 大 modal）：
// 盒底 = --bg（composer 同源档，2026-10-14 全族迁移；[HISTORICAL] 曾为浮层级 --bg-elevated，
// 「遮罩上的面板不沉入内容层」归层原则改由 bg-scrim 遮罩 + shadow-3 承载——遮罩把身后
// 内容压暗后，--bg 盒面相对身后仍呈浮起）；
// 边框 = --hairline（.rmodal-box 档）；阴影 = --shadow-3；圆角 --radius-lg 12px（去 sm:
// 前缀——demo 无条件圆角，窄窗不该塌成直角）；内边距 20px（.cpop padding）；遮罩
// bg-scrim（token 真值 = rgba(0,0,0,0.8)）+ blur 4px 与 demo .cmask 同值。z-index 走 --z-modal(1000)：demo .rmodal
// 用 --z-dialog 是其单一语义；real 的 --z-dialog(1100) 档被嵌套弹层（Popover/Select）与
// ui-request band（AP-2：浮于 modal 之上）占用，DialogContent 升到下一档会破坏 band 语义。
// 进出场过渡参数见 style.css .reka-dialog-transition（demo rmodal-in 0.16s 档）。
// 轨道钉为 grid-cols-[minmax(0,1fr)]：auto 轨道会被网格项的 min-content 撑破内容盒——
// 内容里的 nowrap 长文本（如 worktree modal 的仓库路径 truncate 行，truncate 不减少其对
// 父级内在宽度的贡献）会把整层面板内容撑宽、吃掉右侧 padding；minmax(0,1fr) 使轨道
// 恒等于内容盒且可收缩，超宽内容退化为在自身盒内截断。

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
      class="fixed inset-0 z-[var(--z-modal)] bg-scrim backdrop-blur-sm reka-overlay-transition"
    />
    <DialogContent
      v-bind="mergedAttrs"
      :class="
        cn(
          'fixed left-1/2 top-1/2 z-[var(--z-modal)] grid w-full grid-cols-[minmax(0,1fr)] max-w-lg gap-4 border border-hairline bg-bg p-[20px] shadow-[var(--shadow-3)] select-text reka-dialog-transition rounded-lg',
          props.class,
        )"
    >
      <slot />

      <!-- 关闭按钮：默认 absolute 右上角。消费者提供 hideClose 时隐藏（自行在内容内渲染 DialogClose）。
           形态对齐 demo overlay.css .rmodal-x/.rmodal-xic：24px 热区 + --radius 圆角 + dim 色，
           hover = --hover 底提亮字（原 opacity 渐隐形态退役） -->
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
