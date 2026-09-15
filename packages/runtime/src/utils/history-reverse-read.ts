/**
 * 逆序分块读共享工具（crash-resilience §3.3 D5 / 实施计划 u4b-history-budget）。
 *
 * 从文件尾按固定字节块向前扫描，按「完整行块」交付给调用方——JSONL 行边界对齐
 * （跨块切断的行留在 pending，读到其前部后拼接成交整行才交付）+ UTF-8 字符边界对齐
 * （块首落在多字节序列中间时回退至 lead byte 重读，交付行无 U+FFFD 污染），供以下调用方复用：
 * - ①档 getHistoryFromFilePath 预检超限后的逆序窗口（services/session-history.ts）
 * - ②档尾读 fallback 分块扩窗（services/session-history.ts，替代「凑不够 20 turns 就全量读」）
 * - restore-seeding 超限分流逆序读（session-file-streaming 家族消费方）
 * - ③档 findLastEntryField 逆序分块读（u4c-read-paths，另一单元，预留同款形态）
 *
 * 归属注（MF-8）：原在 services/session/，因「通用 fs IO 工具形态不属 services 业务层」
 * 迁 utils/（与 jsonl.ts 同层）——infra/services 双向消费方均合法依赖 utils。
 *
 * 定位声明：本工具只负责「逆序迭代完整行块」这一 IO 形态，不耦合任何历史业务语义
 * （turn 边界判定 / 窗口选择全部在调用方）。同步 readSync 实现——与 utils/jsonl.ts
 * 的 readTailBytes 同款 IO 模型（块级读取本身是纳秒级 syscall，异步化收益为零），
 * 读取总量受 maxTotalBytes 硬上限约束，不存在无界读。
 *
 * 内存界声明：任意时刻驻留 = 单块 buffer（默认 1MB）+ 尚未拼完整的 pending 行 +
 * 调用方自行的累积。32MB 上限内最坏驻留 ≈ 2×chunkBytes + pending 行，与文件总体积无关。
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

/** 默认块大小：1MB（crash-resilience §3.3 D5②「从尾部按 1MB 块向前扩窗」）。 */
// eslint-disable-next-line no-magic-numbers -- 设计标定块大小（D5② 文本值），非魔法数
export const DEFAULT_REVERSE_CHUNK_BYTES = 1024 * 1024

/**
 * 单次逆序读取的选项（全部可选——生产默认 1MB 块 / 32MB 总上限）。
 */
export interface ReverseReadOptions {
  /** 单块字节数（默认 DEFAULT_REVERSE_CHUNK_BYTES = 1MB）。 */
  chunkBytes?: number
  /**
   * 总读取量上限（默认 READ_PRECHECK_MAX_BYTES = 32MB，shared SSOT——此处不直接
   * import 而由调用方传参注入默认值，保持工具零 shared 依赖、纯 IO 形态）。
   */
  maxTotalBytes?: number
}

/** 交付给 visit 的单个完整行块。 */
export interface ReversedLineChunk {
  /**
   * 完整行文本（正序 = 文件内先后顺序）。每行不含行尾 '\n'。空行原样保留
   * （parse 侧自行跳过）。因 visit 提前停止时，当前块内未交付的更早行不交付。
   */
  lines: string[]
  /** 截至本块（含）的累计读取字节数。 */
  totalBytesRead: number
  /** 本块是否已覆盖到文件头（offset === 0——文件全部剩余内容都在本块及之前交付）。 */
  isStartChunk: boolean
}

/** 逆序读取过程汇总（循环结束时可用）。 */
export interface ReverseReadSummary {
  /** 累计读取字节数（受 maxTotalBytes 上限约束）。 */
  totalBytesRead: number
  /** 是否读到过文件头（最后交付的块 offset === 0）。 */
  sawStart: boolean
  /** visit 是否返回 false 提前停止（停止时当前块内更早行未交付）。 */
  stopped: boolean
  /**
   * 全文件已完整扫描（= sawStart && !stopped：所有块交付完毕且最后块覆盖文件头）。
   * 调用方据此做精确 truncated 判定（读完全文件时 turn 计数是精确总量；
   * 提前停止 / 上限截停时窗口外内容未知，保守判定）。
   */
  fullyScanned: boolean
  /** openSync 失败（文件不存在/不可读）——与 utils/jsonl.ts INVAR-tail-4 同语义，不抛错。 */
  openFailed: boolean
}

/**
 * 逆序主循环的跨块可变状态（readChunkAndDeliver 维护，forEachReversedLineChunk 读取汇总）。
 */
