/**
 * JSONL 解析工具（G2）。
 *
 * 统一散落各处的「逐行 JSON.parse + 跳过空行/畸形行」循环：
 * - infra/pi/session-file-utils.extractSessionName（原倒序找首条匹配）
 * - services/session-history.loadHistory（原正序 filter + 收集）
 *
 * 共性骨架：split 行 → 跳空行 → JSON.parse → 失败静默跳过 → 成功 yield。
 * 各消费方对返回的 entries 再做自己的领域过滤（type 判定 / 取字段等）。
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { warnOnce } from './warn-once.js'

/** 1KB 的字节数（尾读窗口以 KB 为单位表达更直观）。 */
const BYTES_PER_KB = 1024
/** 尾读窗口大小（KB）；session_end/session_info 总在文件尾部，32KB 足够命中。 */
const READ_TAIL_KB = 32

/**
 * JSONL 解析的可选观测参数（RT-8#13）：畸形行此前静默跳过——半损坏文件 = 轮次/
 * 字段无声丢失，零丢弃计数。调用方（知道文件路径的一方）经 onMalformedLine 累计
 * dropCount 并 warn-once，工具自身保持零日志耦合（headless 可测）。
 */
export interface JsonlParseOptions {
  /** 每条畸形行回调一次（行文本已 trim）。 */
  onMalformedLine?: (line: string) => void
}

/**
 * 把 JSONL 文本解析成成功解析的条目数组（按行序，跳过空行与畸形行）。
 *
 * 等价于：
 * ```ts
 * raw.split('\n')
 *   .map(l => l.trim())
 *   .filter(Boolean)
 *   .flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
 * ```
 * 但显式循环更可读、不产生中间数组。
 *
 * @param raw JSONL 文本（各行 JSON 对象，以 \n 分隔）
 * @param opts 可选畸形行观测（RT-8#13）
 * @returns 成功解析的条目（unknown[]；消费方自行收窄类型 + 过滤）
 */
export function parseJsonl(raw: string, opts?: JsonlParseOptions): unknown[] {
  const entries: unknown[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed))
    } catch {
      // skip malformed line（观测回调在 catch 内出声——非吞错，见 JsonlParseOptions）
      opts?.onMalformedLine?.(trimmed)
    }
  }
  return entries
}

/**
 * 解析 JSONL 文本并在存在畸形行时 warn-once 显形（RT-8#13 复用助手）。
 *
 * 「半截 JSONL」的字段提取（session 名/outcome 等）静默降级 = 防线从未生效不可观测。
 * filePath 作 warn-once 去重键（同一文件重复解析只出声一次）；零畸形时不出声。
 * 返回 entries 本体（与 parseJsonl 同形态），丢弃计数只出现在 warn 文案里。
 */
export function parseJsonlWarnOnMalformed(raw: string, filePath: string): unknown[] {
  let dropped = 0
  const entries = parseJsonl(raw, {
    onMalformedLine: () => {
      dropped += 1
    },
  })
  if (dropped > 0) {
    warnOnce(
      `jsonl:${filePath}`,
      `[jsonl] 文件含 ${dropped} 行畸形 JSON，相关字段提取可能缺失: ${filePath}。` +
        '常见原因：写入被中断（崩溃/磁盘满）产生的半截行',
    )
  }
  return entries
}

/**
 * 尾读块大小（D4）。session_end 总在文件尾部（百字节级即够命中）；
 * session_info 若晚期 rename 也在尾部，早期命名则靠 fallback 全量读。
 * 32KB 对齐典型 fs readahead，相对 session 文件 size（实测 max 0.93MB）开销小。
 */
export const READ_TAIL_BYTES = READ_TAIL_KB * BYTES_PER_KB

