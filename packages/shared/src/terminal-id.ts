/**
 * 终端实例编号（terminalId）格式谓词 —— `term:<会话id>:<序号>` 的跨层协议级约定 SSOT。
 *
 * 这是跨层协议级约定（runtime terminal-service / renderer terminal-instance-registry /
 * core terminal-write-queue.removeSession 三包共用同一份结构解析），故归属 shared（平台无关
 * SSOT，同 virtual-session-id.ts 形态），禁止重复定义——历史上三包各持同名实现，跨包无编译期
 * 约束，实现漂移只能靠人肉对齐；本单点以编译期引用约束取代「顺序一致是调用点防错序的唯一
 * 抓手」式注释约定。
 *
 * 键序与解析口径（terminal-multi-instance 设计 §0.5 P7 精确前缀）：会话 id 域不含冒号，
 * 判归属 / 枚举一律取**精确前缀** `term:<sid>:`（后必须紧邻纯数字序号段），**禁按冒号切分
 * 取段**——该口径仅在 sid 域不含冒号时无歧义（否则 `term:a:` 会吞 sid 为 `a:1` 的键）。
 */

/** 实例编号根前缀（编号格式 `term:<会话id>:<序号>`，设计 §3.3「编号格式」）。 */
export const TERMINAL_ID_ROOT = 'term:'

/** `term:<sid>:` 前缀（精确前缀枚举基准；allocateTerminalId 拼编号 / 枚举扫描共用）。 */
export function terminalIdPrefixOf(sessionId: string): string {
  return `${TERMINAL_ID_ROOT}${sessionId}:`
}

/**
 * terminalId 是否属于会话 sid：前缀命中后序号段必须是纯数字（设计 §0.5 P7 精确前缀口径）。
 * 负例：sid `a` 不误纳键 `term:a:1:1`（序号段 `1:1` 非纯数字，实属 sid `a:1` 的实例）。
 *
 * **参数顺序口径**：`(terminalId, sessionId)`——被查编号在前、归属会话在后（与全部历史调用点
 * 及同名实现显式一致；单点后参数传反由调用点编译期类型/语义双错读出，不再依赖约定）。
 */
export function isTerminalIdOfSession(terminalId: string, sessionId: string): boolean {
  const prefix = terminalIdPrefixOf(sessionId)
  if (!terminalId.startsWith(prefix)) return false
  return /^\d+$/.test(terminalId.slice(prefix.length))
}

/** 由 terminalId 解析会话段；非法编号返回 null（sid 域不含冒号，取最后一个冒号前的余段）。 */
export function sessionIdOfTerminalId(terminalId: string): string | null {
  if (!terminalId.startsWith(TERMINAL_ID_ROOT)) return null
  const rest = terminalId.slice(TERMINAL_ID_ROOT.length)
  const idx = rest.lastIndexOf(':')
  if (idx <= 0) return null
  if (!/^\d+$/.test(rest.slice(idx + 1))) return null
  return rest.slice(0, idx)
}

/** 由 terminalId 解析会话内序号；非法编号返回 0（0 为无效序号，显示名回退原始编号）。 */
export function seqOfTerminalId(terminalId: string): number {
  if (!terminalId.startsWith(TERMINAL_ID_ROOT)) return 0
  const rest = terminalId.slice(TERMINAL_ID_ROOT.length)
  const idx = rest.lastIndexOf(':')
  if (idx <= 0) return 0
  const seq = rest.slice(idx + 1)
  if (!/^\d+$/.test(seq)) return 0
  return Number.parseInt(seq, 10)
}
