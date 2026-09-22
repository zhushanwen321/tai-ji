/**
 * 虚拟 session ID 工厂 —— subagent / agent call 对话流在 chatStore.messages Map 中的 key 约定。
 *
 * 这是跨层协议级约定（runtime session-service / renderer store / ui chat 块 / drawer tab 都消费），
 * 故归属 shared（平台无关 SSOT）。store（renderer）与 ui 组件均从此 import，禁止重复定义。
 *
 * 三种结构：
 * - subagent 三段式 `subagent:<mainSessionId>:<subagentId>`：chat-lru 的 isVirtualKeyOf 据此前缀
 *   联动清理；MessageStream.forceWorking 据此判定 running 强制 streaming 显示。
 * - agent call 两段式 `agentcall:<agentCallSessionId>`：快照只读视图，不带 mainSession 命名空间，
 *   清理走 workflowStore.mainSessionAgentCalls 映射（isVirtualKeyOf 不覆盖此前缀）。
 * - btw 两段式 `btw:<piSessionId>`（第三家族，btw-question D2）：第二段直接内嵌 btw 线的
 *   pi 会话 id——映射即 extract（extractBtwPiSessionId 去前缀即真 sid），无独立映射层，
 *   关联不靠 id 前缀解析。vid 仅是 runtime/前端路由 key、不直传 pi（pi id 正则禁冒号——
 *   真 sid 永不含 `:`、虚拟 id 永含 `:`，命名空间构造性分离零冲突）。
 *
 * INVAR-1.1（subagent 派生键形态契约，强制化）：任何写入 messages 的 subagent key 必须经
 * subagentVirtualId 工厂（生产方值域断言 fail-fast），且结构校验恰好 2 冒号 3 段非空。
 */

// ── subagent 三段式 ──

/** subagent 虚拟 session ID 前缀 */
export const SUBAGENT_PREFIX = 'subagent:'

/**
 * 构造三段式虚拟 session ID：`subagent:<mainSessionId>:<subagentId>`。
 *
 * 三段式提供主 session 命名空间，chat-lru 的 isVirtualKeyOf 据此按前缀联动清理。
 * INVAR-1.1：任何写入 messages 的 subagent key 必须经此工厂，恰好 2 冒号 3 段非空。
 *
 * 生产方值域断言（INVAR-1.1 强制化，fail-fast throw；S-R4-2 防误接线）：
 * - 中段（mainSessionId = owner 会话的 piSessionId）禁 `btw:` 前缀——btw 线注册的
 *   sessionId 是 btw vid，误传即产出 `subagent:btw:<y>:<s>` 四段键（结构校验必拒、
 *   静默解析 mainSid="btw" 的歧义路径封死）。btw 线名下派生应传线 piSessionId：
 *   `extractBtwPiSessionId(btwVid)`——映射即 extract（D9③ 键中段位约定）。
 * - 中段禁冒号（`btw:` 前缀必含冒号，该守卫同时兜住其余误传形态，保证产物恰好
 *   2 冒号 3 段、恒过 isSubagentVirtualId 结构校验）；第三段 subagentId 同规则
 *   （非空 + 禁冒号，INVAR-1.1 三段非空）。
 */
export function subagentVirtualId(mainSessionId: string, subagentId: string): string {
  if (mainSessionId.startsWith(BTW_PREFIX)) {
    throw new Error(
      `[INVAR-1.1] subagentVirtualId: 中段禁 btw: 前缀（btw vid 误接线），收到 "${mainSessionId}"；` +
        `btw 线名下派生请传线 piSessionId（extractBtwPiSessionId）`,
    )
  }
  if (mainSessionId.includes(':')) {
    throw new Error(`[INVAR-1.1] subagentVirtualId: 中段（owner piSessionId）禁冒号，收到 "${mainSessionId}"`)
  }
  if (!mainSessionId) {
    throw new Error('[INVAR-1.1] subagentVirtualId: 中段（mainSessionId）不得为空')
  }
  if (!subagentId || subagentId.includes(':')) {
    throw new Error(`[INVAR-1.1] subagentVirtualId: 第三段须非空且禁冒号，收到 "${subagentId}"`)
  }
  return `${SUBAGENT_PREFIX}${mainSessionId}:${subagentId}`
}

/**
 * 判断 sessionId 是否为合法 subagent 虚拟 session（三段结构校验）。
 *
 * INVAR-1.4：不只 startsWith，必须校验三段结构（前缀 + 2 冒号 + 各段非空），
 * 排除旧两段式残留（subagent:foo）和误传字符串。职责：结构判定（非归属判定）。
 *
 * INVAR-1.1 强制化（S-R4-2）：恰好 2 冒号 3 段——旧实现按首个冒号切分，
 * `subagent:btw:<y>:<s>`（3 冒号 4 段）会通过校验并静默解析 mainSid="btw"；
 * 现四段形态必拒。读侧消费方（extractMainSessionId / extractSubagentId）
 * 一律先过本判定再提取，非法键不会进入提取路径。
 */
export function isSubagentVirtualId(sessionId: string): boolean {
  if (!sessionId.startsWith(SUBAGENT_PREFIX)) return false
  const parts = sessionId.slice(SUBAGENT_PREFIX.length).split(':')
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0
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

// ── btw 两段式（第三家族，btw-question D2）──

/** btw 虚拟 session ID 前缀 */
export const BTW_PREFIX = 'btw:'

/**
 * 构造 btw 虚拟 session ID：`btw:<piSessionId>`（两段式，工厂第三家族）。
 *
 * 第二段直接内嵌 btw 线的 pi 会话 id——映射即 extract（extractBtwPiSessionId
 * 去前缀即真 sid），无独立映射层（D2：关联不靠 id 前缀解析，三段式被否）。
 * 值域断言：piSessionId 非空且禁冒号（与 pi assertValidSessionId 同款——真 sid
 * 永不含 `:`，虚拟 id 永含 `:`，命名空间构造性分离；嵌套 btw vid 必含冒号被拒）。
 */
export function btwVirtualId(piSessionId: string): string {
  if (!piSessionId) {
    throw new Error('[btw] btwVirtualId: 第二段（piSessionId）不得为空')
  }
  if (piSessionId.includes(':')) {
    throw new Error(`[btw] btwVirtualId: 第二段须为线 pi session id，禁冒号（禁止二次嵌套虚拟 id），收到 "${piSessionId}"`)
  }
  return `${BTW_PREFIX}${piSessionId}`
}

/**
 * 判断 sessionId 是否为合法 btw 虚拟 session（两段结构校验：恰好 1 冒号 2 段非空）。
 * 排除 `btw:` 空尾与 `btw:a:b` 多段嵌套；与 subagent 三段式构造性互斥
 * （三段键必含 2 冒号，不以 btw: 开头；以 btw: 开头的键必不可能通过 subagent 校验）。
 */
export function isBtwVirtualId(sessionId: string): boolean {
  if (!sessionId.startsWith(BTW_PREFIX)) return false
  const rest = sessionId.slice(BTW_PREFIX.length)
  return rest.length > 0 && !rest.includes(':')
}

/**
 * 从 btw 虚拟 session ID 提取线的 pi session ID（映射即 extract，D2 / D9③
 * 键中段位约定：btw 线派生 subagent 键的中段 = 本函数结果，而非 btw vid 整体）。
 */
export function extractBtwPiSessionId(virtualId: string): string {
  return virtualId.slice(BTW_PREFIX.length)
}
