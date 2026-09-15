<template>
  <!--
    「后台命令」L2 视图（background-task-sidebar-view.md §3.1 终态 + D10，u-renderer-list）。
    宿主：Sidebar plugins tab → PluginViewContainer（NATIVE_VIEWS 路由，D4②）。
    数据：useBackgroundTasks（per-session 分区状态根，拉取 + 广播双腿）+
    useBackgroundTaskBucketFilter（三桶筛选 per-session 分区）；分桶/计数/排序/icon
    全部消费 lib/background-task-bucket SSOT，本组件不重复实现任何判定（D10① 纪律）。

    形态：
    - 全量空态（loaded 且 0 条）不渲染筛选条（S6/D10③ 空态三分）；
    - 有任务 → 凹陷槽三桶筛选（运行中/已结束/全部 + 计数，默认「运行中」，D10②③）；
    - item 两行式 SessionItem 同构（D10⑤）：7px 状态 icon + 命令 + 耗时 / mono 第二行
      pid · exit，状态徽标不进列表（icon 即状态，文字后备 aria-label + title 双轨）；
    - 运行中行行内两段式终止（首击进确认态、再击发令，仅 running 行，D10④）；
      点击行开 drawer bashTask tab（D5④）。
  -->
  <div data-testid="background-task-list" class="flex h-full min-h-0 flex-col gap-1 p-1">
    <!-- 损坏错误条（S7）：sticky 判定（曾收到 corrupted===true 拍；损坏后一拍的 corrupted:false
         空表广播不清位防闪断），由自愈拍（tasks 非空）清位后消失。与全量空态并存（设计 §3.1：
         列表该拍显示空态 + 错误条）。 -->
    <div
      v-if="partition.corrupted"
      data-testid="bg-task-corrupt-banner"
      class="flex shrink-0 items-center gap-1.5 rounded-sm bg-warn-soft px-2 py-1 text-[length:var(--text-2xs)] text-warn"
    >
      <AlertTriangle class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1">{{ t(corruptBannerKey) }}</span>
    </div>
    <!-- 断连提示条（S6）：断连 &&（拉取失败 || 未拉到过数据）时的降级提示；WS 重连后由
         重连恢复腿自动重拉（connected 边沿），数据/连接态恢复即消失。 -->
    <div
      v-if="showDisconnectBanner"
      data-testid="bg-task-disconnect-banner"
      class="flex shrink-0 items-center gap-1.5 rounded-sm bg-bg-input px-2 py-1 text-[length:var(--text-2xs)] text-neutral-mid"
    >
      <WifiOff class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1">{{ t(disconnectBannerKey) }}</span>
    </div>

    <!-- 全量空态：0 计数槽是纯噪音，不渲染筛选条（D10③） -->
    <div
      v-if="isGloballyEmpty"
      data-testid="bg-task-empty"
      class="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center"
    >
      <SquareTerminal class="size-7 text-neutral-dim opacity-40" />
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t(emptyAllTitleKey) }}</p>
      <p class="text-[length:var(--text-3xs)] text-neutral-dim opacity-40">{{ t(emptyAllHintKey) }}</p>
    </div>

    <template v-else-if="hasTasks">
      <!-- 内联 FilterBar：凹陷槽三桶（bg-bg-input 底 + active bg-bg-elevated 浮起，h-6，
           L2TabBar/SegmentedTab 同源参数，D10②）；计数预告同源 counts -->
      <div data-testid="bg-task-filterbar" class="flex gap-[2px] rounded-[6px] bg-bg-input p-[3px]">
        <Button
          v-for="option in FILTER_OPTIONS"
          :key="option.value"
          variant="ghost"
          :data-testid="`bg-task-filter-${option.value}`"
          :data-active="filter === option.value ? 'true' : 'false'"
          class="h-6 gap-1 rounded-[6px] px-2 text-[length:var(--text-2xs)] font-normal text-neutral-dim hover:bg-surface-hover hover:text-neutral-fg"
          :class="filter === option.value ? 'bg-bg-elevated text-neutral-fg hover:bg-bg-elevated' : ''"
          @click="setFilter(option.value)"
        >
          <span class="leading-none">{{ t(option.labelKey) }}</span>
          <span class="font-mono text-[length:var(--text-3xs)] leading-none text-neutral-mid">{{ counts[option.value] }}</span>
        </Button>
      </div>

      <ScrollArea class="min-h-0 flex-1">
        <div class="flex flex-col px-1.5">
          <!-- 运行中空桶自适应：「没有运行中的后台命令」+ 查看全部 (N) 一键跳转（D10③） -->
          <div
            v-if="visibleTasks.length === 0 && filter === 'active'"
            data-testid="bg-task-bucket-empty"
            class="flex flex-col items-center justify-center gap-2 py-8 text-center"
          >
            <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t(emptyActiveKey) }}</p>
            <Button
              variant="ghost"
              data-testid="bg-task-view-all"
              class="h-6 text-[length:var(--text-2xs)] text-accent"
              @click="setFilter('all')"
            >{{ t(viewAllKey, { count: counts.all }) }}</Button>
          </div>
          <!-- 已结束空桶：仅文案（D10③） -->
          <div
            v-else-if="visibleTasks.length === 0 && filter === 'ended'"
            data-testid="bg-task-bucket-empty-ended"
            class="flex flex-col items-center justify-center py-8 text-center"
          >
            <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">{{ t(emptyEndedKey) }}</p>
          </div>

          <!-- 任务列表（排序由 filterBackgroundTasks SSOT 内置，本层不重复排序，偏差登记 #12） -->
          <template v-else>
            <div
              v-for="(entry, index) in visibleTasks"
              :key="entry.taskId"
              class="group/item relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
              data-testid="bg-task-item"
              :aria-label="`${statusText(entry)}: ${entry.command}`"
              @click="onOpenTask(entry)"
              @mouseleave="confirmingKillId = null"
            >
              <!-- 「全部」桶 active/ended 段分隔线（D10③：运行中置顶 + 分隔线 + 历史倒序） -->
              <div
                v-if="isGroupBoundary(index)"
                class="-mx-1 my-1 h-px w-auto border-t border-border-strong"
                data-testid="bg-task-group-divider"
              />
              <!-- 第一行：7px 状态 icon（色档 SSOT backgroundTaskStatusIcon，D10⑤）+ 命令 + 耗时 -->
              <div class="mt-[6px] size-[7px] shrink-0" data-testid="bg-task-icon" :title="statusText(entry)">
                <span
                  v-if="iconOf(entry).shape === 'spinner'"
                  class="block size-[7px] animate-spin rounded-full border-[1.5px] border-accent border-t-transparent"
                />
                <span v-else class="block size-[7px] rounded-full" :class="DOT_TONE_CLASS[iconOf(entry).tone]" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-[1.35] text-neutral-fg">
                  <span class="min-w-0 flex-1 truncate">{{ entry.command }}</span>
                  <span class="shrink-0 font-mono text-[length:var(--text-3xs)] leading-[1.35] text-neutral-dim">{{ elapsedLabel(entry) }}</span>
                </div>
                <!-- 第二行（mono 小字 dim）：pid · exit（C=null 显 exit —，D10⑤）+ hover 两段式终止钮 -->
                <div
                  class="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
                  data-testid="bg-task-meta"
                >
                  <span class="min-w-0 flex-1 truncate">
                    {{ t(pidLabelKey) }} {{ entry.pid }}<template v-if="isEnded(entry)"> · {{ t(exitLabelKey) }} {{ entry.exitCode ?? '—' }}</template>
                  </span>
                  <!-- 行内两段式终止（D10④）：仅 running 行（killing 已发令不重复发）；
                       hover 显现，确认态常显红底对勾 -->
                  <Button
                    v-if="entry.state === 'running'"
                    variant="ghost"
                    size="icon"
                    :data-testid="confirmingKillId === entry.taskId ? 'bg-task-kill-confirm' : 'bg-task-kill'"
                    :data-confirming="confirmingKillId === entry.taskId ? 'true' : 'false'"
                    class="size-5 shrink-0 rounded-sm"
                    :class="confirmingKillId === entry.taskId
                      ? 'border border-danger bg-danger text-neutral-fg opacity-100'
                      : 'text-neutral-dim opacity-0 hover:text-danger group-focus-within/item:opacity-100 group-hover/item:opacity-100'"
                    :title="confirmingKillId === entry.taskId ? t(killConfirmKey) : t(killKey)"
                    @click.stop="onKillClick(entry)"
                  >
                    <Check v-if="confirmingKillId === entry.taskId" class="size-3" />
                    <X v-else class="size-3" />
                  </Button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </ScrollArea>
    </template>
    <!-- 未 loaded（list 在途/失败）：空白容器，不渲染筛选条与空态（首次拉取毫秒级瞬态） -->
  </div>
