/**
 * Notify API 模块
 *
 * 提供插件通知（fire-and-forget 广播）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerNotifyRpcHandler() 在 PluginRpcServer 上注册
 *   plugin.notify 一个 RPC 方法——通过 broadcastFn 广播到前端。
 *
 * Worker 侧：createNotifyApi() 返回 {info/warning/error} 代理对象，通过 RPC
 * 转发到主线程。
 *
 * 此前 handler 内联在 plugin-rpc-setup.ts、Worker 侧代理内联在 plugin-bootstrap.ts。
 * P6 收口到本 api 文件，与其它 6 个域保持一致。
 *
 * 单一广播真相源：broadcastPluginNotification() 封装"组装 plugin:notification
 * payload + 调用 broadcastFn"，plugin.notify 与 plugin.ui.notify 两个 RPC 入口共用。
 * 无 broadcastFn 时返回 false，由调用方各自打印 warn 文案（两入口的原始文案不同，
 * 因此 warn 不进核心函数——去重的是"广播逻辑"，可观测文案各自保留，行为逐字不变）。
 *
 * S3-W4（D7 限流与防毒化）：入口两道防线——
 *   1. 窄校验（S3-W3）：pluginId/level/message 类型 + message ≤8KB，
 *      畸形即抛 INVALID_* 结构化错误（fire-and-forget 场景 dispatch 会落日志）；
 *   2. 每插件令牌桶（NotifyRateLimiter）：默认 20 条/s（shared SSOT，含实测校准
 *      依据注释），超限丢弃并记日志——通知是 fire-and-forget，丢弃即设计行为，
 *      不抛错（抛错与丢弃对插件同样无回包，但会污染 error 日志通道）。
 */

import { PLUGIN_NOTIFY_LIMITS } from '@taiji/shared'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import { asBoundedString, asString } from '../validation.js'

/** 毫秒 → 秒换算（令牌桶按秒补充令牌） */
const MS_PER_SECOND = 1_000

/**
 * 每插件 notify 令牌桶（D7「限流与防毒化」）。
 *
 * 标准 token bucket：容量 = 速率（可瞬时突发 ratePerSec 条），按 ratePerSec/s
 * 连续补充。按 pluginId 独立分桶——一个插件失控不影响其它插件的通知。
 *
 * 可配置：构造接受 { ratePerSec } 覆盖（默认取 shared PLUGIN_NOTIFY_LIMITS
 * SSOT 值）；nowMs 参数供 fake-timers 测试注入。实测校准依据见 shared 常量注释。
 */
export class NotifyRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>()

  constructor(
    public readonly config: { ratePerSec: number } = { ratePerSec: PLUGIN_NOTIFY_LIMITS.NOTIFY_RATE_PER_SEC },
  ) {}

  /**
   * 尝试为 pluginId 消费一个令牌。true = 放行，false = 超限（调用方丢弃 + 记日志）。
   */
  tryAcquire(pluginId: string, nowMs: number = Date.now()): boolean {
    const capacity = this.config.ratePerSec
    const bucket = this.buckets.get(pluginId) ?? { tokens: capacity, lastRefillMs: nowMs }
    const elapsedSec = Math.max(0, nowMs - bucket.lastRefillMs) / MS_PER_SECOND
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * this.config.ratePerSec)
    bucket.lastRefillMs = nowMs
    if (bucket.tokens < 1) {
      this.buckets.set(pluginId, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(pluginId, bucket)
    return true
  }

  /** 清空（或按 pluginId 清空）令牌桶（测试/插件卸载清理用） */
  reset(pluginId?: string): void {
    if (pluginId === undefined) this.buckets.clear()
    else this.buckets.delete(pluginId)
  }
}

/**
 * notify 入口的窄校验 + 限流水线（plugin.notify 与 plugin.ui.notify 共用）。
 *
 * 返回校验通过的 { pluginId, level, message }；畸形输入抛 INVALID_*（fail-fast，
 * 供 request 形态回结构化错误给插件）；超限返回 null（丢弃 + 由调用方记日志）。
 */
export function guardNotifyParams(
  limiter: NotifyRateLimiter,
  params: Record<string, unknown>,
  nowMs: number = Date.now(),
): { pluginId: string; level: string; message: string } | null {
  const pluginId = asString(params.pluginId, 'pluginId')
  const level = asString(params.level, 'level')
  const message = asBoundedString(params.message, 'message', PLUGIN_NOTIFY_LIMITS.NOTIFY_MESSAGE_MAX_BYTES)
  if (!limiter.tryAcquire(pluginId, nowMs)) return null
  return { pluginId, level, message }
}

