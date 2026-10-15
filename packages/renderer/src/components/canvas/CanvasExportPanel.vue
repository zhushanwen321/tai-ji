<!--
  CanvasExportPanel —— 详情面板·导出 tab（problem-solve-canvas §3.1(3)）。

  收敛门禁与导出解锁：门禁区呈现收敛门禁三门禁投影（编号 = runtime
  convergenceBlockers 门禁序：①根判据确认 = root.confirmed 契约直读；②就绪递归 =
  只透传 runtime converged 确定性事实、GUI 不复刻领域规则（校验落点 = converge-check /
  export 的结构化拒绝——拒绝文案含完整阻断清单）；③must-fix 清零且待重审空 = 契约投影
  字段）+ 最近一次未收敛拒绝的错误码与恢复动作文案（设计「未收敛返回错误码+恢复动作
  文案呈现在导出面板门禁区」）。converged = true 导出解锁（时点快照语义：导出后再
  dispatch 需重新导出覆盖——执行清单为实时派生视图随画布刷新）。

  派发段：执行叶子清单（passed 且带判据的已选叶子优先）+ 指针登记（手填下游产物
  位置——D8：派发 = 用户逐叶确认 + 手填指针；已派发叶子显示指针，编辑偏差走待重审）。
-->
<template>
  <div class="flex flex-col gap-3" data-testid="canvas-export-panel">
    <!-- 收敛门禁区 -->
    <section class="flex flex-col gap-1.5 rounded-sm border border-hairline p-2.5" data-testid="canvas-export-gates">
      <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.gatesTitle') }}</p>
      <p
        v-for="gate in gates"
        :key="gate.key"
        class="flex items-start gap-1.5 text-[length:var(--text-2xs)] leading-relaxed"
        :data-testid="`canvas-gate-${gate.key}`"
        :data-gate="gate.ok ? 'ok' : 'blocked'"
        :class="gate.ok ? 'text-neutral-fg' : 'text-neutral-mid'"
      >
        <span
          class="mt-1.5 size-2 flex-none rounded-full"
          :class="gate.ok ? 'bg-success' : 'border border-warn'"
        />
        <span class="min-w-0">{{ gate.label }}</span>
      </p>
      <div
        v-if="blockerList.length > 0"
        class="flex flex-col gap-1 rounded-sm bg-warn-soft/60 px-2 py-1.5"
        data-testid="canvas-export-blockers"
      >
        <p class="font-mono text-[length:var(--text-3xs)] font-semibold text-warn">{{ t('panel.canvas.gateBlockersTitle') }}</p>
        <p
          v-for="blocker in blockerList"
          :key="blocker"
          class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid"
          data-testid="canvas-export-blocker"
        >{{ blocker }}</p>
      </div>
      <p
        v-if="rejection"
        class="rounded-sm border border-danger bg-danger-soft px-2 py-1.5 text-[length:var(--text-2xs)] leading-relaxed text-danger"
        data-testid="canvas-export-rejection"
      >
        <span class="font-mono font-semibold">{{ rejection.code }}</span> {{ rejection.recover }}
      </p>
      <p v-if="state.converged" class="rounded-sm border border-success bg-success-soft px-2 py-1.5 text-[length:var(--text-2xs)] font-semibold text-success" data-testid="canvas-export-unlocked">
        {{ t('panel.canvas.exportUnlocked') }}
      </p>
    </section>

    <!-- 导出动作（converged 解锁；目标二选一：规划文档 / 需求卡） -->
    <section class="flex flex-wrap items-center gap-2">
      <Button variant="default" size="sm" :disabled="!state.converged" data-testid="canvas-export-planning" @click="emit('export', { target: 'planning-doc' })">
        {{ t('panel.canvas.exportPlanning') }}
      </Button>
      <Select v-if="requirementLeaves.length > 0" v-model="leafId">
        <SelectTrigger class="h-8 w-44" :data-testid="`canvas-export-leaf-select`">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="leaf in requirementLeaves" :key="leaf.id" :value="leaf.id" :data-testid="`canvas-export-leaf-${leaf.id}`">
            {{ leaf.content }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Button
        v-if="requirementLeaves.length > 0"
        variant="secondary"
        size="sm"
        :disabled="!state.converged"
        data-testid="canvas-export-requirement"
        @click="emitExportRequirement"
      >
        {{ t('panel.canvas.exportRequirement') }}
      </Button>
    </section>
    <p class="text-[length:var(--text-2xs)] leading-relaxed text-neutral-dim">{{ t('panel.canvas.exportSnapshotNote') }}</p>

    <!-- 执行清单（实时派生视图；dispatch 后即时更新标注） -->
    <section class="flex flex-col gap-1.5 border-t border-hairline pt-2.5">
      <p class="font-mono text-[length:var(--text-3xs)] font-semibold uppercase tracking-wide text-neutral-dim">{{ t('panel.canvas.executionList') }}</p>
      <p v-if="leaves.length === 0" class="text-[length:var(--text-2xs)] text-neutral-faint" data-testid="canvas-execution-empty">
        {{ t('panel.canvas.executionEmpty') }}
      </p>
      <div
        v-for="leaf in leaves"
        :key="leaf.id"
        class="flex items-center gap-2 rounded-sm border border-hairline px-2 py-1.5"
        :data-testid="`canvas-execution-leaf`"
        :data-lifecycle="leaf.lifecycle"
      >
        <span
          class="flex-none rounded-full px-1.5 py-px font-mono text-[length:var(--text-3xs)] font-semibold"
          :class="leaf.lifecycle === 'passed' ? 'bg-success-soft text-success' : 'bg-warn-soft text-warn'"
        >{{ t(LIFECYCLE_KEYS[leaf.lifecycle]) }}</span>
        <Button
          variant="ghost"
          size="sm"
          class="min-w-0 flex-1 justify-start px-1 text-left text-[length:var(--text-2xs)] text-neutral-fg"
          @click="emit('select', leaf.id)"
        >
          <span class="min-w-0 truncate">{{ leaf.content }}</span>
        </Button>
        <span
          v-if="leaf.dispatch"
          class="flex-none max-w-[40%] truncate font-mono text-[length:var(--text-3xs)] text-accent"
          :title="leaf.dispatch.pointer"
          data-testid="canvas-execution-dispatched"
        >{{ t('panel.canvas.dispatchedBadge') }} {{ leaf.dispatch.pointer }}</span>
        <Button
          v-else-if="leaf.lifecycle === 'passed'"
          variant="ghost"
          size="sm"
          class="h-6 flex-none px-2 text-[length:var(--text-2xs)] text-neutral-mid"
          :data-testid="`canvas-execution-dispatch-${leaf.id}`"
          @click="emit('op', { kind: 'dispatch', nodeId: leaf.id })"
        >{{ t('panel.canvas.dispatchAction') }}</Button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CanvasExportTarget, CanvasNode, CanvasState } from '@zhushanwen/extension-protocol'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { dispatchableLeavesOf, openMustFixOf } from './canvas-display'
