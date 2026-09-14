<template>
  <!--
    编排器 · Turn（message-stream 单个回合，W4 拆分后）。
    组合 UserBubble + TurnMeta + TurnSummary 三个子组件。
    保留：trace 区 Block 编排（窗口化）+ ChangeSetCard。
    [streaming-trace-window window wave] trace 区从双层 v-for 改单层渲染 computeTraceWindow 的 visible；
    收编区（compacted/failed）由 TraceCompactorRow 承载（零 chrome，双态，D5）。
    折叠作用域（showTrace）仍由 scope wave D1 控制（isWorkingTurn || isExpanded）。
  -->
  <!-- 根元素 content-col（居中 + 封顶 --content-max-w，720px 内容列原语）：整 turn 居中（spec §6.1 R4）。 -->
  <div class="content-col flex flex-col gap-3.5 pb-5" :data-testid="`turn-${turn.index}`">
    <!-- user 区：UserBubble 子组件 -->
    <UserBubble
      v-if="turn.user"
      :turn="turn"
      :session-id="sessionId"
      :can-edit="canEdit"
      :is-session-editable="isSessionEditable"
      @edit-state-change="emit('edit-state-change', $event)"
    />

    <!-- trigger 起点行（W4·D3）：无 user 起点的后台续跑 turn（隐藏完成通知边界开启）渲染轻量
         弱化起点行替代 user 气泡——横线分隔 + Bell 图标 + 小号文案，视觉语言对齐 SystemNotice
         元信息行（不冒充用户发言）。assistant 自启 turn（user:null 无 trigger）两者皆不渲染。 -->
    <div
      v-else-if="turn.trigger === 'bg-notify'"
      class="mx-auto flex w-full min-w-0 items-center gap-2 py-1 animate-notice-in"
      data-testid="turn-trigger-bgnotify"
    >
      <span class="h-px flex-1 bg-border" />
      <Bell class="size-3 shrink-0 text-neutral-mid" />
      <span class="min-w-0 shrink-0 text-[length:var(--text-xs)] leading-snug text-neutral-mid">{{ t('panel.message.turnTriggerBgNotify') }}</span>
      <span class="h-px flex-1 bg-border" />
    </div>

    <!-- assistant 区 -->
    <div class="group/ai flex flex-col gap-0 self-stretch">
      <!-- turn-meta：TurnMeta 子组件（展开态直接读 useTurnExpansion 共享 store） -->
      <TurnMeta
        :turn="turn"
        :is-working-turn="isWorkingTurn"
        :is-streaming="isStreaming"
        :think-count="thinkCount"
        :tool-count="toolCount"
        :elapsed="elapsed"
        :elapsed-secs="elapsedSecs"
        :first-ts="firstTs"
        :last-ts="lastTs"
        :is-live="isLive"
        :generated-chars="generatedChars"
        :turn-index="turn.index"
        :turn-key="turnStableId(turn)"
        :session-id="sessionId"
      />

      <!-- trace 容器：恒渲染（v-if 下沉 Block 级）。
           折叠态（!showTrace）仅末位 text 正文（scope wave D1）；
           工作展开态（showTrace && isWorkingTurn）渲染 computeTraceWindow 窗口切片结果
             （末位 text + 进行中块 + 最近 W 个已完成过程块）；
           完成态/历史手动展开（showTrace && !isWorkingTurn）渲染全量 flatBlocks
             （design §3.1 交互6「回看就是全量」、G5「完成态与历史呈现不变」，窗口只作用于工作 turn）。
           收编行仅在「工作 turn 且（接管态 或 有收编/失败块）」时显示（design §3.1，D5 零 chrome）。
           takeover 态保留行以提供「恢复精简」回退入口（design 交互1），否则用户卡死在全展态。 -->
      <div class="trace mt-1 mb-1 flex flex-col">
        <TraceCompactorRow
          v-if="showTrace && isWorkingTurn && (takeover || traceWindow.compactedCount > 0 || traceWindow.failedCount > 0)"
          :compacted-count="traceWindow.compactedCount"
          :failed-count="traceWindow.failedCount"
          :takeover="takeover"
          data-testid="trace-compactor"
          @toggle="onToggleTakeover"
        />
        <!-- 单层 v-for 渲染窗口 visible 块。:key=flatIndex（拍平后全 turn 一维稳定序号，跨 assistant 连续）。
             Block props 透传：从 FlatBlock 解出 kind/ref + 所属 assistant 的 status/error（D8 Block.vue 零改动）。
             [W21 D-4] Block 级 v-memo：deps = [块身份/内容引用, assistant 状态, thinking store 折叠态, assistant error]。
             fb.block.ref 即「身份+内容」——text 是 normalizeContent 字符串、thinking/tool 是块对象引用
             （D-1 不可变语义下内容/status/id 变化 = 新对象替换，引用入键即覆盖 08 §3.3.1 键清单的
             thinking.id / tool.id / content / tool.status）；working/streaming 由 assistantStatus 派生。
             刻意不含 Block 本地折叠 ref（thinkingCollapsed/toolCollapsed）——v-memo deps 在父组件渲染
             作用域求值，无法引用子组件私有 ref；折叠由 Block 自身响应式驱动（实例经 :key 保活，
             v-memo 不 gate 子组件内部更新）。sessionId 不入键：跨 session 时 renderKey 不同 →
             Turn 实例整体重建，不存在同实例跨 session 复用。 -->
        <Block
          v-for="fb in visibleBlocks"
          :key="fb.flatIndex"
          v-memo="[
            fb.block.ref,
            fb.assistantStatus,
            fb.block.kind === 'thinking' ? (fb.block.ref as ThinkingBlock).collapsed : undefined,
            assistantById.get(fb.assistantId)?.error,
            assistantById.get(fb.assistantId)?.timestamp,
          ]"
          :type="fb.block.kind"
          :content="fb.block.kind === 'text' ? (fb.block.ref as string) : fb.block.kind === 'thinking' ? (fb.block.ref as ThinkingBlock).content : undefined"
          :tool="fb.block.kind === 'tool' || fb.block.kind === 'agentgraph' ? (fb.block.ref as ToolCall) : undefined"
          :thinking-id="fb.block.kind === 'thinking' ? (fb.block.ref as ThinkingBlock).id : undefined"
          :collapsed="fb.block.kind === 'thinking' ? (fb.block.ref as ThinkingBlock).collapsed : undefined"
          :working="fb.assistantStatus === 'streaming'"
          :streaming="fb.assistantStatus === 'streaming'"
          :status="fb.assistantStatus"
          :error="assistantById.get(fb.assistantId)?.error"
          :message-timestamp="assistantById.get(fb.assistantId)?.timestamp"
          :session-id="sessionId"
        />
        <!-- streaming 光标：turn 内容区末尾独立元素（跟在所有 block 后，位置稳定不受 block 增删/折叠态影响）。
             末位可见 block 为 running tool 时隐藏（工具自带 loader）。 -->
        <span v-if="showStreamingCursor" class="streaming-tail ml-0.5 inline-block h-3.5 w-[7px] rounded-[1px] bg-accent align-middle animate-blink" />
      </div>

      <!-- [premature-timeout] idle 超时误判收口的恢复指引（docs/design/timeout-streaming-ui-idle.md §4.2）：
           该气泡的 error 是前端 idle timer 兜底强推（非 pi 真实终态），提示用户「等待自愈 / 手动止损 / 调阈值」；
           迟到的 message.complete 自愈清标后本行随 computed 消失。turn 内任一 assistant 命中即显示（聚合一次）。 -->
      <div
        v-if="hasPrematureTimeout"
        data-testid="turn-premature-timeout"
        class="flex items-start gap-1.5 text-[length:var(--text-sm)] leading-snug text-warn"
      >
        <Timer class="mt-0.5 size-3.5 shrink-0" />
        <span class="min-w-0 flex-1">{{ t('panel.message.prematureTimeoutNotice') }}</span>
      </div>

      <!-- 操作栏：TurnSummary 子组件（去内容化后仅 hover actions） -->
      <TurnSummary
        :turn="turn"
        :session-id="sessionId"
        :last-assistant="lastAssistant"
      />

      <!-- 变更集卡（W10，ADR-0024） -->
      <ChangeSetCard
        v-if="changeSetFileChanges.length > 0"
        class="mt-2"
        :file-changes="changeSetFileChanges"
        :status="changeSetStatus"
        :session-id="sessionId"
      />
    </div>

    <!-- turn 内 notice（W4·D4）：bash 执行记录 / liveOnly 健康警告按到达序在 turn 内部末尾渲染
         （不切断回合）。bashExecution 复用 BashOutputBlock（既有 bash 消费点，取消按钮经
         abortBash 仍可用）；liveOnly（stream_warn）与其余 system notice 走 SystemNotice 弱化行。
         wrapper 的 data-testid（turn-inline-bash / turn-inline-notice）是 W4 渲染契约——
         不落在子组件根上，避免覆盖 BashOutputBlock 自身的 bash-output-block testid。 -->
    <div
      v-for="n in turn.notices"
      :key="n.id"
      :data-testid="n.bashExecution ? 'turn-inline-bash' : 'turn-inline-notice'"
    >
      <BashOutputBlock v-if="n.bashExecution" :message="n" :session-id="sessionId" />
      <SystemNotice v-else :message="n" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Bell, Timer } from '@lucide/vue'
