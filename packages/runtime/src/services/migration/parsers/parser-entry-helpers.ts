/**
 * 三个 parser（pi / codex / zcode）共享的单条目守卫与文案 helper。
 *
 * W4 复杂度债务偿还（行为保持纯提取）：三个 parser 的 providers 循环体同构——
 * null/非对象条目跳过警告、catch 警告模板、topWarnings 收尾三处文案逐字节一致
 * （真同构，消假差异）；各 parser 专属文案（协议丢弃 / 未知 kind / 孤儿凭据
 * malformed）是真差异，保留在各文件内不合并。
 */

/**
 * 单条目解析结果（skip | keep 二选一）：
 * - skip：条目被丢弃，warning 进顶层 topWarnings（如未知协议 / 未知 kind）。
 * - keep：条目保留，provider 进结果列表。
 */
export type ProviderEntryOutcome<TProvider> =
  | { action: 'skip'; warning: string }
  | { action: 'keep'; provider: TProvider }

/**
 * 非 object 条目（null / 标量）抛出 malformed 错误。
 *
 * 原实现是「push 顶层警告后 continue」，其文案与各 parser 的 catch 模板完全一致：
 * `provider <id> skipped due to malformed entry: not an object (<null|typeof>)`。
 * 等价改写为抛错——provider id 由调用方 catch 经 malformedEntryWarning 拼入
 * （`not an object (...)` 作为 e.message，生成文案逐字节一致）。
 */
export function assertProviderEntryObject(raw: unknown): void {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`not an object (${raw === null ? 'null' : typeof raw})`)
  }
}

/**
 * catch 块统一警告模板（pi / codex / zcode 三处原文案逐字节一致）。
 */
export function malformedEntryWarning(id: string, e: unknown): string {
  return `provider ${id} skipped due to malformed entry: ${e instanceof Error ? e.message : String(e)}`
}

/**
 * topWarnings 收尾：空数组 → undefined（ParseResult.warnings 语义：无警告时省略字段）。
 */
export function warningsOrUndefined(warnings: string[]): string[] | undefined {
  return warnings.length > 0 ? warnings : undefined
}
