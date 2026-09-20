/**
 * zcode 行 id → canonical entry id 归一化（设计 D1 最小例子：行 id 零填充为 8 位
 * 小写十六进制，如 10 → '0000000a'；与 pi 自身 id 形态 randomUUID().slice(0,8) 同为
 * 8-hex，pi 侧对 entry id 仅作 opaque map key 消费、无 parseInt/形态校验）。
 *
 * canonical entry id 的parentId 顺序链（每条 entry 指向前一条）由 source 包的
 * converter 维护，本函数只负责单点 id 值域归一化。
 */

/** 归一化产物的固定十六进制位数（8-hex，'00000001' 起）。 */
export const ZCODE_ROW_ID_WIDTH = 8

export function normalizeZcodeRowId(rowId: number): string {
  if (!Number.isSafeInteger(rowId) || rowId < 0) {
    // 静默产出（负数 toString(16) 带 '-'、小数带小数点）会破坏 8-hex id 值域，
    // fail-fast 优于下游拿到结构坏 id
    throw new RangeError(`zcode row id must be a non-negative safe integer, got: ${rowId}`)
  }
  return rowId.toString(16).padStart(ZCODE_ROW_ID_WIDTH, '0')
}
