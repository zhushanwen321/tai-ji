/**
 * SessionItem 及其子组件（Display / Actions / ContextMenu）共享的 session 展示形状。
 *
 * 与 SessionList 传入的 group session 结构兼容（单一来源，防多组件 inline 类型漂移）。
 * 字段语义见 SessionItem.vue props 注释。
 */
export type SessionItemSession = {
  id: string
  label: string
  cwd: string
  lastActiveAt: number
  status?: string
  gitBranch?: string
  /** 父 session 文件路径/id（fork 血缘键）。有值则为分支 session，sub 行显示血缘元信息。 */
  parentSession?: string
  /** 父 session 显示名（血缘展示用，SessionList 容器可注入避免重复查找父 label）。 */
  parentLabel?: string
  /** 归属 project id（D14 语义修正；空/undefined = 未归类，归入默认项目聚合）。 */
  projectId?: string
  /** 发起来源（agent-managed-session U8）：'agent' = agent 经 session-manager 创建，标题旁显 [AI] badge。 */
  spawnSource?: 'user' | 'agent'
  /** 父 agent session id（U8）：spawnSource='agent' 时由 runtime 注入，右键「查看父 session」用。 */
  parentAgentSessionId?: string
  /** 会话 JSONL 文件绝对路径（SessionSummary.sessionFile 透传）：右键「导出 JSONL」用。
   *  缺失 = pi 延迟写入窗口（首条消息前文件未落盘），菜单项禁用。 */
  sessionFile?: string
  /** 目标会话 id（chat-flow-consistency U9 / S8，SessionSummary.handedOffTo 透传）：
   *  该会话已完成 handoff 交接。非空 → 侧栏「已交接」徽标。 */
  handedOffTo?: string
  /** 交接目标显示名（chat-flow-consistency U9 / S8，SessionList 容器按 id 反查注入，
   *  parentLabel 同款容器注入机制）：目标已删时为空串，徽标 title 回退显 id 前缀。 */
  handoffTargetLabel?: string
}
