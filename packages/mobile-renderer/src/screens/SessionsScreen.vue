<script setup lang="ts">
// SessionsScreen —— 会话屏（remote-use-mobile-v2 §7.1：搜索/分组/未读/长按 480ms 动作
// Sheet；impl-plan u-sessions 单元主体）。
//
// 数据源：app-runtime 的 sessionList（runtime 组序派生，A13 客户端不重排——组内过滤不重排）
// + 本段落位的分组谓词 groupSessions（§6.19 双源：已订阅走 core 9 态完整派生；未订阅按
// SessionSummary.status 二分，dead 优先「最近」组）+ 未读集合（§6.3 客户端 diff）。
// hasBlockingOverlay 输入经 sessions-runtime 注册口（registerOverlayPendingReader）喂入，
// 分区数据接线已由 companion-bridge 落位（form/planReview 分区 + dialog 计数）——waiting 态可达。
//
// 交互：点击行 → markSessionVisited（点入即清）→ core selectSession 12 步切入链 →
// navigateRoute('chat')（路由状态机单点转移，dead 会话同样可入——F14 已退出历史只读 +
// 动作 Sheet 重新打开链路）；长按 480ms 打开 SessionActionsSheet（移动 >8px 取消）；
// 新建入口上抛 new-task 由 App 转 openSheet('newTask')（现 wiring 即终态：Sheet 槽位
// 统一归 App 的 sheet-manager 单例编排）。
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { MessageSquare, Plus, Search } from '@lucide/vue'
import { Button, EmptyState, Input } from '@taiji/ui'
import type { MobileGroupingDeps, MobileSessionRowModel } from '../shell/sessions-runtime'
import {
  groupSessions,
  isSessionUnread,
  overlayPendingOf,
  saveSessionsListScroll,
  sessionExcerptOf,
  sessionsListScrollRestore,
  sessionsQuery,
} from '../shell/sessions-runtime'
import {
  chatStore,
  loadSessions,
  selectSession,
  sessionList,
  sessionStore,
} from '../shell/app-runtime'
import { hasRunningSubagents } from '../shell/subagent-records'
import { navigateRoute } from '../shell/route'
import { activeSheet, closeSheet, openSheet } from '../shell/sheet-manager'
import { markSessionVisited } from '../shell/sessions-runtime'
import type { SessionSummary } from '@taiji/shared'
import SessionRow from '../components/SessionRow.vue'
import SessionActionsSheet from '../features/SessionActionsSheet.vue'

const emit = defineEmits<{
  (e: 'new-task'): void
}>()

const { t } = useI18n()

const loadError = computed(() => sessionStore.listLoadError.value)
const activeId = computed(() => sessionStore.activeId.value)

/** 分组谓词输入束（单例分区读口；overlay 输入经注册口——见 app-runtime 段注释） */
const groupingDeps: MobileGroupingDeps = {
  chat: chatStore,
  isSubscribed: (sid) => chatStore.isHydrated(sid) || chatStore.isActive(sid),
  isActive: (sid) => chatStore.isActive(sid),
  isCompacting: (sid) => chatStore.isCompacting(sid),
  hasBackgroundWork: (sid) => hasRunningSubagents(sid),
  hasBlockingOverlay: (sid) => overlayPendingOf(sid),
  isUnread: (sid) => isSessionUnread(sid),
}

/** 双源分组（computed 体内读 chat 分区/未读集建立响应式依赖——列表 N 小，整表重算） */
const grouped = computed(() => groupSessions(sessionList.value, groupingDeps))

// ── 搜索（§7.1 会话列表「搜索」）──────────────────────────────────────────────

// §6.7「列表滚动位置与搜索词恢复」：屏随路由 v-if 卸载，搜索词直绑 sessions-runtime
// 模块级 ref（跨挂载存活；往返 chat → 列表不清空）
const query = sessionsQuery

function matchesQuery(model: MobileSessionRowModel): boolean {
  const q = query.value.trim().toLowerCase()
  if (q === '') return true
  return model.summary.label.toLowerCase().includes(q)
}

