<template>
  <!--
    展示组件 · trace-inspector（session-trace D5b：drawer 临时上下文页）。
    选中 trace 行才切入（PanelContainer default slot v-if chain 最前），不占一级 tab 位
    （SideDrawerTab 体系不变）；顶部「← 返回」清除选中 → 复原前 tab 内容（activeTab 未被
    改过，单向 main→drawer）。两态：
    - 聚合态（selectedKey = entry key）：kind 分支详情（消息类文本/逐 block/工具输出/
      压缩 summary 全文/SYSTEM 留痕全文，其余原始 JSON 兜底，G1 不丢信息）。
    - block 态（selectedKey = `<entryKey>#block-N`）：assistant 子 block 全文
      （thinking/text 正文、toolCall arguments），「← 返回」回父聚合态。
    正文可鼠标框选复制（body 容器 select-text——全局 user-select:none 下的恢复点，
    与 chat 域内容区同款范式）。
  -->
  <div v-if="row" class="flex h-full min-h-0 flex-col" data-testid="trace-inspector">
    <!-- head：返回 + badge（block 态为 block 类型）+ 定位 + copy -->
    <div class="flex flex-shrink-0 items-center gap-2 border-b border-hairline px-2.5 py-2">
      <Button
        variant="ghost"
        size="sm"
        class="h-5 gap-1 px-1.5 text-[length:var(--text-2xs)] text-neutral-dim hover:text-neutral-fg"
        data-testid="trace-inspector-back"
        @click="onBack"
      >
        <ArrowLeft class="size-3" />
        {{ t('panel.trace.inspectorBack') }}
      </Button>
      <span
        class="shrink-0 rounded px-1.5 py-px font-mono text-[length:var(--text-3xs)] tracking-wide"
        :class="badgeClass"
      >{{ badgeLabel }}</span>
      <span class="min-w-0 truncate font-mono text-[length:var(--text-2xs)] text-neutral-fg">#{{ row.seq }}<template v-if="blockIndex !== null"> · block {{ blockIndex }}</template><template v-if="time"> · {{ time }}</template></span>
      <Button
        variant="ghost"
        size="sm"
        class="ml-auto h-5 gap-1 px-1.5 text-[length:var(--text-2xs)] text-neutral-dim hover:text-neutral-fg"
        data-testid="trace-inspector-copy"
        @click="copy(rawJson, 'entry')"
      >
        <Check v-if="copied === 'entry'" class="size-3 text-success" />
        <Copy v-else class="size-3" />
        {{ t(copied === 'entry' ? 'panel.trace.inspectorCopied' : 'panel.trace.inspectorCopy') }}
      </Button>
    </div>
    <!-- sub：来源说明 -->
    <p class="flex-shrink-0 px-2.5 pb-1.5 pt-1 text-[length:var(--text-2xs)] text-neutral-faint">{{ t('panel.trace.inspectorSubtitle') }}</p>
    <!-- body：两态详情（select-text：全局 user-select:none 的内容区恢复点） -->
    <div class="min-h-0 flex-1 select-text overflow-y-auto px-2.5 pb-4" data-testid="trace-inspector-body">
      <!-- 损坏行恢复指引（§3.1）：打开 JSONL 所在目录（Electron reveal-in-folder IPC →
           shell.showItemInFolder；路径来自快照 filePath，未落盘/未知时置灰）。
           [RD-2#6] 行号未知（协议/版本漂移防御）：不承诺行定位、不给出打开目录动作 -->
      <div
        v-if="row.kind === 'MALFORMED'"
        class="mb-2 flex flex-wrap items-center gap-2 rounded-sm border border-hairline bg-bg-input px-2.5 py-2"
        data-testid="trace-malformed-actions"
      >
        <Button
          v-if="malformedLine !== null"
          variant="ghost"
          size="sm"
          :disabled="revealPath === null"
          class="h-5 gap-1 px-1.5 text-[length:var(--text-2xs)] text-neutral-dim"
          data-testid="trace-malformed-reveal"
          @click="onRevealFolder"
        >
          <FolderOpen class="size-3" />
          {{ t('panel.trace.malformedOpenDir') }}
        </Button>
        <span class="min-w-0 flex-1 text-[length:var(--text-2xs)] text-neutral-faint">{{
          malformedLine !== null
            ? t('panel.trace.malformedHint', { line: malformedLine })
            : t('panel.trace.malformedHintUnknownLine')
        }}</span>
      </div>

      <!-- block 态：assistant 子 block 全文（父 entry 溯源 + 类型分支渲染） -->
      <template v-if="block !== null">
        <p class="mb-2 font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ blockParentRef }}</p>
        <pre
          v-if="block.kind === 'thinking' || block.kind === 'text'"
          class="mb-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[length:var(--text-2xs)] leading-relaxed"
          :class="block.kind === 'thinking' ? 'text-reasoning' : 'text-neutral-mid'"
          data-testid="trace-inspector-block-content"
        >{{ block.kind === 'thinking' && block.redacted ? t('panel.trace.blockRedacted') : block.text }}</pre>
        <template v-else-if="block.kind === 'toolCall'">
          <div class="mb-2 flex flex-col gap-1.5">
            <div class="flex items-baseline gap-2 text-[length:var(--text-2xs)]">
              <span class="w-20 flex-shrink-0 text-neutral-faint">toolName</span>
              <span class="min-w-0 break-all font-mono text-[length:var(--text-2xs)] text-neutral-mid">{{ block.name }}</span>
            </div>
            <div class="flex items-baseline gap-2 text-[length:var(--text-2xs)]">
              <span class="w-20 flex-shrink-0 text-neutral-faint">toolCallId</span>
              <span class="min-w-0 break-all font-mono text-[length:var(--text-2xs)] text-neutral-mid">{{ block.callId }}</span>
            </div>
          </div>
          <Button
            v-if="block.callId"
            variant="ghost"
            size="sm"
            :disabled="toolResultKey === null"
            class="mb-2 h-5 gap-1 px-1.5 text-[length:var(--text-2xs)] text-accent hover:underline"
            data-testid="trace-inspector-jump-tool-result"
            :title="t('panel.trace.jumpToolResult')"
            @click="onJumpToolResult"
          >
            <ArrowUpRight class="size-3" />
            {{ t('panel.trace.jumpToolResult') }}
          </Button>
          <pre
            class="mb-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid"
            data-testid="trace-inspector-block-arguments"
          >{{ blockArgumentsJson }}</pre>
        </template>
        <pre
          v-else
          class="mb-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid"
          data-testid="trace-inspector-block-content"
        >{{ safeJson(block.kind === 'unknown' ? block.raw : block) }}</pre>
      </template>

      <!-- 聚合态：kind 分支详情（原有四层） -->
      <template v-else>
        <!-- 消息类：USER / NOTICE(role=custom) / TOOL 输出 文本全文 -->
        <pre v-if="preText !== null" class="mb-2 overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[length:var(--text-2xs)] leading-relaxed text-neutral-mid">{{ preText }}</pre>
        <!-- ASSISTANT：逐 content block（可点击进入 block 态） -->
        <div v-if="blocks.length > 0" class="mb-2 flex flex-col gap-1" data-testid="trace-inspector-blocks">
          <div
            v-for="b in blocks"
            :key="b.key"
            class="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-[length:var(--text-2xs)] text-neutral-mid hover:bg-surface-2"
            :data-testid="`trace-inspector-block-${b.index}`"
            @click="selectTraceEntry(props.sessionId, b.key)"
          >
            <span class="flex-shrink-0 rounded px-1.5 py-px font-mono text-[length:var(--text-3xs)] tracking-wide" :class="b.badgeClass">{{ b.label }}</span>
            <span class="min-w-0 flex-1 truncate" :class="b.thinking ? 'text-reasoning' : ''">{{ b.preview || b.label }}</span>
          </div>
        </div>
        <!-- meta kv（kind 特化字段：exitCode/tokensBefore/version/…）；SESSION 的
             parentSession 是溯源链接（§3.1 样例 5，jump-parent）而非纯文本 -->
        <div class="mb-2 flex flex-col gap-1.5">
          <div v-for="kv in detailKv" :key="kv.k" class="flex items-baseline gap-2 text-[length:var(--text-2xs)]">
            <span class="w-20 flex-shrink-0 text-neutral-faint">{{ kv.k }}</span>
            <Button
              v-if="kv.action === 'jump-parent'"
              variant="ghost"
              size="sm"
              class="h-auto min-w-0 justify-start break-all px-0 py-0 font-mono text-[length:var(--text-2xs)] text-accent hover:underline"
              data-testid="trace-inspector-jump-parent"
              :title="t('panel.trace.jumpParentTitle')"
              @click="onJumpParent"
            >{{ kv.v }} <ArrowUpRight class="size-3" /></Button>
            <span v-else class="min-w-0 break-all font-mono text-[length:var(--text-2xs)] text-neutral-mid" :class="kv.tone === 'bad' ? 'text-danger' : kv.tone === 'ok' ? 'text-success' : ''">{{ kv.v }}</span>
            <!-- 行尾右侧弱标注（usage 桶语义解释；「不进 context」同款视觉档位） -->
            <span v-if="kv.hint" class="ml-auto shrink-0 font-mono text-[length:var(--text-3xs)] text-neutral-faint">{{ kv.hint }}</span>
          </div>
        </div>
      </template>

      <!-- 原始 JSON（通用兜底，G1 不丢信息；默认折叠减少视觉噪音；block 态为该 block 原文） -->
      <details class="group/raw mb-1">
        <summary class="cursor-pointer select-none text-[length:var(--text-3xs)] uppercase tracking-wide text-neutral-faint hover:text-neutral-mid">{{ t('panel.trace.inspectorRaw') }}</summary>
        <pre class="mt-1 overflow-x-auto whitespace-pre-wrap rounded-sm bg-bg-input p-2.5 font-mono text-[length:var(--text-3xs)] leading-relaxed text-neutral-dim">{{ rawJson }}</pre>
      </details>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * inspector 详情渲染。数据源 = useTraceRows 共享派生（与 TraceView 同源）。
 * 两态：block 态（selectedKey 带 `#block-N` 后缀 → 父溯源 + block 全文）与
 * 聚合态（preText 文本全文 / blocks assistant 逐块可点击 / detailKv kind 特化标量 /
 * rawJson 原始 JSON 兜底）四层，按 kind 填充。block 归一化走 core extractContentBlocks。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft, ArrowUpRight, Copy, Check, FolderOpen } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import {
  blockHeadline,
  extractContentBlocks,
} from '@taiji/core/domain/session-trace'
import type { TraceContentBlock, TraceRow } from '@taiji/core/domain/session-trace'
import { useTraceRows } from '@/composables/features/trace/useTraceRows'
import {
  clearTraceSelection,
  revealTraceEntry,
  selectTraceEntry,
  useSessionTrace,
} from '@/composables/features/trace/useSessionTrace'
import {
  parseTraceBlockKey,
  traceBlockKey,
} from '@/composables/features/trace/trace-display-items'
import { jumpToParentSession } from '@/composables/features/trace/useTraceJump'
import { useToast } from '@/composables/useToast'
import { useCopy } from '@/composables/panel/useCopy'
import { revealInFolder } from '@/lib/ipc'
import {
  BLOCK_BADGE_CLASS,
  blockBadgeLabel,
  KIND_BADGE_CLASS,
} from './trace-kind-style'
import { buildTraceDetailKv } from './trace-inspector-kv'
import { buildTracePreText } from './trace-inspector-pretext'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const { copied, copy } = useCopy()
const { error: toastError } = useToast()
const { partition } = useSessionTrace()
const rows = useTraceRows()

