<!--
  展示组件 · trace 块转发壳（message-stream 折叠区内的单个块，Turn 层唯一渲染单元入口）。
  壳职责：根元素持 .trace-blk / .trace-blk--text 类名契约（下方块间节奏注释——容器选择器
  前锚，类名丢失只会静默丢间距，无类型错误可查）+ data-testid（block-tool-<id> /
  block-thinking-<id>）+ 按 type 分派行组件。壳无状态（无 ref / watch / 本地折叠态，
  展开态由各 Row 组件自持），转发不引入新 DOM 层（壳根 = 原 Block 根 div，Row 根 =
  原分支根 div），视觉像素不变。五类型转发表：
  - thinking → ThinkingRow（折叠状态机 / 尾行视口 / 时长 / 扫光 / 展开区）。
  - text → TextRow（markdown / error 追加行 / 行尾时刻 / turn-actions 锚行；#turn-actions
    插槽经壳透传，锚行开关经 hasTurnActions 由壳 $slots 判空传入）。
  - run-group → RunGroupBlock（run 类型分组组块：组头「类型名[ · 序号] + N 步 · 耗时 +
    含 M 次失败」+ 展开成员列表，成员行在行组件内直递 ToolRow 收起态）。
  - tool / agentgraph → ToolRow（行组件内部按 isSubagent/isWorkflow 三分：subagent →
    SubagentRow / workflow → WorkflowRow / 其余普通 tool 形态——agentgraph 数据结构同
    tool，Turn 层 type 语义与渲染分派在行组件内一致）。
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
<template>
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

    <!-- run 组块 → RunGroupBlock（run 类型分组组块：组头 + 展开成员列表，W3 迁出；
         组头计数口径与展开态语义见行组件头注释） -->
    <RunGroupBlock
      v-else-if="type === 'run-group' && group"
      :group="group"
      :session-id="sessionId"
    />

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
import { computed } from 'vue'
import type { MessageStatus, ToolCall } from '@taiji/shared'
import type { FlatBlock, RunGroupBase, RunGroupMile } from '@taiji/core/domain/chat'
import ThinkingRow from './ThinkingRow.vue'
import TextRow from './TextRow.vue'
import RunGroupBlock from './RunGroupBlock.vue'
import ToolRow from './ToolRow.vue'

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

/** data-testid 锚点：按块类型拼接可定位 id，供 E2E 精确断言特定块。
 *  格式：block-tool-${tool.id}（type==='tool'/'agentgraph' 且有 tool）/ block-thinking-${thinkingId}（type==='thinking'）。
 *  agentgraph（subagent/workflow）数据结构同 tool（ToolCall 有 id），故共用 block-tool 前缀。
 *  run-group 组内成员行的 block-tool-<id> 由 RunGroupBlock 补挂（成员行直递 ToolRow 不经壳）。
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
