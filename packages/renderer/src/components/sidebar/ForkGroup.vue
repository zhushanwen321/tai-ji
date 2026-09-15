<template>
  <!--
    展示组件 · 当前 session 的后台分支小列表（FR-17，spec §2 层③ + §7 视觉 token）。
    当前激活 session 正下方浮出「本会话的分支」折叠区（方案3），不碰全局扁平结构。

    规范（spec §2 层③ + §7）：
    - 容器：4% accent 混底 + radius（去 border 改层级，spec §3.5.4；不用左色条 accent，design-system §2 反模式）
    - 折叠头：accent 色 + chev 图标 + 「本会话的分支」+ 计数
    - 子项复用 .si 紧凑变体（padding 6px 8px，font-size 12px），带「分支 N」pill
    - fresh 高亮：accent-soft 底 + inset accent-ring，FRESH_FADE_MS(3.2s) 后淡出
    - running 分支项 hover 出「停止」action（两段式确认，调 abort）

    展示组件约束：用本地 ui 原语（components/ui）Button，禁止原生 HTML 表单元素；用 lucide-vue-next 图标，禁止 emoji。
  -->
  <div
    v-if="branches.length > 0"
    class="fork-group mx-1 mb-1 mt-0.5 rounded-[var(--radius)] bg-accent/5"
  >
    <!-- 折叠头：chev + 「本会话的分支」+ 计数 -->
    <Button
      variant="ghost"
      class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left"
      data-testid="fork-group-header"
      @click="collapsed = !collapsed"
    >
      <component
        :is="collapsed ? ChevronRight : ChevronDown"
        class="size-[11px] shrink-0 text-accent"
      />
      <GitFork class="size-[11px] shrink-0 text-accent" />
      <span class="text-[length:var(--text-2xs)] font-medium text-accent">
        {{ t('sidebar.forkGroup.title') }}
      </span>
      <span class="font-mono text-[length:var(--text-3xs)] text-accent opacity-70">{{ branches.length }}</span>
    </Button>

    <!-- 分支列表（展开态） -->
    <div v-show="!collapsed" class="flex flex-col gap-0.5 px-1 pb-1">
      <div
        v-for="(b, idx) in branches"
        :key="b.id"
        data-testid="fork-group-branch"
        class="fork-branch-item group relative flex cursor-pointer items-center gap-1.5 rounded-sm px-2 py-[6px] transition-colors"
        :class="[
          isFreshActive(b.id) ? 'fresh bg-accent-soft ring-1 ring-inset ring-accent-ring' : 'hover:bg-surface-hover',
        ]"
        @click="onBranchClick(b.id)"
        @mouseleave="confirmingStopId = null"
      >
        <!-- 状态点：running → accent 脉冲；done → success；error → danger；其余 subtle。
             未读角标（RV2）：分支状态变化未查看时在状态点外加 accent ring 高亮，用户 select 后清除。 -->
        <span class="relative flex shrink-0">
          <span
            class="size-[5px] rounded-full"
            :class="dotClassFor(b)"
          />
          <span
            v-if="isUnread(b.id)"
            class="absolute -right-1 -top-1 size-[5px] rounded-full bg-accent ring-2 ring-bg"
            data-testid="fork-group-branch-unread"
          />
        </span>
        <div class="min-w-0 flex-1">
          <div class="truncate text-[length:var(--text-xs)] leading-[1.3] text-neutral-fg">{{ b.label }}</div>
          <!-- 分支 N pill（reasoning-soft 底 + 9px mono，spec §3.5.7/§5.6C branch-pill git 分支维度） -->
          <div class="mt-0.5 flex items-center gap-1">
            <span
              class="rounded-[3px] bg-reasoning-soft px-1 font-mono text-[9px] font-semibold leading-[1.4] text-reasoning"
            >
              {{ t('sidebar.forkGroup.branchN', { n: idx + 1 }) }}
            </span>
            <span class="truncate font-mono text-[length:var(--text-3xs)] text-neutral-dim">{{ timeLabelOf(b) }}</span>
          </div>
        </div>

        <!-- fresh 标记锚点（testid，供测试额外定位；视觉由父 fresh class 承载） -->
        <span
          v-if="isFreshActive(b.id)"
          data-testid="fork-group-branch-fresh"
          class="sr-only"
        >fresh</span>

        <!-- 停止 action：仅 running 分支显示（hover 出），两段式确认（仿 SessionItem 删除） -->
        <div
          v-if="isRunning(b)"
          class="shrink-0"
          :class="confirmingStopId === b.id ? 'flex' : 'flex opacity-0 group-hover:opacity-100'"
        >
          <Button
            v-if="confirmingStopId !== b.id"
            variant="ghost"
            size="icon"
            class="size-[20px] rounded-sm border border-border-strong bg-surface text-neutral-mid hover:bg-surface-hover hover:text-danger"
            :title="t('sidebar.forkGroup.stop')"
            data-testid="fork-group-stop"
            @click.stop="confirmingStopId = b.id"
          >
            <Square class="size-[11px]" />
          </Button>
          <Button
            v-else
            variant="ghost"
            size="icon"
            class="size-[20px] rounded-sm border border-danger bg-danger text-neutral-fg"
            :title="t('sidebar.forkGroup.stopConfirm')"
            data-testid="fork-group-stop-confirm"
            @click.stop="onStopConfirm(b.id)"
          >
            <Check class="size-[11px]" />
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 展示组件 · 当前 session 的后台分支小列表（FR-17，spec §2 层③）。
 *
 * 接收已 filter 好的子分支列表（branches），渲染为折叠区 + 紧凑分支项。
 * - fresh 高亮：freshIds 中的分支项标 fresh class，FRESH_FADE_MS 后内部清除（淡出）。
 *   用 setTimeout + 内部 Set 维护活跃 fresh 集合（mount 时启动计时，prop 变化增量计时）。
 * - 停止 action：仅 running 分支（status 'active'）hover 显示，两段式确认 → emit stop。
 */
import { onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { GitFork, ChevronRight, ChevronDown, Square, Check } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import type { SessionSummary } from '@taiji/shared'
import { formatRelativeTime } from '@/composables/logic/formatTime'
import { useForkBranchBadges } from '@/composables/effects/useForkNoticeEffect'

/** fresh 高亮持续时间（ms）。测试用 vi.useFakeTimers + advanceTimersByTime 推进。 */
const FRESH_FADE_MS = 3200

const { t } = useI18n()

/** RV2 未读角标：分支状态变化未查看时 unreadByBranch[branchId]=true。select 时清未读。 */
const { unreadByBranch, clearUnread } = useForkBranchBadges()
function isUnread(branchId: string): boolean {
  return unreadByBranch.value.get(branchId) === true
}
function onBranchClick(branchId: string): void {
  clearUnread(branchId)
  emit('select', branchId)
}

const props = withDefaults(
  defineProps<{
    /** 已 filter 好的子分支列表（parentSession 指向当前 session 的分支） */
    branches: SessionSummary[]
    /** 父 session id（血缘键，仅供调试/未来扩展，当前不参与渲染） */
    parentId?: string
    /** 标记为 fresh 的分支 id 列表（新 fork 高亮，FRESH_FADE_MS 后淡出） */
    freshIds?: string[]
  }>(),
  { freshIds: () => [] },
)

const emit = defineEmits<{
  /** 点击分支项：跳转到该分支 session（此时才发生 panel 切换） */
  select: [sessionId: string]
  /** 两段式确认停止后台分支：调 abort 中止该 session 的 pi 进程 */
  stop: [sessionId: string]
}>()

/** 折叠态（默认展开，spec §4 Key States「默认展开」） */
const collapsed = ref(false)

/** 停止两段式确认态：记录当前在确认态的分支 id（同时只允许一个分支处于确认态） */
const confirmingStopId = ref<string | null>(null)

function onStopConfirm(id: string): void {
  confirmingStopId.value = null
  emit('stop', id)
}

// ── fresh 高亮：内部维护活跃 fresh 集合，每个 id 独立计时（FRESH_FADE_MS 后移除） ──
// 纯响应式驱动：isFreshActive(id) 决定 fresh class，timer 到期从 activeFresh 删除 id，
// 模板 :class 绑定自然更新（DOM patch 异步，测试断言前需 await nextTick）。
const activeFresh = ref(new Set<string>())
/** id → timer 句柄映射（卸载时清理，避免泄漏 + 测试 fake timer 残留） */
const freshTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** 标记某分支为 fresh 并启动淡出计时（若已存在则先清旧 timer 再启新） */
function scheduleFreshFade(id: string): void {
  activeFresh.value.add(id)
  // reactive 触发：Set.add 不触发更新，需重新赋值引用
  activeFresh.value = new Set(activeFresh.value)
  const old = freshTimers.get(id)
  if (old) clearTimeout(old)
  const handle = setTimeout(() => {
    // 纯响应式驱动：从 activeFresh 删除 id，模板 :class 绑定 isFreshActive(id)
    // 自然移除 fresh 视觉类。DOM 更新异步（需 nextTick）——测试用 fake timer
    // 后立即断言 class 者需 await nextTick（见 fork-group.test.ts U20）。
    const next = new Set(activeFresh.value)
    next.delete(id)
    activeFresh.value = next
    freshTimers.delete(id)
  }, FRESH_FADE_MS)
  freshTimers.set(id, handle)
}

/** mount + freshIds 变化时：为新增的 fresh id 启动计时。
 *  浅 watch（Q1-9）：freshIds 更新约定经数组引用替换表达（父组件传新数组；本组件不 mutate prop），
 *  原地 mutate 不触发。当前生产消费方（SessionList）未传该 prop（走默认空数组）。 */
watch(
  () => props.freshIds,
  (ids, oldIds) => {
    const prev = new Set(oldIds ?? [])
    for (const id of ids) {
      if (!prev.has(id)) scheduleFreshFade(id)
    }
  },
  { immediate: true },
)

/** 当前 id 是否处于 fresh 高亮态 */
function isFreshActive(id: string): boolean {
  return activeFresh.value.has(id)
}

onBeforeUnmount(() => {
  for (const handle of freshTimers.values()) clearTimeout(handle)
  freshTimers.clear()
})

/** running 判定：SessionStatus 'active' = pi 进程存活且生成中（可被 abort） */
function isRunning(b: SessionSummary): boolean {
  return b.status === 'active'
}

/** 分支状态点 class（running→accent 脉冲；done→success；error→danger；其余 subtle） */
function dotClassFor(b: SessionSummary): string {
  switch (b.status) {
    case 'active':
      return 'bg-accent animate-pulse'
    case 'done':
      return 'bg-success'
    case 'error':
      return 'bg-danger'
    case 'stopped':
      return 'bg-neutral-dim opacity-50'
    default:
      return 'bg-neutral-dim'
  }
}

/** 时间标签：复用 logic 层相对时间纯函数（与 SessionItem 同一信息原子） */
function timeLabelOf(b: SessionSummary): string {
  return formatRelativeTime(b.lastActiveAt)
}

// 显式声明 props 已读（避免某些 lint 规则误报未使用）。
void props
</script>
