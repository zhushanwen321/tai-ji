<!--
  展示组件 · workflow 行（trace 块 workflow 类型行组件；壳分派链：Block 壳 → ToolRow 三分 → 本组件）。
  壳根类名契约（.trace-blk）与 data-testid（block-tool-<id>）留在 Block 壳，本组件根 =
  原 workflow 分支根 div（.trace-workflow + data-testid="workflow-block"），无新 DOM 层。
  职责：collapsed only 单行（icon + workflow prefix + name · slug），点击开 workflow overlay
  （workflow-visualization U6/D1 入口改向）；name 下多阶段 chips（phases 折叠快照，§3.1-2④：
  只表达 phase 名与最新一轮状态，不经 DAG 通道）。
-->
<template>
  <div class="trace-workflow" data-testid="workflow-block">
    <div
      data-testid="tool-block-header"
      class="group/wf flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] [font-weight:var(--fw-mid)] text-neutral-dim"
      @click="openWorkflowDrawer"
    >
      <!-- running 态 loader（呼吸弧 + accent），其余走 list-checks ICON（瞬时切换，tico
           交叉过渡已移除，见 thinking 行 [HISTORICAL]）；failed 图标染 danger（与普通 tool 行同款，demo .line.subagent.failed .sicon 形态家族） -->
      <RunningBlockIcon v-if="isRunning" kind="workflow" />
      <component :is="BLOCK_ICON_LUCIDE.workflow" v-else :class="[headerIconClass, 'self-center']" />
      <span :class="[BLOCK_LABEL_CLASS, 'transition-opacity duration-[var(--duration-fast)] group-hover/wf:opacity-80']">{{ t('panel.message.workflow') }}</span>
      <!-- name 染对话流专属名称色 --name（2026-10-06 裁决）；slug 降行层级灰（与「子代理」等标签同色 --neutral-mid） -->
      <span v-if="workflowFields.nameShort" class="shrink-0 whitespace-nowrap font-mono text-[color:var(--name)] transition-opacity duration-[var(--duration-fast)] group-hover/wf:opacity-80" :title="workflowFields.name">{{ workflowFields.nameShort }}</span>
      <template v-if="workflowFields.slug">
        <span class="text-neutral-faint">·</span>
        <span class="min-w-0 shrink-0 truncate font-mono text-neutral-mid transition-opacity duration-[var(--duration-fast)] group-hover/wf:opacity-80">{{ workflowFields.slug }}</span>
      </template>
    </div>
    <!-- mini phase 管道 chips：数据源 = WorkflowRunRecord.phases 折叠（getWorkflows 同批透出，
         反查经 core lookupWorkflowRun 桥接——ui 不 import renderer store）；settledAt 有值 =
         已收束（success 点）、缺省 = 进行中（accent 点），fold 无 failed 语义不造第三态 -->
    <div
      v-if="workflowChips.length"
      class="mt-1 flex flex-wrap items-center gap-1.5 pl-6"
      data-testid="workflow-block-chips"
    >
      <span
        v-for="p in workflowChips"
        :key="p.phase"
        class="inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm border border-hairline px-1.5 py-px font-mono text-[length:var(--text-3xs)] text-neutral-mid"
        :data-testid="`workflow-chip-${p.phase}`"
        :data-state="chipState(p)"
        :title="chipTitle(p)"
      >
        <span
          class="size-1.5 shrink-0 rounded-full"
          :class="p.settledAt !== undefined ? 'bg-success' : 'bg-accent'"
        />
        <span class="min-w-0 truncate">{{ p.phase }}</span>
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import { displayWorkflowName } from '@taiji/shared'
import { lookupWorkflowRun, openWorkflow } from '@taiji/core/domain/drawer'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE, BLOCK_LABEL_CLASS } from './block-icon'
import RunningBlockIcon from './RunningBlockIcon.vue'

