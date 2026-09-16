<!--
  TrayNativePanel —— composer 任务托盘的 built-in 三件面板（bash / subagent / workflow）。
  设计 docs/design/composer-task-tray.md §3.3 D2/D8/D9 + §3.4 + §3.5。
  props / emits / 尺寸契约与形态说明见 <script setup> 顶部块注释（消费方必读，u-tray-shell）。
-->
<!-- split-justified: built-in 三件面板同一语义域（分桶 tab + 行渲染 + 行内操作 + 行点击归宿） -->
<template>
  <div
    class="flex min-h-0 w-full flex-1 flex-col gap-1"
    data-testid="tray-native-panel" :data-kind="kind" :aria-label="t(titleKey)"
  >
    <!-- 损坏错误条（bash，S7 sticky 语义）：自愈拍（tasks 非空）清位后消失 -->
    <div
      v-if="kind === 'bash' && bashCorrupted"
      data-testid="tray-bash-corrupt-banner"
      class="flex shrink-0 items-center gap-1.5 rounded-sm bg-warn-soft px-2 py-1 text-[length:var(--text-2xs)] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1">{{ t('panel.tray.corruptBanner') }}</span>
    </div>
    <!-- 断连提示条（bash，S6）：断连 &&（拉取失败 || 未拉到过）——重连边沿由 useBackgroundTasks
         重连腿自动重拉，恢复即消失（计数冻结不虚报，§3.5） -->
    <div
      v-if="kind === 'bash' && showDisconnectBanner"
      data-testid="tray-bash-disconnect-banner"
      class="flex shrink-0 items-center gap-1.5 rounded-sm bg-bg-input px-2 py-1 text-[length:var(--text-2xs)] text-neutral-mid"
    >
      <WifiOff class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1">{{ t('panel.tray.disconnectBanner') }}</span>
    </div>

    <!-- 加载态：在途且该类无数据（bash = 从未拉到过一次；重连腿恢复后自消）——有缓存即直出列表 -->
    <div v-if="isKindLoading" data-testid="tray-panel-loading"
      class="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <Loader2 class="size-4 animate-spin text-neutral-dim opacity-60" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-60">{{ t('panel.tray.loading') }}</p>
    </div>

    <!-- 错误态（subagent / workflow 首拉失败）：可重试（D13 retry 腿） -->
    <div v-else-if="kindError" data-testid="tray-panel-error"
      class="flex flex-col items-center justify-center gap-2 py-8 text-center">
      <AlertCircle class="size-5 text-danger opacity-60" />
      <p class="min-w-0 px-2 text-[length:var(--text-2xs)] text-neutral-mid">{{ t('panel.tray.loadFailed', { error: kindError }) }}</p>
      <Button variant="ghost" class="h-6 text-[length:var(--text-2xs)] text-accent"
        data-testid="tray-panel-retry" @click="onRetry">{{ t('panel.tray.retry') }}</Button>
    </div>

    <template v-else>
      <!-- 分桶 tab：计数与行集同源（tab 数字恒等于列表条数，无穿帮面） -->
      <div data-testid="tray-panel-tabs" class="flex shrink-0 gap-[2px] rounded-[6px] bg-bg-input p-[2px]">
        <Button
          v-for="item in buckets" :key="item" variant="ghost"
          :data-testid="`tray-panel-tab-${item}`" :data-active="activeBucket === item ? 'true' : 'false'"
          :class="cn('h-6 flex-1 justify-center gap-[3px] rounded-[4px] px-1 text-xs font-normal',
            activeBucket === item
              ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated hover:text-neutral-fg'
              : 'text-neutral-dim hover:bg-transparent hover:text-neutral-fg')"
          @click="setBucket(item)"
        >
          <span class="leading-none">{{ t(bucketLabelKey(item)) }}</span>
          <span
            :data-testid="`tray-panel-tab-count-${item}`"
            :class="cn('font-mono text-[length:var(--text-3xs)] leading-none',
              activeBucket === item ? 'text-neutral-mid' : 'text-neutral-dim',
              bucketCount(item) === 0 ? 'opacity-40' : '')"
          >{{ bucketCount(item) }}</span>
        </Button>
      </div>

      <!-- 列表（当前桶非空） -->
      <ScrollArea v-if="hasRows" class="min-h-0 flex-1">
        <div class="flex flex-col px-1.5">
          <!-- bash 行：状态 icon + 命令 + 耗时 / pid · exit + 两段式终止（仅 running 行、仅 pin 态） -->
          <template v-if="kind === 'bash'">
            <div
              v-for="entry in bashRows" :key="entry.taskId"
              class="group/item relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
              data-testid="tray-bash-row" :aria-label="`${statusText(entry)}: ${entry.command}`"
              @click="openBashTask(entry)" @mouseleave="confirmingKillId = null"
            >
              <div class="mt-[6px] size-[7px] shrink-0" data-testid="tray-bash-icon" :title="statusText(entry)">
                <span v-if="iconOf(entry).shape === 'spinner'"
                  class="block size-[7px] animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
                <span v-else class="block size-[7px] rounded-full" :class="DOT_TONE_CLASS[iconOf(entry).tone]" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-[1.35] text-neutral-fg">
                  <span class="min-w-0 flex-1 truncate">{{ entry.command }}</span>
                  <span class="shrink-0 font-mono text-[length:var(--text-3xs)] leading-[1.35] text-neutral-dim">{{ elapsedLabel(entry) }}</span>
                </div>
                <div data-testid="tray-bash-meta"
                  class="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim">
                  <span class="min-w-0 flex-1 truncate">
                    {{ t('panel.tray.pidLabel') }} {{ entry.pid }}<template v-if="isEnded(entry)"> · {{ t('panel.tray.exitLabel') }} {{ entry.exitCode ?? '—' }}</template>
                  </span>
                  <Button
                    v-if="pinned && entry.state === 'running'" variant="ghost" size="icon"
                    :data-testid="confirmingKillId === entry.taskId ? 'tray-bash-kill-confirm' : 'tray-bash-kill'"
                    :data-confirming="confirmingKillId === entry.taskId ? 'true' : 'false'"
                    :class="cn('size-5 shrink-0 rounded-sm', confirmingKillId === entry.taskId
                      ? 'border border-danger bg-danger text-neutral-fg opacity-100'
                      : 'text-neutral-dim hover:text-danger')"
                    :title="confirmingKillId === entry.taskId ? t('panel.tray.killConfirm') : t('panel.tray.kill')"
                    @click.stop="onKillClick(entry)"
                  >
                    <Check v-if="confirmingKillId === entry.taskId" class="size-3" />
                    <X v-else class="size-3" />
                  </Button>
                </div>
              </div>
            </div>
          </template>

          <!-- subagent 行：引擎 icon + 状态点/spinner + agent + slug / turns · tokens · 耗时 / task 摘要 -->
          <template v-else-if="kind === 'subagent'">
            <div
              v-for="record in subagentRows" :key="record.subagentId"
              class="group relative cursor-pointer rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
              data-testid="tray-subagent-row"
              :title="record.slug ? record.agent + ' · ' + record.slug : record.agent"
              @click="openSubagentRow(record)" @mouseleave="cancellingSubagentId = null"
            >
              <div class="flex items-center gap-2">
                <component :is="resolveEngineIcon(record.engine).icon" :title="resolveEngineIcon(record.engine).label"
                  class="size-[13px] shrink-0 text-neutral-dim" data-testid="tray-subagent-engine-icon" />
                <Loader2 v-if="isRunningSubagent(record)" data-testid="tray-subagent-spinner"
                  class="size-[13px] shrink-0 animate-spin text-accent" />
                <span v-else class="size-2 shrink-0 rounded-full" :class="subagentDotClass(record)" />
                <span class="min-w-0 flex-1 truncate text-[length:var(--text-xs)] font-medium leading-[1.35] text-neutral-fg">
                  {{ record.agent }}
                </span>
                <span v-if="record.slug" data-testid="tray-subagent-slug"
                  class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-mid">{{ record.slug }}</span>
                <!-- 确认窗口期保留按钮：第一击进入确认态后迟到收口广播不得把确认钮藏掉（可达性优先） -->
                <Button
                  v-if="pinned && (isRunningSubagent(record) || cancellingSubagentId === record.subagentId)"
                  variant="ghost" size="icon"
                  :data-testid="cancellingSubagentId === record.subagentId ? 'tray-subagent-cancel-confirm' : 'tray-subagent-cancel'"
                  :data-confirming="cancellingSubagentId === record.subagentId ? 'true' : 'false'"
                  :class="cn('size-5 shrink-0 rounded-sm', cancellingSubagentId === record.subagentId
                    ? 'border border-danger bg-danger text-neutral-fg'
                    : 'text-neutral-dim hover:text-danger')"
                  :title="cancellingSubagentId === record.subagentId ? t('panel.tray.cancelConfirm') : t('panel.tray.cancel')"
                  @click.stop="onCancelClick(record)"
                >
                  <Check v-if="cancellingSubagentId === record.subagentId" class="size-3" />
                  <X v-else class="size-3" />
                </Button>
              </div>
              <div class="mt-1 flex items-center gap-2 pl-[42px] font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                <span v-if="record.turns !== undefined">{{ record.turns }} {{ t('panel.tray.turnsUnit') }}</span>
                <span v-if="record.totalTokens !== undefined">· {{ formatTokens(record.totalTokens) }}</span>
                <span v-if="record.elapsedSeconds !== undefined">· {{ formatSeconds(record.elapsedSeconds) }}</span>
              </div>
              <div class="mt-0.5 truncate pl-[42px] text-[length:var(--text-2xs)] leading-[1.3] text-neutral-mid">
                {{ record.task }}
              </div>
            </div>
          </template>

          <!-- workflow 行：状态点/spinner + scriptName + slug / 进度条 + N/M + 耗时 + abort（两段式；pause/resume 已随扩展 D-2 移除） -->
          <template v-else>
            <div
              v-for="record in workflowRows" :key="record.runId"
              class="group relative cursor-pointer rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
              data-testid="tray-workflow-row"
              @click="openWorkflowRow(record)" @mouseleave="abortingRunId = null"
            >
              <div class="flex items-center gap-2">
                <Loader2 v-if="record.status === 'running'" data-testid="tray-workflow-spinner"
                  class="size-[13px] shrink-0 animate-spin text-accent" />
                <span v-else class="size-2 shrink-0 rounded-full" :class="workflowToneClass(record)" />
                <span class="min-w-0 flex-1 truncate text-[length:var(--text-xs)] font-medium leading-[1.35] text-neutral-fg">
                  {{ record.scriptName }}
                </span>
                <span v-if="record.slug" data-testid="tray-workflow-slug"
                  class="shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-mid">{{ record.slug }}</span>
                <!-- 行内操作（仅 pin 态）：running 态 abort 两段式。workflow 一次性生命周期
                     （subagent-workflow D-2）：pause/resume 已在扩展侧移除，宿主不再暴露 -->
                <template v-if="pinned && record.status === 'running'">
                  <Button
                    variant="ghost" size="icon"
                    :data-testid="abortingRunId === record.runId ? 'tray-workflow-abort-confirm' : 'tray-workflow-abort'"
                    :data-confirming="abortingRunId === record.runId ? 'true' : 'false'"
                    :class="cn('size-5 shrink-0', abortingRunId === record.runId
                      ? 'border border-danger bg-danger text-neutral-fg'
                      : 'text-neutral-dim hover:text-danger')"
                    :title="abortingRunId === record.runId ? t('panel.tray.abortConfirm') : t('panel.tray.abort')"
                    @click.stop="onAbortClick(record.runId)"
                  >
                    <Check v-if="abortingRunId === record.runId" class="size-3" />
                    <Square v-else class="size-3" />
                  </Button>
                </template>
              </div>
              <div class="mt-1 flex items-center gap-1.5 pl-[21px] font-mono text-[length:var(--text-3xs)] text-neutral-dim">
                <div class="h-[3px] min-w-[40px] flex-1 overflow-hidden rounded-full bg-border">
                  <div class="h-full rounded-full transition-[width,background-color]"
                    :class="workflowToneClass(record)" :style="{ width: `${workflowPercent(record)}%` }" />
                </div>
                <span class="shrink-0">{{ t('panel.tray.agentsLabel', { done: completedAgentCount(record), total: record.agentCalls.length }) }}</span>
                <span v-if="record.startedAt" class="shrink-0">· {{ workflowElapsed(record) }}</span>
              </div>
            </div>
          </template>
        </div>
      </ScrollArea>

      <!-- 空态：默认「进行中」桶为空时给显式切桶按钮（D9：可行动空态，不自动跳转）；
           其余桶为空仅提示（对齐既有视图语义） -->
      <div v-else data-testid="tray-panel-empty"
        class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
        <p data-testid="tray-panel-empty-hint" class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">
          {{ t(emptyKey, { name: t(titleKey) }) }}
        </p>
        <Button
          v-for="item in jumpBuckets" :key="item" variant="ghost"
          class="h-6 text-[length:var(--text-2xs)] text-accent" :data-testid="`tray-panel-empty-jump-${item}`"
          @click="setBucket(item)"
        >{{ t('panel.tray.viewEnded', { count: bucketCount(item) }) }}</Button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * TrayNativePanel —— composer 任务托盘 built-in 三件面板（bash / subagent / workflow）。
 *
 * ── 契约（供 u-tray-shell 消费）──
 * props.kind: 'bash' | 'subagent' | 'workflow' —— 面板类型（built-in 三件之一）
 * props.sessionId: string —— 焦点 session id（行点击归宿 / 行内操作 RPC 的会话键；外壳由
 *   Composer 绑定的 sessionId 透传，与外壳 provide 的数据面同一 session——外壳透传自身
 *   props，两侧天然一致）
 * props.pinned?: boolean（默认 false）—— pin 态。行内操作按钮**仅 pin 态渲染**
 *   （D8：hover 态刻意不渲染行内按钮防误触；pin 由外壳管理，面板只消费该位）
 * inject TRAY_COUNTS_KEY（必需）：数据面单例，由外壳创建并 provide（见 useTrayCountsContext）。
 *   **面板不自建数据实例**——面板随 Popover 开合反复挂载，自建即每次打开重发首拉 RPC；token
 *   缺失时 useTrayCountsContext 直接抛错（不静默降级）。
 * emits: 无 —— 面板自持动作：行内操作直连既有 store / RPC（结果经 store 广播回流，外壳计数
 *   自动跟随），行点击直连 drawer API（D2 入口唯一化），外壳无需回调。
 * 尺寸：面板不设宽度（w-full），根节点 flex-1 撑满外壳的固定高内容区（h-[340px]，小屏
 * max-h 60vh 兜底，见 ComposerTray 挂载点）——空态 flex-1 居中、列表 ScrollArea flex-1 +
 * min-h-0 超出滚动；浮层宽 400px 由外壳承载（D8 + 固定高裁决 2026-09-16）。
 *
 * ── 形态 ──
 * - 分桶 tab（凹陷槽范式：外槽 bg-bg-input + active bg-bg-elevated 浮起），计数与行集同源
 *   （tab 数字恒等于列表条数）：三件均两视图「进行中 / 已结束」——[两视图裁决 2026-09-16]
 *   subagent 的「已收起」桶自托盘退役（「已收起」机制已全链路删除，已结束桶判据 =
 *   !isRunningProjection）；
 * - 行：bash = 状态 icon + 命令 + 耗时 + pid/exit + 两段式终止；subagent = 引擎 icon + 状态点/
 *   spinner + agent + slug + turns/tokens/耗时 + task 摘要 + 两段式取消；workflow = 状态点/spinner
 *   + scriptName + slug + 进度条 + N/M + 耗时 + abort（两段式；pause/resume 已随扩展 D-2 移除）；
 * - 空态（D9 可行动空态）：默认桶「进行中」为空 = 一行提示 + 「查看已结束 (N)」显式切桶按钮
 *   （不自动跳转）；其余桶为空仅提示；
 * - 提示条（bash）：损坏（sticky，自愈拍清位）+ 断连（S6 范式，重连边沿自动重拉）。
 *
 * 迁移语义 D14「复制不抽走」：cancel 防误报（原侧栏列表动作 composable）、两段式确认、行渲染
 * 形态均以复制件迁入；旧侧栏组件已随退役单元删除，本文件为唯一实现。
 *
 * 脚本分区：props 契约 / 数据面接线（inject 外壳单例，禁自建）/ 分桶视图状态（ADR-0049
 * per-session 分区）/ 行渲染格式化 / 行内操作（RPC + 两段式确认）/ 行点击归宿矩阵。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertCircle, AlertTriangle, Check, Loader2, Square, WifiOff, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { getState } from '@taiji/core/transport/ws-client'
