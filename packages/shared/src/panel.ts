/**
 * Panel 类型（v2：移除 split 后单 panel 语义）。
 *
 * 历史背景：v1 用 PanelTree（PanelLeaf | SplitNode 递归联合，PanelLeaf 带 `type` 判别字段）
 * 支持单/双 panel split，split 功能移除后退化为恒单 panel，递归树结构与单成员判别字段
 * 均已删除。三个月后回来看，只有一个 panel，没有树，也没有判别字段。
 */
export interface PanelLeaf {
  id: string
  sessionId: string | null
}

/**
 * 窗口状态投影（跨窗口 session 查询用，main 进程消费）。
 * v2：panelTree 字段简化为 panel（单 panel，无树结构）。
 */
export interface WindowState {
  windowId: string
  panel: PanelLeaf
  focusedPanelId: string
  sessionIds: string[]
}
