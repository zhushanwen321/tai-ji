/**
 * plugin-bridge 协议 v2 的类型定义。
 *
 * select + BRIDGE_MARKER 通道上的请求/回包形状，pi 侧 bridge extension
 * （序列化发送方）与 runtime bridge-handler（解析与回包方）共用。
 * 向后不兼容旧 bridge:* method 承载（旧链路本来就不通，改名无收益）。
 * marker 检测后按 method 分发到对应 handler 分支。
 */
import type { BRIDGE_METHODS } from './marker.js'

/** 协议 v2 的 4 个 method（从 BRIDGE_METHODS 集合派生，值与类型同源） */
export type BridgeMethod = (typeof BRIDGE_METHODS)[number]

/** bridge 请求的统一形状（pi bridge extension → runtime via select 通道） */
export interface BridgeRequest {
  method: BridgeMethod
  /** tool_execute 专属：工具名 */
  toolName?: string
  /** tool_execute 专属：工具调用 id */
  toolCallId?: string
  /** tool_execute 专属：工具入参 */
  params?: Record<string, unknown>
  /** 发起请求的 session（tool_execute/event/intercept 携带，供 runtime 按 session 路由
   * 防跨 session 串台；bridge:sync 全局快照请求不带） */
  sessionId?: string
  /** event / intercept 专属：pi 原生事件名 */
  eventName?: string
  /** event / intercept 专属：事件负载 */
  data?: unknown
}

// ── 回包形状（runtime → pi bridge extension，JSON 序列化后经 select 通道回传）──
// 本模块是 Bridge* 回包形状的唯一定义源（D4 单源化）：runtime
// （services/plugin-service/plugin-types.ts）与 plugin-sdk 均经本包 re-export 消费，
// 不存在第二份定义。
// 回包必须由 runtime 侧先 JSON.stringify 传字符串：pi 帧级 `String(response)`
// 对对象产出 '[object Object]'（设计 §3.3-D1 序列化陷阱）。
// bridge:event 是 fire-and-forget（禁止 await 回包），无回包形状。

/** tool_execute 回包：插件工具执行结果 */
export interface BridgeToolExecuteResponse {
  content: string
  isError?: boolean
}

/** sync 回包：工具清单快照（pi 侧命令发现不走本协议，另走 getCommands 通路） */
export interface BridgeSyncPayload {
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  success: true
}

/** intercept 回包：before_agent_start 拦截决策（bridge 侧把 injectedMessages 映射为单条 CustomMessage） */
export interface BridgeInterceptResponse {
  blocked?: boolean
  reason?: string
  injectedMessages: unknown[]
}

/** 错误回包：runtime 侧异常折叠（不裸 reject；bridge 侧解析后以 isError 返回） */
export interface BridgeErrorResponse {
  error: string
  hint?: string
}
