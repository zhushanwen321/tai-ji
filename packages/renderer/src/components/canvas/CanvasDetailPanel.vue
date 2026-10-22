<!--
  CanvasDetailPanel —— 右侧详情面板（problem-solve-canvas §3.1(3)：节点详情 / 审查报告 /
  导出三 tab）。二级 tab 展示态本面板持有（纯展示维度；数据与操作全经 props/emit 上抛
  CanvasPane 编排）。审查 tab 徽标 = 未处置 must-fix 计数（契约派生口径）。
-->
<template>
  <aside class="flex min-h-0 w-[340px] flex-none flex-col border-l border-hairline bg-surface" data-testid="canvas-detail-panel">
    <nav class="flex flex-none items-center gap-0.5 border-b border-hairline px-2 pt-1.5" role="tablist" data-testid="canvas-detail-tabs">
      <Button
        v-for="seg in tabs"
        :key="seg.value"
        variant="ghost"
        size="sm"
        class="h-7 gap-1 rounded-sm px-2.5 text-[length:var(--text-2xs)]"
        :class="tab === seg.value
          ? 'bg-surface-hover text-neutral-fg hover:bg-surface-hover'
          : 'text-neutral-dim hover:bg-transparent hover:text-neutral-fg'"
        :aria-selected="tab === seg.value"
        :data-testid="`canvas-detail-tab-${seg.value}`"
        @click="tab = seg.value"
      >
        {{ seg.label }}
        <span
          v-if="seg.value === 'review' && openMustFixCount > 0"
          class="rounded-full bg-danger px-1.5 font-mono text-[length:var(--text-3xs)] font-bold leading-4 text-danger-fg"
          data-testid="canvas-review-tab-count"
        >{{ openMustFixCount }}</span>
      </Button>
    </nav>
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <CanvasNodeDetail
        v-show="tab === 'detail'"
        :state="state"
        :node-id="selectedNodeId"
        @op="(intent) => emit('op', intent)"
        @select="(id) => emit('select', id)"
      />
      <CanvasReviewPanel
        v-show="tab === 'review'"
        :state="state"
        @op="(intent) => emit('op', intent)"
        @select="onReviewSelect"
        @request-review="emit('request-review')"
      />
      <CanvasExportPanel
        v-show="tab === 'export'"
        :state="state"
        :rejection="rejection"
        @export="(target) => emit('export', target)"
        @op="(intent) => emit('op', intent)"
        @select="(id) => emit('select', id)"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasExportTarget, CanvasState } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import { openMustFixOf } from './canvas-display'
import CanvasNodeDetail from './CanvasNodeDetail.vue'
import CanvasReviewPanel from './CanvasReviewPanel.vue'
import CanvasExportPanel from './CanvasExportPanel.vue'
import type { CanvasOpKind } from './canvas-ops'

const props = defineProps<{
  state: CanvasState
  selectedNodeId: string | null
  /** 最近一次未收敛拒绝（导出门禁区呈现）。 */
  rejection: { code: string; recover: string } | null
}>()

const emit = defineEmits<{
  op: [intent: { kind: CanvasOpKind; nodeId?: string; entryId?: string; transitionTo?: string }]
  export: [target: CanvasExportTarget]
  select: [nodeId: string | null]
  /** 发起审查（mutate review-request，actor=user）。 */
  'request-review': []
}>()

const { t } = useI18n()

type DetailTab = 'detail' | 'review' | 'export'
const tab = ref<DetailTab>('detail')

const tabs = computed<Array<{ value: DetailTab; label: string }>>(() => [
  { value: 'detail', label: t('panel.canvas.detailTab') },
  { value: 'review', label: t('panel.canvas.reviewTab') },
  { value: 'export', label: t('panel.canvas.exportTab') },
])

/** 未处置 must-fix 计数（审查 tab 徽标；契约派生口径——openMustFixOf 单处实现）。 */
const openMustFixCount = computed(() => openMustFixOf(props.state).length)

/** 审查条目点击定位：targetId 指向节点 → 选中并切详情 tab；指向边 → 选中其终点节点。 */
function onReviewSelect(targetId: string): void {
  const isNode = props.state.nodes.some((n) => n.id === targetId)
  const resolved = isNode ? targetId : (props.state.edges.find((e) => e.id === targetId)?.to ?? targetId)
  emit('select', resolved)
  tab.value = 'detail'
}

// 选中节点变化时详情 tab 跟随（从画布点节点 = 看详情的自然意图）
watch(
  () => props.selectedNodeId,
  (id) => {
    if (id) tab.value = 'detail'
  },
)

defineExpose({ tab })
</script>
