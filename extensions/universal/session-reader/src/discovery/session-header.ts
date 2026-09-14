import { open, type FileHandle } from 'node:fs/promises'
import { closeSync, openSync, readSync } from 'node:fs'

/**
 * [ext-simplify-18 D5] session 文件首行 header 读取的包内单源（原 subagents.ts / find.ts
 * 两份 async 副本 + tool-handler.ts 一份 sync 副本合一）。不进 shared——跨包第二消费方
 * 不存在（runtime 侧首行读取是另一形态 + 分层禁反向 import，设计负面清单同口径）。
 */

/** session header（首行 type==='session' entry 的消费子集）。 */
export interface SessionHeader {
  id: string
  cwd?: string
  parentSession?: string
}

/** 首行读取 buffer 上限。session header（id/cwd/parentSession）实测 < 300 字节，8KB 足够。 */
export const HEADER_READ_BYTES = 8192

/** 读文件首行（header）。定长 8KB 一次 read；空文件/读失败返回 undefined。 */
export async function readSessionHeaderFirstLine(path: string): Promise<string | undefined> {
  let fh: FileHandle | undefined
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(HEADER_READ_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    return nl === -1 ? text : text.slice(0, nl)
  } catch {
    return undefined
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 解析 header 首行为 SessionHeader。非 session 行/缺 id → null。 */
export function parseSessionHeader(line: string | undefined): SessionHeader | null {
  if (!line) return null
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.type !== 'session' || typeof o.id !== 'string') return null
  const h: SessionHeader = { id: o.id }
  if (typeof o.cwd === 'string') h.cwd = o.cwd
  if (typeof o.parentSession === 'string') h.parentSession = o.parentSession
  return h
}

/** readSessionHeaderIdSync 读首行的 buffer 上限。session header 实测 < 300 字节，4KB 足够。 */
const SYNC_HEADER_READ_BYTES = 4096

/**
 * 同步读 session 文件首行 header，返回 type==='session' 的 id。
 *
 * 任何异常（文件不存在/空文件/解析失败/type 不符）返回 undefined。与 async 版
 * readSessionHeaderFirstLine/parseSessionHeader 同构（定长 buffer 读首行 + JSON.parse +
 * type 校验），但用同步 fs API（resolveSessionId 内仅调用 1 次，同步开销可接受），
 * 窗口取 4KB（仅取 id）——sync 形态与窗口差异是刻意的调用上下文适配，独立常量、
 * 不与 async 版 8KB 强行统一。
 */
export function readSessionHeaderIdSync(filePath: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(filePath, 'r')
    const buf = Buffer.alloc(SYNC_HEADER_READ_BYTES)
    const bytesRead = readSync(fd, buf, 0, SYNC_HEADER_READ_BYTES, 0)
    if (bytesRead === 0) return undefined
    const text = buf.subarray(0, bytesRead).toString('utf8')
    const nl = text.indexOf('\n')
    const line = nl === -1 ? text : text.slice(0, nl)
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return undefined
    }
    if (typeof raw !== 'object' || raw === null) return undefined
    const o = raw as Record<string, unknown>
    if (o.type !== 'session' || typeof o.id !== 'string') return undefined
    return o.id
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync 失败：fd 可能已无效，header 数据已读取，关闭失败不影响结果（best-effort）
        void fd
      }
    }
  }
}
