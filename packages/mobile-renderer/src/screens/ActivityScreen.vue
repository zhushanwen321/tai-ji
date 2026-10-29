<script setup lang="ts">
// ActivityScreen —— 移动壳进行中屏（remote-use-mobile-v2 §7.1 / §6.18 聚合半 / §6.21；
// impl-plan §2 u-activity 本体）。
//
// 聚合口径（§6.18 收窄口径，本屏是裁决落点）：
// - 回合面板 / 子代理 / 排队消息 = 只看 activeSession（订阅数据只对活跃会话完备）；
// - 「需要你处理」= 全部会话的可归属待办（form/planReview/dialog，按分区键归属）+
//   全局（无归属）待办（permission——V-6 降级分支恒无归属）；数据源 =
//   companion-bridge usePendingTodoSummary（BottomNav 计数角标消费同一 computed，
//   导航计数与聚合区一致由同源构造性保证）。
//
// 四区块各带三要素空态（EmptyState：图标+说明+主行动，验收条款 2）：
// 无运行 / 无待办 / 无子代理 / 无排队。
//
// 交互：
// - 会话待办条目 → selectSession(归属会话) 后 openSheet('form')（FormSheet 三源读口按
//   activeSessionId 分区派生——先切会话再开槽，槽内呈现的才是该会话的请求；切走已在
//   聊天页的活跃会话是「跨会话作答」的正常路径，返回经 popstate 回源）；
// - permission 条目 → openSheet('permission')（全局单例状态，无分区语义）；
// - 子代理行 → emit('open-subagent-detail') 上抛 + openSheet('subagentList')——SubagentSheet
//   挂载于 App 根级（Sheet 族挂载段），直落详情态经 App 透传 initialSubagentId。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Activity, Bot, ChevronRight, Clock, Inbox } from '@lucide/vue'
import { deliveryQueueEntries, getDeliveryProjectionRef } from '@taiji/core'
import { Button, EmptyState } from '@taiji/ui'
import type { SubagentRecord } from '@taiji/shared'
import { activeSessionId, selectSession, sessionList } from '../shell/app-runtime'
import { navigateRoute } from '../shell/route'
import { openSheet } from '../shell/sheet-manager'
import { usePendingTodoSummary } from '../shell/companion-bridge'
import { runningSubagentRecordsOf } from '../shell/subagent-records'
import { useTurnObservation } from '../features/turn-observation'
import QueueStrip from '../features/QueueStrip.vue'

const emit = defineEmits<{ (e: 'open-subagent-detail', subagentId: string): void }>()

const { t } = useI18n()

// ── 回合面板（§6.21：计时/步数/子代理数；只看 activeSession）───────────────────

const activeId = computed(() => activeSessionId.value ?? null)
const activeSummary = computed(() =>
  activeId.value === null ? undefined : sessionList.value.find((s) => s.id === activeId.value),
)
const activeTitle = computed(() => activeSummary.value?.label ?? t('mobile.chat.untitled'))

const { isActive, observedDuration, completedSteps } = useTurnObservation(activeId)

const runningSubagents = computed<SubagentRecord[]>(() =>
  activeId.value === null ? [] : runningSubagentRecordsOf(activeId.value),
)

// ── 「需要你处理」聚合区（§6.18：全表待办 + 无归属全局区）──────────────────────

const pendingSummary = usePendingTodoSummary()

/** 会话条目明细文案：非零类型计数拼接（「提问 ×1 · 计划 ×2」式；全零不渲染条目） */
function groupDetailKeyParts(g: { formCount: number; planReviewCount: number; dialogCount: number }): string[] {
  const parts: string[] = []
  if (g.formCount > 0) parts.push(t('mobile.activity.pendingForm', { count: g.formCount }))
  if (g.planReviewCount > 0) parts.push(t('mobile.activity.pendingPlanReview', { count: g.planReviewCount }))
  if (g.dialogCount > 0) parts.push(t('mobile.activity.pendingDialog', { count: g.dialogCount }))
  return parts
}

function sessionTitleOf(sid: string): string {
  return sessionList.value.find((s) => s.id === sid)?.label ?? t('mobile.chat.untitled')
}

