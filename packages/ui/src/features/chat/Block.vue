<template>
  <!-- split-justified: trace 块转发壳（run-group 组块暂住壳内，W3 迁出 RunGroupBlock 后回归预算并删本标记） -->
  <!--
    展示组件 · trace 块转发壳（message-stream 折叠区内的单个块，Turn 层唯一渲染单元入口）。
    壳职责：根元素持 .trace-blk / .trace-blk--text 类名契约（下方块间节奏注释——容器选择器
    前锚，类名丢失只会静默丢间距，无类型错误可查）+ data-testid（block-tool-<id> /
    block-thinking-<id>）+ 按 type 分派行组件。转发壳不引入新 DOM 层（壳根 = 原 Block 根
    div，Row 根 = 原分支根 div），视觉像素不变。
    - thinking → ThinkingRow（折叠状态机 / 尾行视口 / 时长 / 扫光 / 展开区）。
    - text → TextRow（markdown / error 追加行 / 行尾时刻 / turn-actions 锚行；#turn-actions
      插槽经壳透传，锚行开关经 hasTurnActions 由壳 $slots 判空传入）。
    - tool / agentgraph → ToolRow（行组件内部按 isSubagent/isWorkflow 三分：subagent →
      SubagentRow / workflow → WorkflowRow / 其余普通 tool 形态——agentgraph 数据结构同
      tool，Turn 层 type 语义与渲染分派在行组件内一致）。
    - run-group 暂住壳内（W3 迁出 RunGroupBlock）：run 类型分组组块——组头「类型名[ · 序号] +
      N 步 · 耗时 + 含 M 次失败」，展开后成员行嵌套递归渲染普通 tool 收起态（SFC 文件名自引用）。
    - failed（tool/agentgraph 族）：无鲜红全展开（红框已删），行文字保持中性灰、图标常驻染
      danger（demo .line.subagent.failed .sicon 形态），错误摘要进 body 文本（形态细节随各 Row）。
    审批按钮 DEFERRED（G-018），v1 不渲染。failed 救生按钮不做（agent 自处理，design.md 决策 3）。
  -->
  <!-- 块间节奏（MF-1-3，demo workbench.css 机制同构）：间距唯一权威 = Turn.vue trace 容器
       scoped——过程行块 py 5px 与块间 margin 两档均在容器侧（.trace-blk--text 正文块无 py，
       与 demo .line 仅过程行挂 padding 一致）。trace-blk--text 是正文类型标记，供容器侧
       选择器前锚。
       [M3b demo 复刻] 块级 running 容器染色（chat-flow-polish P0-1 accent 左标 + soft 底）已删：
       demo 运行态只落在行级（呼吸弧 accent 图标 + 文字扫光，workbench.css .run-ic/.shine），
       .blk 容器无任何 running 形态——行级信号已足，块级染色是 demo 不存在的自行发明。 -->
  <div class="trace-blk" :class="type === 'text' ? 'trace-blk--text' : ''" :data-testid="testId">
    <!-- thinking 行 → ThinkingRow（折叠状态机 / 尾行视口 / 时长 / 扫光 / 展开区，W1 迁出） -->
    <ThinkingRow
      v-if="type === 'thinking'"
      :content="content"
      :thinking-id="thinkingId"
      :collapsed="collapsed"
      :working="working"
      :thinking-start="thinkingStart"
      :thinking-end="thinkingEnd"
      :message-timestamp="messageTimestamp"
      :session-id="sessionId"
    />

    <!-- 正文行 → TextRow（markdown / error 追加行 / 行尾时刻 / turn-actions 锚行，W1 迁出；
         #turn-actions 插槽经壳透传，锚行开关 = 壳 $slots 判空） -->
    <TextRow
      v-else-if="type === 'text'"
      :content="content"
      :streaming="streaming"
      :status="status"
      :error="error"
      :message-timestamp="messageTimestamp"
      :session-id="sessionId"
      :has-turn-actions="!!$slots['turn-actions']"
    >
      <template #turn-actions>
        <slot name="turn-actions" />
      </template>
    </TextRow>

    <!-- ── run 组块（run 类型分组，demo specs/chat/history-load-and-run-grouping.md §3）：
         连续同类型（探索 / 改动 / 执行命令）的工具行折成一行组头。组资格只看工具类型不看状态，
         组头计数三条口径（N=成员数 / 耗时=已完成成员合计 / M=组内失败数）与 hasRunning 由 core
         groupToolRuns 一次算好（header），本组件零解析。类型判定表见 core RUN_GROUP_TOOLS。
         展开态：挂载一律收起（2026-10-15 裁决 ①A：无论什么时候分组的 block 默认折叠、不展开
         内部 tool call，running 成员也不例外——回看与直播形态一致，进行中信号由组头动效图标 +
         「N 步」计数承担）；用户手动开合后以手动为准（本地 ref）。**不做 status 驱动的自动开合**——
         展开/收起翻转会让流式中的块高度突变，破坏贴底跟随（同 Block toolCollapsed 挂载快照的既有取舍）。
         失败不隐瞒：成员含 error 时行尾 traceFailed 段（M = 组内口径，与 TraceCompactorRow 全局
         failedCount 分账）。展开后成员保持各自 1 行收起态（嵌套普通 tool Block 复用既有行形态与
         PR-1 行高不变量），要看某个成员的输出需再点那一行（两步路径）。展开态住组件本地 ref、
         不进 store 不持久化（turn 级展开态现状也不持久化，不为更低层的 UI 态单开先例）。 -->
    <div v-else-if="type === 'run-group' && group" class="trace-run-group" data-testid="run-group">
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
        <div v-if="groupExpanded" class="mt-0.5 flex min-w-0 flex-col">
          <Block
            v-for="m in group.members"
            :key="m.flatIndex"
            :type="m.block.kind"
            :tool="m.block.kind === 'tool' || m.block.kind === 'agentgraph' ? (m.block.ref as ToolCall) : undefined"
            :session-id="sessionId"
          />
        </div>
      </Transition>
    </div>

    <!-- 工具行 → ToolRow（tool / agentgraph 转发，W2 迁出；行组件内部按工具名三分
         subagent / workflow / 普通 tool） -->
    <ToolRow
      v-else-if="type === 'tool' || type === 'agentgraph'"
      :tool="tool"
      :session-id="sessionId"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MessageStatus, ToolCall } from '@taiji/shared'
