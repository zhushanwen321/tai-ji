<template>
  <!--
    SessionItem 条目展示子块：7px 状态 icon + unread 圆点 + label + 徽标 + sub 元信息 + 时间。
    纯展示（零 emit）：unread / markedDone / fresh 徽标读模块级响应式集合，
    toggle 由 Actions 子组件执行，此处响应式自动跟随。
    状态信号集中在左侧 7px 单一 icon（旋转箭头/空心圆/实心圆/空白），
    右侧仅保留时间文字。未读标记 7px accent 圆点叠在 icon 右上角。
  -->
  <!-- 左侧 7px 状态 icon：spinning(旋转箭头) / hollow(空心圆) / waiting / error / done / stopped / dead / 空。
       未读标记 7px accent 圆点叠在 icon 右上角（absolute + box-shadow 镂空）。 -->
  <div class="relative mt-[6px] size-[7px] shrink-0" data-testid="session-icon">
    <!-- spinning: streaming / compacting / working / retrying → 旋转箭头（accent 边框 + 透明顶边） -->
    <span v-if="iconKind === 'spinning'" class="block size-[7px] animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
    <!-- hollow: pending → accent 空心圆 -->
    <span v-else-if="iconKind === 'hollow'" class="block size-[7px] rounded-full border-[1.5px] border-accent" />
    <!-- hollow-dim: stopped → dim 空心圆 -->
    <span v-else-if="iconKind === 'hollow-dim'" class="block size-[7px] rounded-full border-[1.5px] border-neutral-dim opacity-60" />
    <!-- waiting → warn 实心圆 -->
    <span v-else-if="iconKind === 'waiting'" class="block size-[7px] rounded-full bg-warn" />
    <!-- error → danger 实心圆 -->
    <span v-else-if="iconKind === 'error'" class="block size-[7px] rounded-full bg-danger" />
    <!-- done → success 实心圆 90% -->
    <span v-else-if="iconKind === 'done'" class="block size-[7px] rounded-full bg-success opacity-90" />
    <!-- dead → neutral-dim 实心圆 50% -->
    <span v-else-if="iconKind === 'dead'" class="block size-[7px] rounded-full bg-neutral-dim opacity-50" />
    <!-- 已归档+已读 → 空（无 icon） -->
    <span v-else aria-hidden="true" />
    <!-- 未读标记：叠在 icon 右上角 -->
    <span
      v-if="unread"
      data-testid="session-unread-dot"
      class="absolute -right-0.5 -top-0.5 size-[7px] rounded-full bg-accent"
      style="box-shadow: 0 0 0 2px var(--bg)"
    />
  </div>

  <!-- 主体：label + sub（fork 血缘 / branch） -->
  <div class="min-w-0 flex-1">
    <div
      class="flex min-w-0 items-center gap-1 text-[length:var(--text-xs)] leading-[1.35]"
      :class="[
        active ? 'text-accent' : 'text-neutral-fg',
        markedDone ? 'opacity-60' : '',
      ]"
    >
      <span class="min-w-0 flex-1 truncate">{{ session.label }}</span>
      <!-- agent-spawned badge（U8）：accent 低饱和形态（bg-accent-soft + text-accent，
           对齐 popover-styles SELECTED_ITEM_CLASS 配对）；尺寸/圆角对齐同目录
           FileTreeRow badge（rounded-sm px-1 py-0.5 text-[length:var(--text-3xs)]），不抢左侧状态 icon 焦点 -->
      <span
        v-if="isAgentSpawned"
        data-testid="session-agent-badge"
        class="shrink-0 rounded-sm bg-accent-soft px-1 py-0.5 font-mono text-[length:var(--text-3xs)] leading-none text-accent"
      >{{ t('sidebar.sessionItem.agentBadge') }}</span>
      <!-- 导入 fresh 徽标（import-session u7）：刚导入的会话标记「导入」，数秒后
           淡出移除（状态机在 useImportSession 模块级，Sidebar 写 / 此处读）。
           形态与 agent badge 同源（accent 低饱和），fade 阶段走 opacity 过渡 -->
      <span
        v-if="freshImportState"
        data-testid="session-imported-fresh"
        class="shrink-0 rounded-sm bg-accent-soft px-1 py-0.5 text-[length:var(--text-3xs)] leading-none text-accent transition-opacity duration-200"
        :class="freshImportState === 'fading' ? 'opacity-0' : ''"
      >{{ t('importSession.freshBadge') }}</span>
    </div>
    <div
      class="mt-0.5 truncate font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
      data-testid="sidebar-session-sub"
    >
      <!-- 分支血缘元信息（spec §8.5：分支 session 自身显示「↑ fork 自 <父名>」）优先；
           无血缘则显 branch（git 分支）；都无则回退 cwd 末段，避免空行。 -->
      <template v-if="session.parentSession">
        <span class="fork-lineage text-accent/80">{{ t('sidebar.sessionItem.forkFrom') }} {{ session.parentLabel || session.parentSession }}</span>
      </template>
      <template v-else-if="session.gitBranch">{{ session.gitBranch }}</template>
      <template v-else>{{ dirName }}</template>
    </div>
  </div>

  <!-- 右侧：子会话计数 chip（描边 + 层叠图标 + 数字；仅父条目有子会话时渲染，只读中性色，
       不用 accent——accent 已被 [AI] 来源徒标占用）+ 时间文字。 -->
  <span
    v-if="childCount > 0"
    data-testid="session-child-count"
    class="mt-0.5 flex shrink-0 items-center gap-0.5 rounded-sm border border-border-strong px-1 py-px font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
    :title="t('sidebar.sessionItem.childCount', { n: childCount })"
  >
    <Layers class="size-[9px] shrink-0" />
    <span>{{ childCount }}</span>
  </span>
  <span
    class="mt-1 shrink-0 font-mono text-[length:var(--text-3xs)] leading-[1.35] text-neutral-dim"
  >{{ timeLabel }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers } from '@lucide/vue'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { dirNameOf } from '@taiji/ui'
