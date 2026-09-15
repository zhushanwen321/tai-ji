/**
 * UI API 模块
 *
 * 提供前端交互（对话框、通知、状态栏）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerUiRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.ui.showSelect / showConfirm / showInput / notify / updateStatusBarItem 五个 RPC 方法。
 *
 * Worker 侧：createUiApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * showSelect/confirm/input 经 ctx.handleUiRequest 发 extension_ui_request 到前端并等待响应。
 *
 * UI 弹窗超时（timeout-plugin-service D2：Worker 侧单一计时权威）：
 *   - dialog 类三方法（showConfirm/showSelect/showInput）是「等人工操作」，语义计时权威
 *     在请求发起方（本 Worker 侧）：opts.timeout（全程含串行排队）经 resolveUiRequestTimeoutMs
 *     解析为 effective，直传 rpcClient.request 第三参——传输计时即语义计时，链路无「两层
 *     谁先到期」（对齐 pi 先例 showConfirm(title, message, opts?: { timeout?: number })）。
 *   - 到期（PendingTracker reject RPC_TIMEOUT）转译为 UI_TIMEOUT reject（取消 ≠ 替答），
 *     并经 rpcClient.notify('plugin.ui.uiRequestExpired') 通知主线程 queue 取消（撤窗 +
 *     放行串行队列）。notify/updateStatusBarItem 纯展示类无等待语义，维持 client 默认 30s。
 *
 * S3-W3（D7 窄校验层）：全部方法入口 fail-fast 校验——缺字段/错类型/越界键抛
 * INVALID_* 结构化错误（message 含字段名与期望格式），畸形输入不产生 UI 副作用。
 * S3-W4（D7 限流与防毒化）：
 *   - notify 与 plugin.notify 共用同一每插件令牌桶（deps.limiter，默认 20 条/s）
 *     + message ≤8KB（INVALID_MESSAGE）；
 *   - updateStatusBarItem 单条 text ≤4KB（INVALID_TEXT，D3 验收「1MB text 被拒」
 *     依此规则），坏条目在该入口被拒——其余插件条目与后续广播不受影响
 *     （D4 毒化隔离：拒绝该条而非整包）。
 */

import { PLUGIN_NOTIFY_LIMITS } from '@taiji/shared'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { StatusBarItemOptions, UiDialogOptions } from '../plugin-types.js'
import { PluginRpcErrorCodes } from '../plugin-types.js'
import {
  asBoundedString,
  asOptionalString,
  asRecord,
  asSafeKey,
  asString,
  asStringArray,
} from '../validation.js'
import { errorWithCode, toErrorMessage } from '../../../utils/errors.js'
import { randomSuffix } from '../../../utils/ids.js'
import { guardNotifyParams, NotifyRateLimiter } from './notify-api.js'

/** KB → 字节换算 */
const BYTES_PER_KB = 1024
/** 对话框 title/message 等短文本上限：8KB（UTF-8 字节），防超长文本撑爆前端弹窗 */
const UI_TEXT_MAX_KB = 8
const UI_TEXT_MAX_BYTES = UI_TEXT_MAX_KB * BYTES_PER_KB

/** 时长换算基数（命名常量惯例对齐 subagent-core dialog-queue / session-runner） */
const MS_PER_SECOND = 1_000
const SECONDS_PER_MINUTE = 60

/** UI dialog 默认超时的裁决分钟数：30min（「等人工」，dialog-queue 先例同值） */
const DEFAULT_UI_REQUEST_TIMEOUT_MINUTES = 30

/**
 * UI dialog 请求默认超时（ms）＝ 30min（「等人工」裁决值，dialog-queue 先例同值；
 * timeout-plugin-service D2）。opts.timeout 非法/未传时回落此默认。
 */
export const DEFAULT_UI_REQUEST_TIMEOUT_MS =
  DEFAULT_UI_REQUEST_TIMEOUT_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND

/**
 * Node setTimeout delay 安全上限（2^31-1）：超域 delay 被 Node 塌缩为 1ms 立即触发
 * （语义反转）。权威源 @zhushanwen/subagent-core/shared/timer-delay.ts——与
 * bridge-interop（D1）同取「本地同值定义」惯例（平台常量无漂移面），避免首创跨包深路径耦合。
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * opts.timeout 是否为参与取值的合法正数（合法域判定）：finite 且 > 0 才生效。
 * D2 无 opt-out 概念（「等人工」不允许无界等待——串行队列 head-of-line 阻塞），
 * 0 / 负数 / NaN / ±Infinity 一律视为非法回落默认（对齐 dialog-queue isValidDialogTimeout）。
 */
