/**
 * plugin-bridge 回包形状守卫族（D11 自 extensions/taiji/plugin-bridge index.ts 零改动迁入）。
 *
 * 「marker + types + 守卫」同住惯例（session-manager / subagent-inflight 先例）：
 * 回包形状的运行时检测与类型定义同源维护。当前唯一消费方 = pi 侧 bridge
 * extension；runtime bridge-handler 的 5 处 `as string` 断言是后续批次的第二
 * 消费方（换校验的铺路，设计 D11 登记项）。
 *
 * isRecord 为模块内私有副本（排数组版——与 subagent-inflight 同款）：protocol
 * 不依赖 extensions 层的 ext-guards（分层边界裁决，D3 明确排除），包内已有
 * session-manager / subagent-inflight 两份私有副本并存。
 *
 * 设计权威源：docs/architecture/ext-simplify-17-shared-extraction.md §3.3 D11。
 */

import type {
  BridgeErrorResponse,
  BridgeInterceptResponse,
  BridgeSyncPayload,
  BridgeToolExecuteResponse,
} from './types.js'
import { isChannelErrorResult } from '../../core/select-rpc.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** runtime 错误闭环形状 {error, hint?}（设计 §3.3-D1：不裸 reject）——检测逻辑单源于
 * core 的 isChannelErrorResult（D8），本名保留为守卫族整体成员（D11 迁移） */
export function isBridgeErrorResponse(v: unknown): v is BridgeErrorResponse {
  return isChannelErrorResult(v)
}

export function isBridgeToolExecuteResponse(v: unknown): v is BridgeToolExecuteResponse {
  return isRecord(v) && typeof v.content === 'string' && (v.isError === undefined || typeof v.isError === 'boolean')
}

export function isBridgeSyncPayload(v: unknown): v is BridgeSyncPayload {
  return isRecord(v) && v.success === true && Array.isArray(v.tools)
}

export function isBridgeInterceptResponse(v: unknown): v is BridgeInterceptResponse {
  return isRecord(v) && Array.isArray(v.injectedMessages)
}

/** sync 清单里的单个工具条目（parameters 顶层必须 type:'object'——OpenAI 兼容红线） */
export function isSyncedTool(v: unknown): v is BridgeSyncPayload['tools'][number] {
  return (
    isRecord(v) &&
    typeof v.name === 'string' &&
    typeof v.description === 'string' &&
    isRecord(v.parameters) &&
    v.parameters.type === 'object'
  )
}