import { isUnread, isMarkedDone } from '@/composables/useSessionMarkers'
import { unreadByBranch } from '@/composables/features/fork-handoff/useForkBranchNotify'
import { isImportedFresh } from '@/composables/features/sidebar/useImportSession'
import type { SessionItemSession } from './types'

/** 左侧状态 icon 种类（7px 单一 icon 范式）。 */
type IconKind = 'spinning' | 'hollow' | 'hollow-dim' | 'waiting' | 'error' | 'done' | 'dead' | 'empty'

const props = withDefaults(defineProps<{
  session: SessionItemSession
  active: boolean
  status: DerivedStatus
  /** 子会话数（按 parentAgentSessionId 计数，SessionList 注入）；0/缺省不渲染徒标 */
  childCount?: number
}>(), { childCount: 0 })

const { t } = useI18n()

/** dead session（进程已退出）：icon 显示 neutral-dim 实心圆 */
const isDead = computed(() => props.session.status === 'dead')

// ── agent-spawned 标记（U8）：标题旁 [AI] badge 只标来源 ──
const isAgentSpawned = computed(() => props.session.spawnSource === 'agent')

// ── 未读 + 标记完成状态（读 useSessionMarkers 模块级响应式集合）──
// 未读两源合流（D9，ForkGroup 退役）：① 后台完成（useCompletionNotify → markUnread）；
// ② 后台分支状态翻转（useForkBranchNotify.unreadByBranch）。两类都是「这里有没看的东西」，
// 同一枚 dot 承载，不新增元素。
const unread = computed(
  () => isUnread(props.session.id) || unreadByBranch.value.get(props.session.id) === true,
)
const markedDone = computed(() => isMarkedDone(props.session.id))

// ── 导入 fresh 徽标（import-session u7）：isImportedFresh 读模块级响应式集合，
//    'visible' 实显 / 'fading' 淡出过渡 / null 不渲染 ──
const freshImportState = computed(() => isImportedFresh(props.session.id))

/**
 * 左侧 7px 状态 icon 映射（单一 icon 范式）。
 * spinning: streaming/compacting/working/retrying → 旋转箭头（accent 边框+透明顶边）
 * hollow: pending → accent 空心圆
 * hollow-dim: stopped → dim 空心圆
 * waiting: 等用户操作 → warn 实心圆
 * error: 出错 → danger 实心圆
 * done: 正常完成 → success 实心圆 90%
 * dead: 进程退出 → neutral-dim 实心圆 50%
 * empty: 已归档+已读 → 无 icon
 */
const iconKind = computed<IconKind>(() => {
  if (isDead.value) return 'dead'
  if (markedDone.value && !unread.value) return 'empty'
  switch (props.status) {
    case 'streaming':
    case 'working':
    case 'compacting':
      return 'spinning'
    case 'pending':
      return 'hollow'
    case 'waiting':
    case 'retrying':
      return 'waiting'
    case 'error':
      return 'error'
    case 'stopped':
      return 'hollow-dim'
    default:
      return 'done'
  }
})

/** 工作目录名（cwd 末段），长路径只显末段防溢出（dirNameOf 收敛到 logic/path SSOT）。
 *  仅在无 fork 血缘且无 gitBranch 时作为副标题兜底（避免空行）。 */
const dirName = computed(() => dirNameOf(props.session.cwd))

/** 时间格式化：复用 logic 层相对时间纯函数（同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))
</script>