import { getDrawerControlState, openDrawerTab, openSubagent, openWorkflow } from '@taiji/core/domain/drawer'
import { subagentVirtualId, useSubagentStore } from '@/stores/subagent'
import { useWorkflowStore } from '@/stores/workflow'
import { useToast } from '@/composables/useToast'
import { useSessionScopedState } from '@/composables/useSessionScopedState'
import { TRAY_BUCKETS, useTrayCountsContext } from '@/components/panel/tray/useTrayCounts'
import type { TrayBucketValue } from '@/components/panel/tray/useTrayCounts'
import { isRunningProjection } from '@/lib/subagent-bucket'
import { backgroundTaskBucket, backgroundTaskStatusIcon } from '@/lib/background-task-bucket'
import type { BackgroundTaskEntry, BackgroundTaskIconState, BackgroundTaskStatusKey } from '@/lib/background-task-bucket'
import { resolveEngineIcon } from '@/constants/engine-icons'
import { toErrorMessage } from '@taiji/core'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'
import * as sessionApi from '@taiji/core/transport/api/domains/session'
import type { SubagentRecord, WorkflowRunRecord } from '@taiji/shared'

const props = withDefaults(defineProps<{
  /** 面板类型（built-in 三件之一） */
  kind: 'bash' | 'subagent' | 'workflow'
  /** 焦点 session id（数据分区键；外壳由 Composer 的 sessionId 透传） */
  sessionId: string
  /** pin 态（外壳管理）：行内操作按钮仅 pin 态渲染（D8 防误触） */
  pinned?: boolean
}>(), { pinned: false })

