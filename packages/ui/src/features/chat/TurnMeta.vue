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
      <Loader2 v-if="isStreaming" class="size-3.5 shrink-0 animate-spin" :class="spinnerColor" />
      <span class="text-[length:var(--text-sm)] font-medium">
        <span class="lbl" :class="isWorkingTurn ? 'text-accent' : 'text-neutral-mid'">{{ statusLabel }}</span>
        <span class="elapsed ml-1 font-mono font-medium tracking-[0.01em]" :class="elapsedColor">{{ elapsed }}</span>
      </span>
      <!-- Turn 区间：首末时刻 -->
      <span v-if="firstTs > 0" class="tm-range ml-1.5 font-mono text-[length:var(--text-2xs)] text-neutral-dim tabular-nums">
        · {{ formatClock(firstTs) }} → {{ isLive ? t('panel.message.inProgress') : formatClock(lastTs) }}
      </span>
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
// primitives 直接路径（不经 @xyz-agent/ui 顶层 barrel）：chat 组件被 barrel 再导出，
// barrel 自引用会闭合一族循环依赖环（详见 BashOutputBlock.vue 同款注释）
import { Button } from '../../primitives/button'
import type { MessageTurn } from '@xyz-agent/core/domain/chat'
import { useChatViewDeps } from './chat-view-deps'
import { formatClock } from './format-utils'

const props = defineProps<{
  turn: MessageTurn
  isWorkingTurn: boolean
  isStreaming: boolean
  thinkCount: number
  toolCount: number
  elapsed: string
  /** 已耗时秒数（与 elapsed 字符串同源，用于长时生成分级警示配色） */
  elapsedSecs: number
  /** 当前 turn 在 session 内的序列下标（仅展示/testid 用） */
  turnIndex: number
  /** 当前 turn 的稳定 key（turnStableId(turn)，M5 stable-key：展开态查询按此，不随消息插删漂移） */
  turnKey: string
  /** session id（透传保留） */
  sessionId: string
  /** turn 首条 assistant 时刻（epoch ms） */
  firstTs: number
  /** turn 末条 assistant 时刻（epoch ms） */
  lastTs: number
  /** 是否正在流式生成 */
  isLive: boolean
}>()

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

/** 长时生成分级阈值（秒）：≥5min 转 warn、≥30min 转 danger（正常生成 30s~2min 不触发）。 */
const DURATION_WARN_SECS = 300
const DURATION_DANGER_SECS = 1800

/** 分级警示：驱动 spinner + elapsed 配色，让卡死/死循环类异常长耗时在视觉上跳出来。 */
const durationLevel = computed<'normal' | 'warn' | 'danger'>(() => {
  const s = props.elapsedSecs
  if (s >= DURATION_DANGER_SECS) return 'danger'
  if (s >= DURATION_WARN_SECS) return 'warn'
  return 'normal'
})

/** spinner 配色：normal 跟随 accent，warn/danger 转警示色（随时长“变暖”）。 */
const spinnerColor = computed(() =>
  durationLevel.value === 'danger' ? 'text-danger'
    : durationLevel.value === 'warn' ? 'text-warn'
      : 'text-accent',
)

/** elapsed 配色：normal 中性前景，warn/danger 转警示色。 */
const elapsedColor = computed(() =>
  durationLevel.value === 'danger' ? 'text-danger'
    : durationLevel.value === 'warn' ? 'text-warn'
      : 'text-neutral-fg',
)
</script>
