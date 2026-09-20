// 时间格式化器单源于 @zhushanwen/extension-protocol（U2 折叠器下沉：formatSchedule /
// formatRelativeTime 与 composer widget、taiji plugin 管理面同源输出）。本文件保持既有
// import 路径不变（re-export），仅保留扩展侧私有物（truncate / 任务 id 生成 / autoName）。

export {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
  formatDuration,
  formatRelativeTime,
  formatSchedule,
} from '@zhushanwen/extension-protocol'

/** 省略号 "..." 的字符数（truncate 截断预留宽度）。 */
const ELLIPSIS_LENGTH = 3

/**
 * 截断文本到指定长度，超出部分用 "..." 替代。
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  if (maxLen <= ELLIPSIS_LENGTH) return text.slice(0, maxLen)
  return text.slice(0, maxLen - ELLIPSIS_LENGTH) + '...'
}

/** 生成任务 ID 的随机字节数（8 位 hex = 4 字节）。 */
const TASK_ID_RANDOM_BYTES = 4
const HEX_RADIX = 16
/** 每字节展开的 hex 字符数（padStart 宽度）。 */
const HEX_CHARS_PER_BYTE = 2

/**
 * 生成任务 ID：8 位 hex。
 */
export function generateTaskId(): string {
  const bytes = new Uint8Array(TASK_ID_RANDOM_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(HEX_RADIX).padStart(HEX_CHARS_PER_BYTE, '0')).join('')
}

/** autoName 任务名最大长度。 */
const AUTO_NAME_MAX_LENGTH = 30

/**
 * 从 prompt 自动生成任务名称：取前 30 字。
 */
export function autoName(prompt: string): string {
  return truncate(prompt.trim(), AUTO_NAME_MAX_LENGTH)
}