</template>

<script setup lang="ts">
/**
 * BackgroundTaskListView —— 「后台命令」L2 原生视图（u-renderer-list）。
 *
 * 组件为视图容器（自带数据源）：props.sessionId 是唯一外部输入（PluginViewContainer
 * NATIVE_VIEWS 路由透传焦点 session，D4②）；数据消费 useBackgroundTasks 分区状态根
 * （挂载即拉取 + 广播增量，组件不自行订阅 events——AGENTS 规则 2 由 store 层收敛）。
 * 交互出口两个：行点击 → core drawer 公开 API（写 selectedBackgroundTaskId + 开
 * bashTask tab，D5④）；running 行两段式终止 → backgroundTask.kill RPC（D10④，
 * 结果经 killing 广播 ≤2s 翻转行状态）。
 *
 * i18n：只引用 key 不写文案（文案由 u-i18n-docs 落地）；key 字面量集中在
 * KEY_* 常量与 STATUS_TEXT_KEYS 映射表，禁止模板内拼接 key。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { AlertTriangle, Check, SquareTerminal, WifiOff, X } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getState } from '@taiji/core/transport/ws-client'
import { useBackgroundTasks } from '@/composables/features/sidebar/useBackgroundTasks'
import { useBackgroundTaskBucketFilter } from '@/composables/features/sidebar/useBackgroundTaskBucketFilter'
import {
  backgroundTaskBucket,
  backgroundTaskStatusIcon,
  countBackgroundTasks,
  filterBackgroundTasks,
} from '@/lib/background-task-bucket'
import type {
  BackgroundTaskEntry,
  BackgroundTaskFilterValue,
  BackgroundTaskIconState,
  BackgroundTaskStatusKey,
} from '@/lib/background-task-bucket'
import { getDrawerControlState, openDrawerTab } from '@taiji/core/domain/drawer'
import * as backgroundTaskApi from '@taiji/core/transport/api/domains/background-task'

const props = defineProps<{
  /** 焦点 session id（NATIVE_VIEWS 路由透传，数据分区键） */
  sessionId: string
}>()

