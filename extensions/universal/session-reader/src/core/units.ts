/**
 * 字节量纲换算基数（本包内 KB/MB 换算的唯一来源）。
 *
 * 本包是独立 npm 发布的 pi extension（仅依赖 pi-ext-guards），不 import taiji 内部
 * workspace 包（@taiji/shared 的 BYTES_PER_MB 单点不含本包）——量纲基数本地定义，
 * 数值对齐由注释锚定（1MB = 1024×1024）。三个消费域（render 的 omitted 标记 /
 * toolcall 的 write 摘要 / search-across 的预算与人性化格式化）共用本单点，
 * 避免同值常量在本包内多份分裂。
 */

/** bytes→KB 换算基数（omitted 字节 / read 结果规模 / write content 的 KB 显示）。 */
export const BYTES_PER_KB = 1024
/** bytes→MB 换算基数（跨会话检索预算与人性化格式化）。 */
export const BYTES_PER_MB = BYTES_PER_KB * BYTES_PER_KB
