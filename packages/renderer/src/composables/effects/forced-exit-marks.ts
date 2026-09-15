/**
 * 强制退出意图标记（crash-resilience T4 回流修复的退出语义区分器）。
 *
 * 背景：session.exited 帧对「pi 意外崩溃（runtime 会自动 respawn）」与「用户强制退出
 * （forceQuit RPC，runtime 构造性不 respawn）」不可区分（wire payload 相同，不改帧协议）。
 * renderer 需要区分两者：意外退出 → 「引擎恢复中」过渡态（respawnPending）；强制退出 →
 * 既有终态 dead 页行为不变（A7 反向验收）。
 *
 * 形态：renderer 侧模块级 Set（唯一写入点 = onForceQuitSession，RPC 发出前标记；唯一
 * 消费点 = useMessageEffects.handleSessionExited，consume 语义读后即清）。与 useChat
 * streamSubscriptions 同范式（模块级 Map/Set + 显式清理，会话级意图非实例 UI 状态）。
 * RPC 失败时由调用方撤销标记（防残留把下次意外崩溃误判为强制退出——误判方向保守但
 * 会让过渡态失效，撤销是廉价正确性）。
 */

// taste:allow-no-data-owner W24-EX-C（非 GUI 数据技术结构，已登记 §4 ⑧ 2026-09-12）：强制退出意图标记 Set（读后即清，无持久化无 GUI 消费）
const forcedExitSessionIds = new Set<string>()

/** 标记「该 session 的退出将源于用户强制退出」（forceQuit RPC 发出前调用）。 */
export function markForcedExit(sessionId: string): void {
  forcedExitSessionIds.add(sessionId)
}

/** 消费标记：返回该 session 是否处于强制退出意图中，读后即清（一次意图只对应一次 exited）。 */
export function consumeForcedExit(sessionId: string): boolean {
  if (!forcedExitSessionIds.delete(sessionId)) return false
  return true
}

/** 测试隔离：清空全部标记。 */
export function resetForcedExitMarks(): void {
  forcedExitSessionIds.clear()
}
