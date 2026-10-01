/**
 * 会话文件读取策略双轨（W1 [D6/D7]）：
 * - 旧格式惰性兼容读路径 extractRecordsFromSessionFile：读侧换源后调用方收窄为
 *   oversize 分流（v1 巨文件时代会话，>32MB）——32MB 预检与 oversize 语义退役至
 *   此专属。行为冻结：预检/降级/错误分级语义保持改造前逐字不变；
 * - 新路径冷启动流式扫描 scanRecordFamilyEntriesFromSessionFile：按块读 + 行预过滤
 *   + 仅 record 族 entry 进结果（不整串物化、不解析全部对话行），journal 投影的
 *   entry 源冷启动专用（events-projection.ts 消费）。
 *
 * subagent-extractor 与 workflow-extractor 的文件读取骨架此前逐字复制（statSync 预检 →
 * oversize 降级 warn → readFileSync → parseJsonl → entry 扫描），两份漂移即行为分叉；
 * 本骨架把读取/预检/降级语义收单点，两个 extractor 只提供各自的日志标签、降级文案
 * 与 entry 扫描器。
 *
 * 错误分级契约（renderer 侧栏 stale 守卫的前提，两 extractor 原样保留）：
 * - ENOENT → 空列表 + oversize:false（pi session 文件延迟写入的合法窗口）
 * - 其他读错误 → 原样上抛（RPC 报错，renderer catch 保留旧分区 + 重试态，不与「真实删空」混淆）
 * - 预检 stat 失败（含 ENOENT）→ 走原读路径，错误分级由 readFileSync 承担，预检不引入新抛错
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { parseJsonl } from '../../utils/jsonl.js'
import { isEnoent } from '../../utils/errors.js'
import { warnOnce } from '../../utils/warn-once.js'
import { BYTES_PER_MB, READ_PRECHECK_MAX_BYTES } from '@taiji/shared'
import {
  SUBAGENT_RECORD_CUSTOM_TYPE,
  WORKFLOW_RECORD_CUSTOM_TYPE,
  WORKFLOW_STATE_LINK_CUSTOM_TYPE,
} from '@zhushanwen/subagent-core'

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

// ── [W1 / D6] 新路径冷启动流式扫描（32MB 扫描上界）─────────────

/**
 * 行预过滤线索（substring 先行，命中才 JSON.parse——会话文件主体是对话 entry，
 * record 族条目是稀疏少数；线索取宽：误命中无害，解析后由扫描器形状过滤；
 * 漏命中有害：记录消失）。覆盖 v1/v2 条目族 + legacy 解析所需的 message/
 * session/bg-notify 形态。
 */
const RECORD_FAMILY_LINE_HINTS: readonly string[] = [
  SUBAGENT_RECORD_CUSTOM_TYPE, // v1 快照 + v2 注册/终态条目
  WORKFLOW_RECORD_CUSTOM_TYPE, // 同上（两族）
  WORKFLOW_STATE_LINK_CUSTOM_TYPE, // legacy workflow 指针
  'subagent-bg-notify', // legacy bg-notify custom_message
  '"subagent"', // legacy toolCall（"name":"subagent"）/ toolResult（"toolName":"subagent"）
  '"type":"session"', // legacy 主 cwd 提取（findLegacyMainCwd）
]

/** 流式扫描的读块大小（256KiB = 262_144：行平均 <2KB，跨块行拼接余量充足）。 */
const STREAM_CHUNK_BYTES = 262_144

/**
 * 主 session 文件的 record 族条目流式扫描（新路径冷启动专用，journal 投影的
 * entry 源喂入面）。
 *
 * 与上方全文兼容路径的区别：按块读 + 行预过滤 + 仅 record 族 entry 进结果，
 * 扫描字节上界 = READ_PRECHECK_MAX_BYTES。上界外（v1 巨文件时代会话）返回
 * null——调用方回落旧格式惰性兼容读路径。
 *
 * ENOENT / 打开失败 → 空条目（pi session 文件延迟写入的合法窗口，与既有骨架
 * 分级一致：缺文件必然无 record）。
 */
export function scanRecordFamilyEntriesFromSessionFile(filePath: string): unknown[] | null {
  let size: number
  try {
    size = statSync(filePath).size
  } catch {
    return []
  }
  if (size > READ_PRECHECK_MAX_BYTES) return null
  const entries: unknown[] = []
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    return []
  }
  try {
    const chunk = Buffer.alloc(STREAM_CHUNK_BYTES)
    let carry = ''
    let scanned = 0
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, STREAM_CHUNK_BYTES, null)
      if (bytesRead === 0) break
      scanned += bytesRead
      if (scanned > READ_PRECHECK_MAX_BYTES) return null // 防御：stat 与读之间增长超界
      const text = carry + chunk.subarray(0, bytesRead).toString('utf8')
      const lastNewline = text.lastIndexOf('\n')
      if (lastNewline === -1) {
        carry = text
        continue
      }
      for (const line of text.slice(0, lastNewline).split('\n')) {
        collectRecordFamilyLine(filePath, line, entries)
      }
      carry = text.slice(lastNewline + 1)
    }
    collectRecordFamilyLine(filePath, carry, entries) // 末段（无尾随换行的最后一行）
    return entries
  } finally {
    closeSync(fd)
  }
}

function collectRecordFamilyLine(filePath: string, line: string, entries: unknown[]): void {
  if (line.length === 0) return
  let hit = false
  for (const hint of RECORD_FAMILY_LINE_HINTS) {
    if (line.includes(hint)) {
      hit = true
      break
    }
  }
  if (!hit) return
  try {
    entries.push(JSON.parse(line))
  } catch (e) {
    // 坏行宽容跳过 + warnOnce 留证（与 JSONL 全文解析器的逐行容忍语义一致；
    // 按文件去重防坏行密集的旧文件刷屏）
    warnOnce(
      `record-family-scan:${filePath}`,
      `[session-file-extraction] record family scan skipped a malformed line in ${filePath}`,
      e instanceof Error ? e.message : e,
    )
  }
}