function isValidUiTimeout(timeout: number | undefined): timeout is number {
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
}

/**
 * 解析 UI dialog 请求的有效超时（D2 取值链，对齐 dialog-queue resolveDialogTimeoutMs）：
 * 合法正数优先（clamp 到 MAX_TIMER_DELAY_MS 防 timer 域塌缩）；非法值（undefined /
 * 0 / 负数 / NaN / ±Infinity）回落 DEFAULT_UI_REQUEST_TIMEOUT_MS——不因脏参数拆掉语义计时。
 */
export function resolveUiRequestTimeoutMs(timeout: number | undefined): number {
  const resolved = isValidUiTimeout(timeout) ? timeout : DEFAULT_UI_REQUEST_TIMEOUT_MS
  return Math.min(resolved, MAX_TIMER_DELAY_MS)
}

// re-export（NON-BREAKING）：UiDialogOptions 权威契约定义在 plugin-types.ts（与
// StatusBarItemOptions 同源，单一定义消除本文件历史副本）；既有消费者
//（plugin-ui-timeout-authority.test.ts）仍从本文件导入，导出面不变。
export type { UiDialogOptions }

/** Worker→host dialog 请求携带的计时/取消控制字段（queue 尊重来方值）。 */
export interface UiRequestMeta {
  requestId?: string
  timeoutMs?: number
}

/** 从 handler params 提取控制字段（类型守卫窄化，非法值不进 meta——queue 侧回落兜底）。 */
function extractUiRequestMeta(params: Record<string, unknown>): UiRequestMeta {
  const meta: UiRequestMeta = {}
  if (typeof params.requestId === 'string' && params.requestId.length > 0) {
    meta.requestId = params.requestId
  }
  if (typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)) {
    meta.timeoutMs = params.timeoutMs
  }
  return meta
}

/** UI 服务依赖（主线程侧） */
export interface UiHandlers {
  /**
   * 发送 extension_ui_request 到前端。
   * 经 handleUiRequest 发送，返回前端选择结果。
   * meta（D2）：Worker 侧生成的 requestId + effective 超时，透传 UiRequestQueue——
   * queue 尊重来方 requestId（cancel 通知按它匹配）并按 timeoutMs 挂防泄漏兜底。
   */
  showSelect(title: string, options: string[], pluginId: string, meta?: UiRequestMeta): Promise<string | undefined>
  showConfirm(title: string, message: string, pluginId: string, meta?: UiRequestMeta): Promise<boolean>
  showInput(title: string, defaultValue: string | undefined, pluginId: string, meta?: UiRequestMeta): Promise<string | undefined>
  notify(pluginId: string, level: string, message: string): Promise<void>
  updateStatusBarItem(pluginId: string, id: string, text: string, options?: StatusBarItemOptions): Promise<void>
  /**
   * notify 令牌桶（S3-W4）。缺省自建（默认 20 条/s）；与 plugin.notify 入口
   * 共享时应由装配方（plugin-rpc-setup）传入同一实例。
   */
  limiter?: NotifyRateLimiter
  /**
   * UI 请求到期取消回调（D2）：Worker 侧语义 timer 到期后经
   * plugin.ui.uiRequestExpired notification 到达，queue 据此删项 + 撤窗广播 + 放行。
   * 缺省（装配方未接线）时通知被记 warn 后丢弃——queue 兜底 timer 收尾（观测可见，不静默）。
   */
  onUiRequestExpired?: (requestId: string, pluginId: string) => void
}

/**
 * statusbar options 逐字段校验：present 但类型错即抛 INVALID_<FIELD>
 * （窄校验层风格：错误码带字段名，插件作者可据此修正）。缺省字段全放行。
 */
