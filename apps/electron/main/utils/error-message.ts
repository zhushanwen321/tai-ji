/**
 * 从任意 thrown 值提取可读的错误信息字符串：Error → `.message`，其它 → `String(e)`。
 *
 * 各包独立持有本 helper（core/renderer/runtime/subagent-core/electron/ext-guards 同实现），
 * 不引跨包依赖——收敛 `e instanceof Error ? e.message : String(e)` 样板。
 */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
