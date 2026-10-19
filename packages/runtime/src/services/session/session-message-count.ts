/**
 * 会话消息计数（悬停详情卡消息计数）。
 *
 * 流式逐行读取 session JSONL 统计对话消息条数——禁整文件读入内存（会话文件可达数十 MB，
 * 大文件全量 readFileSync 是退出侧同款内存尖峰形态，crash-resilience D5③ 同口径）。
 *
 * 计数口径（与 core 对话流 reducer 一致，证据 = pi 1.0 实装
 * node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:128-129 的
 * SessionEntry 联合与 :23-26 的 SessionMessageEntry；pi-ai dist/types.d.ts:430 的
 * Message role 联合）：
 * - 只计 `type === 'message'` 且 `message.role === 'user' | 'assistant'` 的 entry；
 * - toolResult / system role 的 message entry、thinking（是 message 的 content part 不是
 *   entry）、compaction / usage / session_info / custom / custom_message / context_edit /
 *   label / thinking_level_change / model_change 等非对话 entry 一律不计——core
 *   apply-entry-convert.ts:382（`role !== 'user' && role !== 'assistant'` 跳过）同口径。
 * - session header（首行 `type: 'session'`）不计。
 */

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/** 单行是否为计数的 user/assistant 消息 entry（损坏行跳过，不中断计数）。 */
function isCountableMessageLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return false
  let entry: { type?: unknown; message?: { role?: unknown } }
  try {
    entry = JSON.parse(trimmed) as { type?: unknown; message?: { role?: unknown } }
  } catch {
    return false
  }
  if (entry?.type !== 'message') return false
  return entry.message?.role === 'user' || entry.message?.role === 'assistant'
}

/**
 * 流式统计 session JSONL 的用户+助手消息条数。
 *
 * - 文件不存在（pi 延迟写入窗口——pi 1.0 首条 user 消息才建文件）→ 返回 0，不报错；
 * - 其它读失败（EACCES / EISDIR 等）→ 上抛，由 RPC 层转 error envelope（renderer 占位）。
 *
 * 实现侧 = createReadStream + readline（恒定内存，不随文件大小增长）；正在被 pi append 的
 * 活跃会话读到当前 EOF 即止，半写尾行 parse 失败按损坏行跳过。
 */
export async function countSessionMessagesInFile(filePath: string): Promise<number> {
  const stream = createReadStream(filePath, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  let count = 0
  // 读失败登记（ENOENT 语义归 0，其余上抛）：stream error 时 readline 会随后 close，
  // 失败信息经本槽位带出，不用 events.once（其对 'error' 的 reject 语义与「ENOENT 归 0」
  // 的分流需求冲突）。
  let failure: NodeJS.ErrnoException | undefined
  stream.on('error', (e: NodeJS.ErrnoException) => {
    failure = e
    rl.close()
  })
  rl.on('error', (e: NodeJS.ErrnoException) => {
    failure ??= e
  })
  rl.on('line', (line: string) => {
    if (isCountableMessageLine(line)) count++
  })
  await new Promise<void>((resolve) => {
    rl.on('close', resolve)
    // readline 'error' 单发（输入流异常且未触发 close 的防御形态）：登记后放行，避免悬挂。
    rl.on('error', () => resolve())
  })
  rl.close()
  if (failure) {
    if (failure.code === 'ENOENT') return 0
    throw failure
  }
  return count
}