function parseStatusBarOptions(value: unknown): StatusBarItemOptions {
  if (value === undefined) return {}
  const options = asRecord(value, 'options')
  const tooltip = asOptionalString(options.tooltip, 'tooltip')
  const commandId = asOptionalString(options.commandId, 'commandId')
  if (options.priority !== undefined && typeof options.priority !== 'number') {
    throw errorWithCode(
      `Invalid priority: expected a number but received ${typeof options.priority}.`,
      'INVALID_PRIORITY',
    )
  }
  if (options.scope !== undefined && options.scope !== 'global' && options.scope !== 'per-session') {
    throw errorWithCode(
      `Invalid scope: expected 'global' or 'per-session' but received ${JSON.stringify(options.scope)}.`,
      'INVALID_SCOPE',
    )
  }
  const sessionId = asOptionalString(options.sessionId, 'sessionId')
  return {
    ...(tooltip !== undefined ? { tooltip } : {}),
    ...(commandId !== undefined ? { commandId } : {}),
    ...(options.priority !== undefined ? { priority: options.priority } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  }
}

export function registerUiRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: UiHandlers,
): void {
  // notify 令牌桶（S3-W4）：与 plugin.notify 共用同一实例时由 deps.limiter 注入
  const limiter = deps.limiter ?? new NotifyRateLimiter()

  rpcServer.registerMethod('plugin.ui.showSelect', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const options = asStringArray(params.options, 'options')
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showSelect(title, options, pluginId, extractUiRequestMeta(params))
  })

  rpcServer.registerMethod('plugin.ui.showConfirm', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const message = asBoundedString(params.message, 'message', UI_TEXT_MAX_BYTES)
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showConfirm(title, message, pluginId, extractUiRequestMeta(params))
  })

  rpcServer.registerMethod('plugin.ui.showInput', async (params) => {
    const title = asBoundedString(params.title, 'title', UI_TEXT_MAX_BYTES)
    const defaultValue = asOptionalString(params.defaultValue, 'defaultValue')
    const pluginId = asString(params.pluginId, 'pluginId')
    return deps.showInput(title, defaultValue, pluginId, extractUiRequestMeta(params))
  })

  // D2 到期取消通知（Worker→host 无 id notification，复用既有 dispatch 通路——
  // JSON-RPC 语义不回包）。queue 据此删 pending/排队项 + 撤窗广播 + 放行串行队列。
  rpcServer.registerMethod('plugin.ui.uiRequestExpired', async (params) => {
    const pluginId = typeof params.pluginId === 'string' ? params.pluginId : 'unknown'
    const requestId = extractUiRequestMeta(params).requestId
    if (!requestId) {
      console.warn(`[ui-api] uiRequestExpired notification missing requestId (plugin=${pluginId}) — dropped`)
      return
    }
    if (!deps.onUiRequestExpired) {
      // 装配缺位可见（失败要出声）：取消语义退化为 queue 兜底 timer 收尾（延迟生效）
      console.warn(
        `[ui-api] uiRequestExpired received (requestId=${requestId}, plugin=${pluginId}) but no onUiRequestExpired wired — queue cleanup deferred to its fallback timer`,
      )
      return
    }
    deps.onUiRequestExpired(requestId, pluginId)
  })

  rpcServer.registerMethod('plugin.ui.notify', async (params) => {
    // 与 plugin.notify 同一道窄校验 + 令牌桶（guardNotifyParams 共用）
    const guarded = guardNotifyParams(limiter, params)
    if (guarded === null) {
      console.warn(
        `[ui-api] ui notify dropped: rate limit ${limiter.config.ratePerSec}/s exceeded (plugin=${String(params.pluginId)})`,
      )
      return
    }
    await deps.notify(guarded.pluginId, guarded.level, guarded.message)
  })

  rpcServer.registerMethod('plugin.ui.updateStatusBarItem', async (params) => {
    // CT-D4 毒化隔离可观测：坏条目拒绝除回包给插件外必须留宿主侧日志——
    // RPC 错误响应只到达插件侧，运维排查毒化插件（如批量投递 text:{}）需要
    // 宿主侧痕迹。日志只记错误码级摘要，不回显原始 payload（防日志被毒化刷屏）。
    try {
      const pluginId = asString(params.pluginId, 'pluginId')
      // id 进复合键 `${pluginId}:${id}`（statusBarItems Map 键）——白名单排除
      // 路径分隔符与复合键注入字符 ':'，越界键 INVALID_ID
      const id = asSafeKey(params.id, 'id')
      // 单条 text ≤4KB（D3）：空串 = 移除该 item 的既有语义，0 字节天然放行
      const text = asBoundedString(params.text, 'text', PLUGIN_NOTIFY_LIMITS.STATUSBAR_TEXT_MAX_BYTES)
      const options = parseStatusBarOptions(params.options)
      await deps.updateStatusBarItem(pluginId, id, text, options)
    } catch (e: unknown) {
      // 结构化校验错误的 code 是 'INVALID_*' 字符串（message 是人类可读文案）；
      // 只记校验失败，其他异常（deps 自身错误）原样上抛不打日志
      const code = (e as { code?: unknown }).code
      if (typeof code === 'string' && code.startsWith('INVALID_')) {
        console.warn(
          `[ui-api] statusbar item rejected: ${toErrorMessage(e)} (plugin=${String(params.pluginId)} id=${String(params.id)})`,
        )
      }
      throw e
    }
  })
}

