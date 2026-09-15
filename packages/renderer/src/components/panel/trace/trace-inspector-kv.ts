/**
 * inspector 聚合态 kind 特化标量 kv 构造（从 TraceInspector 提取的纯函数，
 * script setup 行数约束；Gate-1.5 复杂度门禁后按 kind 拆子构造器，主函数只做
 * id/parentId 公共头 + 分派 + context 尾注）。值取自 row.meta——core summarizeRow
 * 提取的 SSOT，不二次解析 entry；句子级文案（context 标注）由调用方传 t()。
 */
import type { TraceRow, TraceRowMeta } from '@taiji/core/domain/session-trace'

export interface TraceDetailKv {
  k: string
  v: string
  tone?: 'ok' | 'bad'
  action?: 'jump-parent'
  /** 行尾右侧弱标注（usage 桶语义等解释；「不进 context」同款视觉档位）。 */
  hint?: string
}

type Translator = (key: string) => string

/** 条件 push（undefined/'' 跳过）+ 原始条目出口（带 action 的特殊行）。 */
interface KvCtx {
  t: Translator
  push: (k: string, v: unknown, tone?: 'ok' | 'bad', hint?: string) => void
  emit: (kv: TraceDetailKv) => void
}

function buildAssistantKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { t, push } = ctx
  push('model', m.model)
  push('provider', m.provider)
  push('stopReason', m.stopReason)
  // usage 行尾弱标注解释互斥桶语义（cacheRead > input 是常态而非异常）：
  // pi-ai 跨协议归一化后 input = 未缓存，输入侧合计 = 未缓存 + 命中 + 写入
  push('inputTokens', m.inputTokens, undefined, t('panel.trace.usageUncached'))
  push('outputTokens', m.outputTokens)
  push('cacheRead', m.cacheReadTokens, undefined, t('panel.trace.usageCacheRead'))
  if (m.cacheWriteTokens) push('cacheWrite', m.cacheWriteTokens, undefined, t('panel.trace.usageCacheWrite'))
  push('inputTotal', m.inputTotal, undefined, t('panel.trace.usageInputTotal'))
  if (m.reasoningTokens) push('reasoning', m.reasoningTokens, undefined, t('panel.trace.usageReasoning'))
  push('cost', m.costTotal)
}

function buildToolKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { push } = ctx
  push('toolName', m.toolName)
  push('toolCallId', m.toolCallId)
  if (m.isError === true) push('result', 'error', 'bad')
  else if (m.isError === false) push('result', 'ok', 'ok')
}

function buildBashKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { push } = ctx
  push('command', m.command)
  if (m.exitCode !== undefined) push('exitCode', m.exitCode, m.exitCode === 0 ? 'ok' : 'bad')
  push('cancelled', m.cancelled)
  push('truncated', m.truncated)
  push('fullOutputPath', m.fullOutputPath)
  push('excludeFromContext', m.excludeFromContext)
}

function buildCompactedKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { push } = ctx
  push('tokensBefore', m.tokensBefore)
  push('firstKeptEntryId', m.firstKeptEntryId)
  push('fromHook', m.fromHook)
}

function buildBranchKv(m: TraceRowMeta, ctx: KvCtx): void {
  ctx.push('fromId', m.fromId)
}

function buildSystemKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { push } = ctx
  push('version', m.version)
  push('reason', m.reason)
  push('hash', m.hash)
  push('charCount', m.charCount)
}

function buildSessionKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { push, emit } = ctx
  push('cwd', m.cwd)
  // 溯源链接（§3.1 样例 5）：两形态（文件路径 / sessionId）由 useTraceJump 解析
  if (m.parentSession !== undefined) {
    emit({ k: 'parentSession', v: String(m.parentSession), action: 'jump-parent' })
  }
  push('forkEntryId', m.forkEntryId)
}

function buildBoundaryKv(m: TraceRowMeta, ctx: KvCtx): void {
  const { push } = ctx
  push('outcome', m.outcome)
  push('reason', m.reason)
  push('handedOffTo', m.handedOffTo)
}

/** kind → 特化构造器（未列 kind 走 customType 兜底）。 */
const KIND_KV_BUILDERS: Partial<Record<TraceRow['kind'], (m: TraceRowMeta, ctx: KvCtx) => void>> = {
  ASSISTANT: buildAssistantKv,
  TOOL: buildToolKv,
  BASH: buildBashKv,
  COMPACTED: buildCompactedKv,
  BRANCH: buildBranchKv,
  SYSTEM: buildSystemKv,
  SESSION: buildSessionKv,
  BOUNDARY: buildBoundaryKv,
}

export function buildTraceDetailKv(row: TraceRow, t: Translator): TraceDetailKv[] {
  const out: TraceDetailKv[] = []
  const push = (k: string, v: unknown, tone?: 'ok' | 'bad', hint?: string) => {
    if (v !== undefined && v !== '') out.push({ k, v: String(v), tone, hint })
  }
  push('id', row.entry && 'id' in row.entry ? (row.entry as { id?: unknown }).id : undefined)
  push('parentId', row.entry && 'parentId' in row.entry ? (row.entry as { parentId?: unknown }).parentId : undefined)
  const build = KIND_KV_BUILDERS[row.kind]
  if (build) build(row.meta, { t, push, emit: (kv) => out.push(kv) })
  else push('customType', row.meta.customType)
  // context 语义标注（§3.4：全量态下不进 context 的 kind 弱标记；影子化给排查线索）
  if (row.shadowed) out.push({ k: 'context', v: t('panel.trace.shadowedHint') })
  else if (!row.inContext) out.push({ k: 'context', v: t('panel.trace.notInContext') })
  return out
}
