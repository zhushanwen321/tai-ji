<!--
  BackgroundTaskDetailPanel —— drawer bashTask tab：后台命令详情（G2/G3 交互闭环）。

  设计：docs/architecture/background-task-sidebar-view.md §3.1 终态（drawer 形态与失败路径）
  + §3.3 D5（drawer 接线第 8 tab）/ D7（输出 = 按需 tail RPC + running 2s 跟随）/ D6（kill 回执
  分支④⑤ toast）。u-drawer 单元。

  数据面（不自持 listener，AGENTS 规则 2）：
  - 控制态：selectedBackgroundTaskId 经 core getDrawerControlState() 读 per-session 分区
    （undefined=未选中 → PanelContainer 不注入本组件，DrawerPanel 空态 fallback 承载）；
  - 任务条目：useBackgroundTasks 分区只读（分区状态根由 u-renderer-store 持有；本组件不拉
    list、不挂广播——广播刷新由 store 编排）；条目从分区消失（registry LRU 淘汰/损坏自愈清表）
    时用最后已知快照兜底渲染元信息（避免 drawer 内容空白）；输出跟随仅以分区条目为据——
    条目消失即停轮询（D6 #13：快照冻结只兜元信息渲染，对已消失条目继续发 output RPC 属
    无效空转）；
  - 输出：backgroundTask.output 按需 tail（D7：打开/切任务拉一次；running 且 drawer 打开时
    每 2s 重拉。drawer 关闭 = DrawerPanel aside v-if 收起 = 本组件卸载，与组件卸载同一停止
    机制；任务终态由 store 分区条目 state 驱动跟随启停）；truncated=true 时输出区顶部提示
    「仅显示尾部」（D5 协议字段消费）+ 元信息区展示 outputFile 全量输出文件路径（可复制）；
  - 终止：两段式（第一次点击进入确认态，再点才发 backgroundTask.kill，D10④ drawer 内同款）；
    仅 running 渲染按钮（killing 已发令不重复发；终态无按钮，S6）。回执 already-exited /
    identity-unverifiable（分支④）/ registry-write-failed（分支⑤）→ toast 文案经 i18n key
    （zh/en 文案由 u-i18n-docs 单元落地）。
