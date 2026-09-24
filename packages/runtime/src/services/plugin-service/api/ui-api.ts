/**
 * UI API 模块
 *
 * 提供前端交互（对话框、通知、状态栏）的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerUiRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.ui.showSelect / showConfirm / showInput / notify / updateStatusBarItem 五个 RPC 方法，
 *   以及 plugin-header-action-modal-points 点位的命令式三方法：
 *   plugin.ui.showModal / hideModal / updateHeaderAction（AP-1/AP-2，sessionId 必填）。
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
 *     （D4 毒化隔离：拒绝该条而非整包）；
 *   - showModal title 与 updateHeaderAction badge/tooltip 同口径 ≤4KB
 *     （INVALID_TITLE / INVALID_BADGE / INVALID_TOOLTIP，code 按字段名推导），
 *     超长展示文本不入广播帧。
 */

import { PLUGIN_NOTIFY_LIMITS } from '@taiji/shared'
import type { PluginModalClosedReason, PluginModalStatePayload, HeaderActionUpdatePayload } from '@taiji/shared'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { StatusBarItemOptions, UiDialogOptions, Disposable } from '../plugin-types.js'
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

/**
 * modal title / headerAction badge·tooltip 上限：4KB（UTF-8 字节）。对齐
 * updateStatusBarItem 的 S3-W4 口径（STATUSBAR_TEXT_MAX_BYTES 同量级），超长展示
 * 文本在入口拒绝（INVALID_TITLE / INVALID_BADGE / INVALID_TOOLTIP），不入广播帧。
 */
const HEADER_TEXT_MAX_KB = 4
const HEADER_TEXT_MAX_BYTES = HEADER_TEXT_MAX_KB * BYTES_PER_KB

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

// ── plugin modal runtime 槽（plugin-header-action-modal-points AP-2，u5b）────────
//
// 层状态 owner 分工：renderer 持屏上台（DOM/焦点/Esc/焦点陷阱），runtime 持最小仲裁
// 记录（当前 open 槽的 owner + epoch——为 replaced 仲裁与 dismissModal 校验）。单一
// 真相帧 = plugin:modalState（全局广播 transient，不经 message-bus publish 故结构性
// 不入 ring；renderer 另以 lastEpoch 丢弃乱序入帧兜底）。槽是全局单例（core 侧
// plugin-modal-slot / search-modal 同款模块级单例先例），数据分区（views.update）是
// per-session 的——两者不冲突（D4）。
//
// 本节函数只做纯状态仲裁；广播与 Worker notify 经 wireRuntimeModalExits 注入的出口
// 执行（出口持有 broadcastFn / rpcServer，属于装配侧）。测试用
// resetRuntimeModalSlotForTest 复位。

/** modal 宽度三档闭集（落宿主 CSS 变量，插件不可指定像素）。 */
const MODAL_WIDTHS = new Set(['sm', 'md', 'lg'])

/** plugin modal 关闭原因词表闭集（AP-2 单点；与 shared protocol.ts 同构）。 */
const MODAL_CLOSED_REASONS: readonly PluginModalClosedReason[] = [
  'dismissed', 'session-switched', 'host-overlay', 'replaced', 'plugin-gone',
]

/**
 * server→Worker 的 modal 关闭定向通知方法名（AP-2：rpcServer.notify 通道，不是 WS 帧、
 * 不进 PLUGIN_RPC_METHODS——与 didCreate/didDestroy/entriesInvalidated 同族）。
 */
export const PLUGIN_MODAL_CLOSED_NOTIFY_METHOD = 'plugin.ui.modalClosed'

/** runtime 侧当前 open 槽的仲裁记录（owner + 调用参数原文 + 槽代数）。 */
export interface RuntimeModalSlotEntry {
  pluginId: string
  modalId: string
  sessionId: string
  title?: string
  width?: 'sm' | 'md' | 'lg'
  /** 单调递增槽代数（同 (pluginId,modalId) 重复 open 与 replaced 均递增，≥1 起）。 */
  epoch: number
  /** owner Worker（modalClosed 定向 notify 的目标；open RPC 的 ctx.workerId）。 */
  workerId: string
}

