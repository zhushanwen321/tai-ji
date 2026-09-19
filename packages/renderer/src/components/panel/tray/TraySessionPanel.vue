<!--
  TraySessionPanel —— composer 任务托盘第 4 件「子会话」面板（u7，调度模式的执行面入口）。
  设计 `.tmp/tech-design/mode-system-composer-density.md` §6.7 决策 D7 + §7.4「底栏」行。

  ── 数据面（D7：native 直连，零新协议）──
  inject TRAY_COUNTS_KEY（外壳单例）：本面板**不自建 useTrayCounts 实例**（面板随 Popover
  开合反复挂载，自建即每次打开重发首拉）；子会话行集来自 `tray.lists.session.children`
  （native 直连 session store，过滤 parentAgentSessionId === 外壳 sessionId，无新 RPC/订阅）。

  ── 形态（与三件任务面板的差异面）──
  扁平列表（刻意不做两视图分桶：子会话条数少，用户要一眼看全「我派发的全部」）——段头摘要
  `{total} 个 · {running} 运行中` + 每行：7px 状态点 + label + `cwd 末段 · 状态 · 最近活动`。
  行点击 = 打开该子会话（`useSidebar().selectSession`，与侧栏点击同一条 core 12 步切入链）；
  pin 态行内渲染「停止」（`chat.abort` 软停止，两段确认——TrayConfirmButton 原语），与三件
  面板 D8「hover 态不渲染行内操作防误触」契约一致。

  ── 状态口径 ──
  进程级 `SessionSummary.status`（active → 运行中；error → 失败；stopped/dead → 已停止；
  idle/done → 已完成）。色语言复用侧栏 `DOT_CLASS` 单点——agent 派发的子会话通常未 hydrate，
  `derivedStatus` 对 status='active' 无消息会兜底 done，无法表达运行中（见 useTrayCounts 文件头）。
