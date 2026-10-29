<script setup lang="ts">
// SessionRow —— 会话屏列表行（remote-use-mobile-v2 §7.1 components/ 段；v2 新建，与 v1
// SessionListItem 无继承关系）。纯渲染组件：数据经 props 传入，无状态无编排——分组/
// 长按手势/未读/删除级联归 SessionsScreen（logic 与呈现分层，v1 MobileSessionList ↔
// SessionListItem 同款拆分）。
//
// 行构成（§7.1 会话列表行）：未读点 + 状态点（StatusDot 原语）+ 标题 + 摘要行 + 状态词 +
// 相对时间。状态点语义色/脉冲由 StatusDot 原语承载（spec §6.5 映射表），本组件只做
// MobileRowStatus → StatusDot 词表映射（'active' 摘要态 → 'streaming' 同族 accent 脉冲，
// §6.19「状态点 accent 脉冲 + 状态词进行中」）。
//
// 摘要行数据源（显式口径）：已订阅会话 = 末条消息纯文本摘录（sessionExcerptOf，构建期由
// SessionsScreen 传入）；未订阅会话 = cwd 尾段（项目位置是 remote-use 多项目场景下行的
// 真实区分维度；摘要无消息源可取，显示位置信息优于留白）。dead 行摘要同未订阅口径。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { StatusDot, type StatusDotStatus } from '@taiji/ui'
import type { MobileRowStatus, MobileSessionRowModel } from '../shell/sessions-runtime'

const props = defineProps<{
  model: MobileSessionRowModel
  active: boolean
  /** 摘要行文本（SessionsScreen 构建期派生：已订阅 = 末条消息摘录，否则 cwd 尾段） */
  excerpt: string
}>()

const emit = defineEmits<{
  (e: 'open', sessionId: string): void
}>()

const { t } = useI18n()

/** MobileRowStatus → StatusDot 词表（'active' 摘要态并入 accent 脉冲同族，§6.19） */
const DOT_STATUS: Record<MobileRowStatus, StatusDotStatus> = {
  streaming: 'streaming',
  pending: 'pending',
  compacting: 'compacting',
  waiting: 'waiting',
  retrying: 'retrying',
  working: 'working',
  done: 'done',
  error: 'error',
  stopped: 'stopped',
  dead: 'dead',
  active: 'streaming',
}

const statusWord = computed(() =>
  props.model.status === 'active'
    ? t('mobile.sessions.statusActive')
    : t(`mobile.sessionList.status.${props.model.status}`),
)

const dotLabel = computed(() => `${props.model.summary.label}·${statusWord.value}`)

// ── 相对时间（§7.1 会话屏「相对时间展示」）──────────────────────────────────────

const MINUTE_MS = 60_000
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const HOUR_MS = MINUTES_PER_HOUR * MINUTE_MS
const DAY_MS = HOURS_PER_DAY * HOUR_MS
/** 7 天内显相对词，更早回落 M/D 绝对日期（相对词超过一周可读性差） */
const RELATIVE_WINDOW_DAYS = 7

function formatRelativeTime(ts: number, now: number): string {
  const diff = now - ts
  if (diff < MINUTE_MS) return t('mobile.sessions.justNow')
  if (diff < HOUR_MS) return t('mobile.sessions.minutesAgo', { n: Math.floor(diff / MINUTE_MS) })
  if (diff < DAY_MS) return t('mobile.sessions.hoursAgo', { n: Math.floor(diff / HOUR_MS) })
  if (diff < RELATIVE_WINDOW_DAYS * DAY_MS) return t('mobile.sessions.daysAgo', { n: Math.floor(diff / DAY_MS) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// 相对时间随渲染时刻取 now（列表重渲染即刷新；不挂自转计时器——时间平抑红线之外，
// 纯展示量驱动来源是分区/列表变化，会话在列表页无逐分重渲染需求）
const relativeTime = computed(() => formatRelativeTime(props.model.summary.lastActiveAt, Date.now()))

function onOpen(): void {
  emit('open', props.model.summary.id)
}
</script>

<template>
  <li>
    <!-- role="button" 条目（原生 button 由 vue_rules_checker 拦；ui Button 形态不符列表条目，
         v1 SessionListItem 先例）。指针事件不声明 emit、走 attrs 透传：长按手势逻辑居
         SessionsScreen（v1 MobileSessionList 在组件标签上直绑 @pointerdown 同款）。 -->
    <div
      role="button"
      tabindex="0"
      class="flex w-full cursor-pointer gap-2 rounded-md px-2 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent"
      :class="props.active ? 'bg-accent-soft' : 'active:bg-surface-hover'"
      :data-testid="`session-row-${props.model.summary.id}`"
      @click="onOpen"
      @keydown.enter="onOpen"
    >
      <!-- 未读点（§6.3：新投递/新终态且非活跃 → 点亮；点入即清） -->
      <span
        v-if="props.model.unread"
        class="mt-1.5 size-2 shrink-0 rounded-full bg-accent"
        :aria-label="t('mobile.sessions.unread')"
        role="img"
        data-testid="session-row-unread"
      />
      <StatusDot
        class="mt-2"
        :status="DOT_STATUS[props.model.status]"
        :label="dotLabel"
        data-testid="session-row-status-dot"
      />
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-sm font-medium text-neutral-fg">{{ props.model.summary.label }}</span>
        <span
          v-if="props.excerpt !== ''"
          data-testid="session-row-excerpt"
          class="truncate text-xs text-neutral-mid"
        >{{ props.excerpt }}</span>
      </span>
      <span class="flex shrink-0 flex-col items-end gap-0.5">
        <span
          data-testid="session-row-time"
          class="text-xs text-neutral-mid"
        >{{ relativeTime }}</span>
        <span
          data-testid="session-row-status"
          class="text-xs text-neutral-mid"
        >{{ statusWord }}</span>
      </span>
    </div>
  </li>
</template>
