<!--
  WorkflowTab —— drawer workflow tab：agent call 列表（按 phase 分组）。

  header（workflow 名 + abort 两段式中止）+ phase 分组 +
  agent call 行（status 圆点 + agent + slug + tokens/turns/duration + running/pending）。
  phase 分组逻辑现居本组件（同数据结构 WorkflowRunRecord.agentCalls）——原实现侧
  侧栏工作流详情视图已随任务 tab 退役（2026-09-16），workflow 详情统一收口本 tab，
  分组/dot/format 逻辑以本文件为唯一在役出处。

  agent call 本质是 subagent（D4）：点 agent call 行 → openSubagent({ virtualId: agentCallVirtualId(call.sessionId),
  enteredFrom:'workflow' }) 切到 subagent tab（D4：从 workflow 进入显返回按钮）。

  数据来源：workflowStore.getRecordsBySession(mainSid)，按 selectedWorkflowName 匹配（先 runId
  精确匹配，后 scriptName 取最新）。selectedWorkflowName 为空 → 空态。
-->
<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="drawer-workflow-tab">
    <!-- 空态：未选中 workflow -->
    <div
      v-if="!workflow"
      class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
      data-testid="drawer-workflow-empty"
    >
      <Workflow class="size-6 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-xs)] text-neutral-dim opacity-70">{{ t('panel.sideDrawer.noWorkflow') }}</p>
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-50">{{ t('panel.sideDrawer.workflowHint') }}</p>
    </div>

    <template v-else>
      <!-- header：workflow 名 + slug + 中止（running 态 Abort 两段式） -->
      <div class="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <Workflow class="size-[15px] shrink-0 text-neutral-dim" />
        <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-neutral-fg">
          {{ workflow.scriptName }}
        </span>
        <span v-if="workflow.slug" class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">
          {{ workflow.slug }}
        </span>
        <!-- [D2] 中断 run 状态徽标（status 徽标面——state-tone-lock 登记的「已中断（可续跑）」
             显示位）：非终局不出 outcome 终态文案，暂停态可 resume 复活（回 running 后本徽标消失） -->
        <span v-if="workflow.status === 'interrupted'" data-testid="drawer-workflow-interrupted"
          class="shrink-0 rounded-sm border border-hairline px-1.5 py-px text-[length:var(--text-3xs)] text-neutral-dim">
          {{ t('panel.tray.workflowInterrupted') }}
        </span>
        <!-- workflow 一次性生命周期（subagent-workflow D-2）：仅 abort，pause/resume 已移除 -->
        <div v-if="workflow.status === 'running'" class="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            :data-testid="aborting ? 'drawer-workflow-abort-confirm' : 'drawer-workflow-abort'"
            :class="aborting
              ? 'size-5 border border-danger bg-danger text-neutral-fg'
              : 'size-5 text-neutral-dim hover:text-danger'"
            :title="aborting ? t('sidebar.workflowDetail.terminateConfirm') : t('sidebar.workflowDetail.terminate')"
            @click="onAbortClick"
          >
            <Check v-if="aborting" class="size-3" />
            <Square v-else class="size-3" />
          </Button>
        </div>
      </div>

      <!-- agent call 列表（按 phase 分组），分组/dot/format 逻辑见下方 phaseGroups -->
      <ScrollArea class="min-h-0 flex-1">
        <div class="flex flex-col px-1.5 pb-2">
          <div v-for="group in phaseGroups" :key="group.phase" class="mb-2">
            <!-- phase header：仅当存在显式 phase 时渲染（线性脚本无 phase 不显示分组 header） -->
            <div
              v-if="hasExplicitPhases"
              class="flex items-center gap-1.5 rounded-sm px-1 py-1"
              :class="group.phaseStatus === 'running' ? 'bg-accent/10' : ''"
            >
              <span class="size-1.5 shrink-0 rounded-full" :class="phaseDotClass(group.phaseStatus)" />
              <span class="text-[length:var(--text-3xs)] font-medium text-neutral-dim">{{ group.phase }}</span>
              <span class="ml-auto text-[length:var(--text-3xs)] text-neutral-dim opacity-60">
                {{ t('sidebar.workflowDetail.agentsLabel', { count: group.calls.length }) }}
              </span>
            </div>

            <!-- agent call 行：点 call → openSubagent（D4：agent call 本质是 subagent） -->
            <div
              v-for="call in group.calls"
              :key="call.id"
              class="group relative cursor-pointer rounded-md px-2 py-[6px] transition-colors hover:bg-surface-hover"
              :class="{ 'opacity-40': call.status === 'pending' }"
              :title="call.status === 'pending' ? t('sidebar.workflowDetail.pendingHint') : undefined"
              data-testid="drawer-workflow-agent-call"
              @click="onSelectCall(call)"
            >
              <!-- 第一行：status 圆点 + agent + 耗时/状态标签（同行，精简两行布局） -->
              <div class="flex items-center gap-2">
                <Loader2
                  v-if="call.status === 'running'"
                  class="size-[11px] shrink-0 animate-spin text-accent"
                />
                <span v-else class="size-1.5 shrink-0 rounded-full" :class="callDotClass(call.status)" />
                <span class="min-w-0 flex-1 truncate font-mono text-[length:var(--text-2xs)] font-medium text-neutral-fg">
                  {{ call.agent }}
                </span>
                <!-- [P3/D6] running ask：已执行时长槽（elapsed 可得时）；
                     旧快照缺 startedAt → 缺省渲染（槽省略） -->
                <span
                  v-if="call.status === 'running'"
                  class="shrink-0 font-mono text-[length:var(--text-3xs)] text-accent"
                >
                  {{ callStatusLabel(call) }}
                </span>
                <span v-else-if="call.status === 'pending'" class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ t('panel.sideDrawer.workflowPending') }}</span>
                <span v-else-if="call.durationMs !== undefined" class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ formatDuration(call.durationMs) }}</span>
              </div>
              <!-- 第二行：token 总量 + turns（仅终态 completed/failed，避免 running/pending 多余行） -->
              <div v-if="isCallDone(call.status) && (callTokenTotal(call) > 0 || call.turns !== undefined)" class="mt-0.5 flex items-center gap-1.5 pl-[19px] font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                <span v-if="callTokenTotal(call) > 0">{{ formatTokens(callTokenTotal(call), 'tokens') }}</span>
                <span v-if="call.turns !== undefined">· {{ call.turns }} {{ t('sidebar.workflowDetail.turnsUnit') }}</span>
              </div>
              <!-- [W0/V6] failed 行错误摘要（record.error 投影，截断一行，title 全文）：
                   状态行转 failed 的同时错误可见（失败路径恢复指引），不再只靠红点 -->
              <div
                v-if="call.status === 'failed' && call.error"
                data-testid="drawer-workflow-agent-call-error"
                class="mt-0.5 truncate pl-[19px] font-mono text-[length:var(--text-3xs)] text-danger"
                :title="call.error"
              >{{ call.error }}</div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Loader2, Square, Workflow } from '@lucide/vue'
