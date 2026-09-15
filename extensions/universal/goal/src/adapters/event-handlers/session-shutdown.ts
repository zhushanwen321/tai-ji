/**
 * 事件 7: session_shutdown（MF-R2-1 根修：invalidate 前取消旧退避 timer）。
 *
 * SDK 触发序（@earendil-works/pi-coding-agent 0.84.4 实装核对）——所有使旧
 * runner 失效的路径都先 emit session_shutdown 再 invalidate，此刻 pi/ctx 仍可用：
 * - reload：agent-session.js（emit → oldRunner.invalidate()）
 * - new / resume / fork 替换：agent-session-runtime.js teardownCurrent
 *   （emit → session.dispose() 内 invalidate）
 * - quit：agent-session-runtime.js dispose（emit → session.dispose()）
 *
 * 此处取消待发的退避 continuation timer。不清理则旧 timer 携旧 ctx/ports 闭包
 * 存活到至多 600s：stale 后回调内访问 ctx（isIdle / sessionManager getter 走
 * assertActive）必抛，catch 内降级日志 pi.appendEntry 同生命周期（loader.js
 * appendEntry 首行 assertActive）二次必抛——timer 回调不在 pi runner handler
 * 错误隔离范围内，同步异常 = uncaughtException，可能带崩 pi 进程。
 */

import type { GoalSession } from "../../session";
import { cancelContinuationTimer } from "../../session";

export async function handleSessionShutdown(session: GoalSession): Promise<void> {
	cancelContinuationTimer(session);
}