const inProgressRows = computed(() => grouped.value.inProgress.filter(matchesQuery))
const recentRows = computed(() => grouped.value.recent.filter(matchesQuery))

/** 摘要行文本：已订阅 = 末条消息摘录；未订阅/dead = cwd 尾段（口径见 SessionRow 头注） */
function excerptOf(model: MobileSessionRowModel): string {
  if (groupingDeps.isSubscribed(model.summary.id)) {
    return sessionExcerptOf(model.summary.id, chatStore)
  }
  const parts = model.summary.cwd.split('/').filter((p) => p !== '')
  return parts[parts.length - 1] ?? model.summary.cwd
}

// ── 点入会话（点入即清 + 切入链 + 路由转移）────────────────────────────────────

async function onOpenSession(sessionId: string): Promise<void> {
  // 长按弹 Sheet 后的 click 穿透抑制（长按计时器 fire 过则本次 click 是松手伴生事件，v1 同款）
  if (suppressNextClick) {
    suppressNextClick = false
    return
  }
  markSessionVisited(sessionId)
  try {
    await selectSession(sessionId)
  } catch (e) {
    // 降级策略：切入失败不阻断导航（聊天视图呈现失败态可重试）；console 留痕不占用
    // 错误条单槽（对齐 restoreSession 降级口径）
    console.warn('[sessions] selectSession failed:', sessionId, e)
  }
  navigateRoute('chat')
}

// ── 长按手势（480ms 打开 / 移动 >8px 取消；spec A9/V3）──────────────────────────

const LONG_PRESS_MS = 480
const LONG_PRESS_CANCEL_MOVE_PX = 8

/** 动作 Sheet 目标会话（null = 无目标；Sheet 挂载条件见模板） */
const actionTarget = ref<SessionSummary | null>(null)

let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressStart: { x: number; y: number } | null = null
let suppressNextClick = false

function onRowPointerDown(session: SessionSummary, e: PointerEvent): void {
  clearPressTimer()
  pressStart = { x: e.clientX, y: e.clientY }
  pressTimer = setTimeout(() => {
    pressTimer = null
    suppressNextClick = true
    actionTarget.value = session
    openSheet('sessionActions')
  }, LONG_PRESS_MS)
}

function onRowPointerMove(e: PointerEvent): void {
  if (pressStart === null) return
  const dx = e.clientX - pressStart.x
  const dy = e.clientY - pressStart.y
  // 移动超阈值 = 滚动/滑动意图，取消长按判定
  if (Math.hypot(dx, dy) > LONG_PRESS_CANCEL_MOVE_PX) clearPressTimer()
}

function onRowPointerEnd(): void {
  clearPressTimer()
}

function clearPressTimer(): void {
  pressStart = null
  if (pressTimer !== null) {
    clearTimeout(pressTimer)
    pressTimer = null
  }
}

// §6.7 列表滚动位置恢复：列表体容器（挂载回填模块级记录、卸载前记录 scrollTop）
const listEl = ref<HTMLElement | null>(null)

onMounted(() => {
  if (listEl.value) listEl.value.scrollTop = sessionsListScrollRestore()
})

// 屏卸载（路由切走）时长按计时器与 actionSheet 槽位不残留（Sheet 生命周期联动 §7.1 的
// 消费方事件点职责——manager 不反向 watch）；滚动位置先于卸载记录（onUnmounted 时
// DOM 已摘除读不到 scrollTop，onBeforeUnmount 仍在）
onBeforeUnmount(() => {
  if (listEl.value) saveSessionsListScroll(listEl.value.scrollTop)
  clearPressTimer()
})
onUnmounted(() => {
  if (activeSheet.value === 'sessionActions') closeSheet()
})

function onRetry(): void {
  void loadSessions()
}

