/**
 * ID / 随机串生成工具（D12）。
 *
 * 收编 plugin-service / plugin-storage 各自定义的 `randomSuffix()`。
 */

/**
 * 生成一个短的随机后缀串（base36，去掉 '0.' 前缀）。
 *
 * 用于临时文件名、请求 id 后缀等需要「短而不重复」的场景。
 * 不保证全局唯一——需要唯一性时与 Date.now() / 业务 id 组合。
 */
export function randomSuffix(): string {
  // eslint-disable-next-line no-magic-numbers
  return Math.random().toString(36).slice(2)
}
