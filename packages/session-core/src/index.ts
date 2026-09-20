/**
 * @zhushanwen/session-core 唯一导出面。
 *
 * 负面契约（设计 §5 Phase 0）：本包不导出任何 header 合法性谓词（判定「首行算不算
 * 合法 session header」的 parse/guard 类函数）——reader/runtime 两侧谓词语义差异
 * 是不可统一的行为契约，各消费侧保留薄包装。新增导出前先核对设计 §1.5 基座内容
 * 收敛清单。
 */

export type {
  Entry,
  NormalizedSession,
  ParseResult,
  SessionHeader,
  SessionMessageRole,
} from './types.js'

export { parseSessionContent, parseSessionFile } from './parse.js'
export { serializeSession } from './serialize.js'
export { readFirstJsonlLine, readFirstJsonlLineSync } from './first-line.js'
export { sessionIdFromFileName } from './session-id.js'
export { normalizeZcodeRowId, ZCODE_ROW_ID_WIDTH } from './zcode-id.js'
