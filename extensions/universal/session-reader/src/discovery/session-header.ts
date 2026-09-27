import {
  readFirstJsonlLine,
  readFirstJsonlLineSync,
  type SessionHeader,
} from '@zhushanwen/session-core'

/**
 * [session-reader-shared-core Phase 1] session 文件首行 header 读取的包内单源（原
 * subagents.ts / find.ts 两份 async 副本 + tool-handler.ts 一份 sync 副本合一后的单源）。
 *
 * 字节原语（buffer 管理/续读/CRLF/空文件）已收敛至基座 `readFirstJsonlLine`（sync/async
 * 双形态）——本模块只剩两件 reader 私有事：
 * ① **header 谓词薄包装**（G4 红线，设计 §5 Phase 0）：reader 仅要求 `type==='session'`
 *    且 `id` 为 string，cwd/parentSession 可缺。runtime 侧「id+cwd 非空」严谓词是不同的
 *    行为契约（缺 cwd 的 header 在 reader 候选集必须可见），谓词语义绝不统一进基座；
 * ② **错误分流薄包装**：旧副本契约是「任何失败都视为无 header → undefined/null」，基座
 *    原语 IO 错误上抛（错误分类留给有消费方的调用侧），reader 无错误分类消费方，catch-all
 *    收敛回旧契约。
 */

export type { SessionHeader }

/**
 * 解析 header 首行为 SessionHeader（谓词薄包装）。非 session 行/缺 id/坏 JSON → null。
 */
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

/** 读文件首行（header）薄包装：基座原语 + IO 失败收敛 undefined（空文件基座已返 undefined）。 */
export async function readSessionHeaderFirstLine(path: string): Promise<string | undefined> {
  try {
    return await readFirstJsonlLine(path)
  } catch {
    return undefined
  }
}

/**
 * 同步读 session 文件首行 header，返回 type==='session' 的 id。
 * 任何失败（文件不存在/空文件/解析失败/type 不符）→ undefined（旧 sync 副本契约不变）。
 */
export function readSessionHeaderIdSync(filePath: string): string | undefined {
  let line: string | undefined
  try {
    line = readFirstJsonlLineSync(filePath)
  } catch {
    return undefined
  }
  return parseSessionHeader(line)?.id
}
