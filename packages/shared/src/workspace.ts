/**
 * RecentWorkspaceRecord — 最近工作区记录 DTO
 *
 * 领域就近（E2 架构候选），前端 + runtime 共享。
 * 文件格式 = JSON 数组（RecentWorkspaceRecord[]），落盘到 <configDir>/recent-workspaces.json。
 *
 * @see docs/adr/decisions.md ADR-0034（recent-workspaces pull-only + 三层）
 */
export interface RecentWorkspaceRecord {
  /** 绝对路径（INV-1 非空串检查） */
  cwd: string
  /** 最后使用时间戳（毫秒，Date.now()，与 session.lastActiveAt 一致） */
  lastUsedAt: number
  /** 显示名（cwd basename，运行时算零冗余存储） */
  label: string
  /**
   * 用户固定标记（2026-10-22，需求「pin 固定目录不随最新使用刷走」）：pinned 条目免 LRU
   * 淘汰、弹层置顶「已固定」分组展示，上限 5 条（runtime RecentWorkspacesStore 拦截）。
   * 缺省/false = 未固定（随最近使用排序与淘汰）。
   */
  pinned?: boolean
}