import { Button } from '@taiji/ui'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useDrawerControl, openSubagent } from '@taiji/core/domain/drawer'
import {
  agentCallVirtualId,
  agentCallElapsedMs,
  useWorkflowStore,
} from '@/stores/workflow'
import { usePanelStore } from '@/stores/panel'
import { useWorkflowAction } from '@/composables/features/workflow/useWorkflowAction'
import { formatTokens } from '@/lib/token-format'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'
import type { WorkflowRunRecord, WorkflowAgentCall } from '@taiji/shared'

const { t } = useI18n()
const panelStore = usePanelStore()
const workflowStore = useWorkflowStore()

const { selectedWorkflowName } = useDrawerControl()

// abort 两段式确认态：动作单点在 useWorkflowAction（与 tray workflow 面板共享）；
// aborting computed 保持模板既有形态（按钮 testid/class/title 按 runId 派生）
const { isAbortConfirming, onAbortClick: onWorkflowAbortClick } = useWorkflowAction(
  () => panelStore.focusedSessionId,
)

/**
 * 当前选中的 workflow record（响应式）。
 * selectedWorkflowName 匹配策略：先 runId 精确匹配，后 scriptName 取最新一条（调用归宿：
 * 托盘行传 runId（TrayNativePanel 行点击矩阵）。
 */
const workflow = computed<WorkflowRunRecord | null>(() => {
  const name = selectedWorkflowName.value
  const mainSessionId = panelStore.focusedSessionId
  if (!name || !mainSessionId) return null
  const records = workflowStore.getRecordsBySession(mainSessionId)
  const byRunId = records.find((w) => w.runId === name)
  if (byRunId) return byRunId
  const byName = records.filter((w) => w.scriptName === name)
  return byName.length > 0 ? byName[byName.length - 1] : null
})

/** abort 两段式确认态（当前选中 workflow 的） */
const aborting = computed(() => workflow.value !== null && isAbortConfirming(workflow.value.runId))

/** phase 分组 + 组内状态聚合（原从侧栏工作流详情视图迁入，该视图已退役） */
interface PhaseGroup {
  phase: string
  calls: WorkflowAgentCall[]
  phaseStatus: PhaseAggregateStatus
}