interface ReverseScanState {
  /** 剩余未读区域的右端（exclusive，下一块范围 [offset, end)）。 */
  end: number
  /** 累计读取字节数（maxTotalBytes 上限的判定输入）。 */
  totalBytesRead: number
  /** 已读区域最前面那行尚未确认完整的部分文本（INVAR-reverse-1，splitChunkIntoLines 维护）。 */
  pending: string
  /** 是否已交付覆盖文件头的块（offset === 0，splitChunkIntoLines 维护）。 */
  sawStart: boolean
}

/**
 * 块首 UTF-8 多字节对齐（镜像 session-file-streaming.trimToUtf8Boundary 的块尾防御，
 * 方向相反——逆序读的污染面在块首）：返回对齐后的块起点 offset。offset 落在多字节
 * 序列中间时块首字节是 continuation byte（10xxxxxx），toString 会把残缺序列替换为
 * U+FFFD，污染随 segs[0] → pending 拼接进入交付行。回退至该序列的 lead byte 重读：
 * lead 距块首 ≤ 3（序列最长 4 字节），探针读块首前 ≤4 字节、从右向左首个非
 * continuation 字节即 lead（lead 右侧至块首全在同一序列内必为 continuation，首个命中
 * 即精确边界，无需迭代；固定步长循环回退在纯 3 字节字符流的特定相位下会永不命中，
 * 故必须探针定位）。探针扫空（文件头即残缺序列的损坏形态）放弃对齐，接受一次
 * U+FFFD，与不回退等价无害。
 */
function alignChunkStartToUtf8Boundary(fd: number, offset: number): number {
  /* eslint-disable no-magic-numbers -- UTF-8 位级判定：掩码 0xc0/0x80、探针窗口 4 与
   * 回退上限 3 是 RFC 3629 协议常量（序列最长 4 字节 = lead + 3 continuation），
   * 命名抽象反而掩盖位语义（session-file-streaming.trimToUtf8Boundary 同款豁免） */
  // 探针含块首字节：仅块首是 continuation（切在序列内）时才回退
  const probeBase = Math.max(0, offset - 4)
  const probe = Buffer.alloc(offset - probeBase + 1)
  readSync(fd, probe, 0, probe.length, probeBase)
  if ((probe[probe.length - 1] & 0xc0) === 0x80) {
    // 从块首左侧第 1 字节向左扫：lead 右侧至块首全在同一序列内（必为
    // continuation），首个非 continuation 字节即精确 lead。
    let boundary = offset - 1
    while (boundary >= probeBase && (probe[boundary - probeBase] & 0xc0) === 0x80) boundary--
    if (boundary >= probeBase) return boundary
  }
  return offset
  /* eslint-enable no-magic-numbers */
}

/**
 * 单块文本的行界处理（INVAR-reverse-1 的块内半段）：按 '\n' 拆行并更新跨块状态
 * （pending 半行 / sawStart 文件头标记），返回可交付的完整行（正序 = 文件内先后顺序）。
 *
 * 行界伪影：text 以 '\n' 结尾时 split 的尾随空段不是行（'\n' 结束了前一行；
 * 中间的空串才是真实空行，保留）。不判伪影会把每块行尾的空段当空行交付。
 * isStartChunk（文件头）→ 全部段完整（pending 补齐后一起交付），pending 清空；否则
 * 首段是被切断行的头部（其开头在 offset 之前）——留 pending，不交付。文件末字节非
 * '\n' 时最后一行仍完整交付（EOF 终止行，无需特判）。
 */
function splitChunkIntoLines(text: string, isStartChunk: boolean, state: ReverseScanState): string[] {
  const segs = text.split('\n')
  if (text.endsWith('\n')) segs.pop()
  if (isStartChunk) {
    state.sawStart = true
    state.pending = ''
  } else {
    // 首段是被切断行的头部（其开头在 offset 之前）——留 pending，不交付
    state.pending = segs[0] ?? ''
    segs.shift()
  }
  return segs
}

/**
 * 读取下一个块并按完整行交付 visit（forEachReversedLineChunk 的单次循环体）：块范围
 * [对齐后 offset, state.end)，读后前移 state.end 至本块起点（下一块终点即本块起点，
 * 块间无重叠无遗漏）。
 *
 * @returns true = visit 请求停止（主循环终止，当前块内剩余更早行不交付）
 */