function onClearSearch(): void {
  query.value = ''
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-testid="sessions-screen">
    <!-- 屏头：标题 + 新建入口（44px 触控档） -->
    <div class="flex shrink-0 items-center justify-between px-3 pt-1 pb-1">
      <h1 class="text-base font-semibold text-neutral-fg">{{ t('mobile.tabs.sessions') }}</h1>
      <Button
        variant="ghost"
        size="icon-44"
        data-testid="sessions-new-task"
        :aria-label="t('mobile.sessionList.newTask')"
        :title="t('mobile.sessionList.newTask')"
        @click="emit('new-task')"
      >
        <Plus class="size-5" />
      </Button>
    </div>

    <!-- 搜索框 -->
    <div class="shrink-0 px-3 pb-2">
      <Input v-model="query" :placeholder="t('mobile.sessions.searchPlaceholder')" data-testid="sessions-search" />
    </div>

    <!-- 列表体（滚动容器：卸载前记录/挂载回填 scrollTop，§6.7 滚动位置恢复） -->
    <div ref="listEl" class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <p
        v-if="loadError"
        data-testid="sessions-error"
        class="cursor-pointer rounded px-2 py-3 text-sm text-danger"
        role="alert"
        @click="onRetry"
      >
        {{ loadError ?? t('mobile.sessionList.loadFailed') }}
      </p>

      <!-- 全空态（无会话）：三要素空态 + 新建行动 -->
      <EmptyState
        v-else-if="sessionList.length === 0"
        :icon="MessageSquare"
        :title="t('mobile.sessionList.empty')"
        :description="t('mobile.sessions.emptyDescription')"
      >
        <Button data-testid="sessions-empty-new-task" @click="emit('new-task')">
          {{ t('mobile.sessionList.newTask') }}
        </Button>
      </EmptyState>

      <!-- 搜索无匹配：三要素空态 + 清空搜索行动 -->
      <EmptyState
        v-else-if="inProgressRows.length === 0 && recentRows.length === 0"
        :icon="Search"
        :title="t('mobile.sessions.searchEmptyTitle')"
        :description="t('mobile.sessions.searchEmptyDescription', { query })"
      >
        <Button variant="ghost" data-testid="sessions-clear-search" @click="onClearSearch">
          {{ t('mobile.sessions.searchClear') }}
        </Button>
      </EmptyState>

      <template v-else>
        <section v-if="inProgressRows.length > 0" data-testid="sessions-group-active" class="pb-2">
          <h2 class="px-2 pb-1 text-xs font-medium text-neutral-mid">
            {{ t('mobile.sessions.groupActive') }}
          </h2>
          <ul class="flex flex-col gap-1">
            <SessionRow
              v-for="model in inProgressRows"
              :key="model.summary.id"
              :model="model"
              :active="model.summary.id === activeId"
              :excerpt="excerptOf(model)"
              @open="onOpenSession"
              @pointerdown="onRowPointerDown(model.summary, $event)"
              @pointermove="onRowPointerMove"
              @pointerup="onRowPointerEnd"
              @pointercancel="onRowPointerEnd"
            />
          </ul>
        </section>
        <section v-if="recentRows.length > 0" data-testid="sessions-group-recent">
          <h2 class="px-2 pb-1 text-xs font-medium text-neutral-mid">
            {{ t('mobile.sessions.groupRecent') }}
          </h2>
          <ul class="flex flex-col gap-1">
            <SessionRow
              v-for="model in recentRows"
              :key="model.summary.id"
              :model="model"
              :active="model.summary.id === activeId"
              :excerpt="excerptOf(model)"
              @open="onOpenSession"
              @pointerdown="onRowPointerDown(model.summary, $event)"
              @pointermove="onRowPointerMove"
              @pointerup="onRowPointerEnd"
              @pointercancel="onRowPointerEnd"
            />
          </ul>
        </section>
      </template>
    </div>

    <!-- 长按动作 Sheet（sheet-manager 单例槽位条件挂载；§6.13/§6.5 浮层纪律） -->
    <SessionActionsSheet
      v-if="activeSheet === 'sessionActions'"
      :session="actionTarget"
    />
  </div>
</template>
