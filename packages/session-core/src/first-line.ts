/**
 * 首行字节原语（设计 G2 的 SSOT）：只读 session JSONL 首行，收敛仓内 4 份漂移副本
 * （runtime sync session-file-utils / runtime async session-file-external-scan /
 * runtime async import-source-external-file / session-reader session-header）。
 *
 * 语义裁决：
 * - 超长首行：块续读直至换行或 EOF（等价「回退全量读首行」，超长首行可解析）；
 *   块大小只影响 syscall 次数不影响结果。
 * - 跨块解码：换行先在原始 Buffer 上定位，命中前内容以 Buffer 累积、最终整体
 *   toString——逐块 toString 会把跨块多字节 UTF-8 字符（CJK）拆出 U+FFFD。
 * - 行尾 CRLF 剥 `\r`（副本既有实现不处理，Windows 侧编辑过的文件首行会带裸 CR
 *   致 JSON.parse 失败；本原语统一处理）。
 * - 空文件 / 首行剥 CR 后纯空白 → undefined。
 * - IO 错误（不存在/权限等）上抛：错误分类信息不丢失（STANDARDS §11.2 把 IO 故障
 *   伪装成 not-found 会误导排障）；「任何失败都视为无 header」的分流归消费侧薄包装。
 */

import { open, type FileHandle } from 'node:fs/promises'
import { closeSync, openSync, readSync } from 'node:fs'

/** LF（'\n'）字节值——JSONL 行终止符，Buffer.indexOf 用字节比较。 */
const NEWLINE_BYTE = 0x0a

/** 块读大小：header 实测 < 300 字节，8KB 覆盖绝大多数首行单次读毕。 */
const CHUNK_BYTES = 8192

/** 行字节 → 文本：整体解码 + 剥行尾 CR（CRLF）+ 纯空白判空。 */
function decodeLineBytes(chunks: readonly Buffer[]): string | undefined {
  if (chunks.length === 0) return undefined
  const line = Buffer.concat(chunks).toString('utf8')
  const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line
  return withoutCr.trim() === '' ? undefined : withoutCr
}

async function readFirstLineViaHandle(fh: FileHandle): Promise<string | undefined> {
  const buffer = Buffer.alloc(CHUNK_BYTES)
  const chunks: Buffer[] = []
  for (;;) {
    const { bytesRead } = await fh.read(buffer, 0, CHUNK_BYTES, null)
    if (bytesRead === 0) {
      return decodeLineBytes(chunks)
    }
    const nl = buffer.subarray(0, bytesRead).indexOf(NEWLINE_BYTE)
    if (nl >= 0) {
      chunks.push(Buffer.from(buffer.subarray(0, nl)))
      return decodeLineBytes(chunks)
    }
    // subarray 是底层 buffer 的视图，必须拷贝——下一轮 read 会覆写
    chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
  }
}

/** 首行读取（async 形态）。文件不存在/打开失败按 fs 原生错误抛出。 */
export async function readFirstJsonlLine(filePath: string): Promise<string | undefined> {
  const fh = await open(filePath, 'r')
  try {
    return await readFirstLineViaHandle(fh)
  } finally {
    await fh.close()
  }
}

/** 首行读取（sync 形态）。文件不存在/打开失败按 fs 原生错误抛出。 */
export function readFirstJsonlLineSync(filePath: string): string | undefined {
  const fd = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES)
    const chunks: Buffer[] = []
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, CHUNK_BYTES, null)
      if (bytesRead === 0) {
        return decodeLineBytes(chunks)
      }
      const nl = buffer.subarray(0, bytesRead).indexOf(NEWLINE_BYTE)
      if (nl >= 0) {
        chunks.push(Buffer.from(buffer.subarray(0, nl)))
        return decodeLineBytes(chunks)
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
    }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // closeSync 失败：fd 可能已无效，首行数据已读取，关闭失败不影响结果（best-effort）
    }
  }
}
