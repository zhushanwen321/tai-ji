/**
 * JSONL 解析（保留损坏行占位）。
 *
 * 与 pi `parseSessionEntries`（session-manager.ts:299）的差异是本模块的存在理由：
 * pi 静默跳过 malformed 行；trace 是全量台账（design G1），损坏行必须以占位行可见、
 * 不静默丢失（§3.1 失败路径），因此解析产物保留行号与原文。
 *
 * 判定「损坏」：空行跳过（与 pi 一致）；JSON.parse 失败、或解析结果不是
 * JSON 对象（字符串/数字/数组/null）→ 损坏占位。后者比 pi 严格——pi 会把合法
 * JSON 标量 push 进 entries（运行时 type 查询潜在崩点），本模块视为损坏行
 * 更符合「占位可见」的 trace 语义。
 */
import type { TraceFileEntry } from './types'

export type ParsedSessionTraceLine =
  | { ok: true; lineNumber: number; entry: TraceFileEntry }
  | { ok: false; lineNumber: number; raw: string }

/** 解析 session JSONL 文本为逐行产物（ok 行序 = 文件行序；1-based 行号）。 */
export function parseSessionTraceJsonl(text: string): ParsedSessionTraceLine[] {
  const lines = text.split('\n')
  const out: ParsedSessionTraceLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw.trim()) continue
    const lineNumber = i + 1
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        out.push({ ok: true, lineNumber, entry: parsed as TraceFileEntry })
      } else {
        out.push({ ok: false, lineNumber, raw })
      }
    } catch {
      out.push({ ok: false, lineNumber, raw })
    }
  }
  return out
}
