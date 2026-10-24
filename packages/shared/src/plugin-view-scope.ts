/**
 * plugin-view-scope —— 插件视图归属作用域（provider-plugin-access U2，分区键泛化）。
 *
 * 视图归属从「会话」泛化为「作用域」，两种形态互斥且恰好其一（wire 上 sessionId 与
 * mountId 二选一，runtime views-api 校验；都缺或都给 → INVALID_VIEW_SCOPE）：
 *
 * | 归属 | 形态 | 分区键（scope 串） |
 * |---|---|---|
 * | 会话域（现役全部挂载点） | { kind: 'session', sessionId } | `session:<sessionId>` |
 * | 全局域（Provider 页，无会话归属） | { kind: 'global', mountId, pluginId } | `global:<mountId>:<pluginId>` |
 *
 * 本模块是 scope 串形态的单一事实源：runtime 侧快照存储（PluginUiSnapshotStore）与
 * 渲染侧缓存（core ViewHostStore）用同一函数推导分区键，快照回放与实时推送两路才能
 * 落同一分区（键形态若两包各自手拼必然漂移）。全局域键含插件维度：同一挂载位被多个
 * 插件推树互不可见、互不覆盖（S25）。
 */

/** 会话域归属：现役全部会话内挂载点（panel.header / sidebar.tab / ...）。 */
export interface SessionViewScope { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  kind: 'session'
  sessionId: string
}

/**
 * 全局域归属：Provider 页等无会话挂载位。pluginId 取自 RPC 通道身份（sandbox fork 与
 * pluginId 一对一，宿主侧落键，不接受载荷自报为键源）。
 */
export interface GlobalViewScope { // oe-exempt:20261024:framework:ports/SDK 契约类型——接口先立、单实现常态（映射表/端口单一数据源）
  kind: 'global'
  /** 挂载位 id（如 'provider.authorize'） */
  mountId: string
  pluginId: string
}

/** 插件视图归属作用域（互斥联合，恰好其一）。 */
export type PluginViewScope = SessionViewScope | GlobalViewScope

/** 插件视图的分区键（scope 串）：runtime 快照存储与渲染侧缓存共用的键形态。 */
export function pluginViewScopeKey(scope: PluginViewScope): string {
  return scope.kind === 'session'
    ? `session:${scope.sessionId}`
    : `global:${scope.mountId}:${scope.pluginId}`
}

/**
 * wire 载荷（sessionId / mountId 二选一）→ scope；形态非法返回 null：
 * 都缺或都给、或所选字段的值不是非空 string、或全局域缺 pluginId。
 *
 * 消费方 = 解析失败要出声的窄化点（core message-bus-bridge 的 viewUpdate 检查，
 * null → parse-failed error 事件，ERR2 不静默吞）。runtime views-api 的 RPC 校验入口
 * 不走本函数——它需要逐字段抛精确错误码（INVALID_SESSION_ID / INVALID_MOUNT_ID），
 * 在此之上先行逐字段窄校验再构造 scope。
 */
export function pluginViewScopeFromWire(payload: {
  sessionId?: unknown
  mountId?: unknown
  pluginId?: unknown
}): PluginViewScope | null {
  const hasSessionId = payload.sessionId !== undefined
  const hasMountId = payload.mountId !== undefined
  // 二选一：都给或都缺均非法（INVALID_VIEW_SCOPE 的判据形态）
  if (hasSessionId === hasMountId) return null
  if (hasSessionId) {
    const sessionId = payload.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return null
    return { kind: 'session', sessionId }
  }
  const mountId = payload.mountId
  const pluginId = payload.pluginId
  if (typeof mountId !== 'string' || mountId === '') return null
  if (typeof pluginId !== 'string' || pluginId === '') return null
  return { kind: 'global', mountId, pluginId }
}
