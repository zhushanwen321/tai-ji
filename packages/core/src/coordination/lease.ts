/**
 * lease —— runtime TTL 管控（占位，C4 deferred）。
 *
 * [C4] deferred：实现留待 connection-lifecycle slice 或 feat-remote-use 合并后。
 *
 * 参考 remote-use routeInbound lease 分支的语义：
 * - session.busy：lease acquire 成功，payload 含 clientId（busyOwnerId）+ expiresAt →
 *   session store 的 setSessionBusy(sid, clientId, expiresAt)（UI 标题旁占用指示器）
 * - session.idle：lease 释放，清除占用 → clearSessionBusy(sid)
 * - acquire/release/过期清理：connection-lifecycle slice 落地（含过期扫描）
 *
 * 本 wave 仅声明接口，不实现逻辑（slice design-review sufficiency gaps 显式排除）。
 */

/**
 * 占位：lease 管理器接口。
 *
 * session.busy/idle → session store 的 setSessionBusy/clearSessionBusy；
 * acquire/release/过期清理由 connection-lifecycle slice 实现。
 */
export interface LeaseManager {
  acquire(sessionId: string, clientId: string, expiresAt: number): void
  release(sessionId: string): void
}