const { t } = useI18n()

// ── i18n key 字面量（文案由 u-i18n-docs 单元落地，本组件只引用）──
const emptyAllTitleKey = 'sidebar.backgroundTaskList.emptyAllTitle'
const emptyAllHintKey = 'sidebar.backgroundTaskList.emptyAllHint'
const emptyActiveKey = 'sidebar.backgroundTaskList.emptyActive'
const emptyEndedKey = 'sidebar.backgroundTaskList.emptyEnded'
const viewAllKey = 'sidebar.backgroundTaskList.viewAll'
const killKey = 'sidebar.backgroundTaskList.kill'
const killConfirmKey = 'sidebar.backgroundTaskList.killConfirm'
const pidLabelKey = 'sidebar.backgroundTaskList.pidLabel'
const exitLabelKey = 'sidebar.backgroundTaskList.exitLabel'
const corruptBannerKey = 'sidebar.backgroundTaskList.corruptBanner'
const disconnectBannerKey = 'sidebar.backgroundTaskList.disconnectBanner'

/** 三桶筛选选项（label key 集中登记；顺序 = 渲染顺序：运行中/已结束/全部，D10）。 */
const FILTER_OPTIONS: Array<{ value: BackgroundTaskFilterValue; labelKey: string }> = [
  { value: 'active', labelKey: 'sidebar.backgroundTaskList.filter.active' },
  { value: 'ended', labelKey: 'sidebar.backgroundTaskList.filter.ended' },
  { value: 'all', labelKey: 'sidebar.backgroundTaskList.filter.all' },
]

/** icon 文字后备 key 映射（statusKey 由分桶 SSOT 派生，消费层禁二次判定，D10①⑤）。 */
const STATUS_TEXT_KEYS: Record<BackgroundTaskStatusKey, string> = {
  running: 'sidebar.backgroundTaskList.status.running',
  killing: 'sidebar.backgroundTaskList.status.killing',
  orphaned: 'sidebar.backgroundTaskList.status.orphaned',
  killed: 'sidebar.backgroundTaskList.status.killed',
  succeeded: 'sidebar.backgroundTaskList.status.succeeded',
  failed: 'sidebar.backgroundTaskList.status.failed',
}

/** 圆点色档 class 映射（语义 tokens；dim=neutral-dim 50%、success 90%，SessionItem 同款）。 */
const DOT_TONE_CLASS: Record<BackgroundTaskIconState['tone'], string> = {
  accent: 'bg-accent',
  warn: 'bg-warn',
  info: 'bg-info',
  dim: 'bg-neutral-dim opacity-50',
  success: 'bg-success opacity-90',
  danger: 'bg-danger',
}

