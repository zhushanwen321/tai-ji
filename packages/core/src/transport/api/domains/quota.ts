/**
 * Quota 域 —— coding-plan 额度查询 RPC 封装。
 *
 * 形态分类（契约见 .xyz-harness/2026-06-23-render-runtime-integration/contract.md §2.3）：
 * - 请求-响应：getCached（读缓存不请求）/ fetch（hover 触发主动查询）
 * - 动作-ack：configure（启用/禁用/写 cookie）
 *
 * 设计文档：docs/architecture/v3-specs/coding-plan-quota/design.md
 * HANDOFF：.xyz-harness/coding-plan-quota/HANDOFF.md
 */
import type { NormalizedQuotaRow, QuotaConfigurePayload, QuotaFetchFailureReason } from '@xyz-agent/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'

/** getCached / fetch 的统一返回结构。 */
export interface QuotaResult {
  data: NormalizedQuotaRow | null
  lastFetchAt: number | null
  /**
   * 最近一次查询失败原因（A2-4，runtime reason 透传）：data=null 失败态出现；
   * getCached 在上次查询失败时携带（失败态渲染 + 「查看上次成功数据」归 Phase B）。
   */
  reason?: QuotaFetchFailureReason
}

/** reply → QuotaResult 纯投影（三个查询 RPC 的统一返回形状）。 */
function toQuotaResult(reply: { data: NormalizedQuotaRow | null, lastFetchAt: number | null, reason?: QuotaFetchFailureReason }): QuotaResult {
  return { data: reply.data, lastFetchAt: reply.lastFetchAt, reason: reply.reason }
}

/**
 * 读缓存不发起请求。浮层首屏即时填充（避免空白）。
 * 无缓存返回 `{ data: null, lastFetchAt: null }`。
 */
export async function getCached(providerId: string): Promise<QuotaResult> {
  const reply = await command('quota.getCached', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return toQuotaResult(reply)
}

/**
 * hover 触发主动查询。成功更新缓存 + 返回最新值。
 * 失败时 runtime 返回失败态（ok=true + data=null + reason），不抛错。
 * 并发保护：同 provider pending 期间复用 Promise（runtime 侧）。
 * 注意：带 10s throttle，10s 内重复 fetch 直接返回缓存。测试查询请用 refreshQuota。
 */
export async function fetchQuota(providerId: string): Promise<QuotaResult> {
  const reply = await command('quota.fetch', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return toQuotaResult(reply)
}

/**
 * 强制刷新额度（绕过 throttle）。Settings 测试查询按钮专用。
 * 仍走 pending 并发保护（同 provider pending 期间复用 Promise）。
 * 失败时 runtime 返回失败态（ok=true + data=null + reason），不抛错。
 */
export async function refreshQuota(providerId: string): Promise<QuotaResult> {
  const reply = await command('quota.refresh', { providerId }, RPC_BACKSTOP_TIMEOUT_MS)
  return toQuotaResult(reply)
}

/**
 * Settings 配置。整对象透传 payload（coding-plan-quota-config-ux §7.1 契约收敛）：
 * 原 6 个位置参数中 4 个是同构的 `string | undefined`，调用方错位编译器不报错；收敛后
 * 后续加字段只改 shared 类型、漏切调用方必是参数数/属性名编译错。
 * 各可选键缺省 = 不变（runtime persist 继承链）；cookie 空串 = 清除；apiKey/workspace
 * 空字符串同样 = 清除（UI 侧已不再产出空串，见 D13）。enabled=false 不删缓存。
 */
export async function configure(payload: QuotaConfigurePayload): Promise<{ ok: boolean; error?: string }> {
  const reply = await command('quota.configure', payload, RPC_BACKSTOP_TIMEOUT_MS)
  return { ok: reply.ok, error: reply.error }
}