/** 选中解析：selectedKey → 行 + block 下标（block 态时非 null；分区切换/清除时整体 null）。 */
const selection = computed<{ row: TraceRow; blockIndex: number | null } | null>(() => {
  const key = partition.value.selectedKey
  if (!key) return null
  const parsed = parseTraceBlockKey(key)
  if (parsed) {
    const row = rows.value.find((r) => r.key === parsed.parentKey) ?? null
    return row ? { row, blockIndex: parsed.index } : null
  }
  const row = rows.value.find((r) => r.key === key) ?? null
  return row ? { row, blockIndex: null } : null
})

const row = computed<TraceRow | null>(() => selection.value?.row ?? null)

const blockIndex = computed<number | null>(() => selection.value?.blockIndex ?? null)

/** block 态的归一化 block（下标越界/非 assistant 行 → null 回聚合态）。 */
const block = computed<TraceContentBlock | null>(() => {
  const sel = selection.value
  if (!sel || sel.blockIndex === null) return null
  const content = (sel.row.entry as { message?: { content?: unknown } })?.message?.content
  return extractContentBlocks(content)[sel.blockIndex] ?? null
})

/** head badge：block 态显示 block 类型，聚合态显示 kind。 */
const badgeClass = computed(() =>
  block.value ? BLOCK_BADGE_CLASS[block.value.kind] : row.value ? KIND_BADGE_CLASS[row.value.kind] : '',
)
const badgeLabel = computed(() => (block.value ? blockBadgeLabel(block.value) : row.value?.kind ?? ''))

