/**
 * RPC 类型化 helper —— 收敛 pending.createCommandId + register + ws-client.send 的 4 行模板。
 *
 * api/domains/ 下每个 RPC 函数原本手动展开：
 *   const id = pending.createCommandId()
 *   const result = pending.register<TReply>(id)
 *   send({ type, id, payload })
 *   return await result
 *
 * 收敛为单次 command<K>(type, payload) 调用。K 经 ReplyPayloadMap 推导出 reply payload 类型，
 * payload 经 ClientMessageMap[K] 约束——调用方无需手写泛型实参，request/reply 双向类型安全。
 * 调用方自己从 reply 解包字段（如 `.subagents`）。
 */
import type { ClientMessage, ClientMessageMap, ReplyPayloadMap } from '@taiji/shared'
import * as pending from './pending'
import { send } from '../ws-client'
import { transportUnavailableError } from '../errors'

/**
 * 发送 RPC 请求并等待 reply（类型化原语）。
 *
 * @param type ClientMessageType 字面量（须是 ReplyPayloadMap 的 key，即 RPC 型）
 * @param payload 请求 payload，类型由 ClientMessageMap[K] 约束
 * @param timeoutMs 超时毫秒数（必传，G5：漏传 = 编译错误——调用方按命令语义显式
 *                  决策，控制面单请求传 pending.RPC_BACKSTOP_TIMEOUT_MS，长任务命令
 *                  传各自校准链常量如 BASH_RPC_TIMEOUT_MS + RENDERER_RPC_MARGIN_MS；
 *                  传 0 禁用超时）
 * @returns reply payload，类型由 ReplyPayloadMap[K] 推导（ack 型为 void，payload 消费型为具体字段）
 *
 * @example
 *   // payload 消费型：reply 类型是 ReplyPayloadMap['session.getSubagents']，即 { sessionId, subagents }
 *   const reply = await command('session.getSubagents', { sessionId })
 *   return reply.subagents
 *
 *   // reply 消费型（session.switch 的 reply 已非 void）：ReplyPayloadMap['session.switch'] =
 *   // ServerMessageMap['session.switched']，即 { sessionId, session }（wave:perf-w20 R-11 瘦身，
 *   // reply 不再含 messages，历史消费走显式 session.history RPC）
 *   const switched = await command('session.switch', { sessionId })
 *   return switched.session
 *
 *   // ack 型：reply 类型是 void（如 ReplyPayloadMap['session.unsubscribe']）
 *   await command('session.unsubscribe', { sessionId })
 */
export async function command<K extends keyof ReplyPayloadMap>(
  type: K,
  payload: ClientMessageMap[K],
  timeoutMs: number,
): Promise<ReplyPayloadMap[K]> {
  const id = pending.createCommandId()
  const result = pending.register<ReplyPayloadMap[K]>(id, timeoutMs)
  // ClientMessage 是 discriminated union（type ↔ payload 对应），helper 的泛型 payload
  // 无法满足精确联合约束，用断言绕过——type 字面量已由 ReplyPayloadMap key 约束，安全。
  const sent = send({ type, id, payload } as ClientMessage)
  if (!sent) {
    // send false = WS 非 OPEN（reconnecting/restarting/connecting），消息根本没送出，
    // 该 id 永远等不到 reply。use-connection 的 rejectAll 只覆盖「connected → 断开」转变；
    // 请求发出时本就处于断开态则后续永不触发，promise 只能等 65s sweep 超时——期间调用方
    // 的 in-flight 标记（如文件树 inFlight/loading）持续拦截用户操作（V8 实测：runtime
    // 重启窗口内点击目录零反馈，reload 才恢复）。立即 reject 让调用方进入可重试的 error 态。
    pending.reject(id, transportUnavailableError('transport unavailable (ws not open)'))
  }
  return result
}
