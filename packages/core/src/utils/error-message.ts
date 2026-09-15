/**
 * 从任意 thrown 值提取可读的错误信息字符串：Error → `.message`，其它 → `String(e)`。
 *
 * 经 core barrel 导出：renderer 已依赖 core，从 core 单源 import（S4 B9 收编，
 * renderer 副本已删）。runtime/subagent-core/electron 等不依赖 core 的包仍各自
 * 独立持有同实现——收敛 `e instanceof Error ? e.message : String(e)` 样板。
 */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
