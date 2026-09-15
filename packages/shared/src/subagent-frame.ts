/**
 * subagent.stream_delta 帧父 session 解析（纯函数，零失败模式）。
 *
 * 消费方：core chat streaming idle timer 的 subagent 桥接（routeInbound FALLBACK →
 * ConnectionPorts.effects `onSubagentStreamDelta` 回调实现）——sync subagent/workflow
 * 编排期父 session 的 message.* 帧构造性为零（生产端不消费 onUpdate），子代理活跃
 * 信号走 subagent.stream_delta 旁路帧，经本函数归一为父 session id 后刷新父 session
 * 的 streaming idle timer（docs/design/timeout-streaming-ui-idle.md §5.1 D1 桥接）。
 *
 * 双通道两形态兼容（SSOT stores/subagent.ts subscribeStream 双键订阅注释）：
 * - relay tee 通道：payload.sessionId = 三段式虚拟分区 id `subagent:<mainSessionId>:<subagentId>`
 * - 旧 widget 通道：payload.sessionId = 主 session id 原样
 *
 * 解析是纯字符串函数：虚拟 id 经 extractMainSessionId 提取第二段；其余（含主 sid、
 * agentcall: 前缀、空串等非 subagent 虚拟形态）原样返回——无「解析失败」形态，
 * 调用方无需错误分支。
 */
import { isSubagentVirtualId, extractMainSessionId } from './virtual-session-id'

/**
 * 将 subagent.stream_delta 帧 payload.sessionId 归一为父（主）session id。
 *
 * - 三段式虚拟 id（`subagent:<mainSessionId>:<subagentId>`）→ 提取 mainSessionId
 * - 主 session id（旧 widget 通道）→ 原样返回
 */
export function resolveSubagentParentSessionId(sessionId: string): string {
  return isSubagentVirtualId(sessionId) ? extractMainSessionId(sessionId) : sessionId
}