const props = defineProps<{
  /** workflow tool_call 数据（ToolCall.input 顶层拍平 schema：action/name/slug/args 都在顶层） */
  tool?: ToolCall
  /** 所属 session（chips 反查按块归属 session 分区；openWorkflow 透传） */
  sessionId?: string | null
}>()

const { t } = useI18n()

const isFailed = computed(() => props.tool?.status === 'error')
const isRunning = computed(() => props.tool?.status === 'running')

/** header 图标状态色（[M3b demo 复刻] workbench.css）：状态色只落图标不落行文字——
 *  running 走模板 loader 分支（accent 呼吸弧，行文字恒 dim），failed 图标染 danger
 *  （demo .line.subagent.failed .sicon，常驻非 hover——原 hover:text-warn 形态废弃）。
 *  failed 分支显式整类重写而非在 BLOCK_ICON_CLASS 上追加 text-danger：两个 text 色
 *  工具类同特异性，追加后由样式表序裁决、覆盖不成立。 */
const headerIconClass = computed(() => (isFailed.value ? 'size-[15px] shrink-0 text-danger [stroke-width:1.6]' : BLOCK_ICON_CLASS))

/** workflow 顶层 input 安全读取（拍平 schema：action/name/slug/args/runId 都在顶层；runId 仅 schema 描述——run 动作调用时刻 runId 尚未由引擎生成、不可得，组件不读该字段，run 定位经 (name, slug) 反查，见 openWorkflowDrawer 注释与设计 §5 检查点④核实结论） */
const workflowInputObj = computed(() => {
  const input = props.tool?.input as Record<string, unknown> | undefined
  return input && typeof input === 'object' ? input : {}
})

/** workflow 标题行字段：name / slug（collapsed only，spec §11）。
 *  nameShort：ref 是绝对路径（input.name），标题行展示 basename 去 .js 短名
 *  （`/a/b/batch.js` → `batch`）——全路径太长挤占单行；drawer 选中仍用全路径 name。
 *  短名派生单点 = shared displayWorkflowName（与 tray 行同源）。 */
const workflowFields = computed(() => {
  const input = workflowInputObj.value
  const name = typeof input.name === 'string' ? input.name : ''
  const slug = typeof input.slug === 'string' ? input.slug : ''
  const nameShort = displayWorkflowName(name)
  return { name, nameShort, slug }
})

/**
 * 点击 workflow 块 → 开 workflow overlay（workflow-visualization U6/D1 入口改向）。
 * 传 (name, slug, sessionId)：反查 runId 的动作在 renderer opener 内单处执行（slug 缺失
 * 回落「name → 最新 run」现状语义、碰撞取最新）；sessionId = 本块所属 session（发起 pane
 * 的 session，D11⑤）。name 为空串时由 opener 兜底（反查不命中 → drawer workflow tab 空态，
 * 与现状「仅切 tab」归宿一致）。
 */
function openWorkflowDrawer(): void {
  openWorkflow(workflowFields.value.name, {
    slug: workflowFields.value.slug || undefined,
    sessionId: props.sessionId ?? undefined,
  })
}

/** chips 数据源：反查本块对应 run 的 phases 折叠（响应式——lookup 实现读 store 分区，依赖
 *  在本 computed 求值期间收集）。未绑定 lookup / 反查不命中 / 旧 run 无 phases → 不渲染。 */
const workflowChips = computed(() => {
  const name = workflowFields.value.name
  const sid = props.sessionId
  if (!name || !sid) return []
  return lookupWorkflowRun(sid, name, workflowFields.value.slug || undefined)?.phases ?? []
})

/** chip 状态词表（两态：fold 快照只有起止——settledAt 有值 = 已收束、缺省 = 进行中）。 */
function chipState(p: { settledAt?: number }): string {
  return p.settledAt !== undefined ? 'settled' : 'running'
}

/** chip 状态提示（数据点标题；phase 名即正文，title 只承载状态语义）。 */
function chipTitle(p: { settledAt?: number }): string {
  return p.settledAt !== undefined ? t('panel.workflowViz.chipSettled') : t('panel.workflowViz.chipRunning')
}
</script>