const { t } = useI18n()
const { error: toastError, info: toastInfo } = useToast()
const subagentStore = useSubagentStore()
const workflowStore = useWorkflowStore()

/**
 * 数据面（单例注入）：实例由外壳 ComposerTray 创建并 provide（TRAY_COUNTS_KEY），本面板
 * **不自建实例**——面板随 Popover 开合反复挂载/卸载，自建即每次打开重发首拉 RPC（loadSubagents
 * + loadWorkflows）。计数/行集/错误态/retry 全部消费外壳实例，本面板零拉取。
 */
const tray = useTrayCountsContext()

// ── 分桶视图状态：per-session 分区（ADR-0049：禁实例级状态依赖组件树隔离）──
// 分区随面板实例存活（关闭面板即丢弃 → 每次打开默认「进行中」，D9）；同挂载期内切 session
// 各 session 记各自选择。标量必须对象包装 + reactive 容器（useSessionScopedState 响应式契约）。
interface TrayBucketPartition {
  bucket: TrayBucketValue
}
const bucketPartition = useSessionScopedState<TrayBucketPartition>(
  computed(() => props.sessionId),
  () => reactive<TrayBucketPartition>({ bucket: 'running' }),
)
/** 当前桶：分区遗留的越界值（跨版本持久化 / 扩枚举残留）按默认「进行中」渲染 */
const activeBucket = computed<TrayBucketValue>(() =>
  TRAY_BUCKETS[props.kind].includes(bucketPartition.current.value.bucket)
    ? bucketPartition.current.value.bucket
    : 'running',
)
function setBucket(bucket: TrayBucketValue): void {
  bucketPartition.update((state) => {
    state.bucket = bucket
  })
}

