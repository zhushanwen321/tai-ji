/**
 * pi tool-result 数据归一（W1 提取的深模块）。
 *
 * 消除实时路径（event-adapter.handleToolExecutionEnd）和历史路径
 *（message-converter toolResult 分支）重复的归一逻辑：三态判定（string /
 * content-array / 其他对象）+ stripAnsi + images/details 提取。
 *
 * 设计要点：
 * - details 来自 `raw.details`（实时路语义：raw 即 event.result，pi 把 __gui__ 等放 result 内）。
 *   历史路径传 toolResult（顶层无 result 包装），归一返回的 details 通常为 undefined，
 *   由调用方独立透传顶层 toolResult.details（message-converter 已保留该逻辑）。
 * - outputRaw 仅在 raw 含 ANSI 时出现（与 output 不同），用于对称恢复对话流状态（关键规则 9）。
 */

/** 归一后的工具结果。 */
export interface NormalizedToolResult {
  /** 归一化后的纯文本 output（已剥离 ANSI）。 */
  output: string
  /** 原始文本（含 ANSI 转义），仅当 raw 含 ANSI 时出现。有 ANSI 时 outputRaw !== output。 */
  outputRaw?: string
  /** 工具结构化细节（如 __gui__），来自 raw.details（仅当对象且非数组）。 */
  details?: Record<string, unknown>
  /** 提取出的 image 块（来自 content-array 的 type==='image' 块，过滤空 data）。 */
  images?: Array<{ data: string; mimeType: string }>
}

/** Strip ANSI escape sequences from text (pi RPC mode sends raw escape codes for themed output) */
const ANSI_REGEX = /\x1b\[[0-9;]*m/g

/** Strip ANSI escape sequences — 单一定义点，被 event-adapter / message-converter 共享。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '')
}

/**
 * 把 pi tool-result 的多形态 raw 归一为 { output, outputRaw, details, images }。
 *
 * 三态判定（与原 event-adapter.handleToolExecutionEnd:135-168 逐字对齐）：
 * - string → output=stripAnsi(raw)，含 ANSI 时 outputRaw=raw
 * - 对象 + content 数组 → 提取 text（join '\\n'）+ images，output=stripAnsi(text)
 * - 非 null 对象（非 content 形态）→ output=JSON.stringify(raw)
 * - null/undefined → output=''
 * details：从 raw.details 提取（typeof==='object' && !Array.isArray）。
 */
export function normalizePiToolResult(raw: unknown): NormalizedToolResult {
  let output: string
  let outputRaw: string | undefined
  let images: Array<{ data: string; mimeType: string }> | undefined

  if (typeof raw === 'string') {
    output = stripAnsi(raw)
    if (output !== raw) outputRaw = raw
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).content)) {
    const contentArr = (raw as Record<string, unknown>).content as Array<Record<string, unknown>>
    const rawText = contentArr
      .filter((c) => c.type === 'text')
      .map((c) => (c.text as string) ?? '')
      .join('\n')
    output = stripAnsi(rawText)
    if (output !== rawText) outputRaw = rawText
    const imageBlocks = contentArr
      .filter((c) => c.type === 'image')
      .map((c) => ({ data: String(c.data ?? ''), mimeType: String(c.mimeType ?? '') }))
      .filter((img) => img.data !== '' || img.mimeType !== '')
    if (imageBlocks.length > 0) images = imageBlocks
  } else if (raw != null) {
    output = JSON.stringify(raw)
  } else {
    output = ''
  }

  let details: Record<string, unknown> | undefined
  if (raw && typeof raw === 'object') {
    const d = (raw as Record<string, unknown>).details
    if (d && typeof d === 'object' && !Array.isArray(d)) details = d as Record<string, unknown>
  }

  return { output, outputRaw, details, images }
}
