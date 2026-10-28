/**
 * PluginUiSnapshotStore —— 插件 UI 快照存储（runtime 侧每 (scope, id) 最新状态）。
 *
 * ADR-0097「拉为主、推补充」：plugin:headerActionUpdate / plugin:viewUpdate 是 transient
 * 推送（不入 ring、无重放），renderer 重载/重连后的状态恢复由 plugin.ui.snapshot 拉取
 * RPC 从本存储收敛（C-comm-08「立即消费的 session 级状态必须主动拉取 RPC」）。写入点
 * = 两条推送链的既有校验出口（plugin-rpc-setup.ts 广播出线 / handleViewUpdate），推送
 * 通道语义不变——本存储只是让「最后一次推送」成为可查询的真值。
 *
 * 视图分区键为 scope 串（provider-plugin-access U2 分区键泛化，形态 SSOT =
 * shared plugin-view-scope）：会话域 `session:<sessionId>`、全局域
 * `global:<mountId>:<pluginId>`（插件维度并入键——双插件同挂载位互不覆盖，S25）。
 * headerAction 帧必带会话（AP-1 契约），保持裸 sessionId 分区不变。
 *
 * generation（U2 全量替换代际）：本存储是「同 (scope, viewId) 最新树」的持有者，
 * 代际在此单调分配（prev + 1，清除后从 1 重新起算——运行时实例生命周期内的单调性
 * 已满足消费端「见新代际整体替换」判据）。setView 返回带代际的存储条目，广播帧与
 * 快照条目携带同一代际（调用方发布返回值即可）。
 *
 * 清除语义与渲染端 ViewHostStore.consumeWidget 同构：views.update 携带 `[null]` 树 =
 * 清除该视图分区（调度器等插件以空树收缩面板）。
 */
import type { HeaderActionUpdatePayload, PluginUiSnapshotPayload, ViewSnapshotItem } from '@taiji/shared'
import { pluginViewScopeKey, pluginViewScopeMountPrefix, pluginViewScopeFromWire } from '@taiji/shared'


/**
 * 拉取过滤参数（plugin.ui.snapshot payload）：缺省 = 全部会话与全局域全部分区。
 * scope 二选一（U2）：sessionId = 会话域收窄（headerActions + views 两族）；
 * mountId + pluginId = 全局域收窄（仅 views 族，headerAction 无全局域形态）。
 */
export interface UiSnapshotFilter { // oe-exempt:20261021:framework:plugin.ui.snapshot 拉取 RPC 的 payload 契约（wire 过滤参数形状，单实现常态）
  sessionId?: string
  mountId?: string
  pluginId?: string
  viewId?: string
}

/** `[null]` = 清除标记（渲染端 ViewHostStore.consumeWidget 同款判定，双侧同构字面量）。 */
function isClearTree(guiTree: unknown[]): boolean {
  return guiTree.length === 1 && guiTree[0] === null
}

export class PluginUiSnapshotStore {
  /** sessionId → (headerActionId → 最新 payload)；headerAction 必带会话（AP-1），无全局域形态 */
  private readonly headerActions = new Map<string, Map<string, HeaderActionUpdatePayload>>()
  /** scope 串 → (viewId → 最新树条目) */
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

  /**
   * 写入视图最新树；`[null]` 树 = 删除该分区条目（清除语义，非存 null 树）。
   * 返回带 generation 的存储条目（正常写入路径；清除路径返回 undefined）——调用方
   * 将返回值作为广播帧载荷，快照与广播同代际。
   */
  setView(item: ViewSnapshotItem): ViewSnapshotItem | undefined {
    const scope = pluginViewScopeFromWire(item)
    if (scope === null) {
      // 写入点上游（views-api resolveViewScope）已保证二选一；防御分支留痕（STANDARDS
      // 静默丢弃必须登记），不阻断其余视图。
      console.warn('[plugin-ui-snapshot-store] view item 缺归属（sessionId/mountId 二选一）已丢弃:', item.viewId)
      return undefined
    }
    const key = pluginViewScopeKey(scope)
    if (isClearTree(item.guiTree)) {
      this.views.get(key)?.delete(item.viewId)
      return undefined
    }
    let partition = this.views.get(key)
    if (!partition) {
      partition = new Map()
      this.views.set(key, partition)
    }
    const previous = partition.get(item.viewId)
    // generation 单调分配：同 (scope, viewId) 递增；清除后从 1 重新起算（见文件头注释）
    const stored: ViewSnapshotItem = { ...item, generation: (previous?.generation ?? 0) + 1 }
    partition.set(item.viewId, stored)
    return stored
  }