-->
<template>
  <div v-if="displayEntry" class="flex h-full min-h-0 flex-col" data-testid="bash-task-detail">
    <!-- 命令全文（可复制，§3.1 终态「命令全文（可复制）」） -->
    <div class="flex shrink-0 items-start gap-1.5 border-b border-hairline px-3 py-2">
      <SquareTerminal class="mt-0.5 size-3.5 shrink-0 text-neutral-dim" />
      <code
        class="min-w-0 flex-1 break-all font-mono text-xs text-neutral-fg"
        data-testid="bash-task-command"
      >{{ displayEntry.command }}</code>
      <Button
        variant="ghost"
        size="icon"
        class="size-6 shrink-0 text-neutral-dim hover:text-neutral-fg"
        :title="copied === 'command' ? t('panel.sideDrawer.bashTaskCopied') : t('panel.sideDrawer.bashTaskCopyCommand')"
        data-testid="bash-task-copy"
        @click="copyCommand"
      >
        <Check v-if="copied === 'command'" class="size-3" />
        <Copy v-else class="size-3" />
      </Button>
    </div>

    <!-- 元信息行：taskId · pid · 开始 · 已运行/时长 · exit · reason（色点与列表 icon 同源 SSOT） -->
    <div
      class="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-1.5 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
      data-testid="bash-task-meta"
    >
      <span
        class="size-1.5 shrink-0 rounded-full"
        :class="statusDotClass"
        data-testid="bash-task-status-dot"
      />
      <span class="min-w-0 truncate" data-testid="bash-task-meta-taskid">{{ displayEntry.taskId }}</span>
      <span class="shrink-0" data-testid="bash-task-meta-pid">pid {{ displayEntry.pid }}</span>
      <span class="shrink-0" data-testid="bash-task-meta-started">
        {{ t('panel.sideDrawer.bashTaskStartedAt', { time: formatClock(displayEntry.startedAt) }) }}
      </span>
      <span class="shrink-0" data-testid="bash-task-meta-duration">{{ durationText }}</span>
      <span
        v-if="displayEntry.exitCode !== undefined"
        class="shrink-0"
        data-testid="bash-task-meta-exit"
      >{{ t('panel.sideDrawer.bashTaskExitCode', { code: displayEntry.exitCode ?? '—' }) }}</span>
      <span v-if="reasonText" class="shrink-0" data-testid="bash-task-meta-reason">{{ reasonText }}</span>
    </div>

    <!-- 全量输出文件路径（D5：截断时的全量输出口；条目契约 outputFile，可复制） -->
    <div
      v-if="displayEntry?.outputFile"
      class="flex shrink-0 items-center gap-1.5 border-b border-hairline px-3 py-1 font-mono text-[length:var(--text-3xs)] text-neutral-dim"
      data-testid="bash-task-output-file-row"
    >
      <FileText class="size-3 shrink-0" />
      <span
        class="min-w-0 flex-1 truncate"
        :title="displayEntry.outputFile"
        data-testid="bash-task-output-file"
      >{{ displayEntry.outputFile }}</span>
      <Button
        variant="ghost"
        size="icon"
        class="size-5 shrink-0 text-neutral-dim hover:text-neutral-fg"
        :title="copied === 'outputFile' ? t('panel.sideDrawer.bashTaskCopied') : t('panel.sideDrawer.bashTaskCopyOutputFile')"
        data-testid="bash-task-copy-output-file"
        @click="copyOutputFile"
      >
        <Check v-if="copied === 'outputFile'" class="size-3" />
        <Copy v-else class="size-3" />
      </Button>
    </div>

    <!-- 输出尾部（等宽滚动块，running 时 2s 跟随；lost = 输出文件已清理/丢失，§3.1 失败路径） -->
    <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
      <div
        v-if="outputLost"
        class="text-[length:var(--text-2xs)] text-neutral-dim"
        data-testid="bash-task-output-unavailable"
      >{{ t('panel.sideDrawer.bashTaskOutputUnavailable') }}</div>
      <template v-else>
        <!-- D5：协议 truncated 字段消费——超出字节窗口（默认 32KB）时提示仅显示尾部 -->
        <div
          v-if="outputTruncated"
          class="pb-1 text-[length:var(--text-2xs)] text-neutral-dim"
          data-testid="bash-task-output-truncated"
        >{{ t('panel.sideDrawer.bashTaskOutputTruncated') }}</div>
        <pre
          v-if="outputText"
          class="whitespace-pre-wrap break-all font-mono text-[length:var(--text-3xs)] leading-4 text-neutral-mid"
          data-testid="bash-task-output"
        >{{ outputText }}</pre>
        <div
          v-else-if="outputLoaded"
          class="text-[length:var(--text-2xs)] text-neutral-dim"
          data-testid="bash-task-output-empty"
        >{{ t('panel.sideDrawer.bashTaskOutputEmpty') }}</div>
      </template>
    </div>

    <!-- 两段式终止（仅 running；killing 已发令不重复发，终态无按钮——S6） -->
    <div
      v-if="canKill"
      class="flex shrink-0 items-center justify-end border-t border-hairline px-3 py-2"
    >
      <Button
        variant="ghost"
        size="dense"
        class="h-6 px-2 text-[length:var(--text-2xs)]"
        :class="killArmed ? 'text-danger' : 'text-neutral-mid'"
        :disabled="killing"
        :data-armed="killArmed ? 'true' : undefined"
        data-testid="bash-task-kill"
        @click="onKillClick"
      >
        <Check v-if="killArmed" class="size-3" />
        <X v-else class="size-3" />
        {{ killArmed ? t('panel.sideDrawer.bashTaskKillConfirm') : t('panel.sideDrawer.bashTaskKill') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, FileText, SquareTerminal, X } from '@lucide/vue'
import { Button } from '@xyz-agent/ui'
import { isActiveBackgroundTaskState } from '@xyz-agent/extension-protocol'
import { getDrawerControlState } from '@xyz-agent/core/domain/drawer'
import { usePanelStore } from '@/stores/panel'
import { useBackgroundTasks } from '@/composables/features/sidebar/useBackgroundTasks'
import { backgroundTaskStatusIcon } from '@/lib/background-task-bucket'
import type { BackgroundTaskEntry } from '@/lib/background-task-bucket'
import * as backgroundTaskApi from '@xyz-agent/core/transport/api/domains/background-task'
import { useToast } from '@/composables/useToast'
import { useCopy } from '@/composables/panel/useCopy'

const FOLLOW_INTERVAL_MS = 2000

const { t } = useI18n()
const toast = useToast()
const { copied, copy } = useCopy()
const panelStore = usePanelStore()

/** 焦点 session（split mode per-pane 场景 drawer 单实例跟随 active panel，同 SubagentTab） */
const focusedSid = computed(() => panelStore.focusedSessionId)

// bashTask tab 选中任务（core per-session 分区直读；写入方 = 列表 item 点击，D5④）
const selectedTaskId = computed(() => getDrawerControlState().selectedBackgroundTaskId)

/** 任务分区只读（状态根由 useBackgroundTasks 持有；本组件零 listener） */
const { current: partition } = useBackgroundTasks(focusedSid)

const entry = computed<BackgroundTaskEntry | null>(() => {
  const tid = selectedTaskId.value
  if (!tid) return null
  return partition.value.tasks.find((task) => task.taskId === tid) ?? null
})

/** 条目从分区消失（registry LRU 淘汰 / 损坏自愈清表）时的最后已知快照（防 drawer 内容空白） */
const entrySnapshot = ref<BackgroundTaskEntry | null>(null)
watch(entry, (value) => {
  if (value) entrySnapshot.value = value
})
const displayEntry = computed<BackgroundTaskEntry | null>(() => entry.value ?? entrySnapshot.value)

// ── 输出尾部（D7）──

const outputText = ref('')
const outputLost = ref(false)
const outputLoaded = ref(false)
/** D5：回执 truncated 字段（超出字节窗口，默认 32KB）——输出区顶部条件提示 */
const outputTruncated = ref(false)
/** running 计时基准（跟随 interval 节拍顺带刷新，零额外 timer；终态用 durationMs 固定值） */
const now = ref(Date.now())

/** 迟到响应守卫：切任务后旧任务的 output reply 不得写进新任务视图 */
let fetchSeq = 0

async function fetchOutput(): Promise<void> {
  const tid = selectedTaskId.value
  if (!tid) return
  const sid = displayEntry.value?.sessionId ?? focusedSid.value
  if (!sid) return
  const seq = ++fetchSeq
  try {
    const reply = await backgroundTaskApi.output(sid, tid)
    if (seq !== fetchSeq) return
    outputLost.value = reply.lost
    outputText.value = reply.text
    outputTruncated.value = reply.truncated
    outputLoaded.value = true
  } catch (err) {
    // 拉取失败保留上次内容不降级（断连窗口 C6 由拉取兜底自愈）；debug 级防刷屏
    console.debug('[background-task-detail] output fetch failed, keep last', tid, err)
  }
}

let followTimer: ReturnType<typeof setInterval> | null = null

// ── 两段式终止状态（声明先于下方 immediate watch 回调的复位引用）──

const killArmed = ref(false)
const killing = ref(false)

/** 仅 running 可终止（killing 已发令不重复发；终态无按钮） */
const canKill = computed(() => displayEntry.value?.state === 'running')

function startFollow(): void {
  if (followTimer !== null) return
  followTimer = setInterval(() => {
    now.value = Date.now()
    void fetchOutput()
  }, FOLLOW_INTERVAL_MS)
}

function stopFollow(): void {
  if (followTimer === null) return
  clearInterval(followTimer)
  followTimer = null
}

/** 跟随条件 = 分区条目活跃（running/killing）；终态即停（D7 停止条件）；条目从分区消失
 * （registry LRU 淘汰 / 损坏自愈清表）同样停——快照冻结只兜元信息渲染，对已消失条目
 * 继续发 output RPC 属无效空转（D6 #13，BG-6） */
const following = computed(() => {
  const value = entry.value
  return value !== null && isActiveBackgroundTaskState(value.state)
})

watch(following, (on) => {
  if (on) startFollow()
  else stopFollow()
}, { immediate: true })

onBeforeUnmount(stopFollow)

// 切任务：重置全部视图状态 + 首拉（immediate 覆盖挂载首拉，D7「打开/切任务时拉一次」）
watch(selectedTaskId, () => {
  fetchSeq += 1
  outputText.value = ''
  outputLost.value = false
  outputLoaded.value = false
  outputTruncated.value = false
  entrySnapshot.value = null
  killArmed.value = false
  killing.value = false
  now.value = Date.now()
  void fetchOutput()
}, { immediate: true })

// ── 元信息派生（状态色点与列表 icon 同源 bucket SSOT，D10① 禁二次判定）──

/** tone → 色点 class（字面量映射：Tailwind JIT 静态扫描，禁模板字符串拼接 class） */
const TONE_DOT_CLASS = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  info: 'bg-info',
  dim: 'bg-neutral-dim',
  success: 'bg-success',
  danger: 'bg-danger',
} as const