import type { MessageTurn, FlatBlock } from '@xyz-agent/core/domain/chat'
import { countThinking, countToolCalls, flattenTurnBlocks, computeTraceWindow, turnStableId, W } from '@xyz-agent/core/domain/chat'
import type { Message, ThinkingBlock, ToolCall } from '@xyz-agent/shared'
import ChangeSetCard from './ChangeSetCard.vue'
import UserBubble from './UserBubble.vue'
import TurnMeta from './TurnMeta.vue'
import TurnSummary from './TurnSummary.vue'
import Block from './Block.vue'
import TraceCompactorRow from './TraceCompactorRow.vue'
import BashOutputBlock from './BashOutputBlock.vue'
import SystemNotice from './SystemNotice.vue'
import { useTurnElapsed } from './composables/useTurnElapsed'
import { useChatViewDeps } from './chat-view-deps'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    sessionId: string
    canEdit?: boolean
    isSessionActive?: boolean
    /** 本 turn 是否为列表末位 turn（D1 折叠作用域修正，streaming-trace-window design §3.3）。
     *  由列表渲染器（MessageStream）按 turn === lastRenderTurn 传入；缺省 false。 */
    isLastTurn?: boolean
  }>(),
  { isSessionActive: undefined },
)

/** trigger 起点行文案（W4·D3）：仅 bg-notify turn 渲染，见 template 注释。 */
const { t } = useI18n()

