/**
 * PluginUiSnapshotStore —— 插件 UI 快照存储（runtime 侧每 (sessionId, id) 最新状态）。
 *
 * ADR-0097「拉为主、推补充」：plugin:headerActionUpdate / plugin:viewUpdate 是 transient
 * 推送（不入 ring、无重放），renderer 重载/重连后的状态恢复由 plugin.ui.snapshot 拉取
 * RPC 从本存储收敛（C-comm-08「立即消费的 session 级状态必须主动拉取 RPC」）。写入点
 * = 两条推送链的既有校验出口（plugin-rpc-setup.ts 广播出线 / handleViewUpdate），推送
 * 通道语义不变——本存储只是让「最后一次推送」成为可查询的真值。
 *
 * 清除语义与渲染端 ViewHostStore.consumeWidget 同构：views.update 携带 `[null]` 树 =
 * 清除该视图分区（调度器等插件以空树收缩面板）。
 */
import type { HeaderActionUpdatePayload, PluginUiSnapshotPayload, ViewSnapshotItem } from '@taiji/shared'

/** 拉取过滤参数（plugin.ui.snapshot payload）：缺省 = 全部会话全部分区。 */
export interface UiSnapshotFilter { // oe-exempt:20261021:framework:plugin.ui.snapshot 拉取 RPC 的 payload 契约（wire 过滤参数形状，单实现常态）
  sessionId?: string
  viewId?: string
}

/** `[null]` = 清除标记（渲染端 ViewHostStore.consumeWidget 同款判定，双侧同构字面量）。 */
function isClearTree(guiTree: unknown[]): boolean {
  return guiTree.length === 1 && guiTree[0] === null
}

export class PluginUiSnapshotStore {
  /** sessionId → (headerActionId → 最新 payload) */
  private readonly headerActions = new Map<string, Map<string, HeaderActionUpdatePayload>>()
  /** sessionId → (viewId → 最新树条目) */
  private readonly views = new Map<string, Map<string, ViewSnapshotItem>>()

  /** 写入 headerAction 最新状态（推送出线处调用；payload 即广播帧原样）。 */
  setHeaderAction(payload: HeaderActionUpdatePayload): void {
    let partition = this.headerActions.get(payload.sessionId)
    if (!partition) {
      partition = new Map()
      this.headerActions.set(payload.sessionId, partition)
    }
    partition.set(payload.headerActionId, payload)
  }

  /** 写入视图最新树；`[null]` 树 = 删除该分区条目（清除语义，非存 null 树）。 */
  setView(item: ViewSnapshotItem): void {
    if (isClearTree(item.guiTree)) {
      this.views.get(item.sessionId)?.delete(item.viewId)
      return
    }
    let partition = this.views.get(item.sessionId)
    if (!partition) {
      partition = new Map()
      this.views.set(item.sessionId, partition)
    }
    partition.set(item.viewId, item)
  }

  /** 读快照（plugin.ui.snapshot handler）：按过滤参数收窄，缺省全量。 */
  snapshot(filter: UiSnapshotFilter = {}): PluginUiSnapshotPayload {
    const headerActions: HeaderActionUpdatePayload[] = []
    const views: ViewSnapshotItem[] = []
    for (const [sessionId, partition] of this.headerActions) {
      if (filter.sessionId !== undefined && sessionId !== filter.sessionId) continue
      headerActions.push(...partition.values())
    }
    for (const [sessionId, partition] of this.views) {
      if (filter.sessionId !== undefined && sessionId !== filter.sessionId) continue
      for (const [viewId, item] of partition) {
        if (filter.viewId !== undefined && viewId !== filter.viewId) continue
        views.push(item)
      }
    }
    return { headerActions, views }
  }

  /** 会话销毁清理（setOnSessionDestroyed 链，防长会话反复建删时条目单调累积）。 */
  clearForSession(sessionId: string): void {
    this.headerActions.delete(sessionId)
    this.views.delete(sessionId)
  }

  /** 插件维度清理（崩溃 / 禁用 / 卸载 / 重启用防陈旧）：遍历比对 pluginId。 */
  clearForPlugin(pluginId: string): void {
    for (const [sessionId, partition] of this.headerActions) {
      for (const [headerActionId, payload] of partition) {
        if (payload.pluginId === pluginId) partition.delete(headerActionId)
      }
      if (partition.size === 0) this.headerActions.delete(sessionId)
    }
    for (const [sessionId, partition] of this.views) {
      for (const [viewId, item] of partition) {
        if (item.pluginId === pluginId) partition.delete(viewId)
      }
      if (partition.size === 0) this.views.delete(sessionId)
    }
  }
}