const buckets = computed(() => TRAY_BUCKETS[props.kind])
/** 三件标题 i18n key（面板 aria-label；外壳 icon title 复用同键） */
const titleKey = computed(() => `panel.tray.title.${props.kind}`)

/** 分桶标签 key：bash 属进程域，沿用「运行中」（sidebar.ts 已登记的域差异，见 locale 文件头） */
function bucketLabelKey(bucket: TrayBucketValue): string {
  if (bucket === 'running') {
    return props.kind === 'bash' ? 'panel.tray.bucket.runningProcess' : 'panel.tray.bucket.running'
  }
  return 'panel.tray.bucket.ended'
}
/** 空态提示 key（{name} 插值 = 三件标题） */
const emptyKey = computed(() => {
  if (activeBucket.value === 'running') {
    return props.kind === 'bash' ? 'panel.tray.empty.runningProcess' : 'panel.tray.empty.running'
  }
  return 'panel.tray.empty.ended'
})
/** 桶计数（与行集同源派生） */
function bucketCount(bucket: TrayBucketValue): number {
  return tray.counts.value[props.kind][bucket]
}
/** 空态可行动按钮（D9：仅默认桶为空、且其他桶有内容时渲染；点击显式切桶）。
 *  [两视图裁决 2026-09-16] 可跳桶只剩「已结束」，按钮文案固定 viewEnded（原
 *  jumpLabelKey 泛化分派随第三桶退役删除）。 */