function readChunkAndDeliver(
  fd: number,
  state: ReverseScanState,
  chunkBytes: number,
  maxTotalBytes: number,
  visit: (chunk: ReversedLineChunk) => boolean | void,
): boolean {
  const chunkLen = Math.min(chunkBytes, state.end, maxTotalBytes - state.totalBytesRead)
  let offset = state.end - chunkLen
  // 块首 UTF-8 多字节对齐（位级判定与协议常量说明见 alignChunkStartToUtf8Boundary）：
  // 回退量 ≤ 3 字节全在同一序列内（无 '\n'），行归属判定不受影响。
  if (offset > 0) offset = alignChunkStartToUtf8Boundary(fd, offset)
  /* eslint-disable-next-line no-magic-numbers -- 块首对齐回退量 ≤ 3 字节（协议常量，alignChunkStartToUtf8Boundary 豁免同源） */
  const buf = Buffer.alloc(chunkLen + 3)
  const bytesRead = readSync(fd, buf, 0, state.end - offset, offset)
  state.totalBytesRead += bytesRead
  // 当前块在前、pending（来自更靠后的块）在后，文件顺序拼接
  const text = buf.subarray(0, bytesRead).toString('utf-8') + state.pending
  const isStartChunk = offset === 0
  const segs = splitChunkIntoLines(text, isStartChunk, state)
  state.end = offset
  if (segs.length === 0) return false
  return visit({ lines: segs, totalBytesRead: state.totalBytesRead, isStartChunk }) === false
}

/**
 * 从文件尾向前按块迭代完整行，visit 返回 false 可提前停止。
 *
 * 行边界对齐算法（INVAR-reverse-1）：维护 pending（已读区域最前面那行尚未确认完整的
 * 部分文本）。每块读 [offset, end)，合并 = 当前块文本（前） + pending（后）后 split('\n')：
 * - offset > 0 → 首段是被切断行的头部 → 成为新 pending，其余段完整交付；
 * - offset === 0（文件头）→ 全部段完整（pending 补齐后一起交付），pending 清空。
 * 文件末字节非 '\n' 时最后一行仍完整交付（EOF 终止行）。
 * 块起点先做 UTF-8 字符边界回退（见 alignChunkStartToUtf8Boundary），保证每块文本
 * decode 无 U+FFFD 污染。
 *
 * @param filePath JSONL 文件绝对路径
 * @param options 块大小 / 总量上限（缺省 1MB / 调用方注入 READ_PRECHECK_MAX_BYTES）
 * @param visit 行块消费者；返回 false 停止迭代（当前块内剩余更早行不交付）
 * @returns 过程汇总（openFailed=true 时 totalBytesRead=0 且不调用 visit）
 */
export function forEachReversedLineChunk(
  filePath: string,
  options: ReverseReadOptions | undefined,
  visit: (chunk: ReversedLineChunk) => boolean | void,
): ReverseReadSummary {
  const chunkBytes = options?.chunkBytes ?? DEFAULT_REVERSE_CHUNK_BYTES
  const maxTotalBytes = options?.maxTotalBytes ?? Number.MAX_SAFE_INTEGER

  let fd: number
  try {
    fd = openSync(filePath, 'r')
  } catch {
    // INVAR-tail-4 同语义：文件不存在（ENOENT）/不可读（EACCES）→ openFailed 汇总不抛
    return { totalBytesRead: 0, sawStart: false, stopped: false, fullyScanned: false, openFailed: true }
  }
  try {
    const size = fstatSync(fd).size
    // 空文件：天然「无内容可读」= 已完整扫描（避免调用方把空文件误判为「未读到头」）
    if (size === 0) return { totalBytesRead: 0, sawStart: true, stopped: false, fullyScanned: true, openFailed: false }
    const state: ReverseScanState = { end: size, totalBytesRead: 0, pending: '', sawStart: false }
    let stopped = false

    while (state.end > 0) {
      // 总量上限：停止（sawStart=false，调用方保守判定）
      if (maxTotalBytes - state.totalBytesRead <= 0) break
      if (readChunkAndDeliver(fd, state, chunkBytes, maxTotalBytes, visit)) {
        stopped = true
        break
      }
    }
    // pending 残留 = 因提前停止 / 上限截停而永不完整的半行——按残行丢弃语义放弃
    // （对齐 readTailBytes INVAR-tail-3「宁可多丢一行也不冒险 parse 残行」取舍）
    return {
      totalBytesRead: state.totalBytesRead,
      sawStart: state.sawStart,
      stopped,
      fullyScanned: state.sawStart && !stopped,
      openFailed: false,
    }
  } finally {
    closeSync(fd)
  }
}