import type { FlatBlock, RunGroupBase, RunGroupMile } from '@taiji/core/domain/chat'
import ThinkingRow from './ThinkingRow.vue'
import TextRow from './TextRow.vue'
import ToolRow from './ToolRow.vue'
import RunningBlockIcon from './RunningBlockIcon.vue'
import type { BlockIconKind, RunningIconKind } from './block-icon'
import { BLOCK_ICON_CLASS, BLOCK_ICON_LUCIDE } from './block-icon'
import { MS_PER_SECOND, formatDuration } from './format-utils'

const { t } = useI18n()

const props = defineProps<{
  type: 'thinking' | 'tool' | 'text' | 'agentgraph' | 'run-group'
  /** thinking / text 内容 */
  content?: string
  /** thinking 块 id（thinking 类型时由父组件透传，用于 data-testid 精确锚定；其他类型忽略） */
  thinkingId?: string
  /** thinking 起止毫秒时间戳（ThinkingBlock.startTime/endTime 透传，N6 思考行时长数据源；
   *  任一缺失不渲染时长——持久化重载链路 thinking part 无时间戳，维持现状展示） */
  thinkingStart?: number
  thinkingEnd?: number
  /** tool_call 数据（type==='tool' 时必填） */
  tool?: ToolCall
  /** run 组块数据（type==='run-group' 时由 Turn.vue 透传；组块数据契约 base/seq/members/header/hasRunning/miles）。
   *  base/seq 与 header 三条口径（count/durationMs/failedCount）由 core groupToolRuns 一次算好；
   *  miles = 里程碑徽标（§3.6，core 结构派生），空/缺省 = 无则不显示。 */
  group?: {
    base: RunGroupBase
    seq: number
    members: FlatBlock[]
    header: { count: number; durationMs: number; failedCount: number }
    hasRunning: boolean
    miles?: RunGroupMile[]
  }
  /** thinking 块初始折叠态（来自 ThinkingBlock.collapsed，默认收起） */
  collapsed?: boolean
  /** working 态（turn 进行中）：thinking 各态默认折叠（collapsed 初值 true），working→false
   *  未手动操作过的块回落收起（SSOT §3.3.3）。
   *  折叠态 working=true 时渲染尾部行窗口 + 双轴尾部追踪（W4 D4），
   *  working=false 保持头部 60 字符静态预览。
   *  tool 块不因 working 强制展开（streaming 态也 1 行收起，header 自带状态指示）。 */
  working?: boolean
  /** streaming 态（所属 assistant 正在流式）：驱动 text 分支颜色——streaming→text-neutral-mid，
   *  complete/缺省→text-neutral-fg（单调，不随兄弟 message 到达翻转）。
   *  由 Turn.vue 传 assistant.status === 'streaming'。thinking/tool/agentgraph 分支不消费此 prop。 */
  streaming?: boolean
  /** 所属 assistant 消息终态（text 分支 error 形态判定，SSOT §3.3.2）：
   *  status==='error' → 追加形态（content 崩溃前正文原色 + error 独立 danger 行）。
   *  [M2 形态统一] 纯 error 形态已消灭——错误文本只住 error 字段，content 恒为崩溃前
   *  正文（手动追加的错误消息 content 为空），渲染只有追加形态一种。thinking/tool 分支不消费。 */
  status?: MessageStatus
  /** 错误文本（assistant Message.error 字段，status==='error' 时有值——收口兜底保证非空）。 */
  error?: string
  /** 所属 assistant message 时刻（epoch ms，行尾时刻显示） */
  messageTimestamp?: number
  /** 所属 session（透传给 MarkdownRenderer 供文件路径打开 DetailPane 用） */
  sessionId?: string | null
}>()

