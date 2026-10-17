<!--
  展示组件 · run 组块（trace 块 run-group 类型行组件，W3 壳化拆分自 Block.vue）。
  本组件根 = 原 run-group 分支根 div（.trace-run-group + data-testid="run-group"），无新 DOM 层。
  run 类型分组组块（demo specs/chat/history-load-and-run-grouping.md §3）：连续同类型
  （探索 / 改动 / 执行命令）的工具行折成一行组头。组资格只看工具类型不看状态，组头计数
  三条口径（N=成员数 / 耗时=已完成成员合计 / M=组内失败数）与 hasRunning 由 core
  groupToolRuns 一次算好（header），本组件零解析。类型判定表见 core RUN_GROUP_TOOLS。
  组头：类型名[ · 序号] + 里程碑徽标 + 「N 步 · 耗时」统计段 + 失败 chip。
  展开态：挂载一律收起（2026-10-15 裁决 ①A：无论什么时候分组的 block 默认折叠、不展开
  内部 tool call，running 成员也不例外——回看与直播形态一致，进行中信号由组头动效图标 +
  「N 步」计数承担）；用户手动开合后以手动为准（本地 ref）。**不做 status 驱动的自动开合**——
  展开/收起翻转会让流式中的块高度突变，破坏贴底跟随（同 ToolRow toolCollapsed 挂载快照的
  既有取舍）。展开后成员行直递 ToolRow 收起态（W3：原经 Block 壳递归，成员恒为 core
  groupToolRuns 产出的 tool 块，壳层无分派价值，少一层壳；block-tool-<id> testid 经
  attribute fallthrough 落 ToolRow 根）。
  失败不隐瞒：成员含 error 时行尾 traceFailed 段（M = 组内口径，与 TraceCompactorRow 全局
  failedCount 分账）。展开后成员保持各自 1 行收起态（嵌套普通 tool 行复用既有行形态与
  PR-1 行高不变量），要看某个成员的输出需再点那一行（两步路径）。展开态住组件本地 ref、
  不进 store 不持久化（turn 级展开态现状也不持久化，不为更低层的 UI 态单开先例）。
