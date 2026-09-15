<template>
  <!--
    TurnSummary：hover actions 操作栏（复制/MD/fork/handoff）。从 Turn.vue 拆出。
    [block-rendering M0] 去内容化：不再渲染正文文字（text 全 inline 到 turn 内容区统一正文样式）
    与 streaming 光标（迁移到 Turn.vue trace 容器末尾 streaming-tail）。
    fork/handoff useTurnActions 在内部调用，不冒泡。
  -->
  <div v-if="lastAssistant" class="turn-summary pt-3">
    <!--
      hover actions（4 个并列按钮：复制 / 复制MD / fork / handoff）。
      fork/handoff 点击进 composer staging 模式：可输入文本带上发送，也可不输入直接提交（空提交≈
      原后台 fork/handoff，由 forkSessionAsk/handoff 空 content 守卫实现）。
      非 subagent session：4 按钮全显；subagent session：仅复制/复制MD（无 fork/handoff）。
    -->
    <div
      v-if="lastAssistant"
      class="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/ai:opacity-100 group-focus-within/ai:opacity-100"
    >
      <!-- 复制（纯文本）-->
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
      <!-- 复制 MD -->
      <Button
        variant="ghost"
        size="icon"
        class="relative size-6 text-neutral-dim hover:text-neutral-fg"
        data-testid="copy-markdown-btn"
        :title="t('panel.message.copyMarkdown')"
        @click="copy(assistantToMarkdown(lastAssistant), aiMdKey)"
      >
        <Check v-if="copied === aiMdKey" class="size-3 text-success" />
        <Copy v-else class="size-3" />
        <span class="absolute -right-0.5 -bottom-0.5 rounded-sm bg-accent px-[2px] text-[8px] font-bold leading-[8px] text-accent-fg">MD</span>
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
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Copy, GitFork, HandHelping } from '@lucide/vue'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import type { MessageTurn } from '@taiji/core/domain/chat'
import type { Message } from '@taiji/shared'
import { normalizeContent } from '@taiji/shared'
import { useCopy } from './composables/useCopy'
import { isSubagentVirtualId } from '../../lib/subagent-id'
import { useChatViewDeps } from './chat-view-deps'

const props = defineProps<{
  turn: MessageTurn
  sessionId: string
  lastAssistant: Message | null
}>()

const { t } = useI18n()
const deps = useChatViewDeps()

/** fork/handoff hover action handler（经 deps 桥接 useTurnActions）。
 *  统一进 composer staging 模式（原 +Q 路径），主操作（后台 fork/handoff）由空提交守卫实现。 */
function onForkAsk(msg: Message): void { deps.onForkAsk(props.sessionId, msg) }
function onHandoffAsk(msg: Message): void { deps.onHandoffAsk(props.sessionId, msg) }
/** copy-as-markdown（经 deps.toMarkdown 桥接 renderer messageFormat） */
function assistantToMarkdown(msg: Message): string { return deps.toMarkdown(msg) }

/** 本 session 是否正在交接（防 handoff 按钮重复点击） */
const isHandingOff = computed(() => deps.isHandingOff(props.sessionId))

/** 复制反馈 */
const { copied, copy } = useCopy()
const aiCopyKey = computed(() => `ai-${props.turn.index}`)
const aiMdKey = computed(() => `md-${props.turn.index}`)

/**
 * summary 文本：copy 按钮内容来源（仅最后一条 assistant.content，streaming/complete 都渲染）。
 */
const summaryText = computed(() => {
  const as = props.turn.assistants
  const last = as[as.length - 1]
  if (!last?.content) return ''
  const text = normalizeContent(last.content)
  return text.trim() ? text : ''
})
</script>