/* ── run 组块：图标 / 组名 / 统计段 / 展开态 ─────────────────────────────── */

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
  const g = props.group
  if (!g) return ''
  const steps = t('panel.message.runGroupSteps', { count: g.header.count })
  return g.header.durationMs >= MS_PER_SECOND ? `${steps} · ${formatDuration(g.header.durationMs)}` : steps
})

/* ── run 组展开态：组件本地 ref，不进 store、不持久化——turn 级展开态（useTurnExpansion /
 *    turn-expansion store）现状也不持久化，不为一个更低层的 UI 态单开持久化先例。
 *    初值 = 恒收起（2026-10-15 裁决 ①A：原「组内有 running 成员则展开」例外已删——无论什么时候
 *    默认折叠，回看与直播形态一致），此后只由用户点击翻转。**不做 status 驱动的自动开合**：
 *    展开/收起翻转会让流式中的块高度突变、破坏贴底跟随（同 toolCollapsed 挂载快照的既有取舍，
 *    见该处注释的「被否」一条）。 ── */
const groupCollapsed = ref(true)
const groupExpanded = computed(() => !groupCollapsed.value)

function toggleGroup(): void {
  groupCollapsed.value = !groupCollapsed.value
}

/** data-testid 锚点：按块类型拼接可定位 id，供 E2E 精确断言特定块。
 *  格式：block-tool-${tool.id}（type==='tool'/'agentgraph' 且有 tool）/ block-thinking-${thinkingId}（type==='thinking'）。
 *  agentgraph（subagent/workflow）数据结构同 tool（ToolCall 有 id），故共用 block-tool 前缀。
 *  无 id（text / thinking 无 id）时回退 undefined（不输出 data-testid 属性，避免污染选择器）。 */
const testId = computed(() => {
  if (props.type === 'tool' || props.type === 'agentgraph') {
    const id = props.tool?.id
    return id ? `block-tool-${id}` : undefined
  }
  if (props.type === 'thinking') {
    return props.thinkingId ? `block-thinking-${props.thinkingId}` : undefined
  }
  return undefined
})
</script>

<style scoped>
/* 块展开/收起过渡（chat-flow-polish P0-2）：消除 v-if 瞬时切换的生硬感。
   opacity + 轻微 translateY（从 header 方向淡入），120ms；保持 v-if 卸载折叠块的长输出
   （不做 grid 恒渲染，避免 streaming 中折叠块长输出恒挂载的性能代价）。
   escape hatch：Vue Transition 类用 scoped 表达（enter-from/leave-to 同时设 opacity+transform）。
   与 ThinkingRow.vue / ToolRow.vue 各持一份同款规则——scoped 样式只作用于本组件模板
   元素（壳内消费点 = run-group 展开区；tool 展开过渡随 W2 迁 ToolRow）。 */
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
