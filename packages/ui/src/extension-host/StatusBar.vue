<script setup lang="ts">
/**
 * StatusBar（W3 · T2，C3 契约，S4 IF5 + clarify Q2/Q4 修订；A4 对齐）——main-panel 局部底栏。
 *
 * 消费 S2 StatusBarController 聚合状态（per-session + global 两 scope，经注入
 * StatusBarSource）。A4 排列：alignment left/right 两段，同段内按 priority 降序
 * （大→左/前，spec §2 A4「聚合按 alignment(left/right) + priority 排序」）；
 * 同 priority 保持合并顺序（per-session 在前 global 在后）。
 *
 * 自隐藏（clarify Q4 双级）：text 空串/纯空白的项不渲染（builtin statusline
 * 初始 text:'' 由 runtime 广播填充，填充前不可见）；两 scope 合并后无任何可渲染项
 * 时根元素 v-if 隐藏（不占位）。
 *
 * A4 视觉（spec §2 A4）：容器 26px 高 bg-elevated text-xs；每项前置 7px 状态点
 * （ok=success / warn=warn / danger=danger / neutral=neutral-ico / plugin-src=accent），
 * 无 status 的项不渲染圆点；溢出不换行、容器横向滚动且隐藏滚动条（priority 高优先
 * 可见由段内降序保证——高 priority 靠段首，先进入可见区）。
 *
 * 命令执行（clarify Q2）：含 commandId 的项点击调 props.onCommand(commandId)，
 * 由父层（壳/P5）把 S2 IF6 CommandRegistry.execute 适配进来；无 commandId 项
 * 纯展示不可点击。
 *
 * 数据源经 inject 注入（STATUS_BAR_SOURCE_KEY），壳 provide 真实实现，单测
 * global.provide mock；无注入时静默空态不崩（design-review R3）。
 */
import { computed, inject } from 'vue'
import { STATUS_BAR_SOURCE_KEY, type StatusBarEntry, type StatusDot } from './status-bar-source'

const props = withDefaults(
  defineProps<{
    /** 当前 sessionId；null 时跳过 per-session scope（仅渲染 global 项） */
    sessionId?: string | null
    /** 命令执行器（commandId → 执行），父层把 CommandRegistry.execute 适配进来 */
    onCommand?: (commandId: string) => void
  }>(),
  { sessionId: null, onCommand: undefined },
)

const source = inject(STATUS_BAR_SOURCE_KEY, null)

/** A4 状态点五色 class 映射（spec §2 A4）。 */
const DOT_CLASS: Record<StatusDot, string> = {
  ok: 'bg-success',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-neutral-ico',
  'plugin-src': 'bg-accent',
}

const dotClass = (status?: StatusDot) => (status ? DOT_CLASS[status] : '')

/** 两 scope 合并 + 空 text 过滤 + A4 排序（left/right 两段，段内 priority 降序） */
const visibleItems = computed<StatusBarEntry[]>(() => {
  if (!source) return []
  const hasText = (entry: StatusBarEntry) => entry.text.trim().length > 0
  const perSession = props.sessionId ? source.getItems('per-session', props.sessionId) : []
  const global = source.getItems('global')
  const all = [...perSession.filter(hasText), ...global.filter(hasText)]
  const byPriority = (a: StatusBarEntry, b: StatusBarEntry) => b.priority - a.priority
  const left = all.filter((entry) => entry.alignment !== 'right').sort(byPriority)
  const right = all.filter((entry) => entry.alignment === 'right').sort(byPriority)
  return [...left, ...right]
})
</script>

<template>
  <div
    v-if="visibleItems.length > 0"
    data-testid="status-bar"
    class="status-bar flex h-[26px] items-center gap-2 overflow-x-auto bg-elevated px-3 text-xs"
  >
    <span
      v-for="item in visibleItems"
      :key="item.id"
      data-testid="status-bar-item"
      :title="item.tooltip"
      class="whitespace-nowrap text-muted-foreground"
      :class="[
        item.alignment === 'right' ? 'ml-auto' : '',
        item.commandId ? 'cursor-pointer hover:text-foreground' : '',
      ]"
      @click="item.commandId && onCommand?.(item.commandId)"
    >
      <span
        v-if="item.status"
        data-testid="status-bar-dot"
        class="mr-1 inline-block size-[7px] shrink-0 rounded-full align-middle"
        :class="dotClass(item.status)"
      />
      {{ item.text }}
    </span>
  </div>
</template>

<style scoped>
/* A4 溢出：容器横向滚动但隐藏滚动条（scrollbar 伪元素 Tailwind 无法表达，escape hatch） */
.status-bar {
  scrollbar-width: none;
}
.status-bar::-webkit-scrollbar {
  display: none;
}
</style>