const jumpBuckets = computed<TrayBucketValue[]>(() => {
  if (activeBucket.value !== 'running') return []
  return buckets.value.filter((bucket) => bucket !== 'running' && bucketCount(bucket) > 0)
})

// ── 当前桶的行集（三件各一；面板按 kind 分支渲染）──
const bashRows = computed<BackgroundTaskEntry[]>(() =>
  activeBucket.value === 'ended' ? tray.lists.bash.ended.value : tray.lists.bash.running.value,
)
const subagentRows = computed<SubagentRecord[]>(() =>
  activeBucket.value === 'ended' ? tray.lists.subagent.ended.value : tray.lists.subagent.running.value,
)
const workflowRows = computed<WorkflowRunRecord[]>(() =>
  activeBucket.value === 'ended' ? tray.lists.workflow.ended.value : tray.lists.workflow.running.value,
)
const hasRows = computed(() => {
  if (props.kind === 'bash') return bashRows.value.length > 0
  if (props.kind === 'subagent') return subagentRows.value.length > 0
  return workflowRows.value.length > 0
})

/**
 * 面板加载态：判据 = **在途且当前 sid 该类无任何数据（total === 0）**。外壳挂载即首拉，hover
 * 打开时数据通常已在——只要有缓存数据就直出列表，不闪加载态（U2：§3.1 场景 A「hover 即得列表」）。
 * bash 的 loaded=false 表示「从未成功拉到过一次」（S6 语义），同样只在无数据时占位。
 */
