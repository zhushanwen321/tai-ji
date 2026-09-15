<template>
  <!--
    展示组件 · system 提示行（W07-C）。
    渲染 compactionSummary / branchSummary 两类 system 消息 + subagent 定向气泡（U2b）。
    不冒充 user/assistant：弱化样式（居中、小字、图标 + 一行摘要），
    作流转过程的元信息提示（压缩 / 分支）。
  -->
  <!-- subagent 定向气泡（U2b）：`@` 定向消息的「可见去向」形态（composer-symbol-system
       §3.3.3a「→ @slug：text」）。左对齐轻量样式区别于 user/assistant 气泡——定向消息
       不是对话回合（无主 agent turn），是元信息记录；live / reload 两链路产出同形态
       Message（store.appendSubagentDirective 注释），本组件是唯一渲染点。 -->
  <div
    v-if="directive"
    class="content-col flex min-w-0 items-start gap-1.5 py-1"
    data-testid="subagent-directive-bubble"
  >
    <ArrowRight class="mt-0.5 size-3 shrink-0 text-accent" />
    <p class="min-w-0 break-words text-[length:var(--text-xs)] leading-snug text-neutral-mid">
      <span class="font-mono font-medium text-accent" data-testid="subagent-directive-slug">@{{ directive.slug }}</span>
      <span>：{{ directive.text }}</span>
    </p>
  </div>
  <!-- [u8-pi-respawn] pi 崩溃恢复提示条分支（crash-resilience D7）：customType 匹配且
       variant 可解析时渲染 RespawnNoticeBar（restored=T4 文案 / restoreFailed=失败态+重试
       按钮，retry 事件透传壳层）。解析失败 → respawn 为 null → 降级走兜底 system 行
       （消息仍在流中，不静默消失——subagent 定向气泡同款降级语义）。 -->
  <RespawnNoticeBar
    v-else-if="respawn"
    data-testid="respawn-notice-bar-slot"
    :variant="respawn"
    @retry="emit('respawnRetry')"
  />
  <!-- 现有 system 提示行（compaction / branch / 兜底文本） -->
  <div v-else class="system-notice content-col flex min-w-0 animate-notice-in items-center gap-2 py-1">
    <span class="h-px flex-1 bg-border" />
    <component :is="icon" class="size-3 shrink-0 text-neutral-mid" />
    <span class="min-w-0 truncate text-[length:var(--text-xs)] leading-snug text-neutral-mid">{{ text }}</span>
    <span class="h-px flex-1 bg-border" />
  </div>
</template>

<script setup lang="ts">
import { GitBranch, Archive, ArrowRight } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import type { Component } from 'vue'
import {
  normalizeContent,
  SUBAGENT_DIRECTIVE_CUSTOM_TYPE,
  parseSubagentDirective,
  PI_RESPAWN_NOTICE_CUSTOM_TYPE,
  parseRespawnNoticeVariant,
} from '@taiji/shared'
import type { Message, SubagentDirectiveData, PiRespawnNoticeVariant } from '@taiji/shared'
import RespawnNoticeBar from './RespawnNoticeBar.vue'

const { t } = useI18n()

const props = defineProps<{
  message: Message
}>()

const emit = defineEmits<{
  /** [u8] 重试按钮点击（仅 restoreFailed 形态渲染）——壳层接手动恢复 RPC */
  respawnRetry: []
}>()

/**
 * subagent 定向数据：customType 匹配且 details 可解析时非 null。
 * 解析失败（details 畸形）→ null → 不渲染定向气泡，降级走下方兜底 system 行
 * （消息 display:true 仍在流中，不静默消失——「渲染过滤不丢消息」规则 9）。
 * 一次性求值（对齐 resolveNotice 先例）：消息对象不可变，props.message 不会原地变更。
 */
const directive: SubagentDirectiveData | null =
  props.message.customType === SUBAGENT_DIRECTIVE_CUSTOM_TYPE
    ? parseSubagentDirective(props.message.content, props.message.details)
    : null

/** [u8] pi 恢复提示条形态：customType 匹配且 variant 合法时非 null（畸形降级同 directive）。 */
const respawn: PiRespawnNoticeVariant | null =
  props.message.customType === PI_RESPAWN_NOTICE_CUSTOM_TYPE
    ? parseRespawnNoticeVariant(props.message.details)
    : null

/** 按消息类型选图标 + 摘要文案（纯函数，props 不变则结果不变） */
const { icon, text } = resolveNotice(props.message)

function resolveNotice(message: Message): { icon: Component; text: string } {
  if (message.compactionSummary) {
    const tokens = message.compactionSummary.tokensBefore
    const tokLabel = tokens !== undefined ? t('panel.message.compactedTokens', { tokens: formatTokens(tokens) }) : ''
    return { icon: Archive, text: t('panel.message.compacted', { tokens: tokLabel }) }
  }
  if (message.branchSummary) {
    const from = message.branchSummary.fromId
    return { icon: GitBranch, text: from ? t('panel.message.branchCreated', { from }) : t('panel.message.branchCreatedNoFrom') }
  }
  // 兜底：纯 system 文本
  return { icon: Archive, text: normalizeContent(message.content) }
}

/** K 格式阈值（>= 此值显示 K，如 237186 → 237.2K，< 此值显原数） */
const K_THRESHOLD = 1000

/** token 数 → K 格式：237186 → 237.2K，13400 → 13.4K，<1000 原数 */
function formatTokens(n: number): string {
  if (n < K_THRESHOLD) return String(n)
  const k = n / K_THRESHOLD
  return `${k.toFixed(1).replace(/\.0$/, '')}K`
}
</script>