-->
<template>
  <div class="trace-run-group" data-testid="run-group">
    <div
      data-testid="run-group-header"
      class="group/bgroup flex min-w-0 cursor-pointer select-none items-baseline gap-[8px] [font-weight:var(--fw-mid)] text-neutral-mid"
      role="button"
      tabindex="0"
      :aria-expanded="groupExpanded"
      :title="groupExpanded ? t('panel.message.collapse') : t('panel.message.expand')"
      @click="toggleGroup"
      @keydown.enter.prevent="toggleGroup"
      @keydown.space.prevent="toggleGroup"
    >
      <!-- running 态 loader（呼吸弧 + accent），其余走组类型对应的静态图标（切换走 tico 交叉过渡，
           同 tool/thinking 行）。组头文字（「N 步 · 耗时」计数/耗时口径）是稳定标识，不跑文字扫光。
           行文字不染 accent（demo 运行态 = 仅呼吸弧图标 accent，文字保持行层级 mid，
           workbench.css .tool .t-name），与普通 tool 行运行态同款。 -->
      <RunningBlockIcon v-if="group.hasRunning" :kind="RUN_GROUP_RUNNING_ICON[group.base]" />
      <component :is="BLOCK_ICON_LUCIDE[RUN_GROUP_ICON[group.base]]" v-else :class="[BLOCK_ICON_CLASS, 'self-center']" />
      <span class="shrink-0 whitespace-nowrap text-left transition-opacity duration-[var(--duration-fast)] group-hover/bgroup:opacity-80">{{ t(RUN_GROUP_LABEL_KEY[group.base]) }}</span>
      <!-- 同名组序号（demo `.rg-seq`）：第二个「探索」起显示「 · 2」，同类型的多段在回看时可区分 -->
      <span v-if="group.seq > 1" class="shrink-0 whitespace-nowrap font-mono text-neutral-dim">· {{ group.seq }}</span>
      <!-- 里程碑徽标（demo spec §3.6 `.rg-badge`，位于序号与统计段之间）：core 结构派生的信号
           聚合上组头（当前 = 首个改动），无则不渲染。视觉 = accent 低饱和 pill（字 accent /
           边 accent-ring 30% / 底 accent-soft 10%，SessionItemDisplay agent badge 同族），
           pop 200ms 入场动效见 scoped `.trace-run-group .rg-badge`。 -->
      <span
        v-for="mile in group.miles"
        :key="mile"
        data-testid="run-group-mile"
        class="rg-badge shrink-0 whitespace-nowrap rounded-full border border-accent-ring bg-accent-soft px-[7px] font-mono text-[length:var(--text-xs)] text-accent"
      >{{ t(RUN_GROUP_MILE_LABEL_KEY[mile]) }}</span>
      <span class="min-w-0 truncate text-left font-mono text-neutral-dim transition-opacity duration-[var(--duration-fast)] group-hover/bgroup:opacity-80">{{ groupStatText }}</span>
      <!-- 失败段 chip 化（demo failtag 形态：workbench.css .failtag = 11px fw-mid danger +
           danger-soft 底 + r-xs 4px + 1px 6px 内边距） -->
      <span v-if="group.header.failedCount > 0" data-testid="run-group-failed" class="shrink-0 rounded-[var(--radius-xs)] bg-danger-soft px-1.5 py-px text-[length:var(--text-2xs)] [font-weight:var(--fw-mid)] text-danger">{{ t('panel.message.traceFailed', { count: group.header.failedCount }) }}</span>
    </div>
    <Transition name="block-expand">
      <!-- 成员行直递 ToolRow（收起态）：core groupToolRuns 成员恒为 kind='tool' 的普通工具块
           （runBaseOf 只对 kind==='tool' 给组类型，agentgraph 名单外原样成行不入组），行形态
           分派（subagent/workflow 三分）与展开区全在 ToolRow 内部，与顶层 tool 块同一组件同一
           形态。key = m.flatIndex（PR-6 方向①：段尾延长 members 增长不 remount 既有成员行）。
           block-tool-<id> testid 经 fallthrough 落 ToolRow 根（原由 Block 壳根承担，W3 去壳后
           由本组件补挂——成员行 E2E 锚点契约不变）。 -->
      <div v-if="groupExpanded" class="mt-0.5 flex min-w-0 flex-col">
        <ToolRow
          v-for="m in group.members"
          :key="m.flatIndex"
          :tool="m.block.kind === 'tool' || m.block.kind === 'agentgraph' ? (m.block.ref as ToolCall) : undefined"
          :session-id="sessionId"
          :data-testid="memberTestId(m)"
        />
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '@taiji/shared'
import type { FlatBlock, RunGroupBase, RunGroupMile } from '@taiji/core/domain/chat'
import ToolRow from './ToolRow.vue'
import RunningBlockIcon from './RunningBlockIcon.vue'
import type { BlockIconKind, RunningIconKind } from './block-icon'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE } from './block-icon'
import { MS_PER_SECOND, formatDuration } from './format-utils'

const { t } = useI18n()

const props = defineProps<{
  /** run 组块数据（Turn.vue → Block 壳透传；契约 base/seq/members/header/hasRunning/miles）。
   *  base/seq 与 header 三条口径（count/durationMs/failedCount）由 core groupToolRuns 一次算好；
   *  miles = 里程碑徽标（§3.6，core 结构派生），空/缺省 = 无则不显示。 */
  group: {
    base: RunGroupBase
    seq: number
    members: FlatBlock[]
    header: { count: number; durationMs: number; failedCount: number }
    hasRunning: boolean
    miles?: RunGroupMile[]
  }
  /** 所属 session（透传成员行 ToolRow → 富渲染 / 图片出口 / workflow overlay 反查） */
  sessionId?: string | null
}>()

/* ── 组头：图标 / 组名 / 统计段 ─────────────────────────────────────────── */

/** 组类型 → 块图标：与同语义工具行同图标（探索 = 只读档 book-open / 改动 = pencil /
 *  执行命令 = square-terminal），三档都复用既有 BlockIconKind，不新开图标（组头即该段语义的标题）。
 *  排掉 'running'——组头运行态走 loader 分支（hasRunning），静态档永远不是 running 图标。 */
const RUN_GROUP_ICON: Record<RunGroupBase, Exclude<BlockIconKind, 'running'>> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** 组类型 → 组头名（ui locale：探索 / 改动 / 执行命令） */
const RUN_GROUP_LABEL_KEY: Record<RunGroupBase, string> = {
  explore: 'panel.message.runGroupExplore',
  edit: 'panel.message.runGroupEdit',
  exec: 'panel.message.runGroupExec',
}

/** 组类型 → 组头运行中动效 kind（RunningBlockIcon；组头动效 = 组类别同款——探索扫描 /
 *  改动描线 / 命令光标闪烁，与成员行各自动效同源，不新开动画） */
