<template>
  <!--
    SessionItem 条目展示子块：label + 徽标（左）+ 右侧固定槽（7px 状态 icon + 时间）（单行，
    demo .si 形态——分支/cwd/fork 血缘等元信息归 hover 详情卡展示，列表行不占副行）。
    纯展示（零 emit）：unread / markedDone / fresh 徽标读模块级响应式集合，
    toggle 由 Actions 子组件执行，此处响应式自动跟随。
    [2026-10-11 用户裁决改版] 状态点自名称左侧移到右侧时间左边（名称贴左缩进、贴近项目
    左线）；右侧槽定宽 58px（容纳悬停三钮 18px×3 + 2px 间隙），名称块 flex-1 min-w-0 截断
    ——悬停钮以 absolute inset-0 覆盖槽内「点 + 时间」（Actions 子组件经默认 slot 注入），
    构造性保证不遮名称。槽内 meta 与钮互斥显隐（opacity 切换，占位不变零布局跳动）。
  -->
  <!-- 主体：label + sub（fork 血缘 / branch）。label 形态 = demo .si .nm（13px fw-mid fg-2，
       选中态 fg——active 由父组件透传，demo .si.on 行级 color 覆盖的等价实现）。 -->
  <div class="min-w-0 flex-1">
    <div
      class="flex min-w-0 items-center gap-1 text-[length:var(--text-sm)] [font-weight:var(--fw-mid)] leading-[1.55]"
      :class="[active ? 'text-neutral-fg' : 'text-neutral-fg-2', markedDone ? 'opacity-60' : '']"
    >
      <span class="min-w-0 flex-1 truncate">{{ session.label }}</span>
      <!-- agent-spawned badge（U8）：accent 低饱和形态（bg-accent-soft 底 + accent 字）；
           尺寸/圆角对齐同目录 FileTreeRow badge（rounded-sm px-1 py-0.5 text-[length:var(--text-3xs)]），
           不抢右侧状态点焦点 -->
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
      <!-- 已交接徽标（chat-flow-consistency U9 / S8）：handedOffTo 非空（源会话已完成
           handoff 交接，runtime handoff_marker sidecar 持久 + 扫描恢复）→ 常驻小徽标。
           中性 dim 描边形态（不用 accent——accent 已被 [AI] 来源与 fresh 徽标占用，
           交接是既成事实元信息非待办信号）；title 显目标名（容器反查注入，目标已删
           回退 id 前缀——已发生事实不回滚，徽标照显）。 -->
      <span
        v-if="session.handedOffTo"
        data-testid="session-handoff-badge"
        class="shrink-0 cursor-default rounded-sm border border-border-strong px-1 py-0.5 font-mono text-[length:var(--text-3xs)] leading-none text-neutral-dim"
        :title="t('sidebar.sessionItem.handedOffTo', { target: handoffTargetTitle })"
      >{{ t('sidebar.sessionItem.handoffBadge') }}</span>
    </div>
  </div>

  <!-- 右侧：子会话计数 chip（描边 + 层叠图标 + 数字；仅父条目有子会话时渲染，只读中性色，
       不用 accent——accent 已被 [AI] 来源徒标占用）。悬停钮只覆盖右槽（点 + 时间），
       chip 在槽外不受覆盖。 -->
  <span
    v-if="childCount > 0"
    data-testid="session-child-count"
    class="flex shrink-0 items-center gap-0.5 rounded-sm border border-border-strong px-1 py-px font-mono text-[length:var(--text-3xs)] leading-[1.3] text-neutral-dim"
    :title="t('sidebar.sessionItem.childCount', { n: childCount })"
  >
    <Layers class="size-[9px] shrink-0" />
    <span>{{ childCount }}</span>
  </span>

  <!-- 右侧固定槽（用户裁决 2026-10-11）：定宽 58px = 悬停三钮（18px×3 + gap 2×2）宽，
       点 + 时间右对齐常驻；悬停/聚焦时 meta 淡出、Actions 钮（默认 slot 注入，absolute
       inset-0 覆盖本槽）淡入——显隐走 opacity，占位恒定零布局跳动；名称块在槽左缘截断，
       钮构造性不遮名称。 -->
  <div class="relative flex h-full w-[58px] shrink-0 items-center justify-end gap-[8px]">
    <div
      class="flex items-center gap-[8px]"
      data-testid="session-meta"
      :class="confirming ? 'opacity-0' : 'group-hover/item:opacity-0 group-focus-within/item:opacity-0'"
    >
      <!-- 7px 状态 icon（原名称左侧位右移至此）：unread(未读替换) / spinning(旋转箭头) /
           hollow(空心圆) / waiting / error / done / stopped / dead / 空。未读为替换式：
           accent 实心点本体取代状态 icon——叠加式几何上盖不全 7px 状态点，左下必露底层点月牙边。 -->
      <span v-if="iconKind === 'unread'" data-testid="session-unread-dot" class="block size-[7px] shrink-0 rounded-full bg-accent" />
      <span v-else-if="iconKind === 'spinning'" data-testid="session-icon" class="block size-[7px] shrink-0 animate-spin rounded-full border-[1.5px] border-accent border-t-transparent" />
      <span v-else-if="iconKind === 'hollow'" data-testid="session-icon" class="block size-[7px] shrink-0 rounded-full border-[1.5px] border-accent" />
      <span v-else-if="iconKind === 'hollow-dim'" data-testid="session-icon" class="block size-[7px] shrink-0 rounded-full border-[1.5px] border-neutral-dim opacity-60" />
      <span v-else-if="iconKind === 'waiting'" data-testid="session-icon" class="block size-[7px] shrink-0 rounded-full bg-warn" />
      <span v-else-if="iconKind === 'error'" data-testid="session-icon" class="block size-[7px] shrink-0 rounded-full bg-danger" />
      <span v-else-if="iconKind === 'done'" data-testid="session-icon" class="block size-[7px] shrink-0 rounded-full bg-success opacity-90" />
      <span v-else-if="iconKind === 'dead'" data-testid="session-icon" class="block size-[7px] shrink-0 rounded-full bg-neutral-dim opacity-50" />
      <span v-else data-testid="session-icon" class="block size-[7px] shrink-0" aria-hidden="true" />
      <span
        class="shrink-0 font-mono text-[length:var(--text-2xs)] leading-[1.55] text-neutral-dim"
      >{{ timeLabel }}</span>
    </div>
    <!-- 悬停操作钮注入点（SessionItemActions，absolute inset-0 覆盖本槽） -->
    <slot />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Layers } from '@lucide/vue'
