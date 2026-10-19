<!--
  SchedulerQuickCard —— composer 左簇定时任务快捷面板（左簇浮层优化 2026-10-19）。

  替代形态：此前该入口是 HeaderActionsHost 通用按钮（原生 title 提示 + 点击直开 overlay）。
  现在按钮不变（时钟 + badge + 点击仍直开 overlay tab），新增 hover 快捷面板：
  160ms 悬停即出任务列表（含每任务 暂停/恢复 · 立即执行 · 删除 行内操作），无需点开 overlay。

  数据面（零新增接线）：直接消费 scheduler-manager 插件经 views.update 持续推送的
  SCHEDULER_MODAL_VIEW_ID 分区树（ViewHost 渲染，与 overlay 定时任务 tab 同一份数据同一
  渲染原语——stats-line / list-tree / action-bar；action-bar 点击经壳层 provide 的
  ACTION_EXECUTOR_KEY 走既有命令链 scheduler-manager.toggle/run/delete，带任务 id 参数）。
  按钮 badge 可见 ⟹ 插件已推送过树（badge 与树同轮推、同源刷新），面板打开即有内容；
  极端时序（树推送失败 badge 仍推）由 ViewHost placeholder 态兜底提示。

  交互状态机（对齐 ComposerTray 外壳 D8 范式的单面板简化版）：
  - hover 按钮 160ms → 开面板；指针离开按钮+面板整体 240ms → 收起
  - 点击按钮 = pin（面板常驻 + overlay 直开保留原语义？否——pin 与 overlay 直开二选一：
    点击改为 toggle pin，overlay 直开移到面板底部「打开定时任务面板」钮，见下方迁移说明）
  - 再点 / Esc / 点面板外 = 解除；同一时刻至多一个面板由单一 panelOpen 布尔结构性保证

  [行为迁移说明] 点击语义变更：原「点击直开 workflow-viz overlay」→「点击 pin 快捷面板」，
  overlay 直开移入面板底部操作条（openSchedulerTab 原样保留，入口位置换挡）。迁移理由：
  hover 快捷面板成为主路径后，点击的主语义收敛为「固定/解除这个面板」（与托盘全族一致），
  完整管理面板（新建任务 / 排期编辑）留在 overlay 承接。
-->
<template>
  <Popover :open="panelOpen" @update:open="onPanelOpenChange">
    <PopoverAnchor as-child>
      <span
        class="inline-flex"
        data-testid="scheduler-quick-anchor"
        data-scheduler-quick-root
        @pointerenter="onAnchorEnter"
        @pointerleave="onAnchorLeave"
      >
        <Button
          variant="ghost"
          size="icon"
          class="relative size-[30px] shrink-0 rounded-sm text-neutral-dim transition-colors hover:bg-surface-hover hover:text-neutral-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-neutral-mid"
          :data-testid="testid"
          :disabled="disabled"
          :aria-label="tooltip"
          :aria-expanded="panelOpen ? 'true' : 'false'"
          :aria-pressed="pinned ? 'true' : 'false'"
          @click="onTogglePin"
        >
          <Clock class="size-[16px]" :stroke-width="1.6" />
          <span
            v-if="badge"
            :class="[TRAY_ITEM_COUNT_CLASS, 'bg-surface-hover', 'text-neutral-mid']"
          >{{ badge }}</span>
        </Button>
      </span>
    </PopoverAnchor>
    <PopoverContent
      side="top"
      align="start"
      :side-offset="10"
      class="w-[400px] min-w-0 max-w-[calc(100vw-16px)] rounded-lg"
      data-testid="scheduler-quick-panel"
      @open-auto-focus.prevent
      @interact-outside="onInteractOutside"
    >
      <!-- 内容 div 覆盖浮层全幅（p-1 在自身上，padding 带同样触发热区，U3 同款）；
           高度自适应 + max-h 340：任务数少时面板不空腔（与托盘固定高 340 的差异理由：
           本面板无内部 tab 切换，不存在「切 tab 容器塌缩致指针落空」的固定高裁决动因） -->
      <div
        class="flex max-h-[340px] min-h-[64px] flex-col p-1"
        @pointerenter="onPanelEnter"
        @pointerleave="onPanelLeave"
      >
        <ViewHost
          :view-id="SCHEDULER_MODAL_VIEW_ID"
          :session-id="sessionId"
          :title="t('panel.header.schedulerPanelTitle')"
          empty="placeholder"
          class="min-h-0 flex-1 overflow-y-auto"
        />
        <div class="mt-1 flex shrink-0 items-center border-t border-hairline pt-1">
          <Button
            variant="ghost"
            class="inline-flex h-auto items-center gap-[5px] rounded-[var(--radius-xs)] px-[4px] py-[3px] font-normal text-[length:var(--text-2xs)] text-accent transition-colors hover:bg-accent-soft hover:text-accent-hover"
            data-testid="scheduler-quick-open-overlay"
            @click="openOverlay"
          >
            {{ t('panel.header.schedulerQuickOpen') }}
            <ArrowUpRight class="size-[12px]" :stroke-width="1.8" />
          </Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Clock, ArrowUpRight } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { ViewHost } from '@taiji/ui/extension-host'