/** 广播/notify 出线（装配侧经 wireRuntimeModalExits 注入；缺省时动作 warn 丢弃——装配缺陷可见，不静默）。 */
export interface RuntimeModalExits {
  /**
   * 广播 modal 状态帧。返回是否真正发出：false = 出线已接线但 broadcastFn 缺失被
   * warn 丢弃（装配缺陷）——调用方据此拒绝「假成功」回执（B-F2：不谎报 opened/updated）。
   */
  broadcastModalState: (payload: PluginModalStatePayload) => boolean
  /** 广播 headerAction 更新帧。返回语义同 broadcastModalState（false = warn 丢弃）。 */
  broadcastHeaderActionUpdate: (payload: HeaderActionUpdatePayload) => boolean
  notifyModalClosed: (workerId: string, payload: { modalId: string; reason: PluginModalClosedReason }) => void
  /** E10 判定：ui-request-queue 是否有待决插件对话框（showSelect/showConfirm/showInput pending 表非空）。 */
  hasPendingUiRequest?: () => boolean
}

let modalSlot: RuntimeModalSlotEntry | null = null
let modalEpochCounter = 0
let runtimeModalExits: RuntimeModalExits | null = null

/** 注入广播/notify 出线（registerAllRpcMethods 装配时调用一次；重复调用覆盖——模块级单例语义）。 */
export function wireRuntimeModalExits(exits: RuntimeModalExits): void {
  runtimeModalExits = exits
}

/** 测试复位（槽 + epoch 计数 + 出线）。生产禁用。 */
export function resetRuntimeModalSlotForTest(): void {
  modalSlot = null
  modalEpochCounter = 0
  runtimeModalExits = null
}

/** 当前槽（测试诊断用）。 */
export function getRuntimeModalSlot(): RuntimeModalSlotEntry | null {
  return modalSlot
}

/**
 * showModal 仲裁（AP-2 开②）：同 (pluginId,modalId) 重复 open 不算换主（replaced=null，
 * 不产生 closed/notify），不同 owner 的 open 以 replaced 关旧者；epoch 每次生效 open
 * 严格递增。开层本身总是成立（E1：runtime 不读声明，modalId 不强制命中声明注册表——
 * updateStatusBarItem 既有口径，声明只影响枚举/置灰/默认元数据，不是授权键）。
 */
export function openRuntimeModalSlot(input: {
  pluginId: string
  modalId: string
  sessionId: string
  title?: string
  width?: 'sm' | 'md' | 'lg'
  workerId: string
}): { epoch: number; replaced: RuntimeModalSlotEntry | null } {
  const replaced = modalSlot
    && (modalSlot.pluginId !== input.pluginId || modalSlot.modalId !== input.modalId)
    ? modalSlot
    : null
  modalEpochCounter += 1
  modalSlot = { ...input, epoch: modalEpochCounter }
  return { epoch: modalEpochCounter, replaced }
}

/**
 * 关槽（三元组校验）：epoch 给定时（宿主 dismissModal 路径）必须与当前槽严格相等——
 * 陈旧 epoch（关闭在途时的重开）或不匹配 → 返回 null（调用方忽略 + 日志，防陈旧
 * dismiss 误关刚重开的层）；epoch 缺省时（插件 hideModal 路径）按 (pluginId, modalId)
 * owner 匹配。命中返回被关条目并清槽；未开层返回 null（closed 对已关层 no-op）。
 */
export function closeRuntimeModalSlot(input: {
  pluginId: string
  modalId: string
  epoch?: number
}): RuntimeModalSlotEntry | null {
  if (!modalSlot) return null
  if (modalSlot.pluginId !== input.pluginId || modalSlot.modalId !== input.modalId) return null
  if (input.epoch !== undefined && modalSlot.epoch !== input.epoch) return null
  const entry = modalSlot
  modalSlot = null
  return entry
}

/**
 * 插件消失（crash/disable/uninstall，E2）时的槽清理：返回被关条目（调用方以
 * 'plugin-gone' 走 closed 路径），无该插件的 open 层返回 null。
 */
export function closeRuntimeModalForPlugin(pluginId: string): RuntimeModalSlotEntry | null {
  if (!modalSlot || modalSlot.pluginId !== pluginId) return null
  const entry = modalSlot
  modalSlot = null
  return entry
}