/**
 * 尾读 JSONL 文件并解析尾部 entry（W1，ADR 尾读优化）。
 *
 * 用 openSync + readSync 从 offset=max(0, size-READ_TAIL_BYTES) 做 partial read，
 * 避免 readFileSync 全量读取。专为 extractSessionName/Outcome 这类「找尾部最后一条
 * 匹配 entry」的场景设计——这些 entry 都是 append（尾部追加）：session_info 现由
 * pi 自身 append 落盘（[HISTORICAL] taiji 直写函数已随 W11 删除），session_end 在
 * 存量旧 session 的 JSONL 内（W4 起现写 sidecar）。
 *
 * INVAR-tail-3：offset>0 时尾块**首行视为残行丢弃**——从文件中间位置读可能切断
 * 某行或多字节 UTF-8 字符，残行可能恰好是合法 JSON 导致误匹配，靠丢首行消除
 * （不靠 try-catch 吞错，因残行可能 parse 成功但语义错误）。
 * INVAR-tail-4：文件不存在/ENOENT 返回 null 不抛（规则 #6 pi 延迟写入，文件可能不存在）。
 * INVAR-tail-5：size<READ_TAIL_BYTES 时 offset=0 读全文件（自然退化，无残行丢弃）。
 *
 * 未命中（尾部块无目标 entry）时返回的数组不含目标——调用方（extractSessionName/Outcome）
 * 负责 fallback 全量读（SR1：早期命名长 session 的最后一条 session_info 在文件头部）。
 *
 * @param filePath JSONL 文件绝对路径
 * @returns 尾部解析出的 entry 数组（offset>0 时不含被丢弃的残行）；文件不存在返回 null
 */
export function readTailEntries(filePath: string): unknown[] | null {
  return readTailBytes(filePath, READ_TAIL_BYTES)
}

/**
 * 尾读指定字节数的 JSONL 并解析 entry（W1 H4 尾读优化）。
 *
 * readTailEntries 的参数化版本：readTailEntries 固定读 READ_TAIL_BYTES(32KB)，
 * 本函数允许调用方指定字节数。[HISTORICAL] 参数化的原始动机（tailReadHistory 需要
 * 更大窗口覆盖 20 turn）已随 u4b 逆序分块读（utils/history-reverse-read.ts
 * 的 forEachReversedLineChunk）退役——现无更大窗口消费方，参数化作为零成本通用形态保留。
 *
 * 同样遵守 INVAR-tail-3/4/5：
 * - offset>0 时首行视为残行丢弃
 * - 文件不存在返回 null
 * - size < maxBytes 时 offset=0 读全文件
 *
 * @param filePath JSONL 文件绝对路径
 * @param maxBytes 尾部读取的最大字节数
 * @param opts 可选畸形行观测（RT-8#13，同 parseJsonl）
 * @returns 尾部解析出的 entry 数组；文件不存在返回 null
 */
export function readTailBytes(filePath: string, maxBytes: number, opts?: JsonlParseOptions): unknown[] | null {
  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    // INVAR-tail-4: 文件不存在（ENOENT）/不可读 → 返回 null 不抛
    return null
  }
  try {
    const stat = fstatSync(fd)
    const size = stat.size
    if (size === 0) return []
    // offset = max(0, size - maxBytes)；size < maxBytes 时 offset=0 读全文件
    const offset = Math.max(0, size - maxBytes)
    const readLen = size - offset
    const buf = Buffer.alloc(readLen)
    // readSync 从 offset 读 readLen 字节到 buf
    const bytesRead = readSync(fd, buf, 0, readLen, offset)
    const content = buf.subarray(0, bytesRead).toString('utf-8')
    const lines = content.split('\n')
    // INVAR-tail-3: offset>0 时首行是残行（被切断），丢弃不参与 parse
    // offset===0 时首行是完整行，不丢
    //
    // UTF-8 多字节字符的取舍：offset 切点可能落在多字节字符中间（如中文占 3 字节），
    // 此时残行在 toString('utf-8') 时会得到替换字符（U+FFFD）。丢首行 = 保守丢弃可能
    // 完整的行——即切点恰好在某行行首或上一行行尾时首行本完整，但仍按残行丢弃。这是
    // 有意权衡：宁可多丢一行也不冒险 parse 残行（残行可能 parse 成语义错误的 JSON），
    // 调用方有 fallback 全量读兜底，丢一行不丢正确性。
    const startIdx = offset > 0 ? 1 : 0
    const entries: unknown[] = []
    for (let i = startIdx; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed))
      } catch {
        // skip malformed line（观测回调在 catch 内出声——非吞错，见 JsonlParseOptions）
        opts?.onMalformedLine?.(trimmed)
      }
    }
    return entries
  } finally {
    closeSync(fd)
  }
}