import type { DerivedStatus } from '@/types'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { isUnread, isMarkedDone } from '@/composables/useSessionMarkers'
import { unreadByBranch } from '@/composables/features/fork-handoff/useForkBranchNotify'
import { isImportedFresh } from '@/composables/features/sidebar/useImportSession'
import type { SessionItemSession } from './types'

/** 左侧（现右槽）状态 icon 种类（7px 单一 icon 范式）。 */
type IconKind = 'unread' | 'spinning' | 'hollow' | 'hollow-dim' | 'waiting' | 'error' | 'done' | 'dead' | 'empty'

const props = withDefaults(defineProps<{
  session: SessionItemSession
  status: DerivedStatus
  /** 子会话数（按 parentAgentSessionId 计数，SessionList 注入）；0/缺省不渲染徒标 */
  childCount?: number
  /** 选中态（SessionItem 透传）：标题字色提档 fg-2 → fg（demo .si.on 行级覆盖） */
  active?: boolean
  /** 删除两段确认态（SessionItem 透传 Actions 的同一状态）：true 时右槽 meta 让位 */
  confirming?: boolean
}>(), { childCount: 0 })

const { t } = useI18n()

/** dead session（进程已退出）：icon 显示 neutral-dim 实心圆 */
const isDead = computed(() => props.session.status === 'dead')

// ── agent-spawned 标记（U8）：标题旁 [AI] badge 只标来源 ──
const isAgentSpawned = computed(() => props.session.spawnSource === 'agent')

// ── 已交接徽标（chat-flow-consistency U9 / S8）：title 目标名 = 容器反查注入的显示名，
//    查不到（目标已删/跨组）回退目标 id 前缀（uuid 前 HANDOFF_ID_PREFIX 位已可辨识）。 ──
const HANDOFF_ID_PREFIX = 8
const handoffTargetTitle = computed(() => {
  const target = props.session.handedOffTo ?? ''
  return props.session.handoffTargetLabel || target.slice(0, HANDOFF_ID_PREFIX)
})

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
 * 状态 icon 映射（单一 icon 范式，位次随裁决移至右槽）。
 * unread: 未读（后台完成 / fork 分支变更，两源合流）→ accent 实心圆替换状态 icon
 * spinning: streaming/compacting/working/retrying → 旋转箭头（accent 边框+透明顶边）
 * hollow: pending → accent 空心圆
 * hollow-dim: stopped → dim 空心圆
 * waiting: 等用户操作 → warn 实心圆
 * error: 出错 → danger 实心圆
 * done: 正常完成 → success 实心圆 90%
 * dead: 进程退出 → neutral-dim 实心圆 50%
 * empty: 已归档+已读 → 无 icon（占位 7px 空白，保时间对齐稳定）
 */
const iconKind = computed<IconKind>(() => {
  if (unread.value) return 'unread'
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

/** 时间格式化：复用 logic 层相对时间纯函数（同一信息原子） */
const timeLabel = computed(() => formatRelativeTime(props.session.lastActiveAt))
</script>
