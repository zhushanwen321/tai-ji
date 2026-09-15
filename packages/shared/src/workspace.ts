/**
 * RecentWorkspaceRecord — 最近工作区记录 DTO
 *
 * 领域就近（E2 架构候选），前端 + runtime 共享。
 * 文件格式 = JSON 数组（RecentWorkspaceRecord[]），落盘到 <configDir>/recent-workspaces.json。
 *
 * @see code-architecture.md §3
 * @see decisions.md D-005/D-006
 */
export interface RecentWorkspaceRecord {
  /** 绝对路径（INV-1 非空串守卫） */
  cwd: string
  /** 最后使用时间戳（毫秒，Date.now()，D-006 与 session.lastActiveAt 一致） */
  lastUsedAt: number
  /** 显示名（cwd basename，运行时算零冗余存储） */
  label: string
}