const time = computed(() => {
  const ts = row.value?.timestamp
  if (!ts) return ''
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(ts)
  return m ? m[2] : ''
})

/** block 态父溯源行（父 assistant entry id + model）。 */
const blockParentRef = computed(() => {
  const r = row.value
  if (!r) return ''
  const id = r.entry && 'id' in r.entry ? String((r.entry as { id?: unknown }).id ?? '') : ''
  const model = typeof r.meta.model === 'string' ? r.meta.model : ''
  return `assistant ${id}${model ? ` · ${model}` : ''}`
})

/** 返回：block 态回父聚合态（保留 drawer），聚合态清除选中复原前 tab。 */
function onBack(): void {
  const key = partition.value.selectedKey
  const parsed = key ? parseTraceBlockKey(key) : null
  if (parsed) selectTraceEntry(props.sessionId, parsed.parentKey)
  else clearTraceSelection(props.sessionId)
}

/** 文本全文层（构造逻辑提取在 trace-inspector-pretext；block 态不出该层）。 */
const preText = computed<string | null>(() => {
  const r = row.value
  if (!r || block.value !== null) return null
  return buildTracePreText(r)
})

/** assistant 逐 block 清单（聚合态；点击进入 block 态——key = traceBlockKey）。 */
const blocks = computed<
  { index: number; key: string; label: string; preview: string; badgeClass: string; thinking: boolean }[]
