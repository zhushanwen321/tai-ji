<!--
  CanvasNodeCard —— 主干节点卡（question/option；problem-solve-canvas §3.1(3)，demo v3
  node 卡内核平移 + taiji token 化）。

  视觉通道（概念 §3.1 通道分配）：类型 = 形状徽标（Q 方 / O 圆）；生命周期 = 边框与
  透明度（draft 虚边 / under-review 警示边 / rejected 灰显删除线 / shelved 半透明虚边）；
  selected 加粗描边；待重审专属角标（卡右上角浮标——门禁③「待重审=空」的可感知通道）；
  评论计数气泡（待响应醒目）；fact 论据核实角标在论据条内；派发徽标/按钮。
  纯展示组件：数据全部由父层（CanvasGraph）派生透传，交互只上抛事件。
-->
<template>
  <div
    class="absolute cursor-pointer rounded-[var(--radius-lg)] border bg-surface p-3 transition-[border-color,box-shadow,opacity] duration-150"
    :class="[
      lifecycleClass,
      { 'ring-2 ring-neutral-fg ring-offset-1': focused, 'opacity-60': muted },
    ]"
    :style="{ left: `${pos.x}px`, top: `${pos.y}px`, width: `${pos.w}px` }"
    :data-testid="`canvas-node-${node.type}`"
    :data-node-id="node.id"
    :data-lifecycle="node.lifecycle"
    :data-selected="node.selected ? 'true' : 'false'"
    :data-dirty="dirty ? 'true' : 'false'"
    @click.stop="emit('select', node.id)"
  >
    <!-- 待重审角标（专属可见标记，demo recheck-flag 形态平移） -->
    <span
      v-if="dirty"
      class="absolute -top-2 right-2.5 rounded-full border border-warn bg-warn-soft px-2 font-mono text-[length:var(--text-3xs)] font-bold leading-4 tracking-wide text-warn"
      data-testid="canvas-node-recheck-badge"
    >{{ t('panel.canvas.recheckBadge') }}</span>
    <!-- 评论气泡：计数徽标，待响应醒目（warn） -->
    <span
      v-if="commentCount > 0"
      class="absolute -right-2 -top-2 z-[3] grid min-w-[18px] place-items-center rounded-full border px-1 font-mono text-[length:var(--text-3xs)] font-bold leading-[16px]"
      :class="pendingComments > 0 ? 'border-warn bg-warn-soft text-warn' : 'border-neutral-dim bg-surface text-neutral-mid'"
      :title="t('panel.canvas.commentsTitle', { n: commentCount })"
      data-testid="canvas-node-comments-badge"
    >{{ commentCount }}</span>

    <div class="flex items-center gap-2">
      <span
        class="inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
        :class="node.type === 'option' ? 'rounded-full bg-neutral-dim/40 text-neutral-mid' : 'bg-neutral-dim/40 text-neutral-mid'"
      >
        <b class="font-bold">{{ node.type === 'question' ? 'Q' : 'O' }}</b>
        {{ nodeTypeLabel }}
      </span>
      <span v-if="node.dispatchable" class="rounded-full bg-accent-soft px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-semibold text-accent">
        {{ t('panel.canvas.leafTag') }}
      </span>
      <span class="flex-1" />
      <span
        class="size-[9px] flex-none rounded-full border-[1.5px]"
        :class="dotClass"
        :title="lifecycleLabel"
        data-testid="canvas-node-status-dot"
      />
    </div>
    <p
      class="mt-1 text-[13px] font-medium leading-snug text-neutral-fg"
      :class="{ 'line-through decoration-neutral-mid': node.lifecycle === 'rejected' }"
      data-testid="canvas-node-title"
    >{{ node.content }}</p>

    <!-- 否决折叠 chip（rejected 折叠不消失：保留展开入口与计数） -->
    <Button
      v-if="rejectedKids > 0"
      variant="ghost"
      size="sm"
      class="mt-1.5 inline-flex h-auto items-center gap-1 rounded-full border border-dashed border-hairline px-2 py-px font-mono text-[length:var(--text-3xs)] text-neutral-mid hover:text-neutral-fg"
      :data-testid="`canvas-node-rejected-chip`"
      @click.stop="emit('toggle-collapse')"
    >
      {{ collapsed ? '▸' : '▾' }}
      {{ t('panel.canvas.rejectedChip', { n: rejectedKids }) }}
    </Button>

    <!-- 论据条：支持/反对两横框收于框内底部 -->
    <CanvasArgStrip
      v-if="args.support.length > 0"
      polarity="support"
      :args="args.support"
      :selected-id="selectedArgId"
      :rebutted-ids="rebuttedIds"
      @select="(id) => emit('select', id)"
    />
    <CanvasArgStrip
      v-if="args.object.length > 0"
      polarity="object"
      :args="args.object"
      :selected-id="selectedArgId"
      :rebutted-ids="rebuttedIds"
      @select="(id) => emit('select', id)"
    />

    <!-- 派发徽标（已派发）/ 派发按钮（执行叶子 + passed + 未派发；指针表单在详情派发对话框） -->
    <span
      v-if="node.dispatch"
      class="mt-1.5 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-px font-mono text-[length:var(--text-3xs)] font-semibold text-accent"
      :title="node.dispatch.pointer"
      data-testid="canvas-node-dispatched-badge"
    >{{ t('panel.canvas.dispatchedBadge') }}</span>
    <Button
      v-else-if="canDispatch"
      variant="default"
      size="sm"
      class="mt-1.5 h-6 px-2 text-[length:var(--text-2xs)]"
      data-testid="canvas-node-dispatch-button"
      @click.stop="emit('dispatch', node.id)"
    >{{ t('panel.canvas.dispatchAction') }}</Button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasNode } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import type { LayoutPos } from './canvas-display'