const isKindLoading = computed(() => {
  const counts = tray.counts.value
  if (props.kind === 'bash') return tray.loading.bash.value && counts.bash.total === 0
  if (props.kind === 'subagent') return tray.loading.subagent.value && counts.subagent.total === 0
  return tray.loading.workflow.value && counts.workflow.total === 0
})
/** 错误态（subagent / workflow 首拉失败；bash 的失败信号由提示条承载，见设计 §3.5） */
const kindError = computed(() =>
  props.kind === 'subagent'
    ? tray.errors.subagent.value
    : props.kind === 'workflow' ? tray.errors.workflow.value : null,
)

// ── bash 提示条判据（损坏 = 分区 sticky 位；断连 = 非 connected 且（拉取失败 || 未拉到过））──
const bashCorrupted = computed(() => tray.bashPartition.value.corrupted)
const wsState = getState()
const showDisconnectBanner = computed(() => {
  if (wsState.value === 'connected') return false
  const partition = tray.bashPartition.value
  return partition.fetchFailed || !partition.loaded
})
/** 错误态 retry：按类重拉（D13 retry 腿） */
function onRetry(): void {
  void tray.retry(props.kind)
}

// ── 行渲染格式化（bash：格式/色档全部消费 background-task-bucket SSOT，本层禁二次判定）──
const DOT_TONE_CLASS: Record<BackgroundTaskIconState['tone'], string> = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  info: 'bg-info',
  dim: 'bg-neutral-dim opacity-50',
  success: 'bg-success opacity-90',
  danger: 'bg-danger',
}
/** 状态文字后备 key 映射（statusKey 由 SSOT 派生） */
const STATUS_TEXT_KEYS: Record<BackgroundTaskStatusKey, string> = {
  running: 'panel.tray.status.running',
  killing: 'panel.tray.status.killing',
  orphaned: 'panel.tray.status.orphaned',
  killed: 'panel.tray.status.killed',
  succeeded: 'panel.tray.status.succeeded',
  failed: 'panel.tray.status.failed',
}
const MS_PER_SECOND = 1000
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_MINUTE = 60
const TIME_PAD_WIDTH = 2
const TOKEN_K_THRESHOLD = 1000
const PERCENT_BASE = 100

