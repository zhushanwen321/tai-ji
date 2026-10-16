/**
 * useTurnTrace —— Turn 的 trace 窗口化编排 + 渲染单元（run 类型分组）派生。
 *
 * 从 Turn.vue script 拆出（split-justified 登记既定方向「trace 窗口化编排抽 useTurnTrace
 * composable」）：Turn.vue script 随 trace/run-group/里程碑等波次叠加超 vue_rules_checker
 * 500 行绝对上限，按域拆出本 composable——纯迁移无行为变化（Turn.test.ts + renderer 挂载
 * 族原覆盖不动）。
 *
 * 职责（turn 内一维块序列的窗口化 + 渲染单元派生，core 纯函数在本 composable 内接线）：
 * - flatBlocks / traceWindow / visibleBlocks：拍平 → 窗口切片（computeTraceWindow）→
 *   折叠态/工作展开/完成态三分支汇合（design §3.1 交互6「窗口只作用于工作 turn」）。
 * - renderUnits：visibleBlocks 汇合后接 groupToolRuns（run 类型分组，§3；接线点在汇合后
 *   而非 computeTraceWindow 之后——否则历史回合手动展开全量路径拿不到分组）。
 * - isActionsAnchor / unitKey / unitMemoDeps / unitBlockProps：单层 v-for 的锚块判定、
 *   run-head key、v-memo deps 二型、Block props 二型收敛（vue/valid-v-memo 禁 template
 *   v-for 子元素挂 v-memo，分支不能拆成双 Block）。
 *
 * showTrace 一并内聚于此（折叠作用域 = 工作 turn || 手动 expanded，与 visibleBlocks 同源）。
 */
import { computed } from 'vue'
import {
  computeTraceWindow,
  flattenTurnBlocks,
  groupToolRuns,
  isRunGroupBlock,
  turnStableId,
  W,
} from '@taiji/core/domain/chat'
import type { FlatBlock, MessageTurn, RunGroupBase, RunGroupMile, TraceRenderUnit } from '@taiji/core/domain/chat'
import type { Message, ThinkingBlock, ToolCall } from '@taiji/shared'
import { useChatViewDeps } from '../chat-view-deps'

/** Block props（按单元类型二选一，v-bind 展开的类型前提；定义随单元派生逻辑内聚于本文件）。 */
export interface BlockUnitProps { // oe-exempt:20261013:framework:类型契约先行——Turn→Block 渲染单元 props 契约层（v-bind 展开的类型前提，单构造点 unitBlockProps 为常态），消费面为 Turn.vue 模板与 Block.test.ts
  type: 'thinking' | 'tool' | 'text' | 'agentgraph' | 'run-group'
  content?: string
  tool?: ToolCall
  thinkingId?: string
  collapsed?: boolean
  working?: boolean
  streaming?: boolean
  status?: Message['status']
  error?: string
  messageTimestamp?: number
  /** thinking 起止毫秒时间戳（N6 思考行时长数据源，ThinkingBlock.startTime/endTime 透传） */
  thinkingStart?: number
  thinkingEnd?: number
  group?: {
    base: RunGroupBase
    members: FlatBlock[]
    header: { count: number; durationMs: number; failedCount: number }
    hasRunning: boolean
    miles?: RunGroupMile[]
    headFlatIndex?: number
  }
}

/**
 * trace 窗口化编排 + 渲染单元派生。
 *
 * @param turn 当前 MessageTurn getter（props.turn；computed 内经 getter 读，保持响应式追踪）
 * @param isWorkingTurn 工作 turn 判定 getter（Turn.vue isWorkingTurn：sessionActive && isLastTurn）
 */