>(() => {
  const r = row.value
  if (!r || r.kind !== 'ASSISTANT' || block.value !== null) return []
  const content = (r.entry as { message?: { content?: unknown } })?.message?.content
  return extractContentBlocks(content).map((b, i) => ({
    index: i,
    key: traceBlockKey(r.key, i),
    label: blockBadgeLabel(b),
    preview: blockHeadline(b),
    badgeClass: BLOCK_BADGE_CLASS[b.kind],
    thinking: b.kind === 'thinking',
  }))
})

/** toolCall arguments 展示 JSON（[RD-2#5] 经 safeJson 统一守卫：解析失败/超限降级占位，不让 inspector 崩）。 */
const blockArgumentsJson = computed(() => {
  const b = block.value
  if (!b || b.kind !== 'toolCall') return ''
  return safeJson(b.arguments ?? {})
})

/** 配对 toolResult 行 key（toolCallId 匹配；找不到 → 跳转按钮置灰）。 */
const toolResultKey = computed<string | null>(() => {
  const b = block.value
  if (!b || b.kind !== 'toolCall' || !b.callId) return null
  return rows.value.find((r) => r.kind === 'TOOL' && r.meta.toolCallId === b.callId)?.key ?? null
})

/** 跳到配对 TOOL 行（reveal = 选中 + 滚动定位；inspector 切到该行详情）。 */
function onJumpToolResult(): void {
  const key = toolResultKey.value
  if (key === null) return
  revealTraceEntry(props.sessionId, key)
}