function iconOf(entry: BackgroundTaskEntry): BackgroundTaskIconState {
  return backgroundTaskStatusIcon(entry)
}
function statusText(entry: BackgroundTaskEntry): string {
  return t(STATUS_TEXT_KEYS[iconOf(entry).statusKey])
}
function isEnded(entry: BackgroundTaskEntry): boolean {
  return backgroundTaskBucket(entry) === 'ended'
}
/** 秒 → mm:ss（≥1h h:mm:ss；bash 行「00:37」形态） */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  const padded = (n: number) => String(n).padStart(TIME_PAD_WIDTH, '0')
  return hours > 0 ? `${hours}:${padded(minutes)}:${padded(seconds)}` : `${padded(minutes)}:${padded(seconds)}`
}
/** 秒 → 可读耗时（≥1h hNm / ≥1m NmNs / Ns；subagent 与 workflow 行共用） */
function formatSeconds(seconds: number): string {
  if (seconds >= SECONDS_PER_HOUR) {
    return `${Math.floor(seconds / SECONDS_PER_HOUR)}h${Math.floor((seconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)}m`
  }
  if (seconds >= SECONDS_PER_MINUTE) {
    return `${Math.floor(seconds / SECONDS_PER_MINUTE)}m${seconds % SECONDS_PER_MINUTE}s`
  }
  return `${seconds}s`
}
function formatTokens(tokens: number): string {
  if (tokens >= TOKEN_K_THRESHOLD) return `${(tokens / TOKEN_K_THRESHOLD).toFixed(1)}k ${t('panel.tray.tokUnit')}`
  return `${tokens} ${t('panel.tray.tokUnit')}`
}
/** workflow 行耗时：startedAt（ISO）→ completedAt 或当下 */
function workflowElapsed(record: WorkflowRunRecord): string {
  const start = new Date(record.startedAt).getTime()
  const end = record.completedAt ? new Date(record.completedAt).getTime() : Date.now()
  return formatSeconds(Math.floor((end - start) / MS_PER_SECOND))
}

// ── running bash 行实时计时（1s tick；仅驱动 elapsedLabel 重算，测试用 fake timers）──
const NOW_TICK_INTERVAL_MS = 1000
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => {
    now.value = Date.now()
  }, NOW_TICK_INTERVAL_MS)
})
onBeforeUnmount(() => {
  if (tickTimer !== null) clearInterval(tickTimer)
})
/** 右侧耗时：运行中 = 实时（now - startedAt）；终态 = durationMs（缺省按 endedAt 推算） */
function elapsedLabel(entry: BackgroundTaskEntry): string {
  const ms = isEnded(entry)
    ? entry.durationMs ?? (entry.endedAt ?? entry.startedAt) - entry.startedAt
    : now.value - entry.startedAt
  return formatDuration(ms)
}

// ── subagent 行状态点（表驱动；承自侧栏任务卡片状态表的复制迁移件——源组件已随退役批次
//    删除，本表为唯一实现）：失败红 / 中断灰先于完成绿兜底，顺序即语义 ──
const INTERRUPTED_STOP_REASONS = new Set(['cancelled', 'interrupted', 'interrupted-by-restart', 'interrupted-by-parent'])
type SubagentDotRule = { match: (record: SubagentRecord) => boolean; cls: string }
const SUBAGENT_DOT_RULES: SubagentDotRule[] = [
  { match: (r) => r.status === 'running' && r.stopReason === 'failed', cls: 'bg-danger' },
  { match: (r) => r.status === 'idle' && r.stopReason === 'failed', cls: 'bg-danger' },
  { match: (r) => r.status === 'idle' && r.stopReason !== undefined && INTERRUPTED_STOP_REASONS.has(r.stopReason), cls: 'bg-neutral-dim opacity-50' },
  { match: (r) => r.status === 'idle', cls: 'bg-success' },
]
/** 执行态判据 = SSOT 谓词（isRunningProjection），与计数/徽标同源不漂移 */
const isRunningSubagent = isRunningProjection
function subagentDotClass(record: SubagentRecord): string {
  const hit = SUBAGENT_DOT_RULES.find((entry) => entry.match(record))
  return hit ? hit.cls : 'bg-accent'
}