/**
 * 插件消失（crash/disable/uninstall，E2 关②）的 closed 路径（PluginService 三路清理点
 * 与既有贡献清理同址转调）：命中该插件的 open 层时清槽并经出线广播 closed{plugin-gone}
 * + notify owner Worker，返回是否命中（无 open 层返回 false、零广播——closed 对未开层
 * no-op，与宿主 dismiss 路径的幂等语义一致）。
 */
export function dismissRuntimeModalForPluginGone(pluginId: string): boolean {
  const entry = closeRuntimeModalForPlugin(pluginId)
  if (!entry) return false
  closeRuntimeModalViaExits(entry, 'plugin-gone')
  return true
}

/** closed 路径的唯一出口（AP-2：宿主侧「关层」= runtime 广播 closed → renderer 收起，runtime 不操作 DOM）：清槽后广播 closed 帧 + notify owner Worker。 */
function closeRuntimeModalViaExits(entry: RuntimeModalSlotEntry, reason: PluginModalClosedReason): void {
  const exits = runtimeModalExits
  if (!exits) {
    console.warn(
      `[ui-api] modal "${entry.modalId}" (plugin=${entry.pluginId}) closed but no broadcast exits wired `
      + `— renderer layer state and plugin notification were not updated (host wiring gap)`,
    )
    return
  }
  exits.broadcastModalState({
    pluginId: entry.pluginId,
    modalId: entry.modalId,
    sessionId: entry.sessionId,
    ...(entry.title !== undefined && { title: entry.title }),
    ...(entry.width !== undefined && { width: entry.width }),
    state: 'closed',
    epoch: entry.epoch,
    reason,
  })
  exits.notifyModalClosed(entry.workerId, { modalId: entry.modalId, reason })
}

/** PluginModalClosedReason 闭集守卫（plugin-message-handler 的 dismissModal 帧校验用）。 */
export function isPluginModalClosedReason(value: unknown): value is PluginModalClosedReason {
  return typeof value === 'string' && (MODAL_CLOSED_REASONS as readonly string[]).includes(value)
}

/**
 * 宿主 dismissModal（C→S 帧）的 closed 路径（AP-2 关①；plugin-message-handler 转调）：
 * 三元组命中时清槽 + 广播 closed + notify owner Worker，返回是否命中（未命中由调用方
 * 忽略 + 日志）。
 */