  /** 读快照（plugin.ui.snapshot handler）：按过滤参数收窄，缺省全量。 */
  snapshot(filter: UiSnapshotFilter = {}): PluginUiSnapshotPayload {
    const headerActions: HeaderActionUpdatePayload[] = []
    const views: ViewSnapshotItem[] = []
    for (const [sessionId, partition] of this.headerActions) {
      if (filter.sessionId !== undefined && sessionId !== filter.sessionId) continue
      headerActions.push(...partition.values())
    }
    // scope 过滤（U2）：会话域 / 全局域精确键匹配，都给 = 调用方 bug → 空结果 + warn
    //（fail-visible，不静默退化为全量）；都缺 = 无过滤全量（connected 边沿恢复路径）。
    // 键形态统一经 pluginViewScopeKey 推导（SSOT = shared plugin-view-scope，禁手拼——
    // setView 写入与过滤/清理必须落同一分区）。
    let viewKey: string | undefined
    if (filter.sessionId !== undefined && filter.mountId !== undefined) {
      console.warn('[plugin-ui-snapshot-store] snapshot filter sessionId 与 mountId 互斥（二选一），本次返回空快照')
      return { headerActions: [], views: [] }
    }
    if (filter.sessionId !== undefined) {
      viewKey = pluginViewScopeKey({ kind: 'session', sessionId: filter.sessionId })
    } else if (filter.mountId !== undefined) {
      if (filter.pluginId === undefined) {
        // 全局域键无法成形（pluginId 缺省）→ views 空结果（与「无匹配分区返回空」同
        // 语义，不猜测插件）；headerAction 无全局域形态，不受影响保持全量。
        return { headerActions, views: [] }
      }
      viewKey = pluginViewScopeKey({ kind: 'global', mountId: filter.mountId, pluginId: filter.pluginId })
    }
    for (const [key, partition] of this.views) {
      if (viewKey !== undefined && key !== viewKey) continue
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
    this.views.delete(pluginViewScopeKey({ kind: 'session', sessionId }))
  }

  /**
   * 全局域挂载位清理（U2）：插件维度给定 = 精确分区；缺省 = 该挂载位全部插件的分区
   * （挂载位退役 / 家族切换时防陈旧）。headerAction 无全局域形态，不涉及。
   */
  clearForMount(mountId: string, pluginId?: string): void {
    if (pluginId !== undefined) {
      this.views.delete(pluginViewScopeKey({ kind: 'global', mountId, pluginId }))
      return
    }
    const prefix = pluginViewScopeMountPrefix(mountId)
    for (const key of this.views.keys()) {
      if (key.startsWith(prefix)) this.views.delete(key)
    }
  }

  /** 插件维度清理（崩溃 / 禁用 / 卸载 / 重启用防陈旧）：遍历比对 pluginId。 */
  clearForPlugin(pluginId: string): void {
    for (const [sessionId, partition] of this.headerActions) {
      for (const [headerActionId, payload] of partition) {
        if (payload.pluginId === pluginId) partition.delete(headerActionId)
      }
      if (partition.size === 0) this.headerActions.delete(sessionId)
    }
    for (const [key, partition] of this.views) {
      for (const [viewId, item] of partition) {
        if (item.pluginId === pluginId) partition.delete(viewId)
      }
      if (partition.size === 0) this.views.delete(key)
    }
  }
}
