<template>
  <!--
    TurnSummary：hover actions 操作栏（复制/朗读/fork/handoff）。从 Turn.vue 拆出。
    [block-rendering M0] 去内容化：不再渲染正文文字（text 全 inline 到 turn 内容区统一正文样式）
    与 streaming 光标（迁移到 Turn.vue trace 容器末尾 streaming-tail）。
    [actions-anchor] 本组件由 Turn.vue 经末位 text 块（Block.vue）的 #turn-actions 插槽挂载：
    流内固定槽位 = text 块下部一行（2026-10-15 用户裁决，对齐 UserBubble hover actions
    同族形态——原悬浮 chip「text 上方右侧 + 不透明底」退役）。透明底因此可行：行体不再
    覆盖任何文字；悬停区 = text 块行 + 本行（group/text 门控在 Block 的插槽包装层），
    按钮是 text 块的 DOM 子孙，鼠标从正文移入按钮期间悬停态经 DOM 祖先传递不熄灭。
    fork/handoff useTurnActions 在内部调用，不冒泡。
  -->
  <!--
    hover actions（4 个并列按钮：复制 / 朗读 / fork / handoff），挂载位见根注释。
    复制 = 末条 assistant 正文（仅 text，不含思考/工具分区，2026-10-15 用户裁决——
    原 assistantToMarkdown 三分区展平随本裁决整体退役）。
    fork/handoff 点击进 composer staging 模式：可输入文本带上发送，也可不输入直接提交（空提交≈
    原后台 fork/handoff，由 forkSessionAsk/handoff 空 content 检查实现）。
    非 subagent session：4 按钮全显；subagent session：复制/朗读（无 fork/handoff）。
  -->
  <div
    v-if="lastAssistant"
    class="turn-summary flex items-center gap-0.5"
  >
    <!-- 复制：末条 assistant 正文（仅 text，不含思考/工具分区，2026-10-15 用户裁决）。
         正文即 markdown 源——MarkdownRenderer 渲染态与复制内容一致；原 assistantToMarkdown
         （思考引用块 + 工具代码块 + 正文三分区）随本裁决整体退役（messageFormat.ts 已删）。 -->
    <Button
      variant="ghost"
      size="icon"
      class="size-6 text-neutral-dim hover:text-neutral-fg"
      data-testid="copy-btn"
      :title="t('panel.message.copy')"
      @click="copy(summaryText, aiCopyKey)"
    >
      <Check v-if="copied === aiCopyKey" class="size-3 text-success" />
      <Copy v-else class="size-3" />
    </Button>
    <!-- 朗读：状态机（ai-voice-tts §5.1）idle Volume2 → loading Loader2 旋转（可点，点击=取消）
         → playing Square（点击=停止）→ idle；生成中置灰（disabled + title=回复生成中）。
         对 subagent session 同样可见（朗读是只读消费，与复制同类，不受 fork/handoff 隐藏规则约束）。
         deps 两字段（onSpeak/speakStateOf）未 provide 时按钮不渲染（宿主未接语音能力则无此交互面）；
         点击动作分流（idle=朗读 / 非 idle=取消或停止）在壳层装配侧，ui 只调 onSpeak。 -->
    <Button
      v-if="speakState"
      variant="ghost"
      size="icon"
      class="size-6 text-neutral-dim hover:text-neutral-fg"
      data-testid="speak-btn"
      :disabled="speakDisabled"
      :title="speakTitle"
      @click="onSpeakClick(lastAssistant)"
    >
      <Loader2 v-if="speakState === 'loading'" class="size-3 animate-spin" />
      <Square v-else-if="speakState === 'playing'" class="size-3" />
      <Volume2 v-else class="size-3" />
    </Button>
    <!-- subagent session：仅复制类按钮，无 fork/handoff -->
    <template v-if="!isSubagentVirtualId(sessionId)">
      <span class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
      <!-- fork：进 composer 模式，可输入提问或空提交（空提交=后台 fork）-->
      <Button
        variant="ghost"
        size="icon"
        class="fork-btn relative size-6 text-neutral-dim hover:bg-accent-soft hover:text-accent"
        data-testid="fork-ask-btn"
        :title="t('panel.message.forkAsk')"
        @click="onForkAsk(lastAssistant)"
      >
        <GitFork class="size-3" />
      </Button>
      <span class="as-sep mx-1 h-3.5 w-px shrink-0 bg-border" />
      <!-- handoff：进 composer 模式，可输入备注或空提交（空提交=后台 handoff）-->
      <Button
        variant="ghost"
        size="icon"
        :class="['handoff-btn relative size-6 text-neutral-dim hover:text-neutral-fg', { 'opacity-50 pointer-events-none': isHandingOff }]"
        data-testid="handoff-ask-btn"
        :title="t('panel.message.handoffAsk')"
        @click="onHandoffAsk(lastAssistant)"
      >
        <HandHelping class="size-3.5 fill-current" />
      </Button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, GitFork, HandHelping, Loader2, Square, Volume2 } from '@lucide/vue'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会封住一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import type { MessageTurn } from '@taiji/core/domain/chat'
