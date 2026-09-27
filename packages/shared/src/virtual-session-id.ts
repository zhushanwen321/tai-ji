/**
 * 虚拟 session ID 工厂 —— subagent / agent call 对话流在 chatStore.messages Map 中的 key 约定。
 *
 * 这是跨层协议级约定（runtime session-service / renderer store / ui chat 块 / drawer tab 都消费），
 * 故归属 shared（平台无关 SSOT）。store（renderer）与 ui 组件均从此 import，禁止重复定义。
 *
 * 两种结构：
 * - subagent 三段式 `subagent:<mainSessionId>:<subagentId>`：chat-lru 的 isVirtualKeyOf 据此前缀
 *   联动清理；MessageStream.forceWorking 据此判定 running 强制 streaming 显示。
 * - agent call 两段式 `agentcall:<agentCallSessionId>`：快照只读视图，不带 mainSession 命名空间，
 *   清理走 workflowStore.mainSessionAgentCalls 映射（isVirtualKeyOf 不覆盖此前缀）。
 */

// ── subagent 三段式 ──

/** subagent 虚拟 session ID 前缀 */
export const SUBAGENT_PREFIX = 'subagent:'

/**
 * 构造三段式虚拟 session ID：`subagent:<mainSessionId>:<subagentId>`。
 *
 * 三段式提供主 session 命名空间，chat-lru 的 isVirtualKeyOf 据此按前缀联动清理。
 * INVAR-1.1：任何写入 messages 的 subagent key 必须经此工厂，恰好 2 冒号 3 段非空。
 */
export function subagentVirtualId(mainSessionId: string, subagentId: string): string {
  return `${SUBAGENT_PREFIX}${mainSessionId}:${subagentId}`
}

/**
 * 判断 sessionId 是否为合法 subagent 虚拟 session（三段结构校验）。
 *
 * INVAR-1.4：不只 startsWith，必须校验三段结构（前缀 + 2 冒号 + 各段非空），
 * 排除旧两段式残留（subagent:foo）和误传字符串。职责：结构判定（非归属判定）。
 */
export function isSubagentVirtualId(sessionId: string): boolean {
  if (!sessionId.startsWith(SUBAGENT_PREFIX)) return false
  const rest = sessionId.slice(SUBAGENT_PREFIX.length)
  const sepIdx = rest.indexOf(':')
  if (sepIdx <= 0) return false // 无第二冒号或 mainSid 段空
  return sepIdx < rest.length - 1 // subId 段非空
}

/**
 * 从虚拟 session ID 提取 subagentId（第三段，DR9 保持消费契约不变）。
 * 消费方（MessageStream.vue 等）按 subId 契约，改三段式不破坏。
 */
export function extractSubagentId(virtualId: string): string {
  const rest = virtualId.slice(SUBAGENT_PREFIX.length)
  return rest.slice(rest.indexOf(':') + 1)
}

/** 从虚拟 session ID 提取 mainSessionId（第二段，供 evictSessionWithVirtual 前缀清理复用）。 */
export function extractMainSessionId(virtualId: string): string {
  const rest = virtualId.slice(SUBAGENT_PREFIX.length)
  return rest.slice(0, rest.indexOf(':'))
}

// ── agent call 两段式 ──

/** agent call 虚拟 session ID 前缀 */
export const AGENTCALL_PREFIX = 'agentcall:'

/** 构造 agent call 虚拟 session ID：`agentcall:<sessionId>` */
export function agentCallVirtualId(sessionId: string): string {
  return `${AGENTCALL_PREFIX}${sessionId}`
}

/** 判断 sessionId 是否为 agent call 虚拟 session */
export function isAgentCallVirtualId(sessionId: string): boolean {
  return sessionId.startsWith(AGENTCALL_PREFIX)
}

/** 从虚拟 session ID 提取 agent call 的 pi session ID */
export function extractAgentCallSessionId(virtualId: string): string {
  return virtualId.slice(AGENTCALL_PREFIX.length)
}