/**
 * B9：编辑状态变化通知父组件。
 * [pin-identity D2/D7] 负载扩展为 {editing, turnKey}（turnKey = turnStableId(turn)，身份由
 * 事件源 UserBubble 携带，父组件不再持数组位置快照）；Turn 只透传不解读（模板
 * `emit('edit-state-change', $event)` 原样不动），仅 emits 类型声明随负载扩展——编排器不解析领域语义。
 */
const emit = defineEmits<{
  'edit-state-change': [{ editing: boolean; turnKey: string }]
}>()

const deps = useChatViewDeps()
// isTakeover/setTakeover 为 optional（窗口增强，非所有壳层 provide）：未提供时兜底 false / no-op
const { isExpanded, collapse, getChangeSetStatus, isActive, isTakeover = () => false, setTakeover } = deps

/** 最后一条 assistant */
const lastAssistant = computed(() => {
  const as = props.turn.assistants
  return as[as.length - 1] ?? null
})

/**
 * isStreaming（turn 级）：文本正在流式生成。
 * sessionActive（session 级）：对话进行中（含 streaming/ask-user/subagent/compacting 等）。
 */
const isStreaming = computed(() => props.turn.isStreaming)
const sessionActive = computed(() => props.isSessionActive ?? props.turn.isStreaming)
/**
 * 本 turn 是否为「工作 turn」（D1：折叠作用域降到 turn 级）。
 */