import { normalizeContent, type Message } from '@taiji/shared'
import { useCopy } from './composables/useCopy'
import { isSubagentVirtualId } from '../../lib/subagent-id'
import { useChatViewDeps } from './chat-view-deps'
import type { SpeakState } from './chat-view-deps'

const props = defineProps<{
  turn: MessageTurn
  sessionId: string
  lastAssistant: Message | null
}>()

const { t } = useI18n()
const deps = useChatViewDeps()

/** fork/handoff hover action handler（经 deps 桥接 useTurnActions）。
 *  统一进 composer staging 模式（原 +Q 路径），主操作（后台 fork/handoff）由空提交检查实现。 */
function onForkAsk(msg: Message): void { deps.onForkAsk(props.sessionId, msg) }
function onHandoffAsk(msg: Message): void { deps.onHandoffAsk(props.sessionId, msg) }

/** 朗读态（ai-voice-tts §5.1 状态机）：数据源 deps.speakStateOf（renderer useTtsPlayer
 *  全局单例任务态按 messageId 派生，D11——切 session 回来按钮仍显示正确播放态）。
 *  computed 内调用使单例 ref 变化可追踪；两字段未 provide（宿主未接语音能力/测试 mock 壳）
 *  返回 undefined → 按钮不渲染。 */
const speakState = computed<SpeakState | undefined>(() => {
  const msg = props.lastAssistant
  if (!msg) return undefined
  return deps.speakStateOf?.(msg.id)
})

/** 生成中置灰（§5.1）：朗读语义锚定「最终」assistant 文本，流式生成中点击会合成半截内容——
 *  disabled 保持操作栏形态稳定不闪烁。turn 级状态组件内取（MessageTurn.isStreaming），
 *  不经 ChatViewDeps 新增字段。 */
const speakDisabled = computed(() => props.turn.isStreaming)

/** 朗读按钮 title：三态各一（idle 朗读 / loading 取消 / playing 停止）+ 生成中置灰文案优先。
 *  键名对齐 u4 已登记的 locale 键（panel.message.speak* 族，idle 态键 = speakTitle）。 */
const speakTitle = computed(() => {
  if (speakDisabled.value) return t('panel.message.speakStreaming')
  switch (speakState.value) {
    case 'loading': return t('panel.message.speakCancel')
    case 'playing': return t('panel.message.speakStop')
    default: return t('panel.message.speakTitle')
  }
})

/** 朗读点击：动作分流在壳层装配侧（idle=朗读 / loading=取消 / playing=停止，stop 同源
 *  useTtsPlayer 点击停止），ui 只透传 (sessionId, message)。 */
function onSpeakClick(msg: Message): void { deps.onSpeak?.(props.sessionId, msg) }

/** 本 session 是否正在交接（防 handoff 按钮重复点击） */
const isHandingOff = computed(() => deps.isHandingOff(props.sessionId))

/** 复制反馈 */
const { copied, copy } = useCopy()
const aiCopyKey = computed(() => `ai-${props.turn.index}`)

/**
 * 复制内容 = 末条 assistant 正文（normalizeContent(msg.content)，仅 text——不含思考/工具分区，
 * 2026-10-15 用户裁决）。读既有 lastAssistant prop（Turn.vue 单点推导后传入），
 * 「末条 assistant」语义变化时只改 Turn.vue 一处；该 prop 同时承托复制/朗读/fork/handoff。
 */
const summaryText = computed(() => {
  const last = props.lastAssistant
  if (!last?.content) return ''
  const text = normalizeContent(last.content)
  return text.trim() ? text : ''
})
</script>
