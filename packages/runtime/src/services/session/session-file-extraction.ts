/**
 * extract*FromSessionFile 共享骨架 —— oversize 预检 + 全量读 + JSONL 解析的单一实现。
 *
 * subagent-extractor 与 workflow-extractor 的文件读取骨架此前逐字复制（statSync 预检 →
 * oversize 降级 warn → readFileSync → parseJsonl → entry 扫描），两份漂移即行为分叉；
 * 本骨架把读取/预检/降级语义收单点，两个 extractor 只提供各自的日志标签、降级文案
 * 与 entry 扫描器（scan 与实时增量拉取共用同一份派生代码的契约不变）。
 *
 * 错误分级契约（renderer 侧栏 stale 守卫的前提，两 extractor 原样保留）：
 * - ENOENT → 空列表 + oversize:false（pi session 文件延迟写入的合法窗口）
 * - 其他读错误 → 原样上抛（RPC 报错，renderer catch 保留旧分区 + 重试态，不与「真实删空」混淆）
 * - 预检 stat 失败（含 ENOENT）→ 走原读路径，错误分级由 readFileSync 承担，预检不引入新抛错
 */

import { readFileSync, statSync } from 'node:fs'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { BYTES_PER_MB, READ_PRECHECK_MAX_BYTES } from '@taiji/shared'

/** extract*FromSessionFile 的结果形状：records + oversize 正交降级标志（不往 records
 * 里塞哨兵记录；正交字段先例 = HistoryFileReadResult {messages, truncated} /
 * traceEntries source:'oversize'）。 */
export interface SessionFileExtraction<T> {
  /** 派生记录列表；oversize 时恒空数组（不做尾读部分提取——extractor 是全文扫描
   * 语义，部分提取的记录缺失面难界定，memory-leak-remediation 三审 INFO-3） */
  records: T[]
  /** 主 session JSONL 超预检阈值的降级标记（true = 未读文件，records 为降级空列表） */
  oversize: boolean
}

/** 各 extractor 注入的差异面：日志标签、降级文案的被提取对象名、entry 扫描器。 */
export interface SessionFileExtractionReader<T> {
  /** warn 留痕的日志前缀（如 'subagent-extractor'） */
  warnTag: string
  /** oversize 降级文案中的被提取对象名（如 'subagent' / 'workflow'） */
  subject: string
  /** entry 扫描器（与实时增量拉取同一份派生代码） */
  scan: (entries: unknown[]) => T[]
}

/**
 * 从主 session JSONL 文件提取记录（冷启动 / RPC 路径的共享骨架）。
 *
 * [G3 / crash-resilience D5⑤] READ_PRECHECK 预检：statSync 大小 > READ_PRECHECK_MAX_BYTES
 * （32MB，与 session-file-utils 全量读预检同阈值同标尺）时不读全文，降级返回空列表 +
 * oversize 标记 + warn 留痕（对齐 trace-sync D5④ 的 oversize 降级范式）。
 */
export function extractRecordsFromSessionFile<T>(
  filePath: string,
  reader: SessionFileExtractionReader<T>,
): SessionFileExtraction<T> {
  let fileSize = -1
  try {
    fileSize = statSync(filePath).size
  } catch {
    // 预检失败不改变错误契约：fall through 到读路径，由 readFileSync 产生原分级错误
    fileSize = -1
  }
  if (fileSize > READ_PRECHECK_MAX_BYTES) {
    console.warn(
      `[${reader.warnTag}] session file oversize ` +
      `(${(fileSize / BYTES_PER_MB).toFixed(1)} MB > ${(READ_PRECHECK_MAX_BYTES / BYTES_PER_MB).toFixed(0)} MB), ` +
      `skip ${reader.subject} extraction (degraded to empty list): ${filePath}`,
    )
    return { records: [], oversize: true }
  }

  let content: string
  try {
    content = readFileSync(filePath, 'utf-8')
  } catch (e) {
    if (isEnoent(e)) return { records: [], oversize: false }
    throw e
  }

  const entries = parseJsonl(content)
  return { records: reader.scan(entries), oversize: false }
}