-->
<template>
  <div
    data-testid="tray-session-panel"
    :data-session-id="sessionId"
    :aria-label="t('panel.tray.title.session')"
    class="flex min-h-0 w-full flex-1 flex-col gap-1"
  >
    <!-- 段头摘要（与行集同源：total = children.length，running = 进行中数） -->
    <div
      v-if="children.length > 0"
      data-testid="tray-session-header"
      class="flex shrink-0 items-center px-1 font-mono text-[length:var(--text-2xs)] text-neutral-dim"
    >
      <span class="min-w-0 flex-1 truncate">{{ headerText }}</span>
    </div>

    <ScrollArea v-if="children.length > 0" class="min-h-0 flex-1">
      <div class="flex flex-col px-1.5">
        <div
          v-for="child in children"
          :key="child.id"
          data-testid="tray-session-row"
          :data-child-session-id="child.id"
          class="group/item relative flex cursor-pointer items-start gap-2 rounded-md px-2 py-1 transition-colors hover:bg-surface-hover"
          :title="child.label"
          @click="openChild(child)"
          @mouseleave="stopConfirm.clear()"
        >
          <!-- 7px 状态点（色语言 = DOT_CLASS 单点；error 行显 danger 色） -->
          <span
            data-testid="tray-session-dot"
            class="mt-[6px] size-[7px] shrink-0 rounded-full"
            :class="dotClass(child)"
            :title="statusText(child)"
            aria-hidden="true"
          />
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-[1.35] text-neutral-fg">
              <span class="min-w-0 flex-1 truncate">{{ child.label }}</span>
              <!-- 行内操作（仅 pin 态、仅运行中）：停止（软停止，两段确认） -->
              <TrayConfirmButton
                v-if="pinned && isRunning(child)"
                testid="tray-session-stop"
                :confirming="stopConfirm.isConfirming(child.id)"
                :title="t('panel.tray.session.stop')"
                :confirm-title="t('panel.tray.session.stopConfirm')"
                @click.stop="onStopClick(child)"
              />
            </div>
            <div
              data-testid="tray-session-meta"
              class="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
            >
              <span class="min-w-0 flex-1 truncate">
                {{ cwdLastSegment(child.cwd) }} · {{ statusText(child) }} · {{ lastActiveLabel(child) }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>

    <!-- 空态（防御：外壳三态「全无 → 不渲染」下不应到达） -->
    <div
      v-else
      data-testid="tray-session-empty"
      class="flex min-h-0 flex-1 items-center justify-center py-8 text-center"
    >
      <p class="text-[length:var(--text-2xs)] text-neutral-dim opacity-55">
        {{ t('panel.tray.session.empty') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 脚本分区：数据面（inject 外壳单例）/ 状态映射（进程级 status → DOT_CLASS 色 + i18n 文案）/
 * 行格式化（cwd 末段 / 最近活动）/ 行动作（打开 = selectSession；停止 = chat.abort 两段确认）。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { chat as chatApi } from '@/api'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useSidebar } from '@/composables/features/sidebar/useSidebar'
import { useToast } from '@/composables/useToast'
import { useTwoStepConfirm } from '@/composables/useTwoStepConfirm'
import { DOT_CLASS, DISPLAY_STATUS } from '@/composables/logic/sessionStatus'
import { useTrayCountsContext } from '@/components/panel/tray/useTrayCounts'
import TrayConfirmButton from '@/components/panel/tray/TrayConfirmButton.vue'
import { formatCompactDuration, MS_PER_SECOND } from '@/lib/duration-format'
import { toErrorMessage } from '@taiji/core'
import type { SessionStatus, SessionSummary } from '@taiji/shared'

withDefaults(defineProps<{
  /** 焦点（父）session id：子会话过滤键（parentAgentSessionId === 本值；透传自外壳） */
  sessionId: string
  /** pin 态（外壳管理）：行内操作仅 pin 态渲染（沿用三件面板 D8 防误触契约） */
  pinned?: boolean
}>(), { pinned: false })

const { t } = useI18n()
const { error: toastError } = useToast()
/** 打开子会话：与侧栏点击同一条 core 12 步切入链（useSidebar 为每次调用新建实例，无副作用） */
const { selectSession } = useSidebar()

/** 数据面（单例注入）：实例由外壳 ComposerTray 创建并 provide，本面板零拉取（见文件头） */
const tray = useTrayCountsContext()
const children = computed(() => tray.lists.session.children.value)

/** 段头摘要（计数与行集同源） */
const headerText = computed(() =>
  t('panel.tray.session.header', {
    total: tray.counts.value.session.total,
    running: tray.counts.value.session.running,
  }),
)

/**
 * 状态文案 key（i18n 子表；与 sessionStatus.ts 的 DISPLAY_STATUS 一一对应）。
 */
const STATUS_TEXT_KEY: Record<SessionStatus, string> = {
  active: 'running',
  idle: 'done',
  done: 'done',
  error: 'error',
  stopped: 'stopped',
  dead: 'stopped',
}

function dotClass(child: SessionSummary): string {
  return DOT_CLASS[DISPLAY_STATUS[child.status]]
}
function statusText(child: SessionSummary): string {
  return t(`panel.tray.session.status.${STATUS_TEXT_KEY[child.status]}`)
}
function isRunning(child: SessionSummary): boolean {
  return child.status === 'active'
}
/** cwd 末段（跨平台分隔符；空路径回退原值） */
function cwdLastSegment(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}
/** 最近活动（lastActiveAt 相对当下；面板随 Popover 开合短命，不另挂 1s tick） */
function lastActiveLabel(child: SessionSummary): string {
  const seconds = Math.max(0, Math.floor((Date.now() - child.lastActiveAt) / MS_PER_SECOND))
  return formatCompactDuration(seconds, { hours: true })
}

/** 行点击 = 打开该子会话（与侧栏点击同一条 core 12 步切入链） */
async function openChild(child: SessionSummary): Promise<void> {
  try {
    await selectSession(child.id)
  } catch (e) {
    toastError(t('panel.tray.session.openFailed', { msg: toErrorMessage(e) }))
  }
}

/** 行内操作：停止（软停止 chat.abort，两段确认；仅运行中子会话、仅 pin 态渲染） */
const stopConfirm = useTwoStepConfirm((childId) => {
  void abortChild(childId)
})
function onStopClick(child: SessionSummary): void {
  stopConfirm.toggle(child.id)
}
async function abortChild(childId: string): Promise<void> {
  try {
    await chatApi.abort(childId)
  } catch (e) {
    toastError(t('panel.tray.session.stopFailed', { msg: toErrorMessage(e) }))
  }
}
</script>