import type { CanvasOpKind } from './canvas-ops'

const props = defineProps<{
  state: CanvasState
  /** 最近一次未收敛拒绝（converge-check / export 失败臂——门禁区呈现，设计明文）。 */
  rejection: { code: string; recover: string } | null
}>()

const emit = defineEmits<{
  export: [target: CanvasExportTarget]
  op: [intent: { kind: CanvasOpKind; nodeId?: string }]
  select: [nodeId: string]
}>()

const { t } = useI18n()

const LIFECYCLE_KEYS = {
  draft: 'panel.canvas.lifecycleDraft',
  'under-review': 'panel.canvas.lifecycleUnderReview',
  passed: 'panel.canvas.lifecyclePassed',
  rejected: 'panel.canvas.lifecycleRejected',
  shelved: 'panel.canvas.lifecycleShelved',
} as const

/**
 * 收敛门禁三门禁投影（编号 = runtime convergenceBlockers 门禁序：①根判据 ②就绪递归
 * ③must-fix+待重审）：①根判据确认 = root.confirmed（契约直读字段）；②就绪递归 = 只
 * 透传 runtime converged 确定性事实、不复刻领域规则，未收敛时逐项清单数据源 =
 * CanvasState.convergenceBlockers（查询侧派生，缺字段 = marker 通道/旧 runtime，
 * 退回「由权威校验」措辞形态）；③must-fix 清零且待重审空 = 契约投影口径。
 */
const gates = computed<Array<{ key: string; ok: boolean; label: string }>>(() => [
  {
    key: 'root',
    ok: props.state.root.confirmed === true && props.state.root.criterias.length > 0,
    label: props.state.root.confirmed
      ? t('panel.canvas.gateRootOk')
      : t('panel.canvas.gateRootPending'),
  },
  {
    key: 'readiness',
    // converged = runtime 已校验全部门禁后置位的确定性事实——据此着色；未收敛时
    // 就绪递归不渲染红绿（GUI 不复刻领域规则），具体缺什么由阻断清单承载（下方
    // blockerList；无清单字段的旧形态退回「由权威校验」措辞）。
    ok: props.state.converged,
    label: props.state.converged
      ? t('panel.canvas.gateReadinessOk')
      : props.state.convergenceBlockers !== undefined
        ? t('panel.canvas.gateReadinessBlocked')
        : t('panel.canvas.gateReadinessRuntime'),
  },
  {
    key: 'clean',
    ok: openMustFixOf(props.state).length === 0 && props.state.dirtyPaths.length === 0,
    label:
      openMustFixOf(props.state).length > 0
        ? t('panel.canvas.gateCleanMustFix', { n: openMustFixOf(props.state).length })
        : props.state.dirtyPaths.length > 0
          ? t('panel.canvas.gateCleanDirty', { n: props.state.dirtyPaths.length })
          : t('panel.canvas.gateCleanOk'),
  },
])

/**
 * 门禁区逐项清单（runtime convergenceBlockers 的查询侧派生快照；导出前「具体缺
 * 什么」的权威清单——含就绪类与待重审类，后者与门禁③的计数呈现互补）。
 */
const blockerList = computed<string[]>(() => props.state.convergenceBlockers ?? [])

/** 执行叶子清单（实时派生视图）。 */
const leaves = computed<CanvasNode[]>(() => dispatchableLeavesOf(props.state))

/** 需求卡候选（passed 叶子——不变量 7：dispatched 前必须 passed；导出同判据）。 */
const requirementLeaves = computed<CanvasNode[]>(() => leaves.value.filter((l) => l.lifecycle === 'passed'))

const leafId = ref('')

watch(
  requirementLeaves,
  (list) => {
    if (!list.some((l) => l.id === leafId.value)) leafId.value = list[0]?.id ?? ''
  },
  { immediate: true },
)

function emitExportRequirement(): void {
  if (!leafId.value) return
  emit('export', { target: 'requirement-card', leafId: leafId.value })
}
</script>
