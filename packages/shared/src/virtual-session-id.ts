/**
 * 虚拟 session ID 工厂 —— subagent / agent call 对话流在 chatStore.messages Map 中的 key 约定。
 *
 * 这是跨层协议级约定（runtime session-service / renderer store / ui chat 块 / drawer tab 都消费），
 * 故归属 shared（平台无关 SSOT）。store（renderer）与 ui 组件均从此 import，禁止重复定义。
 *
 * 两种结构（W4a 身份统一后）：
 * - subagent 三段式 `subagent:<mainSessionId>:<subagentId>`：chat-lru 的 isVirtualKeyOf 据此前缀
 *   联动清理；MessageStream.forceWorking 据此判定 running 强制 streaming 显示。
 * - agent call 两段式 `agentcall:<agentCallSessionId>`：快照只读视图，不带 mainSession 命名空间，
 *   清理走 workflowStore.mainSessionAgentCalls 映射（isVirtualKeyOf 不覆盖此前缀）。
 *
 * **btw 两段式（`btw:<piSessionId>`）已随 W4a 身份统一退役**：btw 线是 runtime 注册的真会话，
 * 以 pi 真实会话 id 作唯一键（注册表 / bus / chatStore 分区 / 磁盘同一 id）——虚拟 id 工厂
 * 第三家族（btwVirtualId / isBtwVirtualId / extractBtwPiSessionId / BTW_PREFIX）整体删除，
 * 不保留 alias（一个会话一个 id，I1；验收项 9「不存在 btw 专用翻译函数」）。
 *
 * INVAR-1.1（subagent 派生键形态契约，强制化）：任何写入 messages 的 subagent key 必须经
 * subagentVirtualId 工厂（生产方值域断言 fail-fast），且结构校验恰好 2 冒号 3 段非空。
 */

// ── subagent 三段式 ──

/** subagent 虚拟 session ID 前缀 */
export const SUBAGENT_PREFIX = 'subagent:'

/**
 * INVAR-1.1 结构常量：`subagent:` 剥前缀后恰为 2 段（⇔ 全键恰好 2 冒号 3 段非空）。
 * 结构校验（isSubagentVirtualId）与负例契约（`subagent:btw:<y>:<s>` 四段必拒，S-R4-2）
 * 同锚于此值。
 */
const SUBAGENT_REST_SEGMENT_COUNT = 2

/**
 * 构造三段式虚拟 session ID：`subagent:<mainSessionId>:<subagentId>`。
 *
 * 三段式提供主 session 命名空间，chat-lru 的 isVirtualKeyOf 据此按前缀联动清理。
 * INVAR-1.1：任何写入 messages 的 subagent key 必须经此工厂，恰好 2 冒号 3 段非空。
 *
 * 生产方值域断言（INVAR-1.1 强制化，fail-fast throw；S-R4-2 防误接线）：
 * - 中段禁冒号（`btw:` 前缀必含冒号，该检查同时兜住误传虚拟 id 的形态，保证产物恰好
 *   2 冒号 3 段、恒过 isSubagentVirtualId 结构校验）；
 * - 中段非空（mainSessionId = owner 会话的 piSessionId——btw 线名下派生传线 piSessionId，
 *   W4a 键统一后即线的注册 id 本身）；
 * - 第三段 subagentId 同规则（非空 + 禁冒号，INVAR-1.1 三段非空）。
 */
export function subagentVirtualId(mainSessionId: string, subagentId: string): string {
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
  return parts.length === SUBAGENT_REST_SEGMENT_COUNT && parts[0].length > 0 && parts[1].length > 0
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

/** 从 agent call 虚拟 session ID 提取 agent call 的 pi session ID */
export function extractAgentCallSessionId(virtualId: string): string {
  return virtualId.slice(AGENTCALL_PREFIX.length)
}

// ── 虚拟 id → 底层真实 session id 解析（renderer 数据链进 runtime RPC 前的规整）──

/**
 * 解析虚拟 session id 为底层真实 pi session id。
 *
 * 背景（fileSearch vid 修复，方案 A）：runtime file.search 等服务只登记真实 pi session
 * （sessionService.getSummary 查 lifecycle 注册表），虚拟 id 直传必 session_not_found。
 * 「vid 只做前端路由 key，需要真实 id 的 RPC 由调用方先解析」是现行契约（agentcall D4
 * 先例：历史拉取走 getAgentCallHistory(mainSid, acsId) 显式双参数）——本函数是该解析的
 * 跨层单一实现（renderer useChatViewDeps / sessionCwdOf 等数据链消费）。
 *
 * 规则（W4a 键统一后）：
 * - 真实 id（无冒号）→ 原样返回（直通）
 * - `subagent:<mainSid>:<subId>` → mainSid（三段式自带归属命名空间，ownerSessionId 不消费）
 * - `agentcall:<acsId>` → ownerSessionId（两段式无归属命名空间，挂载链显式传入；
 *   acsId 是 agent call 自身的 subagent session id，不在 runtime session 注册表）
 * - 其余带冒号的未知形态 → undefined（fail-safe：不把未知 vid 传给 runtime RPC）
 *
 * **btw 分支已随 W4a 身份统一删除**：btw 线以 pi 真实会话 id 注册（无 `btw:` 前缀第二套
 * 键），线的 id 本身就是真实 id、直通本函数第一分支——映射即 extract 的旧 btw 分支
 * （`btw:<piSid>` → piSid）失去服务对象。
 */
export function resolveVirtualSessionId(virtualId: string, ownerSessionId?: string): string | undefined {
  if (!virtualId.includes(':')) return virtualId
  if (isSubagentVirtualId(virtualId)) return extractMainSessionId(virtualId)
  if (isAgentCallVirtualId(virtualId)) return ownerSessionId || undefined
  return undefined
}