const phaseGroups = computed<PhaseGroup[]>(() => {
  const wf = workflow.value
  if (!wf) return []
  const map = new Map<string, WorkflowAgentCall[]>()
  for (const call of wf.agentCalls) {
    const phase = call.phase ?? 'Other'
    const list = map.get(phase) ?? []
    list.push(call)
    map.set(phase, list)
  }
  return Array.from(map.entries()).map(([phase, calls]) => ({
    phase,
    calls,
    phaseStatus: aggregatePhaseStatus(calls),
  }))
})

/** 是否存在显式 phase（至少一个 agent call 有 phase 字段，否则不渲染分组 header） */
const hasExplicitPhases = computed(() =>
  workflow.value?.agentCalls.some((c) => c.phase !== undefined) ?? false,
)

// ── phase 聚合与状态点映射（[W2 D8] 全集锁）─────────────────────────────────
// 聚合输出四值（failed 不再被吸收进 completed——含失败步骤的 phase 显示红点）；
// 全部 switch 用 default-never 穷尽锁：call.status 词表扩值而分支漏配 = vue-tsc 红。

/** phase 聚合输出词表（[W2 D8] 四值） */
type PhaseAggregateStatus = 'done' | 'failed' | 'running' | 'pending'

/** never 穷尽断言（default 分支消费：漏配分支时 value 不再是 never → 编译红） */
function assertNever(value: never): never {
  throw new Error(`unreachable status: ${String(value)}`)
}

/** 终态判据（输入侧全集锁：call.status 扩值落 default → 编译红，不再静默判 pending） */
function isTerminalCallStatus(status: WorkflowAgentCall['status']): boolean {
  switch (status) {
    case 'done':
    case 'failed':
      return true
    case 'running':
    case 'pending':
      return false
    default:
      return assertNever(status)
  }
}

/** 组内状态聚合：有 running → running；全终态 → 含 failed 即 failed、否则 done；否则 pending */
function aggregatePhaseStatus(calls: WorkflowAgentCall[]): PhaseAggregateStatus {
  if (calls.some((c) => c.status === 'running')) return 'running'
  if (calls.every((c) => isTerminalCallStatus(c.status))) {
    return calls.some((c) => c.status === 'failed') ? 'failed' : 'done'
  }
  return 'pending'
}

function phaseDotClass(status: PhaseAggregateStatus): string {
  switch (status) {
    case 'done': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'bg-accent'
    case 'pending': return 'bg-neutral-dim opacity-40'
    default: return assertNever(status)
  }
}

function callDotClass(status: WorkflowAgentCall['status']): string {
  switch (status) {
    case 'done': return 'bg-success'
    case 'failed': return 'bg-danger'
    case 'running': return 'bg-accent'
    case 'pending': return 'bg-neutral-dim opacity-40'
    default: return assertNever(status)
  }
}

/** ms → 耗时（WorkflowTab 口径：无小时档，≥1h 仍累计分钟——现状保留；换算单点在 lib/duration-format） */
function formatDuration(ms: number): string {
  return formatCompactDuration(Math.floor(ms / MS_PER_SECOND), { hours: false })
}

// ── [P3/D6] progress 消费（推导纯函数单源在 stores/workflow）────────
// 1s tick 只驱动「已执行时长」槽重算（data 面仍由 records 推送驱动；
// interval 随组件 scope 自动回收）。
const now = ref(Date.now())
const TICK_INTERVAL_MS = 1000
const tickTimer = setInterval(() => {
  now.value = Date.now()
}, TICK_INTERVAL_MS)
onScopeDispose(() => clearInterval(tickTimer))

/** running ask 的状态标签：运行中（+ 已执行时长槽，可得时） */
function callStatusLabel(call: WorkflowAgentCall): string {
  const elapsed = agentCallElapsedMs(call, now.value)
  const label = t('panel.sideDrawer.workflowRunning')
  return elapsed === null ? label : `${label} · ${formatDuration(elapsed)}`
}

/** agent call 是否终态（done/failed，显示 token/turns 第二行；running/pending 不显） */
function isCallDone(status: WorkflowAgentCall['status']): boolean {
  return status === 'done' || status === 'failed'
}

/** agent call 的 token 总量（input + output 合并，精简显示） */
function callTokenTotal(call: WorkflowAgentCall): number {
  return (call.inputTokens ?? 0) + (call.outputTokens ?? 0)
}

/** 点 agent call → 切 subagent tab（D4：agent call 本质是 subagent，从 workflow 进入显返回按钮） */
function onSelectCall(call: WorkflowAgentCall): void {
  if (call.status === 'pending' || !call.sessionId) return
  openSubagent({ virtualId: agentCallVirtualId(call.sessionId), enteredFrom: 'workflow' })
}

/** abort 两段式：首次点击进入确认态，二次点击执行（动作单点 useWorkflowAction） */
function onAbortClick(): void {
  const wf = workflow.value
  if (wf) onWorkflowAbortClick(wf.runId)
}
</script>
