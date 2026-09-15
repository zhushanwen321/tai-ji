/**
 * 崩溃台账 JSONL 读取的家族统一口径（【oe-audit C5】收敛；设计 §3.1 失败路径）。
 *
 * 此前 trigger-patrol / export-diagnostic-bundle 各自手写 readJournalLines 且语义分叉
 * （patrol 区分 ENOENT/其余错误，bundle 全静默吞）——违反设计 §3.1「评估器读不到台账
 * 文件 → 摘要标注数据缺失而非静默空白」的显式要求。本模块是读取层 SSOT：
 * - ENOENT = 常态空台账（台账文件首事件前不存在，评估器以 no-data 显式呈现）；
 * - 其余读取失败 → 经注入的 warn 出口记一条（非静默）+ 返回空行数组——评估结果
 *   在空行输入下自然落入 no-data 分支，缺失被显式呈现而非静默空白。
 */
import { readFileSync } from 'node:fs'

/** 读取失败 warn 出口（patrol 传 mainLogger.warn 包装；测试注入 spy）。 */
export type JournalReadWarn = (line: string) => void

/** 读台账文件为行数组（含尾随空行伪影，parse 层跳过）。ENOENT = 空台账常态。 */
export function readJournalLines(file: string, warn: JournalReadWarn): string[] {
  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch (err) {
    if (isEnoent(err)) return []
    warn(`[diagnostics] 台账读取失败 ${file}: ${err instanceof Error ? err.message : String(err)}（按空台账处理，评估结果将显式 no-data）`)
    return []
  }
}

export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT'
}
