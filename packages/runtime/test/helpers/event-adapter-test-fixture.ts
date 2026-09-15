/**
 * 测试辅助：构造 EventAdapter + EventInterpreter 组合，保留旧 EventAdapterOptions 风格 API。
 *
 * [背景] R1 重构后 EventAdapter 变为纯翻译器（无业务回调），业务编排移到 EventInterpreter。
 * 大量历史测试按「EventAdapter + EventAdapterOptions 回调」风格编写。本 helper 装配两者，
 * 使这些测试在最小改动下继续验证翻译 + 编排行为。
 *
 * 生产装配见 src/index.ts（组合根）。本文件仅测试用，不进 src/。
 */
import { EventAdapter } from '../../src/infra/pi/event-adapter.js'
import { EventInterpreter, type EventInterpreterOptions } from '../../src/services/session/event-interpreter.js'
import type { ServerMessage } from '@taiji/shared'
import type { FileChange } from '@taiji/shared'
import type { IFileChangeDiff } from '../../src/services/ports/file-change-diff.js'

export type WsSender = (msg: ServerMessage) => void

/** hook 执行结果（与原 EventAdapterOptions.onHookExecute 一致）。 */
export interface HookResult {
  blocked: boolean
  transformedData?: unknown
}

/**
 * 旧风格配置（与重构前 EventAdapterOptions 对齐），便于测试迁移。
 * onHookExecute 经 EventInterpreter.executeHooks 注入。
 */
export interface EventAdapterOptions {
  cwd?: string
  fileChangeDiff?: IFileChangeDiff
  onExtensionUIRequest?: (requestId: string, sessionId: string, method: string) => void
  onBridgeUIRequest?: (requestId: string, sessionId: string, method: string, data: Record<string, unknown>) => void
  onStatusSetUpdate?: (payload: { sessionId: string; key: string; text: string }) => void
  onContextUpdate?: (sessionId: string, data: { inputTokens: number; totalTokens: number }) => void
  /** W3：pi turn_end 单 turn 用量到达（turn 级副作用触发点）。 */
  onTurnUsage?: (sessionId: string) => void
  /** W3：pi agent_end 整循环结束（isGenerating 复位 + 终态副作用）。 */
  onTurnFinalize?: (sessionId: string) => void
  /** session_info_changed 事件到达（pi extension auto-rename）——回写 session label 缓存。 */
  onSessionRenamed?: (sessionId: string, name: string | undefined) => void
  onHookExecute?: (hookType: string, context: Record<string, unknown>) => Promise<HookResult>
}

/**
 * 装配 EventAdapter + EventInterpreter，返回可直接 attach 的适配器。
 * 业务回调透传到 EventInterpreterOptions。
 */
export function createEventAdapter(
  sessionId: string,
  send: WsSender,
  options?: EventAdapterOptions,
): EventAdapter {
  const interpreterOpts: EventInterpreterOptions = {
    cwd: options?.cwd,
    send,
    fileChangeDiff: options?.fileChangeDiff,
    onExtensionUIRequest: options?.onExtensionUIRequest,
    onBridgeUIRequest: options?.onBridgeUIRequest,
    onStatusSetUpdate: options?.onStatusSetUpdate,
    onContextUpdate: options?.onContextUpdate,
    onTurnUsage: options?.onTurnUsage,
    onTurnFinalize: options?.onTurnFinalize,
    onSessionRenamed: options?.onSessionRenamed,
    executeHooks: options?.onHookExecute,
  }
  const interpreter = new EventInterpreter(sessionId, interpreterOpts)
  return new EventAdapter(sessionId, (events) => interpreter.interpret(events))
}

export type { FileChange }