const statusDotClass = computed(() => {
  const value = displayEntry.value
  if (!value) return ''
  return TONE_DOT_CLASS[backgroundTaskStatusIcon(value).tone]
})

const REASON_KEYS = {
  natural: 'panel.sideDrawer.bashTaskReasonNatural',
  timeout: 'panel.sideDrawer.bashTaskReasonTimeout',
  killed: 'panel.sideDrawer.bashTaskReasonKilled',
  'process-exit': 'panel.sideDrawer.bashTaskReasonProcessExit',
  orphaned: 'panel.sideDrawer.bashTaskReasonOrphaned',
} as const

const durationText = computed(() => {
  const value = displayEntry.value
  if (!value) return ''
  if (isActiveBackgroundTaskState(value.state)) {
    return t('panel.sideDrawer.bashTaskRunningFor', { duration: formatDuration(now.value - value.startedAt) })
  }
  const ms = value.durationMs ?? (value.endedAt !== undefined ? value.endedAt - value.startedAt : 0)
  return t('panel.sideDrawer.bashTaskDuration', { duration: formatDuration(ms) })
})

/** reason 文案（仅终态；orphaned 契约缺省 reason，按状态单独承载） */
const reasonText = computed(() => {
  const value = displayEntry.value
  if (!value) return ''
  if (value.state === 'orphaned') return t(REASON_KEYS.orphaned)
  if (value.state !== 'exited' || value.reason === undefined) return ''
  return t(REASON_KEYS[value.reason])
})