/** broadcastFn 类型：Server→Client 推送（[HISTORICAL] 冒号 + camelCase 命名约定） */
export type PluginBroadcastFn = (type: string, payload: unknown) => void

/**
 * 单一来源的插件通知广播。fire-and-forget。
 *
 * 行为契约（不可变）：
 *   - 有 broadcastFn：调用 `broadcastFn('plugin:notification', { pluginId, level, message })`，返回 true
 *   - 无 broadcastFn：返回 false（不在此处 warn，由调用方按各自原始文案打印）
 *
 * 不在此函数内 warn 的原因：plugin.notify 与 plugin.ui.notify 两个 RPC 入口的
 * 历史 warn 文案不同（分别含 'plugin.notify' / 'ui-api notify' 字样），统一模板会
 * 改变可观测输出。去重的核心是广播 payload 组装，warn 是入口特定的可观测细节。
 */
export function broadcastPluginNotification(
  broadcastFn: PluginBroadcastFn | undefined,
  pluginId: string,
  level: string,
  message: string,
): boolean {
  if (broadcastFn) {
    broadcastFn('plugin:notification', { pluginId, level, message })
    return true
  }
  return false
}

/** Notify 服务依赖（主线程侧） */
export interface NotifyHandlers {
  /**
   * 广播一条插件通知。fire-and-forget。
   * @param pluginId 插件 ID
   * @param level   级别（info/warning/error）
   * @param message 消息文本
   */
  notify(pluginId: string, level: string, message: string): void
  /**
   * 每插件令牌桶（S3-W4）。缺省时 registerNotifyRpcHandler 自建默认桶
   * （20 条/s，shared SSOT）；plugin.ui.notify 入口应传入同一实例共享配额。
   */
  limiter?: NotifyRateLimiter
}

/**
 * 在 PluginRpcServer 上注册 plugin.notify RPC handler。
 *
 * Notify 是 fire-and-forget：直接通过 broadcastFn 广播。无 broadcastFn 时打印警告
 * 并丢弃（保持原行为）。
 *
 * S3-W4：入口先窄校验（畸形 → INVALID_* 结构化错误）再过令牌桶（超限丢弃 +
 * warn 日志，不抛错——丢弃是设计行为）。
 */
export function registerNotifyRpcHandler(
  rpcServer: PluginRpcServer,
  deps: NotifyHandlers,
): void {
  const limiter = deps.limiter ?? new NotifyRateLimiter()
  rpcServer.registerMethod('plugin.notify', async (params) => {
    const guarded = guardNotifyParams(limiter, params)
    if (guarded === null) {
      console.warn(
        `[plugin-notify-api] plugin.notify dropped: rate limit ${limiter.config.ratePerSec}/s exceeded (plugin=${String(params.pluginId)})`,
      )
      return
    }
    deps.notify(guarded.pluginId, guarded.level, guarded.message)
  })
}

/**
 * 由 broadcastFn 构造主线程侧 NotifyHandlers。无 broadcastFn 时警告并丢弃。
 */
export function notifyHandlersFrom(
  broadcastFn?: PluginBroadcastFn,
): NotifyHandlers {
  return {
    notify: (pluginId, level, message) => {
      // 文案与重构前逐字一致（commit 8dd3034f 父版本）
      if (!broadcastPluginNotification(broadcastFn, pluginId, level, message)) {
        console.warn('[plugin-notify-api] plugin.notify dropped: no broadcastFn configured')
      }
    },
  }
}

/**
 * 创建 Worker 侧 notify 代理对象。
 *
 * Worker 侧 Phase2AgentAPI.notify 签名为 {info/warning/error}(message)。
 * 微项 6（D2-2 同族）：notify 本就是 fire-and-forget（主线程 handler 只广播、无返回值），
 * 经 rpcClient.notify 发真 notification（无 id、不登记 pending、不等响应、不占 30s 超时
 * 定时器）——替代旧实现的 request 往返。接口形状保持 Promise<void>（Phase2AgentAPI 契约
 * 不变），实现为同步发通知后立即 resolve。
 */
export function createNotifyApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  info(message: string): Promise<void>
  warning(message: string): Promise<void>
  error(message: string): Promise<void>
} {
  const send = (level: string, msg: string): Promise<void> => {
    rpcClient.notify('plugin.notify', { pluginId, level, message: msg })
    return Promise.resolve()
  }
  return {
    info: (msg: string) => send('info', msg),
    warning: (msg: string) => send('warning', msg),
    error: (msg: string) => send('error', msg),
  }
}