/**
 * dialog 类请求的统一发起（D2 Worker 侧单一计时权威）：
 * 1. requestId 在 Worker 侧生成（全局唯一：pluginId 前缀 + 时间戳 + 随机后缀——
 *    共享 Worker 内多插件并发不碰撞），随 params 传递（queue 尊重来方值，取消通知按它匹配）；
 * 2. opts.timeout 经 resolveUiRequestTimeoutMs 解析为 effective，直传 rpcClient.request
 *    第三参（无余量）——传输计时即语义计时，从调用起算、全程含串行排队；
 * 3. effective 到期（PendingTracker reject RPC_TIMEOUT）转译为 UI_TIMEOUT reject：
 *    warn（等了多久 + 恢复指引）+ notify cancel（主线程 queue 删项/撤窗/放行）。
 *    其它错误（dispose / not attached / host 回包错误）原样传播，不误判为超时。
 */
function dialogRequest<T>(
  rpcClient: PluginRpcClient,
  pluginId: string,
  method: string,
  params: Record<string, unknown>,
  opts?: UiDialogOptions,
): Promise<T> {
  const requestId = `${pluginId}_${Date.now()}_${randomSuffix()}`
  const effective = resolveUiRequestTimeoutMs(opts?.timeout)
  return rpcClient
    .request(method, { ...params, requestId, timeoutMs: effective }, effective)
    .catch((err: unknown) => {
      if ((err as { code?: unknown }).code === PluginRpcErrorCodes.RPC_TIMEOUT) {
        console.warn(
          `[ui-api] ui dialog timed out after ${effective}ms without response ` +
            `(plugin=${pluginId}, method=${method}, requestId=${requestId}) — the request ` +
            `(including queue wait) was cancelled, no default answer was made. ` +
            `Recovery: pass opts.timeout (ms) to extend the full wait, or re-issue the request.`,
        )
        rpcClient.notify('plugin.ui.uiRequestExpired', { requestId, pluginId })
        throw errorWithCode(
          `ui request timed out after ${effective}ms (requestId=${requestId}) — ` +
            `the dialog was cancelled and can be re-issued. ` +
            `Recovery: pass opts.timeout (ms) to extend the wait (covers queueing).`,
          'UI_TIMEOUT',
        )
      }
      throw err
    }) as Promise<T>
}

export function createUiApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  showSelect(title: string, options: string[], opts?: UiDialogOptions): Promise<string | undefined>
  showConfirm(title: string, message: string, opts?: UiDialogOptions): Promise<boolean>
  showInput(title: string, defaultValue?: string, opts?: UiDialogOptions): Promise<string | undefined>
  notify(level: 'info' | 'warn' | 'error', message: string): Promise<void>
  updateStatusBarItem(id: string, text: string, options?: StatusBarItemOptions): Promise<void>
} {
  return {
    showSelect: (title: string, options: string[], opts?: UiDialogOptions) =>
      dialogRequest<string | undefined>(rpcClient, pluginId, 'plugin.ui.showSelect', { pluginId, title, options }, opts),

    showConfirm: (title: string, message: string, opts?: UiDialogOptions) =>
      dialogRequest<boolean>(rpcClient, pluginId, 'plugin.ui.showConfirm', { pluginId, title, message }, opts),

    showInput: (title: string, defaultValue?: string, opts?: UiDialogOptions) =>
      dialogRequest<string | undefined>(rpcClient, pluginId, 'plugin.ui.showInput', { pluginId, title, defaultValue }, opts),

    notify: (level: 'info' | 'warn' | 'error', message: string) =>
      rpcClient.request('plugin.ui.notify', { pluginId, level, message }).then(() => {}),

    updateStatusBarItem: (id: string, text: string, options?: StatusBarItemOptions) =>
      rpcClient.request('plugin.ui.updateStatusBarItem', { pluginId, id, text, options }).then(() => {}),
  }
}
