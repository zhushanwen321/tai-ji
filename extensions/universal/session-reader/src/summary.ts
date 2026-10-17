/**
 * session_read 工具的收起态一行摘要（GUI details.summary + TUI renderResult 共用）。
 *
 * 纯函数：按 params.action 分支，从 result.details 容错取数（details 形态随 action
 * 与历史 entry 版本漂移，逐字段 typeof/Array.isArray 守卫，取不到的后缀省略）。
 * 文案与 content 正文风格一致（动作 + 数量/目标），一行英文，不带逐条详情。
 */

import type { SessionReadParams, ToolResult } from './tool-handler.js'
import { pad } from './handler-utils.js'

// ---- details 容错取数原语（details 是 unknown，逐字段守卫替代裸断言）----

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function numOf(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function strOf(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function arrOf(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined
}

function countOf(details: Record<string, unknown>, key: string): number {
  return arrOf(details[key])?.length ?? 0
}

/** 截断标注（find/search/result 的 truncated 字段在场且为真时追加） */
function truncatedSuffix(details: Record<string, unknown>): string {
  return details.truncated === true ? ' (truncated)' : ''
}

/**
 * 按 action 产出一行摘要。action 与 details 不匹配（历史 entry / 异常形态）时
 * 落到该 action 的兜底文案，不抛错——summary 是展示面，失败不追究。
 */
export function buildSessionReadSummary(params: SessionReadParams, result: ToolResult): string {
  const details = asRecord(result.details)

  // 消歧结果（任意 action 的 session 解析多匹配共用此 details 形态）
  if (details.ambiguous === true) {
    const candidates = countOf(details, 'candidates')
    return `Ambiguous session "${params.session ?? ''}": ${candidates} candidates`
  }

  switch (params.action) {
    case 'find': {
      const query = params.query ?? ''
      const matches = countOf(details, 'matches')
      if (matches === 0) return `No sessions matching "${query}"`
      return `Found ${matches} sessions matching "${query}"${truncatedSuffix(details)}`
    }

    case 'family': {
      // recursive=true 的 details 是 { tree }；flat 的 details 是 Family（root/parents/forks/subagents/workflows）
      if (details.tree !== undefined) return `Execution tree of session ${params.session ?? ''}`
      const relations =
        countOf(details, 'parents') + countOf(details, 'forks') + countOf(details, 'subagents') + countOf(details, 'workflows')
      return `Family of session ${params.session ?? ''}: ${relations} relations`
    }

    case 'outline': {
      const stats = asRecord(details.stats)
      const turns = numOf(stats.totalTurns)
      return turns === undefined
        ? `Outline of session ${params.session ?? ''}`
        : `Outline of session ${params.session ?? ''} · ${turns} turns`
    }

    case 'expand': {
      const turn = numOf(asRecord(details.turn).index)
      const entries = countOf(details, 'entries')
      return `Expanded turn ${turn !== undefined ? `T${pad(turn)}` : (params.turn ?? '')} · ${entries} entries`
    }

    case 'detail': {
      const label = strOf(details.turns) ?? params.turns ?? ''
      return `Read turns ${label} · ${countOf(details, 'entries')} entries`
    }

    case 'search': {
      const pattern = params.pattern ?? ''
      const hits = countOf(details, 'hits')
      if (hits === 0) return `No hits for "${pattern}"`
      return `Found ${hits} hits for "${pattern}"${truncatedSuffix(details)}`
    }

    case 'export': {
      const format = params.format ?? 'outline'
      const sizeBytes = numOf(details.sizeBytes)
      return sizeBytes === undefined
        ? `Exported ${format} view`
        : `Exported ${format} view · ${sizeBytes} bytes`
    }

    case 'extract': {
      const what = strOf(details.what) ?? params.what ?? ''
      const count = numOf(details.count) ?? 0
      if (count === 0) return `No ${what} found`
      const shown = numOf(details.shown)
      const clipped = details.truncated === true && shown !== undefined ? ` (showing ${shown})` : ''
      return `Extracted ${count} ${what}${clipped}`
    }

    case 'workflow': {
      const runs = countOf(details, 'runs')
      if (runs === 0) return 'No workflow runs'
      const skipped = countOf(details, 'skippedRuns')
      return `Found ${runs} workflow runs${skipped > 0 ? ` · ${skipped} skipped` : ''}`
    }

    case 'result': {
      // 批量 details = { count, items }；单条 details = ResultItem 本体（session/totalChars/truncated）
      const count = numOf(details.count)
      if (count !== undefined && details.items !== undefined) {
        return `Read ${count} final results`
      }
      const session = strOf(details.session) ?? params.session ?? ''
      const totalChars = numOf(details.totalChars)
      return `Read final result of ${session} · ${totalChars !== undefined ? `${totalChars} chars` : 'done'}${truncatedSuffix(details)}`
    }

    case 'doctor': {
      const roots = arrOf(details.roots)
      return roots !== undefined ? `Doctor: ${roots.length} roots checked` : 'Doctor check completed'
    }

    default:
      return 'Done'
  }
}

/**
 * 给 tool result 的 details 追加 summary（现有字段一律保留）。details 非对象
 * （防御形态）时整体替换为 { summary }——生产路径 details 恒为对象，此分支只为
 * 类型完备。
 */
export function withResultSummary(params: SessionReadParams, result: ToolResult): ToolResult {
  const summary = buildSessionReadSummary(params, result)
  const details = result.details
  if (details === null || typeof details !== 'object' || Array.isArray(details)) {
    return { ...result, details: { summary } }
  }
  return { ...result, details: { ...details, summary } }
}
