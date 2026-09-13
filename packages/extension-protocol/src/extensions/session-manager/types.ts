/**
 * session-manager extension 的类型定义。
 *
 * 6 个 action 的请求 params 和结果类型，供 handler 和 extension 共用。
 * marker 检测后按 action 分发到对应 handler 分支。
 */
import type { SESSION_MANAGER_ACTIONS } from './marker.js'

/** session-manager 支持的 6 个 action（从 SESSION_MANAGER_ACTIONS 集合派生，值与类型同源） */
export type SessionManagerAction = (typeof SESSION_MANAGER_ACTIONS)[number]

/** 各 action 的请求参数映射 */
export interface SessionManagerParams {
  create: SessionManagerCreateParams
  send: SessionManagerSendParams
  history: SessionManagerHistoryParams
  status: SessionManagerStatusParams
  list: SessionManagerListParams
  abort: SessionManagerAbortParams
}

/** create action 参数 */
export interface SessionManagerCreateParams {
  /** session 工作目录 */
  cwd?: string
  /** session 标签 */
  label?: string
  /** 初始 prompt（可选；提供时 create 后立即注入——设计文档 §5.2 原子性决策） */
  prompt?: string
}

/** send action 参数 */
export interface SessionManagerSendParams {
  sessionId: string
  prompt: string
}

/** history action 参数 */
export interface SessionManagerHistoryParams {
  sessionId: string
  /** 截断尾部 turn 数（0 = 不截断） */
  tailTurns?: number
}

/** status action 参数 */
export interface SessionManagerStatusParams {
  sessionId: string
}

/** list action 参数（无字段：过滤由 handler 固化——spawnSource='agent' + 路由上下文父 id；Record<string, never> 结构性拒绝任何请求字段） */
export type SessionManagerListParams = Record<string, never>

/** abort action 参数 */
export interface SessionManagerAbortParams {
  sessionId: string
}

// ── params 运行时守卫（信任边界：params 来自 extension_ui_request，LLM 可控 JSON）──
// handler 侧 dispatch 前校验；非法 params 不再经 `as unknown as` 断言静默流入
// sessionService（曾以 undefined 流入 create 的 cwd/label/prompt）。

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isOptionalString(v: unknown): boolean {
  return v === undefined || typeof v === 'string'
}

function isSessionIdParams(v: unknown): boolean {
  return isRecord(v) && typeof v.sessionId === 'string'
}

/** create：全字段可选 string */
export function isSessionManagerCreateParams(v: unknown): v is SessionManagerCreateParams {
  return (
    isRecord(v) &&
    isOptionalString(v.cwd) &&
    isOptionalString(v.label) &&
    isOptionalString(v.prompt)
  )
}

/** send：sessionId + prompt 必填 */
export function isSessionManagerSendParams(v: unknown): v is SessionManagerSendParams {
  return isRecord(v) && typeof v.sessionId === 'string' && typeof v.prompt === 'string'
}

/** history：sessionId 必填、tailTurns 可选 number */
export function isSessionManagerHistoryParams(v: unknown): v is SessionManagerHistoryParams {
  return (
    isRecord(v) &&
    typeof v.sessionId === 'string' &&
    (v.tailTurns === undefined || typeof v.tailTurns === 'number')
  )
}

/** status / abort：sessionId 必填 */
export function isSessionManagerStatusParams(v: unknown): v is SessionManagerStatusParams {
  return isSessionIdParams(v)
}

export function isSessionManagerAbortParams(v: unknown): v is SessionManagerAbortParams {
  return isSessionIdParams(v)
}

/** list：无参数（过滤由 handler 固化，params 不携带任何过滤字段） */
export function isSessionManagerListParams(v: unknown): v is SessionManagerListParams {
  return isRecord(v)
}

/** create 结果 */
export interface SessionManagerCreateResult {
  sessionId: string
  status: 'created'
  modelId?: string
}

/**
 * send 结果（sd-u5 起）：消息已入队/已投递——目标 busy 时在下一 turn 边界注入。
 * 失败形状走 SessionManagerErrorResult（error + hint），不再出现旧的 {blocked, rejected}。
 */
export interface SessionManagerSendResult {
  queued: true
}

/** history 结果 */
export interface SessionManagerHistoryResult {
  messages: unknown[]
  truncated: boolean
}

/** status 结果 */
export interface SessionManagerStatusResult {
  status: string
  modelId?: string
}

/** list 结果 */
export interface SessionManagerListResult {
  sessions: SessionManagerSessionSummary[]
}

/** list 返回的 session 摘要（精简版） */
export interface SessionManagerSessionSummary {
  id: string
  label: string
  cwd: string
  status: string
  spawnSource?: 'user' | 'agent'
  parentAgentSessionId?: string
}

/** abort 结果 */
export interface SessionManagerAbortResult {
  success: boolean
}

/** 错误响应形状（send 同步失败时 = { error, hint }；create 已成功时另附 sessionId） */
export interface SessionManagerErrorResult {
  error: string
  /** create 已成功时附 sessionId + hint */
  sessionId?: string
  hint?: string
}