const RUN_GROUP_RUNNING_ICON: Record<RunGroupBase, RunningIconKind> = {
  explore: 'tool-read',
  edit: 'tool-edit',
  exec: 'tool-bash',
}

/** 里程碑 → 徽标文案（ui locale）。当前唯一信号 firstEdit（首个改动）——信号来源与「语义里程碑
 *  不关键词派生」的裁决见 core RunGroupMile 类型注释。 */
const RUN_GROUP_MILE_LABEL_KEY: Record<RunGroupMile, string> = {
  firstEdit: 'panel.message.runGroupMileFirstEdit',
}

/**
 * 组头统计段「N 步 · 耗时」：耗时只在 ≥1s 时显示（不足 1s 的秒数对回看没有信息量，demo `.rg-stat`
 * 同口径）。耗时口径 = 组内已完成成员合计（core 侧算好），running 成员不计入。
 */
const groupStatText = computed(() => {
  const steps = t('panel.message.runGroupSteps', { count: props.group.header.count })
  return props.group.header.durationMs >= MS_PER_SECOND ? `${steps} · ${formatDuration(props.group.header.durationMs)}` : steps
})

/**
 * 成员行 testid：block-tool-<id>（原 Block 壳 testId computed 的 tool 族口径——
 * tool/agentgraph 且 ref 有 id；core 成员恒 kind='tool'，agentgraph 支路为类型完备保留）。
 * 经 `<ToolRow :data-testid>` fallthrough 落 ToolRow 根 div。
 */
function memberTestId(m: FlatBlock): string | undefined {
  const id = m.block.kind === 'tool' || m.block.kind === 'agentgraph' ? (m.block.ref as ToolCall).id : undefined
  return id ? `block-tool-${id}` : undefined
}

/* ── 组展开态：组件本地 ref，不进 store、不持久化——turn 级展开态（useTurnExpansion /
 *    turn-expansion store）现状也不持久化，不为一个更低层的 UI 态单开持久化先例。
 *    初值 = 恒收起（2026-10-15 裁决 ①A：原「组内有 running 成员则展开」例外已删——无论什么时候
 *    默认折叠，回看与直播形态一致），此后只由用户点击翻转。**不做 status 驱动的自动开合**：
 *    展开/收起翻转会让流式中的块高度突变、破坏贴底跟随（同 toolCollapsed 挂载快照的既有取舍，
 *    见 ToolRow.vue 该处注释的「被否」一条）。 ── */
const groupCollapsed = ref(true)
const groupExpanded = computed(() => !groupCollapsed.value)

function toggleGroup(): void {
  groupCollapsed.value = !groupCollapsed.value
}
</script>

<style scoped>
/* 块展开/收起过渡（chat-flow-polish P0-2）：消除 v-if 瞬时切换的生硬感。
   opacity + 轻微 translateY（从 header 方向淡入），120ms；保持 v-if 卸载折叠块的长输出
   （不做 grid 恒渲染，避免 streaming 中折叠块长输出恒挂载的性能代价）。
   escape hatch：Vue Transition 类用 scoped 表达（enter-from/leave-to 同时设 opacity+transform）。
   与 ThinkingRow.vue / ToolRow.vue 各持一份同款规则——scoped 样式只作用于本组件模板
   元素（消费点 = 组展开区容器）。 */
.block-expand-enter-active,
.block-expand-leave-active {
  transition:
    opacity var(--duration-fast) var(--ease),
    transform var(--duration-fast) var(--ease);
}
.block-expand-enter-from,
.block-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* run 组头里程碑徽标入场（demo spec §3.5/§3.6 workbench.css .rg-badge + rg-badge-pop 同参）：
   opacity 0→1 + scale 0.6→1，200ms --ease-out-soft，backwards 填充（挂载帧即取 from 态，
   无闪烁）。徽标挂 v-for 上——首个改动完成、组首次渲染时元素插入，动画自然播一次。
   escape hatch 同 ToolRow.vue 的 .fchip-roll-x：keyframes + 后代选择器（Tailwind 无法表达 scale+opacity
   组合的入场帧），仅本组件单消费点。reduced-motion 显式停播（demo 同档；全局 0.01ms
   兜底只会瞬切终态，此处显式声明降级语义）。 */
.trace-run-group .rg-badge { animation: run-group-badge-pop 200ms var(--ease-out-soft, var(--ease-out)) backwards; }
@keyframes run-group-badge-pop { from { opacity: 0; transform: scale(0.6); } }
@media (prefers-reduced-motion: reduce) { .trace-run-group .rg-badge { animation: none; } }

</style>
