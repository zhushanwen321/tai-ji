/**
 * 输出文件 tail 读取原语（末尾字节窗口 + 行/字节双上限）——跨端单一实现。
 *
 * 此前两侧各持一份逐行同构实现且签名已实际漂移（bte `(file, maxLines, maxBytes)`
 * vs runtime `(file, maxBytes, maxLines)`；返回字段 `output` vs `text`）——本模块
 * 定型单一签名：`(file, opts: { maxBytes, maxLines })` → `{ text, truncated }`
 * （字段名取 runtime 的 `text`，比 `output` 中性且不与「输出文件」混淆）。
 *
 * 默认上限（bte 50KB / runtime 32KB）是各自产品决策，**留在各调用方**传参，
 * 本模块不设默认值。
 *
 * 日志通道：零日志依赖——close 失败（已读完内容，不影响结果）的 debug 诊断经可选
 * 回调 `onLog('debug', event, detail)` 上报，调用方不适配则静默。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs'

/** output-tail 日志回调（落盘/console 通道由调用方适配注入；close debug 可选）。 */
export type OutputTailLogFn = (level: 'warn' | 'debug', event: string, detail?: unknown) => void

/** tail 读取上限（字节/行双上限，先到为准；由调用方按产品口径传参）。 */
export interface OutputTailOptions {
  maxBytes: number
  maxLines: number
}

export interface OutputTailResult {
  text: string
  /** 读取窗口被截断（内容超任一上限）时 true。 */
  truncated: boolean
}

/** 字节窗口余量：截窗口可能吞掉首行前半，余量降低残行概率。 */
const TAIL_WINDOW_MARGIN_BYTES = 64

/**
 * 读文件尾部（行/字节双上限）。文件不存在/不可读返回 undefined——调用方按
 * 「输出丢失」降级，不崩溃。实现从文件末尾按字节窗口读（不整读大文件，
 * O(maxBytes) 而非 O(fileSize)）。
 */
export function readOutputTail(
  outputFile: string,
  opts: OutputTailOptions,
  onLog?: OutputTailLogFn,
): OutputTailResult | undefined {
  const { maxBytes, maxLines } = opts
  let size: number
  try {
    size = statSync(outputFile).size
  } catch {
    return undefined
  }
  // 字节窗口从末尾取 maxBytes + 余量（截窗口可能吞掉首行前半，余量降低概率）
  const windowSize = Math.min(size, maxBytes + TAIL_WINDOW_MARGIN_BYTES)
  const buffer = Buffer.alloc(windowSize)
  let fd: number | undefined
  try {
    fd = openSync(outputFile, 'r')
    readSync(fd, buffer, 0, windowSize, size - windowSize)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch (err) {
        // 已读完内容，close 失败不影响结果，仅留诊断
        onLog?.('debug', 'output tail close failed', { outputFile, err })
      }
    }
  }
  const text = buffer.toString('utf8')
  const lines = text.split('\n')
  // 窗口起点可能落在行中间：首行是残行时丢弃（它必然不完整）
  const firstLineIsPartial = windowSize < size && lines.length > 0
  const effectiveLines = firstLineIsPartial ? lines.slice(1) : lines
  const byteTruncated = size > maxBytes
  const shown = effectiveLines.slice(-maxLines).join('\n')
  return { text: shown, truncated: byteTruncated || effectiveLines.length > maxLines }
}
