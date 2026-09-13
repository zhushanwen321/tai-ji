/**
 * 工具块补充细节条 meta 计算（从 Block.vue 拆出，控 script 行数）。
 *
 * 职责：计算展开后细节条的 meta 项（错误摘要 + 行数/字符数）。
 *  - 行数/字符数：pi 协议不返回文件元信息（exit code / fileSize 均无），前端从 output 自算。
 *    read 工具 output 是文件内容，行数/字符数有统计意义；bash output 是命令输出，行数有参考价值；
 *    edit/write 等 output 是简短确认（如 "done"），行数无意义不展示。
 *  - 失败态错误摘要已移至内容区（displayContent 兕底 tool.error），meta 仅保留中性 muted 项。
 *  - 耗时已上提为 Block header 行尾常驻槽（chat-flow-timestamp U2），meta 不再重复。
 *
 * formatDuration 已移除（chat-flow-timestamp U2：耗时由 Block header 槽直用 format-utils）。
 */
import { computed, type ComputedRef } from 'vue'
import type { ToolCall } from '@xyz-agent/shared'

export interface MetaItem {
  /** 高亮态。当前只产出 muted（中性灰 dim）；保留枚举字段以备后续状态色扩展。 */
  tone: 'muted'
  text: string
}

/** 字符数格式化阈值（>= 此值显示为 XK chars） */
const CHAR_K_THRESHOLD = 1000
/** 有输出统计意义的工具（行数/字符数） */
const OUTPUT_META_TOOLS = new Set(['read', 'bash', 'cat', 'glob', 'grep', 'list'])

export function useToolMeta(params: {
  tool: ComputedRef<ToolCall | undefined>
  toolName: ComputedRef<string>
  isFailed: ComputedRef<boolean>
}): { metaItems: ComputedRef<MetaItem[]> } {

  /** 字符数格式化：>= CHAR_K_THRESHOLD 显示为 XK chars，否则原值 + chars */
  function formatCharCount(n: number): string {
    if (n >= CHAR_K_THRESHOLD) return `${(n / CHAR_K_THRESHOLD).toFixed(1)}K chars`
    return `${n} chars`
  }

  const metaItems = computed<MetaItem[]>(() => {
    const items: MetaItem[] = []
    const tool = params.tool.value
    // 失败态错误摘要已移至内容区（displayContent 兜底 tool.error），meta 不再重复展示
    // 工具特化：行数/字符数（仅 read/bash 等输出有统计意义的工具）
    // failed 时跳过——行数/字符数无参考价值
    const name = params.toolName.value
    const output = tool?.output ?? ''
    if (!params.isFailed.value && OUTPUT_META_TOOLS.has(name) && output.trim()) {
      const lineCount = output.split('\n').length
      items.push({ tone: 'muted', text: `${lineCount} 行` })
      // read/cat 额外显示字符数（文件内容大小有参考价值）
      if (name === 'read' || name === 'cat') {
        items.push({ tone: 'muted', text: formatCharCount(output.length) })
      }
    }
    return items
  })

  return { metaItems }
}