const isWorkingTurn = computed(() => sessionActive.value && (props.isLastTurn ?? false))

const thinkCount = computed(() => countThinking(props.turn))
const toolCount = computed(() => countToolCalls(props.turn))

/**
 * 折叠作用域（scope wave D1）：工作 turn 或手动 expanded 时展开 trace。
 * [M5 stable-key] 展开态按 turnStableId(turn)（首条消息 id）查询。
 */
const showTrace = computed(() => isWorkingTurn.value || isExpanded(turnStableId(props.turn)))

/**
 * trace 拍平 + 窗口切片（window wave）。
 * - flatBlocks：turn 内所有 assistant 块按真实时序拍平为一维（跨 assistant 连续 flatIndex）。
 * - takeover：展开全部接管态（D6，落 useTurnExpansion store per-turn 分区，非本地 ref——
 *   ask-user/compacting 态 isStreaming=false 时 virtua 不钉住工作 turn，本地 ref 上滚出视口会丢；
 *   跨 pane 同 session 也需共享，store 化一并消除）。
 * - traceWindow：computeTraceWindow 切片（visible + compactedCount + failedCount）。
 *   takeover=true 时 visible=全量、计数归零；takeover=false 时按窗口策略取末位 text + 进行中块 + 最近 W 个已完成过程块。
 */
const flatBlocks = computed<FlatBlock[]>(() => flattenTurnBlocks(props.turn.assistants))
const takeover = computed(() => isTakeover(turnStableId(props.turn)))
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
  if (!isWorkingTurn.value) {
    return flatBlocks.value
  }
  return traceWindow.value.visible
})

/** assistantId → Message 映射（取 error 字段透传给 Block，D8 Block.vue 零改动）。 */
const assistantById = computed(() => {
  const m = new Map<string, Message>()
  for (const a of props.turn.assistants) m.set(a.id, a)
  return m
})

/**
 * [premature-timeout] 本 turn 是否含 idle 超时误判收口的气泡（§4.2）：error 态且带
 * prematureTimeout 标记。complete 自愈恢复（status 翻 complete + 清标）后 computed 失效，
 * 恢复指引行自动消失——不依赖用户重开 session。
 */
const hasPrematureTimeout = computed(() =>
  props.turn.assistants.some((a) => a.status === 'error' && a.prematureTimeout === true),
)

/** 切换 takeover（展开全部 ↔ 恢复精简），落 store（D6，非本地 ref）。未 provide setTakeover 时 no-op。 */
function onToggleTakeover(): void {
  setTakeover?.(turnStableId(props.turn), !takeover.value)
}

/**
 * 工作耗时 live 计时。
 */
const { elapsed, elapsedSecs, firstTs, lastTs, isLive, generatedChars } = useTurnElapsed(
  () => props.turn.assistants,
  () => isStreaming.value,
  () => sessionActive.value,
  () => {
    collapse(turnStableId(props.turn))
  },
)

/** 变更集卡（W10） */
const changeSetFileChanges = computed(() => lastAssistant.value?.fileChanges ?? [])
const changeSetStatus = computed(() => {
  const msg = lastAssistant.value
  if (!msg) return undefined
  return getChangeSetStatus(props.sessionId, msg.id)
})

/** 本 session 是否可编辑 */
const isSessionEditable = computed(() => isActive(props.sessionId))

/**
 * streaming-tail 光标显隐（IF2/ES1）：isStreaming && 最后一个可见 block 不是 running tool。
 * 末项 kind 为 tool/agentgraph 且 ref.status === 'running' → 隐藏（工具自带 loader，避免光标+loader 并存）；
 * 其余（含无可见 block 的防御性兜底 ES1）→ 显示。
 */
const showStreamingCursor = computed(() => {
  if (!isStreaming.value) return false
  const blocks = visibleBlocks.value
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : null
  if (last && (last.block.kind === 'tool' || last.block.kind === 'agentgraph')) {
    const ref = last.block.ref as ToolCall
    if (ref.status === 'running') return false
  }
  return true
})
</script>