/**
 * 会话待办条目点击：先切归属会话再开「待回答」Sheet（FormSheet 三源读口按活跃分区派生，
 * 见文件头交互节）。selectSession 失败（会话恰被删除的竞态窗口）不开槽——分区已随删除
 * 级联清空，条目随快照消失，console 留痕即可（不占错误条单槽——单槽留给 core 失败面）。
 */
const openingPendingSid = ref<string | null>(null)

async function onOpenSessionPending(sid: string): Promise<void> {
  if (openingPendingSid.value !== null) return
  openingPendingSid.value = sid
  try {
    if (sid !== activeSessionId.value) await selectSession(sid)
  } catch (e) {
    console.warn('[ActivityScreen] selectSession for pending failed:', sid, e)
    return
  } finally {
    openingPendingSid.value = null
  }
  openSheet('form')
}

function onOpenPermissionPending(): void {
  openSheet('permission')
}

// ── 排队消息区（§6.22 状态机渲染在 QueueStrip；本屏只管区块显隐与空态）────────────

const projection = getDeliveryProjectionRef()

const activeQueueRows = computed(() =>
  activeId.value === null ? [] : deliveryQueueEntries(projection.value.get(activeId.value) ?? []),
)

function goSessions(): void {
  navigateRoute('sessions')
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="activity-screen">
    <!-- ── 回合面板（当前活跃会话的回合计时/步数/子代理数）────────────────────── -->
    <section class="shrink-0 border-b border-[var(--border)] px-3 py-2.5">
      <h2 class="mb-1.5 text-xs font-medium text-neutral-mid">{{ t('mobile.activity.turnTitle') }}</h2>
      <!-- 面板（生成中；未订阅会话 isActive 恒 false 构造性不显示，§6.21） -->
      <div
        v-if="isActive && observedDuration"
        class="flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-bg-input px-3 py-2"
        data-testid="activity-turn-panel"
      >
        <p class="truncate text-sm text-neutral-fg" data-testid="activity-turn-session">{{ activeTitle }}</p>
        <p class="text-xs text-neutral-mid">
          <span data-testid="activity-turn-timer">{{ t('mobile.activity.observed', { duration: observedDuration }) }}</span>
          <span v-if="completedSteps > 0"> · <span data-testid="activity-turn-steps">{{ t('mobile.activity.steps', { count: completedSteps }) }}</span></span>
          <span v-if="runningSubagents.length > 0"> · <span data-testid="activity-turn-subagents">{{ t('mobile.activity.subagentCount', { count: runningSubagents.length }) }}</span></span>
        </p>
      </div>
      <!-- 空态①：无运行（图标+说明+主行动三要素） -->
      <EmptyState
        v-else
        :icon="Activity"
        :title="t('mobile.activity.turnIdleTitle')"
        :description="t('mobile.activity.turnIdleDescription')"
        data-testid="activity-empty-running"
      >
        <Button variant="secondary" size="sm" data-testid="activity-empty-running-action" @click="goSessions">
          {{ t('mobile.activity.turnIdleAction') }}
        </Button>
      </EmptyState>
    </section>

    <!-- ── 「需要你处理」（全部会话可归属待办 + 无归属全局区）──────────────────── -->
    <section class="shrink-0 border-b border-[var(--border)] px-3 py-2.5">
      <h2 class="mb-1.5 text-xs font-medium text-neutral-mid">{{ t('mobile.activity.pendingTitle') }}</h2>
      <div v-if="pendingSummary.total > 0" class="flex flex-col gap-1" data-testid="activity-pending-list">
        <!-- 无归属全局区（permission 恒无归属——一等分支在前，进程级请求不归属特定会话） -->
        <div
          v-if="pendingSummary.global.permissionCount > 0"
          role="button"
          tabindex="0"
          class="flex min-h-[var(--m-tap)] cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-bg-input px-3 outline-none active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
          data-testid="activity-pending-permission"
          :aria-label="t('mobile.activity.pendingPermission')"
          @click="onOpenPermissionPending"
          @keydown.enter="onOpenPermissionPending"
        >
          <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">
            {{ t('mobile.activity.pendingPermission') }}
          </span>
          <span class="shrink-0 text-xs text-neutral-mid">{{ t('mobile.activity.pendingProcess') }}</span>
          <ChevronRight class="size-4 shrink-0 text-neutral-mid" aria-hidden="true" />
        </div>
        <!-- 可归属会话区（按 sessionList 序） -->
        <div
          v-for="group in pendingSummary.sessionGroups"
          :key="group.sessionId"
          role="button"
          tabindex="0"
          class="flex min-h-[var(--m-tap)] cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-bg-input px-3 outline-none active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
          :data-testid="`activity-pending-session-${group.sessionId}`"
          :aria-label="t('mobile.activity.pendingOpen', { session: sessionTitleOf(group.sessionId) })"
          @click="onOpenSessionPending(group.sessionId)"
          @keydown.enter="onOpenSessionPending(group.sessionId)"
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm text-neutral-fg">{{ sessionTitleOf(group.sessionId) }}</span>
            <span class="block truncate text-xs text-neutral-mid">{{ groupDetailKeyParts(group).join(' · ') }}</span>
          </span>
          <ChevronRight class="size-4 shrink-0 text-neutral-mid" aria-hidden="true" />
        </div>
      </div>
      <!-- 空态②：无待办 -->
      <EmptyState
        v-else
        :icon="Inbox"
        :title="t('mobile.activity.pendingEmptyTitle')"
        :description="t('mobile.activity.pendingEmptyDescription')"
        data-testid="activity-empty-pending"
      >
        <Button variant="secondary" size="sm" data-testid="activity-empty-pending-action" @click="openSheet('newTask')">
          {{ t('mobile.activity.pendingEmptyAction') }}
        </Button>
      </EmptyState>
    </section>

    <!-- ── 子代理（当前活跃会话运行中；行直落 SubagentSheet 详情）────────────────── -->
    <section class="shrink-0 border-b border-[var(--border)] px-3 py-2.5">
      <h2 class="mb-1.5 text-xs font-medium text-neutral-mid">{{ t('mobile.activity.subagentTitle') }}</h2>
      <div v-if="runningSubagents.length > 0" class="flex flex-col gap-1" data-testid="activity-subagent-list">
        <div
          v-for="r in runningSubagents"
          :key="r.subagentId"
          role="button"
          tabindex="0"
          class="flex min-h-[var(--m-tap)] cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-bg-input px-3 outline-none active:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent"
          :data-testid="`activity-subagent-${r.subagentId}`"
          :aria-label="t('mobile.activity.subagentOpen', { name: r.slug !== '' ? r.slug : r.agent })"
          @click="emit('open-subagent-detail', r.subagentId)"
          @keydown.enter="emit('open-subagent-detail', r.subagentId)"
        >
          <span class="size-2 shrink-0 animate-pulse rounded-full bg-accent motion-reduce:animate-none" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate text-sm text-neutral-fg">{{ r.slug !== '' ? r.slug : r.agent }}</span>
          <span class="shrink-0 text-xs text-accent">{{ t('mobile.subagent.stateRunning') }}</span>
          <ChevronRight class="size-4 shrink-0 text-neutral-mid" aria-hidden="true" />
        </div>
      </div>
      <!-- 空态③：无子代理 -->
      <EmptyState
        v-else
        :icon="Bot"
        :title="t('mobile.activity.subagentEmptyTitle')"
        :description="t('mobile.activity.subagentEmptyDescription')"
        data-testid="activity-empty-subagents"
      >
        <Button variant="secondary" size="sm" data-testid="activity-empty-subagents-action" @click="goSessions">
          {{ t('mobile.activity.subagentEmptyAction') }}
        </Button>
      </EmptyState>
    </section>

    <!-- ── 排队消息（当前活跃会话队列；状态机渲染复用 QueueStrip）─────────────────── -->
    <section class="shrink-0 px-3 py-2.5">
      <h2 class="mb-1.5 text-xs font-medium text-neutral-mid">{{ t('mobile.activity.queueTitle') }}</h2>
      <QueueStrip v-if="activeId !== null && activeQueueRows.length > 0" :session-id="activeId" />
      <!-- 空态④：无排队 -->
      <EmptyState
        v-else
        :icon="Clock"
        :title="t('mobile.activity.queueEmptyTitle')"
        :description="t('mobile.activity.queueEmptyDescription')"
        data-testid="activity-empty-queue"
      >
        <Button variant="secondary" size="sm" data-testid="activity-empty-queue-action" @click="goSessions">
          {{ t('mobile.activity.queueEmptyAction') }}
        </Button>
      </EmptyState>
    </section>
  </div>
</template>
