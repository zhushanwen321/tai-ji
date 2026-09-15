/**
 * message.content block 解析（design §3.4 渲染模型补充：assistant 聚合行的子 block 展示）。
 *
 * 输入是 pi AgentMessage.content（宽松 unknown）：assistant 为 thinking/text/toolCall
 * block 数组，toolResult 为 text/image block 数组（真实 corpus 采样确认无其他组合）。
 * 防御性 narrowing（pi session 文件不做校验），未知 block 类型归 unknown 兜底不丢失。
 * 列表子行与 inspector 详情共用本 SSOT——此前组件层手写解析用了错误字段名
 * （toolName/toolCallId vs pi 实际的 name/id），统一收口后消除该类偏差。
 */

/** content block 归一化视图（kind 判别联合；字段名对齐 UI 语义，不透传 pi 原字段名）。 */
export type TraceContentBlock =
  | { kind: 'thinking'; text: string; redacted: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'toolCall'; name: string; callId: string; arguments: unknown }
  | { kind: 'image'; mimeType?: string }
  | { kind: 'unknown'; type: string; raw: unknown }

/** block 子行/清单首行摘要长度上限（纯数据截断；行内溢出由 UI truncate 收尾）。 */
const HEADLINE_MAX = 160

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > HEADLINE_MAX ? `${line.slice(0, HEADLINE_MAX)}…` : line
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** JSON 单行紧凑化（toolCall arguments 摘要：转义换行/真实空白压平 + 截断）。 */
function compactJson(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v) ?? ''
  } catch {
    return '(unserializable)'
  }
  // stringify 产出的换行是字面 `\n` 两字符（非真实空白），需单独压平
  s = s.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim()
  return s.length > HEADLINE_MAX ? `${s.slice(0, HEADLINE_MAX)}…` : s
}

/** content → 归一化 block 数组。非数组（user 的 string content 等）返回 []，由调用方走文本路径。 */
export function extractContentBlocks(content: unknown): TraceContentBlock[] {
  if (!Array.isArray(content)) return []
  const out: TraceContentBlock[] = []
  for (const b of content) {
    if (typeof b !== 'object' || b === null) {
      out.push({ kind: 'unknown', type: '?', raw: b })
      continue
    }
    const block = b as Record<string, unknown>
    switch (block.type) {
      case 'thinking':
        out.push({
          kind: 'thinking',
          text: str(block.thinking),
          redacted: block.redacted === true,
        })
        break
      case 'text':
        out.push({ kind: 'text', text: str(block.text) })
        break
      case 'toolCall':
        out.push({
          kind: 'toolCall',
          name: str(block.name),
          callId: str(block.id),
          arguments: block.arguments,
        })
        break
      case 'image':
        out.push({
          kind: 'image',
          mimeType: typeof block.mimeType === 'string' ? block.mimeType : undefined,
        })
        break
      default:
        // pi 未来新增 block 类型：不丢失，inspector raw JSON 可见
        out.push({ kind: 'unknown', type: String(block.type ?? '?'), raw: block })
        break
    }
  }
  return out
}

/**
 * block 首行摘要（列表子行 headline / inspector 清单 preview；数据提取非 i18n）。
 * 空摘要（redacted thinking 等）由 UI 以 block kind 标签兜底（与行 headline 契约同款）。
 */
export function blockHeadline(block: TraceContentBlock): string {
  switch (block.kind) {
    case 'thinking':
      return firstLine(block.text)
    case 'text':
      return firstLine(block.text)
    case 'toolCall': {
      const args = compactJson(block.arguments)
      return args ? `${block.name} ${args}` : block.name
    }
    case 'image':
      return block.mimeType ?? 'image'
    case 'unknown':
      return compactJson(block.raw)
  }
}