import { TRAY_ITEM_COUNT_CLASS } from '@/components/panel/tray/tray-item-button'
import { openSchedulerTab, SCHEDULER_MODAL_VIEW_ID } from '@/components/panel/workflow-viz/overlay/workflow-viz-overlay'

const { t } = useI18n()

const props = defineProps<{
  /** 所属 session（ViewHost 分区键 + overlay 直开参数；本卡片只在 session 态渲染） */
  sessionId: string
  /** 运行时徽标（启用任务数，HeaderActionsHost 合成后透传；空串不渲染） */
  badge: string
  /** 运行时灰置（HeaderActionsHost 三源合成后透传；disabled 时 hover 不开面板） */
  disabled: boolean
  /** testid（HeaderActionsHost actionTestId 契约形态透传） */
  testid: string
  /** 提示文案（HeaderActionsHost tooltip 合成语义透传；按钮 aria-label 同串承载） */
  tooltip: string
}>()

// ── hover/pin 状态机（ComposerTray D8 单面板简化版）──

const HOVER_OPEN_MS = 160
const HOVER_CLOSE_MS = 240

const panelOpen = ref(false)
const pinned = ref(false)
let openTimer: ReturnType<typeof setTimeout> | null = null
let closeTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers(): void {
  if (openTimer) clearTimeout(openTimer)
  if (closeTimer) clearTimeout(closeTimer)
  openTimer = null
  closeTimer = null
}

function close(): void {
  clearTimers()
  panelOpen.value = false
  pinned.value = false
}

function onAnchorEnter(): void {
  if (props.disabled) return
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
  if (panelOpen.value) return
  if (openTimer) return
  openTimer = setTimeout(() => {
    openTimer = null
    panelOpen.value = true
  }, HOVER_OPEN_MS)
}

function onAnchorLeave(): void {
  if (openTimer) clearTimeout(openTimer)
  openTimer = null
  if (pinned.value || !panelOpen.value) return
  if (closeTimer) return
  closeTimer = setTimeout(() => {
    closeTimer = null
    close()
  }, HOVER_CLOSE_MS)
}

function onPanelEnter(): void {
  clearTimers()
}

function onPanelLeave(): void {
  if (pinned.value) return
  if (closeTimer) return
  closeTimer = setTimeout(() => {
    closeTimer = null
    close()
  }, HOVER_CLOSE_MS)
}

function onTogglePin(): void {
  if (panelOpen.value && pinned.value) {
    close()
    return
  }
  clearTimers()
  pinned.value = true
  panelOpen.value = true
}

/** reka 上报「应关闭」（Esc / 焦点移出 / 点外）→ 收起并解 pin（不反向驱动开） */
function onPanelOpenChange(open: boolean): void {
  if (open) return
  close()
}

/** 按钮行内 pointerdown 在 reka 眼里属「层外」（anchor 非 trigger）：不拦截会先关面板、
 *  再被随后的 click 重新 pin——表现为「永远 pin 不住」（ComposerTray 同款拦截）。 */
function onInteractOutside(e: Event): void {
  const target = e.target as Element | null
  if (target?.closest('[data-scheduler-quick-root]')) e.preventDefault()
}

/** 底部操作条：收起快捷面板 + 直开 workflow-viz overlay 定时任务 tab（完整管理面） */
function openOverlay(): void {
  close()
  openSchedulerTab(props.sessionId)
}

onBeforeUnmount(clearTimers)
</script>
