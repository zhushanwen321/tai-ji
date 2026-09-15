/**
 * presence —— 全局协同态（占位，C4 deferred）。
 *
 * [C4] deferred：实现留待 connection-lifecycle slice 或 feat-remote-use 合并后。
 * 当前 main 基线的 shared 尚未引入 PresenceConnection 类型（remote-use 未合并），
 * 故本地定义最小占位类型；remote-use 合并后应改为 import type { PresenceConnection }
 * from '@taiji/shared' 并落地真实 store。
 *
 * 参考 remote-use stores/presence.ts 的 API 形状：
 * - 全量替换语义（非增量 diff）：单用户自托管规模≤10，全量 payload<2KB
 * - 数据流：runtime presence.update 广播 / auth.ok presence 字段（ws-client 合成
 *   presence.update）→ routeInbound global 通道 → setConnections(list)
 *
 * ⚠️ presence 弱可靠通道约束（架构文档 §5.3-4）：presence 不入 seq 桶、靠 auth.ok/presence.list
 * 兜底——防止未来误「修复」成入 seq 桶（对应 ws-client.invariants.test.ts 的 it.todo）。
 */

/**
 * 占位：在线设备连接信息（最小形状）。
 * remote-use 合并后替换为 @taiji/shared 的 PresenceConnection。
 */
export interface PresenceConnection {
  clientId: string
  deviceName: string
  activeSessionId?: string
  isActive?: boolean
}

/**
 * 占位：全局协同态 store 接口。
 *
 * 持有 runtime 推送的 PresenceConnection[] 全量列表（谁在线、活跃 session、是否在操作）。
 * 本 wave 不实现（C4 deferred），仅声明接口供 route-inbound global 通道未来接入。
 */
export interface PresenceStore {
  connections: PresenceConnection[]
  setConnections(list: PresenceConnection[]): void
}
