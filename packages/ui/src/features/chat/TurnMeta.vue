<template>
  <!--
    TurnMeta：回合级元信息（已工作/工作中 + badge）。
    从 Turn.vue 拆出。badge 灰阶化（H 设计：bg-surface-2 text-neutral-mid 替代彩色）。
  -->
  <!-- turn-meta + hr wrapper（sticky 已移除：负 margin 覆盖 scrollEl padding-top 的技巧不可靠——
       working 态贴顶时与 scrollEl 顶部有间隔，滚过来的文字从 gap 漏出。改回正常文档流）。
       [u6a] v-if 收窄回 assistants.length > 0：dispatching 空窗期的空 turn（user 已发、
       assistant 未到）不再渲染 TurnMeta 占位——「思考中」指示已迁对话流尾部 ActivityStrip
       thinking 行（sessionPhase occupancy 投影驱动，D7 展示统一）。 -->
  <div
    v-if="turn.assistants.length > 0"
    :data-testid="`turn-meta-${turnIndex}`"
  >
    <Button
      variant="ghost"
      size="sm"
      class="turn-meta h-auto w-fit items-center justify-start gap-2.5 self-start px-1 py-1 font-sans text-[length:var(--text-sm)] font-medium transition-colors duration-[var(--duration-fast)] ease-[var(--ease)]"
      :class="[
        !turn.hasFoldable
          ? 'cursor-default hover:text-neutral-mid'
          : 'cursor-pointer hover:text-neutral-fg',
      ]"
      :disabled="isWorkingTurn || !turn.hasFoldable"
      @click="toggle(turnKey)"
    >
      <!-- streaming 态：spinner（更显眼的流式生成指示），替代原脉冲点。仅文本流式生成时转（A 类） -->
      <!-- [u6a] dispatching 占位态（isPendingPlaceholder）已删除：空 turn 不再渲染 TurnMeta
           （v-if 收窄），「思考中」指示迁 ActivityStrip thinking 行；spinner 只跟 isStreaming -->
      <!-- 配色恒 accent：曾按期长分 warn(5min)/danger(30min) 三档警示，已删（2026-09）——
           时长改为整 turn 墙钟（含工具执行/等待）后，等构建/等子代理/等用户回答都会触红，
           颜色不再是「生成异常」信号（唯一可靠的信号是时长数字本身） -->
      <Loader2 v-if="isStreaming" class="size-3.5 shrink-0 animate-spin text-accent" />
      <span class="text-[length:var(--text-sm)] font-medium">
        <span class="lbl" :class="isWorkingTurn ? 'text-accent' : 'text-neutral-mid'">{{ statusLabel }}</span>
        <span class="elapsed ml-1 font-mono font-medium tracking-[0.01em] text-neutral-fg">{{ elapsed }}</span>
      </span>
      <!-- Turn 区间（整个 agent-turn 起止时刻）：进行中右端显「（进行中）」，
           定格后显末次产出结束时刻 -->
      <span v-if="startedAt > 0" class="tm-range ml-1.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums">
        · {{ formatClock(startedAt) }} → {{ isLive ? t('panel.message.inProgress') : formatClock(endedAt) }}
      </span>
      <!-- 已生成 token 数（B1 完成态定格常驻；口径 = 本 turn 已上报的真实 usage.outputTokens
           之和，含正文 + 思考 + 工具参数——pi usage 原语义，无需按 block 分类）：
           TurnMeta 是 per-turn 事实聚合位，tokens 与 elapsed/时刻区间同族事实。
           流式期的当前调用尚无 usage → 显示已完成段的真实累计（收口时跳到完整值）；
           全程无近似值（用户裁决 A：不在真值之外显示估算）。0 不渲染（零内容 turn 不占行宽） -->
      <span
        v-if="generatedTokens > 0"
        data-testid="turn-meta-tokens"
        class="tm-tokens ml-1.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums"
      >· {{ t('panel.message.generatedTokens', { tokens: generatedTokens.toLocaleString() }) }}</span>
      <!-- chevron 紧跟耗时（展开/收起 trace 入口），在 badge 之前 -->
      <ChevronRight
        v-if="turn.hasFoldable && !isWorkingTurn"
        class="chev size-[9px] text-neutral-dim transition-transform duration-[var(--duration)] ease-[var(--ease)]"
        :class="isExpanded(turnKey) ? 'rotate-90 text-accent' : ''"
      />
      <!-- H 设计 badge 灰阶化：bg-surface-2 text-neutral-mid 替代 bg-reasoning-soft/bg-info-soft。
           mid #96969c on surface-2 #27272a = 5.06:1 过 AA；dim #74747a = 3.21:1 不过（tokens SSOT） -->
      <span v-if="thinkCount > 0" class="badge badge-think inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] font-medium tracking-[0.02em] text-neutral-mid">
        <Brain class="size-2" />{{ t('panel.message.thinkCount', { count: thinkCount }) }}
      </span>
      <span v-if="toolCount > 0" class="badge badge-tool inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-[length:var(--text-2xs)] font-medium tracking-[0.02em] text-neutral-mid">
        <SquareFunction class="size-2" />{{ t('panel.message.toolCount', { count: toolCount }) }}
      </span>
    </Button>
    <hr class="border-0 border-t border-border" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Brain, ChevronRight, Loader2, SquareFunction } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
// primitives 直接路径（不经 @taiji/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import type { MessageTurn } from '@taiji/core/domain/chat'
import { useChatViewDeps } from './chat-view-deps'
import { formatClock } from './format-utils'

const props = withDefaults(
  defineProps<{
    turn: MessageTurn
    isWorkingTurn: boolean
    isStreaming: boolean
    thinkCount: number
    toolCount: number
    elapsed: string
    /** 当前 turn 在 session 内的序列下标（仅展示/testid 用） */
    turnIndex: number
    /** 当前 turn 的稳定 key（turnStableId(turn)，M5 stable-key：展开态查询按此，不随消息插删漂移） */
    turnKey: string
    /** session id（透传保留） */
    sessionId: string
    /** turn 起点时刻（epoch ms；user 消息 / 首条 assistant，core deriveTurnAggregates） */
    startedAt: number
    /** turn 终点时刻（epoch ms；最后一次产出结束；进行中 = 当下已发生活动的结束时刻） */
    endedAt: number
    /** 本 turn 是否仍在进行（未定格，= 工作 turn）——驱动「（进行中）」与 live 语义 */
    isLive: boolean
    /** 本 turn 已上报的真实生成 token 总量（Σ usage.outputTokens）；0 不渲染。
     *  可选 + 默认 0：非可选类型经 withDefaults 会编译出 required:true，漏传即 Vue warn */
    generatedTokens?: number
  }>(),
  { generatedTokens: 0 },
)

// turn 展开/折叠经 ChatViewDeps inject（renderer 壳绑 useTurnExpansion store）
const { isExpanded, toggleExpand: toggle } = useChatViewDeps()

const { t } = useI18n()

/**
 * working 态文案（SSOT §3.3.4）：working（assistant 已到、仍在生成）显示「工作中」；
 * 完成态「已工作」。[u6a] dispatching 空窗占位分支已删除——空 turn 不再渲染 TurnMeta
 * （v-if 收窄 assistants.length > 0），「思考中」指示迁对话流尾部 ActivityStrip thinking 行
 * （sessionPhase occupancy 投影驱动，D7 展示统一）。
 */
const statusLabel = computed(() => {
  if (!props.isWorkingTurn) return t('panel.message.worked')
  return t('panel.message.working')
})
</script>