/** kind 特化标量 kv（构造逻辑提取在 trace-inspector-kv，meta SSOT 不二次解析 entry）。 */
const detailKv = computed(() => (row.value ? buildTraceDetailKv(row.value, t) : []))

/** 溯源跳转（§3.1 样例 5）：与 TraceView 的 SESSION 行链接同一编排。 */
async function onJumpParent(): Promise<void> {
  const r = row.value
  if (!r || r.kind !== 'SESSION') return
  const ref = r.meta.parentSession
  if (typeof ref !== 'string' || !ref) return
  const forkId = typeof r.meta.forkEntryId === 'string' ? r.meta.forkEntryId : undefined
  try {
    const result = await jumpToParentSession(props.sessionId, ref, forkId)
    if (!result.ok) {
      toastError(t(result.reason === 'target_not_found' ? 'panel.trace.jumpTargetNotFound' : 'panel.trace.jumpLoadFailed'))
    }
  } catch (e) {
    // jumpToParentSession 内部 await selectSession 会 throw（切 session 失败）——裸
    // reject 成 unhandled 且零反馈；对齐同文件 onRevealFolder 的 catch+toast 先例
    console.error('[trace] jump to parent session failed:', e)
    toastError(t('panel.trace.jumpLoadFailed'))
  }
}

/** reveal 数据源：分区快照透传的 session JSONL 绝对路径（未知 → 按钮置灰）。 */
const revealPath = computed<string | null>(() => partition.value.filePath || null)

/** 打开 JSONL 所在目录（§3.1 损坏行恢复指引）：Electron reveal-in-folder IPC →
 *  shell.showItemInFolder。main 校验绝对路径；web/mock 无 IPC 时 no-op。 */
function onRevealFolder(): void {
  const p = revealPath.value
  if (p === null) return
  void revealInFolder(p).catch((e: unknown) => {
    toastError(t('panel.trace.malformedRevealFailed'))
    console.error('[trace] reveal-in-folder failed:', e)
  })
}

/** JSON.stringify 缩进宽度（原始 entry / block 原文兜底展示）。 */
const JSON_INDENT = 2

/** [RD-2#5] 序列化超限阈值（字符数，200KB）：超出截断 + 标记行，防巨型 entry 拖垮 inspector 渲染。 */
const RAW_JSON_MAX_CHARS = 204_800

/**
 * [RD-2#5] JSON 序列化统一安全出口：模板表达式与 computed 的 JSON.stringify 一律经此。
 * 环形引用 / BigInt 等会在 render 路径直接抛错（消息流无 per-item 错误边界，Inspector
 * 整块空白且无降级标记）——此处 catch 降级占位；超限截断防巨型 payload。
 */
function safeJson(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v, null, JSON_INDENT)
  } catch {
    return t('panel.trace.rawJsonUnserializable')
  }
  // JSON.stringify(undefined) 返回 undefined（非字符串），不能进 .length
  if (s === undefined) return 'undefined'
  if (s.length > RAW_JSON_MAX_CHARS) {
    return `${s.slice(0, RAW_JSON_MAX_CHARS)}\n${t('panel.trace.rawJsonTruncated')}`
  }
  return s
}

/** [RD-2#6] MALFORMED 行号：类型上可缺（协议/版本漂移防御）——null = 未知，
 * 不以 ?? 0 伪装成「第 0 行」指引用户查不存在的行。 */
const malformedLine = computed<number | null>(() => {
  const r = row.value
  return r !== null && r.kind === 'MALFORMED' && typeof r.lineNumber === 'number' ? r.lineNumber : null
})

/** 原始 JSON 兜底：block 态为该 block 原文（content[index]），聚合态为整个 entry。 */
const rawJson = computed(() => {
  const r = row.value
  if (!r) return ''
  const idx = blockIndex.value
  if (idx !== null) {
    const content = (r.entry as { message?: { content?: unknown } })?.message?.content
    const rawBlock = Array.isArray(content) ? content[idx] : undefined
    return safeJson(rawBlock ?? { block: block.value?.kind })
  }
  return safeJson(r.entry ?? { raw: r.raw })
})
</script>