import type { HostArgs } from './canvas-display'
import CanvasArgStrip from './CanvasArgStrip.vue'

const props = defineProps<{
  node: CanvasNode
  pos: LayoutPos
  args: HostArgs
  /** 派发按钮可见（执行叶子 + passed + 未派发——不变量 7 的 UI 预判，runtime 仍权威）。 */
  canDispatch: boolean
  /** 待重审角标（dirtyPaths 成员）。 */
  dirty: boolean
  /** 评论计数与待响应数。 */
  commentCount: number
  pendingComments: number
  /** 选中态（卡与论据条目共用选中通道——论据选中时本卡呈宿主弱高亮由父层 focused 承载）。 */
  focused: boolean
  /** 被反驳论据 id 集（互驳徽标）。 */
  rebuttedIds: Set<string>
  /** 否决折叠 chip。 */
  rejectedKids: number
  collapsed: boolean
  /** 论据条选中回显（选中的论据 id，或 null）。 */
  selectedArgId?: string | null
  /** 焦点路径外降透明（其余子树降透明度）。 */
  muted?: boolean
}>()

const emit = defineEmits<{
  select: [nodeId: string]
  dispatch: [nodeId: string]
  'toggle-collapse': []
}>()

const { t } = useI18n()

const nodeTypeLabel = computed(() =>
  props.node.type === 'question' ? t('panel.canvas.typeQuestion') : t('panel.canvas.typeOption'),
)

const lifecycleLabel = computed(() => LIFECYCLE_LABEL_KEYS[props.node.lifecycle])

/** 生命周期词条映射（显式表；动态键拼接会绕开 i18n 双侧 key 对齐检查）。 */
const LIFECYCLE_LABEL_KEYS = {
  draft: 'panel.canvas.lifecycleDraft',
  'under-review': 'panel.canvas.lifecycleUnderReview',
  passed: 'panel.canvas.lifecyclePassed',
  rejected: 'panel.canvas.lifecycleRejected',
  shelved: 'panel.canvas.lifecycleShelved',
} as const

const lifecycleClass = computed(() => {
  switch (props.node.lifecycle) {
    case 'draft':
      return 'border-dashed border-hairline'
    case 'under-review':
      return 'border-warn'
    case 'passed':
      return 'border-hairline'
    case 'rejected':
      return 'border-hairline opacity-55'
    case 'shelved':
      return 'border-dashed border-hairline opacity-70'
    default:
      return 'border-hairline'
  }
})

const dotClass = computed(() => {
  switch (props.node.lifecycle) {
    case 'draft':
      return 'border-neutral-mid bg-transparent'
    case 'under-review':
      return 'border-warn bg-warn'
    case 'passed':
      return 'border-success bg-success'
    case 'rejected':
      return 'border-neutral-dim bg-neutral-dim'
    case 'shelved':
      return 'border-dashed border-neutral-mid bg-transparent'
    default:
      return 'border-neutral-mid bg-transparent'
  }
})

</script>