// ── 数据面：per-session 分区状态根 + 三桶筛选分区（组件纯读筛选，禁 watch 清空）──
const sidRef = computed<string | null>(() => props.sessionId)
const { current: partition } = useBackgroundTasks(sidRef)
const { current: filter, setFilter } = useBackgroundTaskBucketFilter(sidRef)

/** 三桶计数（FilterBar 计数预告 + 空桶自适应判定，同源 SSOT）。 */
const counts = computed(() => countBackgroundTasks(partition.value.tasks))
/** 当前桶可见条目（过滤 + 排序均由 SSOT 内置，本层不做二次加工）。 */
const visibleTasks = computed(() => filterBackgroundTasks(partition.value.tasks, filter.value))
/** 全量空态（成功拉到过一次且 0 条）——loaded 区分「从未拉取」与「拉到空表」。 */
const isGloballyEmpty = computed(() => partition.value.loaded && partition.value.tasks.length === 0)
const hasTasks = computed(() => partition.value.tasks.length > 0)

// ── 断连提示条（S6）：断连 &&（拉取失败 || 未拉到过数据）。已 loaded 且无失败时断连仅
//    显示旧缓存（缓存可用，无需告警）；重连由 store 重连恢复腿自动重拉，恢复即消失。 ──
const wsState = getState()
const showDisconnectBanner = computed(() => {
  if (wsState.value === 'connected') return false
  return partition.value.fetchFailed || !partition.value.loaded
})

// ── running 行实时计时（1s tick；仅驱动 elapsedLabel 重算，测试用 fake timers）──
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

// ── 耗时换算常量（no-magic-numbers 命名锚）──
const MS_PER_SECOND = 1000
const SECONDS_PER_HOUR = 3600
const SECONDS_PER_MINUTE = 60
const TIME_PAD_WIDTH = 2

/** 秒 → mm:ss（≥1h h:mm:ss）；设计 §3.1 计时形态「00:37」。 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  const padded = (n: number) => String(n).padStart(TIME_PAD_WIDTH, '0')
  return hours > 0 ? `${hours}:${padded(minutes)}:${padded(seconds)}` : `${padded(minutes)}:${padded(seconds)}`
}

function isEnded(entry: BackgroundTaskEntry): boolean {
  return backgroundTaskBucket(entry) === 'ended'
}

function iconOf(entry: BackgroundTaskEntry): BackgroundTaskIconState {
  return backgroundTaskStatusIcon(entry)
}

/** icon 文字后备（aria-label + title 双轨，D10⑤）。 */
function statusText(entry: BackgroundTaskEntry): string {
  return t(STATUS_TEXT_KEYS[iconOf(entry).statusKey])
}

/** 右侧耗时：运行中 = 实时（now - startedAt）；终态 = durationMs（缺省 endedAt 兜底推算）。 */
function elapsedLabel(entry: BackgroundTaskEntry): string {
  const ms = isEnded(entry)
    ? entry.durationMs ?? (entry.endedAt ?? entry.startedAt) - entry.startedAt
    : now.value - entry.startedAt
  return formatDuration(ms)
}

/** 「全部」桶 active/ended 段边界（渲染分隔线，D10③）。 */
function isGroupBoundary(index: number): boolean {
  if (filter.value !== 'all' || index === 0) return false
  return backgroundTaskBucket(visibleTasks.value[index - 1]) === 'active'
    && backgroundTaskBucket(visibleTasks.value[index]) === 'ended'
}

// ── 交互出口 1：点击行 → drawer bashTask tab（D5④；taskId 经 controlState 传递，D5①）──
function onOpenTask(entry: BackgroundTaskEntry): void {
  getDrawerControlState().selectedBackgroundTaskId = entry.taskId
  openDrawerTab('bashTask')
}

// ── 交互出口 2：行内两段式终止（D10④，仅 running 行渲染按钮）──
const confirmingKillId = ref<string | null>(null)

function onKillClick(entry: BackgroundTaskEntry): void {
  // 两段式：首次点击进入确认态（不发令），再次点击才发 kill RPC
  if (confirmingKillId.value !== entry.taskId) {
    confirmingKillId.value = entry.taskId
    return
  }
  confirmingKillId.value = null
  // fire-and-forget：结果经 killing 广播 ≤2s 翻转行状态；失败条目停留原状态
  //（下次广播/拉取自愈），debug 级避免断连期刷屏（对齐 useBackgroundTasks 先例）
  void backgroundTaskApi.kill(props.sessionId, entry.taskId).catch((err: unknown) => {
    console.debug('[background-tasks] inline kill failed', entry.taskId, err)
  })
}
</script>
