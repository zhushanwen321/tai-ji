/**
 * 内部 slash 命令过滤（W4，cw-2026-07-22-unify-slash-command-source）。
 *
 * 约定：skill name 或 slash 命令名以 `__` 开头的是内部触发命令（W5 reload-orchestrator
 * 的 /__taiji_reload__），不在用户可见的 slash 浮层显示。pi RegisteredCommand 无 hidden 标记，
 * get_commands 会列出这类命令，靠前端按前缀过滤隐藏。
 */

/**
 * 判定 skill name 是否为内部命令（__ 前缀，不可见）。
 * skill name 不带 / 前缀（如 '__taiji_reload'）。
 */
export function isInternalSkillName(name: string): boolean {
  return name.startsWith('__')
}

/**
 * 判定 slash 命令名（pi getCommands 返回，可能带 / 也可能不带）是否为内部命令（__ 前缀）。
 * 先归一化去 / 前缀，再判 __ 前缀。
 */
export function isInternalSlashName(name: string): boolean {
  const stripped = name.replace(/^\//, '')
  return stripped.startsWith('__')
}
