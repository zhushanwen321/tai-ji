/**
 * 过滤后台账行 → 列表渲染项派生（assistant 聚合行的子 block 内联展开）。
 *
 * 台账契约「一行 = 一个 entry」不变（core mapSessionTraceRows SSOT）：子 block 是单个
 * assistant entry 的 content 展开，纯展示层派生。selectedKey 寻址扩展为
 * `<entryKey>#block-<N>`（traceBlockKey 本文件 SSOT）——entry key 取值域（pi id /
 * `line:N` / `malformed:N` / `sidecar:session_end`）不含 `#`，分隔符无歧义。
 */
import { blockHeadline, extractContentBlocks } from '@taiji/core/domain/session-trace'
import type { TraceContentBlock, TraceRow } from '@taiji/core/domain/session-trace'

/** block 寻址分隔符（entry key 取值域不含 `#`，无碰撞）。 */
const BLOCK_KEY_SEPARATOR = '#block-'

/** block 选中 key（`<entryKey>#block-<N>`）。 */
export function traceBlockKey(parentKey: string, index: number): string {
  return `${parentKey}${BLOCK_KEY_SEPARATOR}${index}`
}

/** 解析 block 选中 key；非 block 寻址返回 null。 */
export function parseTraceBlockKey(key: string): { parentKey: string; index: number } | null {
  const m = /^(.*)#block-(\d+)$/.exec(key)
  return m ? { parentKey: m[1], index: Number(m[2]) } : null
}

/** 渲染项：台账行 / assistant 子 block 行 / context 分界行。 */
export type TraceDisplayItem =
  | { kind: 'row'; row: TraceRow; expanded: boolean }
  | {
      kind: 'block'
      parent: TraceRow
      index: number
      block: TraceContentBlock
      headline: string
      /** toolCall 子行的配对结果态（按 toolCallId 匹配 TOOL 行；未配对 undefined——与 TOOL
       *  行区分：子行是「调用 + 结果态」，TOOL 行是结果 entry 本身，配对而非重复渲染）。 */
      resultState?: 'ok' | 'error'
    }
  | { kind: 'divider' }

/** 渲染项稳定 key（virtua stable-key 与选中态比较共用）。 */
export function displayItemKey(item: TraceDisplayItem): string {
  switch (item.kind) {
    case 'row':
      return item.row.key
    case 'block':
      return traceBlockKey(item.parent.key, item.index)
    case 'divider':
      return 'ctx-divider'
  }
}

/** assistant 行是否可展开（content 为非空数组；展开抽取走 core，收起态免解析）。 */
function assistantContent(row: TraceRow): unknown {
  return (row.entry as { message?: { content?: unknown } } | undefined)?.message?.content
}

/** 过滤后行 + 展开集 → 渲染项（子 block 跟随父行：父行被过滤掉则子行不出现）。 */
export function buildTraceDisplayItems(rows: TraceRow[], expandedKeys: string[]): TraceDisplayItem[] {
  const expanded = new Set(expandedKeys)
  // toolCallId → 结果态（toolCall 子行显示配对结果，区分「调用」与 TOOL 结果行）
  const resultByCallId = new Map<string, 'ok' | 'error'>()
  for (const row of rows) {
    if (row.kind !== 'TOOL') continue
    const callId = typeof row.meta.toolCallId === 'string' ? row.meta.toolCallId : ''
    if (callId && !resultByCallId.has(callId)) {
      resultByCallId.set(callId, row.meta.isError === true ? 'error' : 'ok')
    }
  }
  const out: TraceDisplayItem[] = []
  for (const row of rows) {
    const content = row.kind === 'ASSISTANT' ? assistantContent(row) : undefined
    const expandable = Array.isArray(content) && content.length > 0
    const isOpen = expandable && expanded.has(row.key)
    out.push({ kind: 'row', row, expanded: isOpen })
    if (isOpen) {
      extractContentBlocks(content).forEach((block, index) => {
        out.push({
          kind: 'block',
          parent: row,
          index,
          block,
          headline: blockHeadline(block),
          resultState:
            block.kind === 'toolCall' && block.callId ? resultByCallId.get(block.callId) : undefined,
        })
      })
    }
  }
  return out
}
