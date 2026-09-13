// src/execution/ui/ui-request-observability.ts
//
// UI 请求可观测性状态（从 subagent-service.ts 提取，降低主文件行数）。
// 持有 sessionMode + handler 缺失告警去重集合，供 SubagentService 委托调用。

import { getLogger } from "../../core/logger.ts";

import type { ExtensionMode } from "../assembly/host-mode.ts";

const logger = getLogger("subagents");

// ── 跨模块桥接（inproc UI 请求队列（已删） 无 ctx.service 引用时走这里） ──
//
// inproc UI 请求队列 handleUiRequest（已删） 在 ctx.uiRequestHandler 缺失时需要触发去重告警，
// 但 SessionRunnerContext 不持有 service 引用（改 ctx 签名超出本组 4 文件范围）。
// 解法：SubagentService 构造后调 registerGlobalObservability(this.uiObservability)
// 把进程单例挂到 globalThis；queue 走 notifyMissingHandlerGlobal 路径调到同一实例，
// 共享 warnedMissingHandlerSessions 去重集合。
//
// 遗留：SubagentService 接线（构造/初始化时调 registerGlobalObservability）需在后续 PR 完成，
// 本组仅提供桥接入口 + queue 侧调用。未注册时 notifyMissingHandlerGlobal 走 fallback warn（不去重），
// 保证可观测性不回归。
const GLOBAL_OBSERVABILITY_KEY = Symbol.for("pi-subagent-workflow.ui-observability");

/** 注册进程级 observability 单例（SubagentService 构造后调用一次）。 */
export function registerGlobalObservability(obs: UiRequestObservability): void {
  (globalThis as Record<symbol, unknown>)[GLOBAL_OBSERVABILITY_KEY] = obs;
}

/** 触发 handler 缺失告警（经全局单例，per-session 去重）。
 *  未注册全局单例时走 fallback warn（不去重），保证可观测性不丢。 */
export function notifyMissingHandlerGlobal(sessionId: string): void {
  const obs = (globalThis as Record<symbol, unknown>)[GLOBAL_OBSERVABILITY_KEY] as
    | UiRequestObservability
    | undefined;
  if (obs) {
    obs.notifyMissingHandler(sessionId);
  } else {
    logger.warn(
      `[subagents] uiRequestHandler missing (session=${sessionId}, global observability not registered)`,
    );
  }
}

/** warnedMissingHandlerSessions 容量上限（#14 防 Set 无界增长）。
 *  长生命周期进程（GUI 主进程长开）下，不同子进程会话 id 不断积累；
 *  超过阈值时清空集合（简单策略，LRU 留作后续优化）。 */
const MAX_WARNED_SESSIONS = 1024;

/** UI 请求可观测性状态。
 *  持有 sessionMode（主进程运行模式，W4 守卫透传）+ handler 缺失告警去重集合。
 *  外部通过 setMode/resetMissingHandlerWarnings/notifyMissingHandler 驱动。 */
export class UiRequestObservability {
  private sessionMode: ExtensionMode | undefined;
  private warnedMissingHandlerSessions = new Set<string>();

  setMode(mode: ExtensionMode | undefined): void {
    this.sessionMode = mode;
  }

  getMode(): ExtensionMode | undefined {
    return this.sessionMode;
  }

  /** handler 变化时重置告警去重（新 handler 就位后允许重新 warn）。 */
  resetMissingHandlerWarnings(): void {
    this.warnedMissingHandlerSessions.clear();
  }

  /** 记录 handler 缺失（per-session 去重，每 session 只 warn 一次）。
   *  #14：Set 加 cap——超 MAX_WARNED_SESSIONS 时先清空再 add，防无界增长。
   *  清空策略：当前会话首条告警丢失可接受（去重本身只是降噪，非数据完整性约束）。 */
  notifyMissingHandler(sessionId: string): void {
    if (this.warnedMissingHandlerSessions.has(sessionId)) return;
    if (this.warnedMissingHandlerSessions.size >= MAX_WARNED_SESSIONS) {
      this.warnedMissingHandlerSessions.clear();
    }
    this.warnedMissingHandlerSessions.add(sessionId);
    logger.warn(`[subagents] uiRequestHandler missing (session=${sessionId}, mode=${this.sessionMode})`);
  }
}
