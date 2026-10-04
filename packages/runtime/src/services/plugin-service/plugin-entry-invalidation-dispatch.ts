/**
 * Entry 失效信号订阅注册表 + 定向派发器（plugin headerAction/modal 点位 AP-4，U2）。
 *
 * Worker 侧经 plugin.sessions.registerEntryInvalidation（session-api 读段，U2）注册
 * handlerId，本表按 (sessionId, customType) 分桶记录投递目标；pi custom entry 到达
 * （event-adapter 对任意 customType 产出失效事件 → 组合根两路注入的
 * pluginService.notifyEntryInvalidation 腿）时按事件的双键命中订阅者，产出投递意图
 * （workerId + handlerId），由 PluginService 经 rpcServer.notify 定向投递到对应 Worker。
 *
 * 与 SessionEventDispatch（api/session-api.ts，S3-W2）同族先例：主线程侧注册表 +
 * rpcServer 通道定向 notify（非 WS 帧、非全局广播）；Worker 已死（crash/卸载后残留
 * 条目）时 notify 找不到 port 静默 no-op，运行期清理由 PluginService 的
 * crash/disable/uninstall 三路 clearForPlugin 与 session-destroyed 一路 clearForSession
 * 完成。
 *
 * 与先例的差异（有意为之）：SessionEventDispatch 按 handlerId 平铺注册、didCreate/
 * didDestroy 全表广播；本表注册键是 (sessionId, customType) 分桶——失效信号是高频
 * 热路径且事件带双维键，派发必须双匹配命中（会话 A 的事件不唤醒只在会话 B 订阅的
 * 插件）且无订阅者时零开销（两次 Map.get 返回空）。故 dispatch 只产出投递意图，
 * notify 由持有 rpcServer 的 PluginService 执行（本类不依赖 PluginRpcServer，可纯单测）。
 */

/** 主线程 → Worker 的定向投递通知方法名（server→Worker notify，非 WS 帧——不进 PLUGIN_RPC_METHODS，与 didCreate/didDestroy 同族）。U2 的 session-api 读段引用。 */
export const ENTRY_INVALIDATION_NOTIFY_METHOD = 'plugin.sessions.entriesInvalidated'

/** 一条订阅的投递目标（workerId 定向 + pluginId 归属清理）。 */
export interface EntryInvalidationTarget {
  workerId: string
  pluginId: string
  sessionId: string
  customType: string
}

/** 一次派发的投递意图：命中订阅者的所属 Worker 与 handlerId（payload 其余维度由调用方按事件补全）。 */
export interface EntryInvalidationDelivery {
  workerId: string
  handlerId: string
}

export interface EntryInvalidationDispatchDeps {
  /**
   * 注册时校验 sessionId 存在于当前会话列表（防无界注册表——不存在 → 拒绝注册）。
   * PluginService 装配时注入 sessionService.listPersistedSessions 的存在性谓词
   * （UI 侧边栏会话列表同一权威源，broadcastSessionList 同查询口）；deps 后置绑定
   * （setSessionService 晚于构造），谓词在调用时求值。
   */
  sessionExists: (sessionId: string) => boolean
}

/**
 * Entry 失效信号订阅注册表（主线程侧）。
 *
 * 注册键 = (sessionId, customType) 分桶：sessionId → (customType → handlerId → target)。
 * dispatch 双键取桶遍历（双匹配结构性成立）；unregister / clearForPlugin 跨桶遍历删除
 * （订阅量级 = 插件数 × 会话数 × customType 数，低频路径遍历可接受；热路径 dispatch
 * 恒 O(命中数)）。handlerId 全表唯一：重复注册幂等覆盖（同 SessionEventDispatch 先例
 * 语义——先摘旧条目再插新，同一 handler 不会同时挂在两个桶）。
 */
export class EntryInvalidationDispatch {
  private readonly buckets = new Map<string, Map<string, Map<string, EntryInvalidationTarget>>>()

  constructor(private readonly deps: EntryInvalidationDispatchDeps) {}

  /**
   * 注册一条订阅。sessionId 不存在于当前会话列表 → 拒绝（返回 false，RPC 层映射回执）；
   * 成功 → true。同一 handlerId 重复注册幂等覆盖（旧位置摘除后插入新位置）。
   */
  register(handlerId: string, target: EntryInvalidationTarget): boolean {
    if (!this.deps.sessionExists(target.sessionId)) return false
    this.unregister(handlerId)
    let byCustomType = this.buckets.get(target.sessionId)
    if (!byCustomType) {
      byCustomType = new Map()
      this.buckets.set(target.sessionId, byCustomType)
    }
    let byHandlerId = byCustomType.get(target.customType)
    if (!byHandlerId) {
      byHandlerId = new Map()
      byCustomType.set(target.customType, byHandlerId)
    }
    byHandlerId.set(handlerId, target)
    return true
  }

  /** 注销一条订阅（幂等：不存在时 no-op）。 */
  unregister(handlerId: string): void {
    for (const [sessionId, byCustomType] of this.buckets) {
      for (const [customType, byHandlerId] of byCustomType) {
        if (byHandlerId.delete(handlerId) && byHandlerId.size === 0) {
          byCustomType.delete(customType)
          if (byCustomType.size === 0) this.buckets.delete(sessionId)
        }
      }
    }
  }

  /**
   * 派发：按事件 (sessionId, customType) 双匹配命中订阅者，产出投递意图列表。
   * 无订阅者 → 空数组（零开销路径：两次 Map.get）。
   */
  dispatch(sessionId: string, customType: string): EntryInvalidationDelivery[] {
    const byHandlerId = this.buckets.get(sessionId)?.get(customType)
    if (!byHandlerId) return []
    const deliveries: EntryInvalidationDelivery[] = []
    for (const [handlerId, target] of byHandlerId) {
      deliveries.push({ workerId: target.workerId, handlerId })
    }
    return deliveries
  }

  /** 清理指定插件的全部订阅（crash / disable / uninstall 三路对偶清理；幂等）。 */
  clearForPlugin(pluginId: string): void {
    for (const [sessionId, byCustomType] of this.buckets) {
      for (const [customType, byHandlerId] of byCustomType) {
        for (const [handlerId, target] of byHandlerId) {
          if (target.pluginId === pluginId) {
            byHandlerId.delete(handlerId)
          }
        }
        if (byHandlerId.size === 0) byCustomType.delete(customType)
      }
      if (byCustomType.size === 0) this.buckets.delete(sessionId)
    }
  }

  /** 清理指定会话的全部订阅（session-destroyed 一路；幂等）。 */
  clearForSession(sessionId: string): void {
    this.buckets.delete(sessionId)
  }

  /** 当前注册条目数（测试诊断用）。 */
  get size(): number {
    let total = 0
    for (const byCustomType of this.buckets.values()) {
      for (const byHandlerId of byCustomType.values()) total += byHandlerId.size
    }
    return total
  }
}