export function useTurnTrace(turn: () => MessageTurn, isWorkingTurn: () => boolean) {
  const { isExpanded, isTakeover } = useChatViewDeps()

  /**
 * 折叠作用域（scope wave D1）：工作 turn 或手动 expanded 时展开 trace。
 * [M5 stable-key] 展开态按 turnStableId(turn)（首条消息 id）查询。
 */
  const showTrace = computed(() => isWorkingTurn() || isExpanded(turnStableId(turn())))

  /**
 * trace 拍平 + 窗口切片（window wave）。
 * - flatBlocks：turn 内所有 assistant 块按真实时序拍平为一维（跨 assistant 连续 flatIndex）。
 * - takeover：展开全部接管态（D6，落 useTurnExpansion store per-turn 分区，非本地 ref——
 *   ask-user/compacting 态 isStreaming=false 时 virtua 不钉住工作 turn，本地 ref 上滚出视口会丢；
 *   跨 pane 同 session 也需共享，store 化一并消除）。
 * - traceWindow：computeTraceWindow 切片（visible + compactedCount + failedCount）。
 *   takeover=true 时 visible=全量、计数归零；takeover=false 时按窗口策略取末位 text + 进行中块 + 最近 W 个已完成过程块。
 */
  const flatBlocks = computed<FlatBlock[]>(() => flattenTurnBlocks(turn().assistants))
  const takeover = computed(() => isTakeover(turnStableId(turn())))
  const traceWindow = computed(() =>
    computeTraceWindow(flatBlocks.value, { windowSize: W, takeover: takeover.value }),
  )

  /**
 * 实际渲染的块序列：
 * - 折叠态（!showTrace）：每个 assistant 的末位 text（按 assistantId 分组各取 flatIndex 最大者）。
 *   多 assistant turn 下每个 assistant 的最终回复默认可见（与 computeTraceWindow ①规则一致）；
 *   computeTraceWindow 不参与折叠态（无 trace 细节）。
 * - 工作展开态（showTrace && isWorkingTurn）：traceWindow.visible（窗口切片结果，含各 assistant
 *   末位 text + 过程块；takeover=true 时 visible=全量）。
 * - 完成态/历史手动展开（showTrace && !isWorkingTurn）：全量 flatBlocks（design §3.1 交互6
 *   「窗口只作用于工作 turn，回看就是全量」、G5「完成态与历史呈现不变」，不走窗口切片）。
 */
  const visibleBlocks = computed<FlatBlock[]>(() => {
    if (!showTrace.value) {
    // 全 turn 末位 text（与 computeTraceWindow ①一致，不按 assistant 分组）
      let lastText: FlatBlock | undefined
      for (const fb of flatBlocks.value) {
        if (fb.block.kind === 'text' && (!lastText || fb.flatIndex > lastText.flatIndex)) lastText = fb
      }
      return lastText ? [lastText] : []
    }
    // 窗口仅作用于工作 turn：完成态/历史手动展开回看全量，不截断（design §3.1 交互6 / G5）。
    if (!isWorkingTurn()) {
      return flatBlocks.value
    }
    return traceWindow.value.visible
  })

  /**
 * run 类型分组：visibleBlocks 三分支汇合之后接 groupToolRuns（接线点在汇合后而非 computeTraceWindow
 * 之后——否则历史回合手动展开全量路径拿不到分组，收益最大路径静默落空）。flatBlocks 与 visibleBlocks
 * 同源同拍（都是 turn().assistants 的 computed 派生、同一渲染拍计算），满足 groupToolRuns 的
 * 入参一致性不变量（段首回查用 flatBlocks）。
 */
  const renderUnits = computed<TraceRenderUnit[]>(() =>
    groupToolRuns(visibleBlocks.value, flatBlocks.value),
  )

  /**
 * [actions-anchor] hover actions 锚块 = visibleBlocks 内 flatIndex 最大的 text 块（折叠态即唯一
 * 可见的末位正文；工作展开/历史展开态取时序最后的 text）。操作栏（TurnSummary）经
 * #turn-actions 插槽只挂在该块上：悬停区收窄到 text 块本身，悬浮位随块定位。无 text 块
 * （纯工具 turn 流式前期）无锚 → 操作栏不渲染。
 */
  const actionsAnchorFlatIndex = computed<number | null>(() => {
    let last: number | null = null
    for (const fb of visibleBlocks.value) {
      if (fb.block.kind === 'text') last = fb.flatIndex
    }
    return last
  })

  /** 锚块判定（模板插槽 v-if 与 v-memo deps 共用单点）；run 组块永不命中。 */
  function isActionsAnchor(unit: TraceRenderUnit): boolean {
    if (isRunGroupBlock(unit) || unit.block.kind !== 'text') return false
    return unit.flatIndex === actionsAnchorFlatIndex.value
  }

  /** 渲染单元 key（run head）：普通块 = flatIndex；run 组块 = 段首锚定 headFlatIndex。 */
  function unitKey(unit: TraceRenderUnit): number {
    return isRunGroupBlock(unit) ? unit.headFlatIndex : unit.flatIndex
  }

  /**
 * v-memo deps（按单元类型二选一，见模板注释）。
 * 组块七项 = [base, members.length, 末成员 block.ref, header.count, header.durationMs,
 * hasRunning, miles]：base 覆盖组类型切换；末成员 ref 覆盖 running→completed
 * 内容重组、count/durationMs 覆盖组头刷新、length 覆盖成员增减、hasRunning 覆盖组头执行态翻转；
 * miles（§3.6 里程碑徽标，序列化字符串）覆盖「首个 edit 完成 → 徽标入场」——该翻转可发生在
 * durationMs 不变（0ms 耗时成员）且 hasRunning 不变（同组仍有 running 成员）时，漏了它徽标
 * 会滞到下一个无关 dep 变化才渲染。miles 取 join 串而非数组引用：每次重组都是新数组，
 * 引用入键 v-memo 将永远失效（同 members 的处理）。
 * 不用整个 members 数组引用入 deps——每次重组都是新数组，v-memo 将永远失效。
 * 普通块七项 = W21 D-4 既有键清单 + textFinalized（chat-flow-text-color D1：mid-turn 气泡
 * 定稿标记落地时要触发重渲染翻白，不入键则 memo 命中旧 props、颜色滞留 streaming 灰到回合收口）
 * + [actions-anchor] 锚标记：block.ref 即「身份+内容」——text 是 normalizeContent 字符串、
 * thinking/tool 是块对象引用（D-1 不可变语义下内容/status/id 变化 = 新对象替换，引用入键即
 * 覆盖 08 §3.3.1 键清单的 thinking.id / tool.id / content / tool.status）；working/streaming
 * 由 unitBlockProps 按 textFinalized 逐消息派生。锚标记覆盖操作栏插槽挂载点切换——流式追加/
 * 窗口变化使锚在 text 块间移动时，旧块摘插槽、新块挂插槽，漏了它被缓存的 vnode 不重渲染，
 * 插槽永远不跟着锚走。刻意不含 Block 本地折叠 ref（thinkingCollapsed/toolCollapsed）——
 * v-memo deps 在父组件渲染作用域求值，无法引用子组件私有 ref；折叠由 Block 自身响应式驱动
 * （实例经 :key 保活，v-memo 不 gate 子组件内部更新）。sessionId 不入键：跨 session 时
 * renderKey 不同 → Turn 实例整体重建，不存在同实例跨 session 复用。
 * deps 在父组件渲染作用域求值（assistantById 为 computed，此处取 .value）。
 */
  function unitMemoDeps(unit: TraceRenderUnit): unknown[] {
    if (isRunGroupBlock(unit)) {
      return [
        unit.base,
        unit.members.length,
        unit.members[unit.members.length - 1].block.ref,
        unit.header.count,
        unit.header.durationMs,
        unit.hasRunning,
        unit.miles.join('|'),
      ]
    }
    return [
      unit.block.ref,
      unit.assistantStatus,
      unit.block.kind === 'thinking' ? (unit.block.ref as ThinkingBlock).collapsed : undefined,
      assistantById.value.get(unit.assistantId)?.error,
      assistantById.value.get(unit.assistantId)?.timestamp,
      assistantById.value.get(unit.assistantId)?.textFinalized,
      isActionsAnchor(unit),
    ]
  }

  /**
 * 普通块按 kind 分派解出 Block 字段（每 kind 一次 ref 收窄，替代字段级嵌套三元的分支链）：
 * ref 形状由 OrderedBlock 生产端约定——text=string / thinking=ThinkingBlock /
 * tool|agentgraph=ToolCall。返回不含的键经 v-bind 展开与显式 undefined 同值（Vue props
 * 缺席即 undefined），渲染结果不变。
 */
  function kindBlockProps(
    kind: FlatBlock['block']['kind'],
    ref: FlatBlock['block']['ref'],
  ): Partial<BlockUnitProps> {
    switch (kind) {
      case 'text':
        return { content: ref as string }
      case 'thinking': {
        const t = ref as ThinkingBlock
        // N6 思考行时长：startTime/endTime 透传（实时链路 thinking_start/end 效果器填充；重载
        // 链路两字段 undefined → Block 侧守卫不渲染时长，维持现状展示）
        return { content: t.content, thinkingId: t.id, collapsed: t.collapsed, thinkingStart: t.startTime, thinkingEnd: t.endTime }
      }
      case 'tool':
      case 'agentgraph':
        return { tool: ref as ToolCall }
    }
  }

  /**
 * Block props（按单元类型二选一）：普通块从 FlatBlock 解出 kind/ref + 所属 assistant 的
 * status/error/timestamp（D8 形态原样迁移）；run 组块走 type='run-group' + group 数据
 * （base + header 三条口径 + miles 里程碑徽标由 core 一次算好）。经 v-bind 展开收敛到单 Block 元素——
 * vue/valid-v-memo 禁止 template v-for 子元素挂 v-memo，双分支无法各自带 memo。
 *
 * working/streaming（chat-flow-text-color D1）：按「该消息文本是否仍在写」逐消息派生，
 * 不再直接跟 assistantStatus——pi 回合 =「assistant 消息 → 工具 → assistant 消息 → …」
 * 循环，mid-turn 气泡的 status 要到回合级 message.complete 才收口，直接跟 status 会让
 * 长工具回合中已写完的正文/思考块一直处于 streaming 视觉（正文灰、思考块尾窗模式）。
 * 事实源 = core message_end 写入的 textFinalized（确定性事件边沿，非时间推测）。
 */
  function unitBlockProps(unit: TraceRenderUnit): BlockUnitProps {
    if (isRunGroupBlock(unit)) {
      return {
        type: 'run-group',
        group: {
          base: unit.base,
          members: unit.members,
          header: unit.header,
          hasRunning: unit.hasRunning,
          miles: unit.miles,
          headFlatIndex: unit.headFlatIndex,
        },
      }
    }
    const assistant = assistantById.value.get(unit.assistantId)
    const textLive = unit.assistantStatus === 'streaming' && !assistant?.textFinalized
    return {
      type: unit.block.kind,
      ...kindBlockProps(unit.block.kind, unit.block.ref),
      working: textLive,
      streaming: textLive,
      status: unit.assistantStatus,
      error: assistant?.error,
      messageTimestamp: assistant?.timestamp,
    }
  }

  /** assistantId → Message 映射（取 error 字段透传给 Block，D8 Block.vue 零改动）。 */
  const assistantById = computed(() => {
    const m = new Map<string, Message>()
    for (const a of turn().assistants) m.set(a.id, a)
    return m
  })

  return {
    showTrace,
    takeover,
    traceWindow,
    visibleBlocks,
    renderUnits,
    isActionsAnchor,
    unitKey,
    unitMemoDeps,
    unitBlockProps,
  }
}