/** 时分秒补零宽度（HH:MM:SS / mm:ss 定宽） */
const PAD_WIDTH = 2
/** 时间换算基数（ms→s→min→hour） */
const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

/** epoch ms → HH:MM:SS（设计终态样例「开始 14:32:05」） */
function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(PAD_WIDTH, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** ms → mm:ss / hh:mm:ss（设计终态样例「已运行 00:37」） */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const pad = (n: number): string => String(n).padStart(PAD_WIDTH, '0')
  const h = Math.floor(total / SECONDS_PER_HOUR)
  const m = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const s = total % SECONDS_PER_MINUTE
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

// ── 两段式终止（D10④ drawer 内同款：第一次点击确认态，再点发 kill）──

function copyCommand(): void {
  const value = displayEntry.value
  if (value) copy(value.command, 'command')
}

/** D5：复制全量输出文件路径（截断提示的全量输出口） */
function copyOutputFile(): void {
  const value = displayEntry.value
  if (value?.outputFile) copy(value.outputFile, 'outputFile')
}

async function onKillClick(): Promise<void> {
  const value = displayEntry.value
  if (!value || killing.value) return
  if (!killArmed.value) {
    killArmed.value = true
    return
  }
  killing.value = true
  try {
    const reply = await backgroundTaskApi.kill(value.sessionId, value.taskId)
    // D6 分支④⑤ toast（文案 key 由 u-i18n-docs 落地）；killed = 发令成功，列表经 killing
    // 即时广播翻转，设计未定义成功文案，不造词
    if (reply.reason === 'already-exited') {
      toast.info(t('panel.sideDrawer.bashTaskAlreadyExited'))
    } else if (reply.reason === 'identity-unverifiable') {
      toast.warning(t('panel.sideDrawer.bashTaskIdentityUnverifiable'))
    } else if (reply.reason === 'registry-write-failed') {
      toast.warning(t('panel.sideDrawer.bashTaskWriteFailed'))
    }
  } catch (err) {
    // 传输层失败（WS 断开/超时，非 D6 矩阵回执）：设计未定义该分支文案，不 toast 造词；
    // 连接态由全局连接指示承载，复位两段式等用户重试
    console.debug('[background-task-detail] kill rpc failed (transport)', value.taskId, err)
  } finally {
    killing.value = false
    killArmed.value = false
  }
}
</script>