export function dismissRuntimeModalFromHost(input: {
  pluginId: string
  modalId: string
  epoch: number
  reason: PluginModalClosedReason
}): boolean {
  const entry = closeRuntimeModalSlot(input)
  if (!entry) return false
  closeRuntimeModalViaExits(entry, input.reason)
  return true
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

  // ── plugin modal/headerAction 点位（AP-1/AP-2，u5b）──────────────────────
  // sessionId 必填（E15：缺/非法 → INVALID_SESSION_ID，不回落全局槽/猜测路径）；
  // 开层不校验声明（E1 降级：runtime 不读声明，D4）；有 pending 插件对话框时拒绝（E10）。
  rpcServer.registerMethod('plugin.ui.showModal', async (params, ctx) => {
    const pluginId = asString(params.pluginId, 'pluginId')
    const modalId = asSafeKey(params.modalId, 'modalId')
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    // title ≤4KB（S3-W4 同口径）：present 但超长 → INVALID_TITLE（B-F1：无上限的
    // title 可被毒化刷屏，与 updateStatusBarItem text 限界同理由）
    const title =
      params.title === undefined ? undefined : asBoundedString(params.title, 'title', HEADER_TEXT_MAX_BYTES)
    if (params.width !== undefined && !(typeof params.width === 'string' && MODAL_WIDTHS.has(params.width))) {
      throw errorWithCode(
        `Invalid width ${JSON.stringify(params.width)}: expected one of 'sm' | 'md' | 'lg'.`,
        'INVALID_WIDTH',
      )
    }
    const width = params.width as 'sm' | 'md' | 'lg' | undefined
    const exits = runtimeModalExits
    if (!exits) {
      // B-F2 装配缺陷显式报错（SESSION_READ_NOT_WIRED 同口径）：广播出线未接线时开层
      // 对 renderer 必然不可见——不建槽、不回 {opened:true} 假成功。
      throw errorWithCode(
        `showModal is not available: runtime broadcast exits are not wired (wireRuntimeModalExits was not `
        + `called by the host assembly). The modal layer would never reach the renderer — this is a `
        + `host-side wiring gap, not a plugin error; retrying will not help.`,
        'MODAL_BROADCAST_NOT_WIRED',
      )
    }
    if (exits.hasPendingUiRequest?.()) {
      // E10（AP-2 浮层规则②）：用户必须回应的系统层不被插件层压住。pi extension 的
      // select + UI_FORM_MARKER 表单族 pending 表在 pi 侧、runtime 无跟踪——不在本判定内（设计已登记）。
      throw errorWithCode(
        `showModal blocked: a plugin dialog (showSelect/showConfirm/showInput) is awaiting the user. `
        + `Resolve the pending dialog (or wait for its timeout) and retry.`,
        'MODAL_BLOCKED_BY_UI_REQUEST',
      )
    }
    // E1 日志留痕：runtime 无声明注册表可查（D4——声明唯一落点是 renderer/core），任何
    // modalId 都以调用参数开层；本行即开层可观测面（排查未声明 modalId 的调用从这里入手）。
    console.log(`[ui-api] showModal (plugin=${pluginId}, modal=${modalId}, session=${sessionId}, worker=${ctx.workerId})`)
    const { epoch, replaced } = openRuntimeModalSlot({ pluginId, modalId, sessionId, title, width, workerId: ctx.workerId })
    if (replaced) closeRuntimeModalViaExits(replaced, 'replaced')
    const delivered = exits.broadcastModalState({
      pluginId,
      modalId,
      sessionId,
      ...(title !== undefined && { title }),
      ...(width !== undefined && { width }),
      state: 'open',
      epoch,
    })
    if (!delivered) {
      // B-F2：出线已接线但 broadcastFn 缺失（warn-drop）——开帧对 renderer 不可见，
      // 回滚槽并显式报错，不回 {opened:true} 假成功。
      closeRuntimeModalSlot({ pluginId, modalId, epoch })
      throw errorWithCode(
        `showModal did not take effect: the modal-open broadcast was dropped (no broadcastFn configured `
        + `on the host side). The modal would be invisible to the renderer — fix the runtime assembly `
        + `(broadcastFn wiring) and retry.`,
        'MODAL_BROADCAST_NOT_WIRED',
      )
    }
    return { opened: true, epoch }
  })

  rpcServer.registerMethod('plugin.ui.hideModal', async (params) => {
    const pluginId = asString(params.pluginId, 'pluginId')
    const modalId = asSafeKey(params.modalId, 'modalId')
    // 插件自身关闭（AP-2 关③）：走与宿主 dismiss 相同的 closed 路径，按 owner 匹配
    //（Worker 侧插件不持 epoch）；已关层 no-op（closed 对已关层幂等）。
    const entry = closeRuntimeModalSlot({ pluginId, modalId })
    if (entry) closeRuntimeModalViaExits(entry, 'dismissed')
    return { closed: entry !== null }
  })

  rpcServer.registerMethod('plugin.ui.updateHeaderAction', async (params) => {
    const pluginId = asString(params.pluginId, 'pluginId')
    const headerActionId = asSafeKey(params.headerActionId, 'headerActionId')
    // E15：徽标是 per-session 语义（AP-1），缺/非法 sessionId 拒绝、不回落全局槽
    const sessionId = asSafeKey(params.sessionId, 'sessionId')
    // badge/tooltip ≤4KB（S3-W4 同口径，B-F1）：超长展示文本不入广播帧
    const badge =
      params.badge === undefined ? undefined : asBoundedString(params.badge, 'badge', HEADER_TEXT_MAX_BYTES)
    const tooltip =
      params.tooltip === undefined ? undefined : asBoundedString(params.tooltip, 'tooltip', HEADER_TEXT_MAX_BYTES)
    if (params.disabled !== undefined && typeof params.disabled !== 'boolean') {
      throw errorWithCode(
        `Invalid disabled: expected a boolean but received ${typeof params.disabled}.`,
        'INVALID_DISABLED',
      )
    }
    // badge ≤4 字符的截断由渲染端承担（AP-1），帧面存原文
    // B-F2：回执如实反映投递结果——出线未接线（optional-chain 跳过）或 broadcastFn
    // 缺失被 warn 丢弃时回 {updated:false}，不让插件误以为渲染端已收到
    const delivered =
      runtimeModalExits?.broadcastHeaderActionUpdate({
        pluginId,
        headerActionId,
        sessionId,
        ...(badge !== undefined && { badge }),
        ...(tooltip !== undefined && { tooltip }),
        ...(params.disabled !== undefined && { disabled: params.disabled }),
      }) ?? false
    return { updated: delivered }
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
  /** AP-2：开层（sessionId 必填；有 pending 插件对话框时 reject MODAL_BLOCKED_BY_UI_REQUEST；
   *  广播出线未接线/broadcastFn 缺失时 reject MODAL_BROADCAST_NOT_WIRED——不谎报 opened）。 */
  showModal(modalId: string, opts: { sessionId: string; title?: string; width?: 'sm' | 'md' | 'lg' }): Promise<{ opened: true; epoch: number }>
  /** AP-2 关③：插件自身关闭，走与宿主 dismiss 相同的 closed 路径（已关层 no-op）。 */
  hideModal(modalId: string): Promise<{ closed: boolean }>
  /**
   * AP-1：badge/tooltip/disabled 可变字段更新（sessionId 必填，徽标是 per-session 语义）。
   * 回执 {updated}：true = 广播帧已发出；false = 渲染端未收到（装配缺陷被丢弃），插件
   * 可据此告警或走轮询兜底，不应把 false 当成功。
   */
  updateHeaderAction(id: string, opts: { sessionId: string; badge?: string; tooltip?: string; disabled?: boolean }): Promise<{ updated: boolean }>
  /** AP-2：modal 被关闭（宿主 dismiss / 切会话 / 宿主浮层 / replaced / plugin-gone）的定向通知订阅。 */
  onModalClosed(handler: (event: { modalId: string; reason: PluginModalClosedReason }) => void): Disposable
} {
  // modalClosed 通知派发：单一 notification listener + 本地 handler 集（多订阅互不覆盖；
  // rpcClient.onNotification 同名方法实装为 Set 多 listener（plugin-rpc-client.ts），此处
  // 刻意收敛为单 listener + 本地 Set——订阅注销语义（Disposable.dispose）由本地 handler 集
  // 承载，不依赖 rpcClient 返回的 unsubscribe 逐个挂，与 session-api 的 handlerId 分派
  // 同款约束）。
  const modalClosedHandlers = new Set<(event: { modalId: string; reason: PluginModalClosedReason }) => void>()
  rpcClient.onNotification(PLUGIN_MODAL_CLOSED_NOTIFY_METHOD, (params: unknown) => {
    const p = params as { modalId: string; reason: PluginModalClosedReason }
    for (const handler of modalClosedHandlers) {
      handler({ modalId: p.modalId, reason: p.reason })
    }
  })

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

    showModal: (modalId: string, opts: { sessionId: string; title?: string; width?: 'sm' | 'md' | 'lg' }) =>
      rpcClient
        .request('plugin.ui.showModal', { pluginId, modalId, ...opts })
        .then(v => v as { opened: true; epoch: number }),

    hideModal: (modalId: string) =>
      rpcClient.request('plugin.ui.hideModal', { pluginId, modalId }).then(v => v as { closed: boolean }),

    updateHeaderAction: (id: string, opts: { sessionId: string; badge?: string; tooltip?: string; disabled?: boolean }) =>
      rpcClient
        .request('plugin.ui.updateHeaderAction', { pluginId, headerActionId: id, ...opts })
        .then(v => v as { updated: boolean }),

    onModalClosed: (handler: (event: { modalId: string; reason: PluginModalClosedReason }) => void): Disposable => {
      modalClosedHandlers.add(handler)
      return { dispose: () => { modalClosedHandlers.delete(handler) } }
    },
  }
}
