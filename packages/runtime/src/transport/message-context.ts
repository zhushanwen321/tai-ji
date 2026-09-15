/**
 * transport message-handler 的共享上下文接口（D8/D9/D2/D10）。
 *
 * 5 个 handler 的 Context 接口此前各自重复声明 `send` / `sendError` 签名（4/5 完全相同，
 * tree 只有 send）。抽此 base interface 让它们 extends，消除签名重复。每个 handler 仍保留
 * 自己的领域 service 依赖（pluginService / sessionService / ...），只共享「向 ws 发消息」
 * 这对无业务语义的契约。
 *
 * - `send`：5/5 handler 都有（向单个 ws 发 ServerMessage）。
 * - `sendError`：4/5 handler 有（tree 不发 error envelope，故 tree 的 Context 只 extends
 *   这里的 send 而不带 sendError——tree 不继承本接口，仅复用 send 形态）。
 * - `reply`（D2）：消灭 46 处 `send(ws, { type, id: msg.id, payload })` 样板。id 默认取请求 id。
 * - `sendError` 的 `details`（D10/P0-B）：请求级操作失败统一走 error envelope，
 *   扩展信息（hint / path 等）进 details，不再为每个失败类型造独立 *Error 子类型。
 */
import type { WebSocket as WsType } from 'ws'
import type { ServerMessage, ServerMessageMap, ServerMessageType } from '@taiji/shared'

/**
 * 所有 message-handler 共享的最小发消息契约。
 *
 * 实现由 server.ts 提供（send/sendError/reply 都是 server 的方法），handler 只通过 ctx 调用。
 */
export interface MessageHandlerContext {
  send(ws: WsType, msg: ServerMessage): void
  /**
   * 发送请求级操作失败的统一 error envelope（D10/P0-B）。
   * @param details 可选扩展槽：`{ hint?, path?, ... }` 等附加信息（此前散落在
   *   extension.installError.hint / file.read:error.path 等独立字段）。
   */
  sendError(ws: WsType, code: string, message: string, id?: string, details?: ErrorDetails): void
  /**
   * 发送一条带请求 id 的回复（D2 reply 惯用法）。
   * 等价于 `send(ws, { type, id, payload })`，但省去每次手写 `id: msg.id`。
   *
   * E1 泛型化：`type` 字面量收窄 `payload` 到 `ServerMessageMap[T]`。
   * ADR-0016 类型保护此前只单向生效（消费侧 on<T> 收窄），构造侧靠宽类型
   * `Record<string, unknown>` 放行——任何字段拼错都不报错。泛型化后，构造点
   * payload 字段对不上 `ServerMessageMap[T]` 时 tsc 报错（D5 的预期收益）。
   * 某些 reply 的 type 是动态变量（非字面量），调用方需显式断言 type 为具体 ServerMessageType。
   */
  reply<T extends ServerMessageType>(ws: WsType, id: string | undefined, type: T, payload: ServerMessageMap[T]): void
}

/**
 * error envelope 的可选扩展槽（D10/P0-B）。
 * sessionId 是常见字段（标定失败关联的会话）；其余为领域附加信息（install 的 hint、file.read 的 path 等）。
 */
export interface ErrorDetails {
  sessionId?: string
  /** extension install 失败的修复提示（原 extension.installError.hint） */
  hint?: string
  /** file.read 失败的文件路径（原 file.read:error.path） */
  path?: string
  [key: string]: unknown
}

