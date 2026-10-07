<!--
  OverlayShell —— 内容浮层统一壳（display-containers §6.5/§7.3「浮层公共壳组件」）。

  从 WorkflowVizOverlay 抽出的公共壳：面板（88%×92% 圆角面板 + 遮罩、--z-modal）+ **两通道
  关闭**（点遮罩 / 右上关闭按钮）+ 标题栏 slot（#title，内容侧注入自己的 header 信息）+
  body slot（默认槽 = 面板 body 区，直接挂在面板 flex-col 下——内容自带 `min-h-0 flex-1`
  尺寸控制，如 workflow 的左 DAG 右实况分栏）。browser 与 workflow 两个内容挂进来
  （workflow = WorkflowVizOverlay；browser 挂载归 u-w2-browser-mount）。

  **ESC 不在壳内监听**（§6.7 唯一属主 = 栈序编排器）：关闭通道只有两路（遮罩 / 按钮），
  Esc 由编排器按层级序统一路由到 core 开合态——双监听会一次 Esc 连剥两层。

  Tab 焦点陷阱 + IME 组合态守卫（§7.3 随壳归位、a11y 不回退）：两机制的**逻辑单源**在
  编排器浮层分支（key-orchestrator/overlay-focus-trap + onWindowKeydown 首行 isComposing
  前置守卫，W1 随迁保位实装），壳是**注册点**（open 时把面板 ref 注册为陷阱目标、关闭/
  卸载时注销）——任何挂进壳的内容都天然获得陷阱与 IME 守卫覆盖，壳自身不挂 window
  keydown（避免与编排器双陷阱双守卫）。

  焦点契约（§6.7）：打开 → 面板聚焦（安全默认焦点）；关闭 → 焦点回 composer（放弃旧
  「焦点锚记录/归还」双规则）。

  DOM 契约：抽壳保持「既有形态」零 DOM 变化——wfvz-overlay / wfvz-overlay-panel /
  wfvz-overlay-header / wfvz-overlay-close 四锚点沿用 WorkflowVizOverlay 时代 testid
  （e2e 两 spec + docs/testing/02-panels-sidebar.md 登记表 + overlay 单测族共享该锚点；
  改名需三处同步，登记为后续清理候选）。内容侧锚点（wfvz-overlay-slug / -run-pill /
  -dag-* 等）归各内容组件。
-->
<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/80 backdrop-blur-[2px]"
    data-testid="wfvz-overlay"
    @click.self="close"
  >
    <section
      ref="panelRef"
      class="flex h-[88%] w-[92%] flex-col overflow-hidden rounded-lg border border-hairline bg-surface shadow-2 outline-none"
      role="dialog"
      aria-modal="true"
      :aria-label="label"
      tabindex="-1"
      data-testid="wfvz-overlay-panel"
      @click.stop
    >
      <!-- 标题栏：标题栏 slot（内容侧 header 信息）+ 恒定右侧关闭按钮 -->
      <header
        class="flex flex-none items-center gap-2 border-b border-hairline px-3 py-2"
        data-testid="wfvz-overlay-header"
      >
        <slot name="title" />
        <span class="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          class="size-[22px] shrink-0 text-neutral-dim"
          :aria-label="closeLabel"
          data-testid="wfvz-overlay-close"
          @click="close"
        >
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      </header>

      <!-- body：内容区（默认槽直接挂面板 flex-col，内容自带尺寸控制） -->
      <slot />
    </section>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { focusComposer, registerOverlayFocusTrapPanel } from '@/composables/features/app/key-orchestrator'

const props = defineProps<{
  /** 壳开合（v-if 全量挂卸——关闭态 DOM 零痕迹）。 */
  open: boolean
  /** dialog aria-label（内容侧提供 i18n 文案——壳通用不绑具体词表）。 */
  label: string
  /** 关闭按钮 aria-label（同上）。 */
  closeLabel: string
}>()

const emit = defineEmits<{
  /** 关闭动作统一出口（点遮罩 / 按钮两通道；ESC 归编排器直接关 core 开合态，不经本壳）。 */
  close: []
}>()

const panelRef = ref<HTMLElement | null>(null)
/** 已开态标记（immediate 首挂 open=false 不触发关闭侧动作——焦点契约只对真实关闭生效） */
let wasOpen = false

function close(): void {
  emit('close')
}

/**
 * open 切换（SearchModal watch(immediate) 同型）：打开 → nextTick focus 面板（安全默认焦点）
 * + 面板 ref 注册为编排器浮层分支的 Tab 陷阱目标；关闭 → 注销陷阱目标 + 焦点回 composer
 * （§6.7 焦点契约）+ 瞬态清理（本壳无定时器/在途查询——数据生命周期归内容侧）。
 */
watch(() => props.open, (isOpen) => {
  if (isOpen) {
    void nextTick(() => {
      panelRef.value?.focus()
      registerOverlayFocusTrapPanel(panelRef.value)
    })
  } else {
    registerOverlayFocusTrapPanel(null)
    if (wasOpen) focusComposer()
  }
  wasOpen = isOpen
}, { immediate: true })

onUnmounted(() => {
  registerOverlayFocusTrapPanel(null)
})
</script>