// ── workflow 行色档（状态点与进度条同源；承自侧栏 workflow 列表的复制迁移件）──
function workflowToneClass(record: WorkflowRunRecord): string {
  if (record.status === 'done') return record.reason === 'completed' ? 'bg-success' : 'bg-danger'
  return 'bg-accent'
}
function completedAgentCount(record: WorkflowRunRecord): number {
  return record.agentCalls.filter((call) => call.status === 'completed' || call.status === 'failed').length
}
function workflowPercent(record: WorkflowRunRecord): number {
  if (record.agentCalls.length === 0) return 0
  return Math.round((completedAgentCount(record) / record.agentCalls.length) * PERCENT_BASE)
}

// ── 行点击归宿矩阵（D2：subagent/bash 对齐现状；workflow 行改收口 drawer workflow tab）──
function openSubagentRow(record: SubagentRecord): void {
  openSubagent({ virtualId: subagentVirtualId(props.sessionId, record.subagentId), enteredFrom: 'chat' })
}
function openBashTask(entry: BackgroundTaskEntry): void {
  getDrawerControlState().selectedBackgroundTaskId = entry.taskId
  openDrawerTab('bashTask')
}
/** workflow 行传 runId（drawer WorkflowTab 先按 runId 精确匹配，后回退 scriptName 取最新） */
function openWorkflowRow(record: WorkflowRunRecord): void {
  openWorkflow(record.runId)
}

// ── 行内操作 1：bash 两段式终止（首击确认态，再击发令；仅 running 行、仅 pin 态渲染）──
const confirmingKillId = ref<string | null>(null)
function onKillClick(entry: BackgroundTaskEntry): void {
  if (confirmingKillId.value !== entry.taskId) {
    confirmingKillId.value = entry.taskId
    return
  }
  confirmingKillId.value = null
  // fire-and-forget：结果经 killing 广播翻转行状态，失败条目停留原状态（下次广播/拉取自愈）
  void backgroundTaskApi.kill(props.sessionId, entry.taskId).catch((err: unknown) => {
    console.debug('[tray] background task kill failed', entry.taskId, err)
  })
}

// ── 行内操作 2：subagent 两段式取消 + 迟到收口防误报（复制件，自原侧栏列表动作 composable）──
const cancellingSubagentId = ref<string | null>(null)
function onCancelClick(record: SubagentRecord): void {
  if (cancellingSubagentId.value !== record.subagentId) {
    cancellingSubagentId.value = record.subagentId
    return
  }
  cancellingSubagentId.value = null
  void cancelSubagent(record)
}
/**
 * 第二击时任务可能已收口（迟到 isStreaming=false 窗口）——此时**不发** cancel RPC
 * （会被 runtime 拒绝并误报「取消失败」），toast「任务已结束」给出确定反馈。
 */
async function cancelSubagent(record: SubagentRecord): Promise<void> {
  if (!subagentStore.isStreamingSubagent(props.sessionId, record.subagentId)) {
    toastInfo(t('panel.tray.alreadyEnded'))
    return
  }
  try {
    await subagentStore.cancelSubagent(props.sessionId, record.subagentId)
  } catch (e) {
    toastError(t('panel.tray.cancelFailed', { msg: toErrorMessage(e) }))
  }
}

// ── 行内操作 3：workflow abort（两段式；pause/resume 随扩展 D-2 一次性生命周期移除）──
const abortingRunId = ref<string | null>(null)
function onAbortClick(runId: string): void {
  if (abortingRunId.value === runId) {
    abortingRunId.value = null
    void runWorkflowAction('abort', runId)
    return
  }
  abortingRunId.value = runId
}
/** 调 runtime RPC + 刷新列表（不做乐观写——workflow 状态由 runtime 推送权威） */
async function runWorkflowAction(action: 'abort', runId: string): Promise<void> {
  try {
    await sessionApi.workflowAction(props.sessionId, action, runId)
    void workflowStore.loadWorkflows(props.sessionId)
  } catch (e) {
    toastError(t('panel.tray.workflowOpFailed', { msg: toErrorMessage(e) }))
  }
}
</script>
