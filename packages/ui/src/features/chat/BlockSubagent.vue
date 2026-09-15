<template>
  <!--
    subagent 块（@zhushanwen/pi-subagent-workflow，重写 fork）—— collapsed only（spec §10 / design D2）。
    异步 background 执行：只展示发起参数（input），看不到执行过程（结果由 agent 后续 turn 总结）。
    单行摘要：subagent prefix + agent · slug + (model · thinking X)。
    running → 双环 loader；failed → icon + 文案降 neutral-mid。
    点击整行 → openSubagent（drawer 开 subagent tab，主对话流保留）。subagentId 取自 toolResult.output。
  -->
  <div class="trace-subagent pb-2.5 mb-0.5" data-testid="subagent-block">
    <div
      class="flex min-w-0 cursor-pointer select-none items-center gap-1.5 text-[length:var(--text-base)] font-medium text-neutral-dim transition-opacity hover:opacity-80"
      @click="openSubagentDrawer"
    >
      <!-- running 态 loader（双环 + accent），其余走 users ICON -->
      <span v-if="isRunning" class="inline-flex size-[13px] shrink-0 items-center justify-center text-accent animate-loader-spin" v-html="RUNNING_LOADER_SVG" /> <!-- eslint-disable-line vue/no-v-html -- hardcoded constant from block-icon.ts -->
      <component
        :is="BLOCK_ICON_LUCIDE.subagent"
        v-else
        class="size-3.5 shrink-0 text-neutral-ico hover:text-neutral-ico-hover"
        :class="isFailed ? 'hover:text-warn' : ''"
      />
      <span class="mr-0.5 inline-block shrink-0 whitespace-nowrap font-mono text-[length:var(--text-2xs)] font-semibold tracking-[0.08em] text-neutral-dim">Subagent</span>
      <span class="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-sm)] text-accent">{{ subagentAgent }}</span>
      <template v-if="subagentSlug">
        <span class="text-neutral-faint">·</span>
        <span class="shrink-0 whitespace-nowrap font-mono text-[length:var(--text-sm)] text-accent">{{ subagentSlug }}</span>
      </template>
      <template v-if="subagentModel">
        <span class="text-neutral-dim font-mono text-[length:var(--text-xs)]">&nbsp;(</span>
        <span class="font-mono text-[length:var(--text-xs)] text-accent">{{ subagentModel }}</span>
        <span v-if="subagentThinkingLevel" class="text-neutral-dim font-mono text-[length:var(--text-xs)]">&nbsp;· thinking {{ subagentThinkingLevel }})</span>
        <span v-else class="text-neutral-dim font-mono text-[length:var(--text-xs)]">)</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { ToolCall } from '@taiji/shared'
import { subagentVirtualId } from '@taiji/shared'
import { openSubagent } from '@taiji/core/domain/drawer'
import { BLOCK_ICON_LUCIDE, RUNNING_LOADER_SVG } from './block-icon'

const props = defineProps<{
  tool: ToolCall
  /** 所属主 session ID（构造 subagent 虚拟 id 的 mainSid 段；点击开 drawer 用） */
  sessionId?: string | null
}>()

const isFailed = computed(() => props.tool.status === 'error')
const isRunning = computed(() => props.tool.status === 'running')

/* header 色（feat-chat-flow-dim）：恒 neutral-dim 置灰（用户裁决降两档，dim 不过 AA——
 * 仅限过程块折叠 header；running 由 loader + accent 文案表达）。 */

/** 顶层 input 安全读取。
 *  拍平 schema：action / agent / slug / model / thinkingLevel / task 都在顶层（非 startParam 嵌套）。 */
const inputObj = computed<Record<string, unknown>>(() => {
  const input = props.tool.input
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
})

/** agent 名（顶层 input.agent，默认 general-purpose）。
 *  完整路径仅显示最后一段（去掉目录和 .md 后缀），如 `~/.agents/skills/explorer/agent.md` → `explorer`。 */
function extractAgentBasename(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'general-purpose'
  const lastSlash = trimmed.lastIndexOf('/')
  const base = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed
  return base.replace(/\.md$/i, '') || 'general-purpose'
}
const subagentAgent = computed(() => {
  const agent = inputObj.value.agent
  return typeof agent === 'string' ? extractAgentBasename(agent) : 'general-purpose'
})

/** slug（顶层 input.slug，短标签，≤35 字符）。 */
const subagentSlug = computed(() => {
  const slug = inputObj.value.slug
  return typeof slug === 'string' ? slug.trim() : ''
})

/** model override（顶层 input.model，provider/modelId 格式）。 */
const subagentModel = computed(() => {
  const model = inputObj.value.model
  return typeof model === 'string' && model.trim() ? model : ''
})

/** thinkingLevel（off/minimal/low/medium/high/xhigh）。 */
const subagentThinkingLevel = computed(() => {
  const level = inputObj.value.thinkingLevel
  return typeof level === 'string' && level.trim() ? level : ''
})

/**
 * subagentId（来自 toolResult.output 的顶层 subagentId 字段）。
 *
 * 数据来源（read 源码确认，非推测）：packages/shared/src/subagent.ts:36-37 —— subagentId 是
 * toolResult.subagentId（pi-subagent-workflow start action 立即返回，即便 subagent 仍在 running）。
 * input 不含 subagentId（start action 的 input 只有 task/slug/agent/model/thinkingLevel 等发起参数；
 * 仅 cancel action 的 cancelParam.subagentId 有，但 cancel 块非本组件点击入口）。
 *
 * output 形态：{ action, subagentId, sessionFile, slug, bgResponse: { status, mode, message } }。
 * running 早期 output 可能未就绪（空串/非 JSON）→ 此时点击为 no-op（不抛错）。
 */
const subagentId = computed<string | null>(() => {
  const raw = props.tool.output?.trim()
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') {
      const id = (data as Record<string, unknown>).subagentId
      if (typeof id === 'string' && id.trim()) return id
    }
  } catch (err) {
    // output 非合法 JSON（纯文本结果或空串）→ 无 subagentId，点击 no-op。预期分支非错误。
    void err
  }
  return null
})

/** 点击整行 → drawer 开 subagent tab（D2/D4）。mainSid 来自 sessionId prop，subId 来自 output。
 *  缺任一（running 早期 output 未就绪 / sessionId 缺）→ no-op，不阻断对话流。 */
function openSubagentDrawer(): void {
  const mainSid = props.sessionId
  const subId = subagentId.value
  if (!mainSid || !subId) return
  openSubagent({ virtualId: subagentVirtualId(mainSid, subId), enteredFrom: 'chat' })
}
</script>
