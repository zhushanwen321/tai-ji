/**
 * session JSONL 文件名短格式化。
 *
 * pi 的 session 文件命名为 `<ISO_timestamp>_<uuidv7>.jsonl`
 * （如 2026-07-09T11-16-46-632Z_019f4698-2fa8-791c-858f-d02ba39d9676.jsonl）。
 * 展示时取 uuidv7 前 8 位 + .jsonl（如 019f4698.jsonl），对齐 coding-agent SDK 示例
 * （11-sessions.ts 的 info.id.slice(0,8)）。
 *
 * 前 8 位而非后 8 位：uuidv7 前缀是毫秒时间戳，前 8 位在时间相近的 session 间有区分度；
 * 后 8 位是随机尾部，区分度低。
 */

/** uuidv7 短展示截取长度（对齐 coding-agent SDK 示例 slice(0,8)） */
const SHORT_ID_LENGTH = 8

/**
 * 把 session JSONL 绝对路径格式化为短展示名（前 8 位 + .jsonl）。
 *
 * 解析顺序：
 * 1. 取 basename（去掉目录前缀）
 * 2. 匹配最后一个 `_<id>.jsonl` → 取 id 前 8 位
 * 3. 兜底（无下划线 / 非标准命名）→ basename 去扩展名后前 8 位
 * 4. 空串 → 空串
 */
export function formatShortSessionFile(absolutePath: string): string {
  if (!absolutePath) return ''

  const base = absolutePath.split('/').pop() ?? absolutePath
  // 匹配末尾 _<id>.jsonl，取 id 段。用贪婪 .* 确保只匹配最后一个下划线后的内容
  // （cwd-hash 目录名可能含下划线，不能误匹配目录段）。
  const match = base.match(/_([^/]+)\.jsonl$/)
  const id = match?.[1] ?? base.replace(/\.jsonl$/, '')

  return `${id.slice(0, SHORT_ID_LENGTH)}.jsonl`
}
