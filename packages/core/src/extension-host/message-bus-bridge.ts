/**
 * message-bus-bridge.ts —— MessageBusBridge（IF3/TC1）。
 *
 * plugin 系与 extension 系下行消息族 → core InternalEvent 的归一入口（AC8 + FR5）。
 * 构造注入 { source: PluginMessageSource; bus: InternalEventBus }（依赖注入，core 与
 * transport 解耦——不持有任何 ws-client 引用），构造即 subscribe(source)，dispose 时
 * unsubscribe（防 listener 翻倍，项目规则#2）。
 *
 * 映射表（IF3）：
 *   9 个 plugin 系：statusBarUpdate→plugin-status-bar-update；statusSetUpdate→
 *     plugin-status-set-update；permissionRequest→plugin-permission-request；crashed→
 *     plugin-crashed；notification→plugin-notification；config→plugin-config-changed；
 *     messageDecoration→plugin-message-decoration；statusChange→plugin-status-change；
 *     uiRequest→ui-request
 *   5 个 extension 系：widget/widgetGui→extension-widget；status→extension-status；
 *     notify→extension-notify；ui_request→ui-request（与 plugin:uiRequest 归一）
 *
 * payload 窄化契约（clarify Q1，runtime 实际生产形状逐一核实）：
 * - statusBarUpdate payload = { items: StatusBarItem[] }（runtime StatusBarItem 含
 *   scope/sessionId 无 alignment）→ StatusBarEntry[]：保留 scope/sessionId（IF8 分流），
 *   alignment 取 payload.alignment，无则默认 'left'
 * - statusSetUpdate payload = { sessionId, key, text, textRaw? }（bridge-handler 形状）
 *   → StatusSetEntry：id←key、text←text、pluginId←''（wire 无 pluginId）
 * - permissionRequest payload = { pluginId, permissions: string[] }（activator 形状）
 *   → PermissionRequest：permissions 原样透传整个数组、requestId←合成 perm_${pluginId}
 * - crashed payload = { pluginId, workerId, error } → { pluginId, error }
 * - notification payload = { pluginId, level, message } → NotificationPayload
 * - config payload = { pluginId, config } → { pluginId, config }
 * - messageDecoration payload 无 runtime 生产方（protocol 占位）→ 宽容窄化：object 且含
 *   messageId 即收，decoration 原样透传
 * - statusChange payload = { pluginId, oldStatus, newStatus }（hot-reload 形状）
 *   → status←newStatus（∈ PluginStatus 才收）
 * - uiRequest payload = { requestId, pluginId, method, ...params } → DialogRequest：
 *   kind←method（select/confirm/input）
 * - extension 系五消息 wire 无 pluginId → 统一置 ''；widget viewId←widgetKey、
 *   guiTree←lines（widget）或 [gui]（widgetGui，gui:null 保留清除语义）；status
 *   status←text、detail←textRaw；notify message/level 保留
 * - extension.ui_request method 可超界（editor）→ kind 兜底 'input' + 原始 method 经
 *   DialogRequest 索引签名保留（request.method 不丢信息，s4 适配层可恢复）
 *
 * ERR2（C2 契约）：未知 type → error（'unknown message type: <type>'）；payload 解析
 * 失败 → error（'<type> payload parse failed: ...'）。两条路径都不静默吞。
 * 例外（CT-D5 毒化隔离）：statusBarUpdate 的 items 内单条坏值跳过该条保留其余
 * （全坏才整包 error）——坏条目来自单个插件，不连坐其余插件的条目。
 */
import type { InternalEvent, StatusBarEntry } from './types'
import type { InternalEventBus } from './internal-event-bus'
import type { PluginMessageSource, IncomingPluginMessage } from './plugin-message-source'

// ── 窄化工具（模块私有，不 export）────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null
}

/** 事件级 sessionId 传播：msg.sessionId ?? payload.sessionId（string 才收）。 */
function resolveSessionId(msg: IncomingPluginMessage, payload: Record<string, unknown> | null): string | undefined {
  return asOptionalString(msg.sessionId) ?? (payload ? asOptionalString(payload.sessionId) : undefined)
}

const PLUGIN_STATUS_VALUES = new Set(['discovered', 'loaded', 'active', 'inactive', 'crashed'])

// ── 9 个 plugin:* 窄化守卫（返回 InternalEvent | null，null=解析失败）──

/**
 * statusbar 更新解析（CT-D5 毒化隔离，导出供单元测试）。
 *
 * 单条坏 item（id/pluginId/text 非 string、priority 非 number）跳过该条保留
 * 其余——恶意/缺陷插件投递的坏条目不连坐整包，其余插件的条目正常上屏。
 * 全部条目均坏（原始 items 非空但零条存活）→ 返回 null（整包 error）：
 * 「清空」的合法 wire 形态是 items: []，全坏与清空不可混淆，仍按毒化上报。
 */
export function parseStatusBarUpdate(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const rawItems = payload.items
  if (!Array.isArray(rawItems)) return null
  const items: StatusBarEntry[] = []
  for (const raw of rawItems) {
    const item = parseStatusBarItem(raw)
    if (item) items.push(item)
  }
  if (items.length === 0 && rawItems.length > 0) return null
  return { kind: 'plugin-status-bar-update', sessionId: resolveSessionId(msg, payload), items }
}

/**
 * 单条 statusbar item 窄化（parseStatusBarUpdate 的逐条 helper，CT-D5）。
 * 非 object、必填字段（id/pluginId/text）缺失或 priority 非 number → null（调用方跳过该条）；
 * alignment 缺省/非法回退 'left'，scope 非法置 undefined，tooltip/commandId/sessionId 可选透传。
 */
function parseStatusBarItem(raw: unknown): StatusBarEntry | null {
  const item = asRecord(raw)
  if (!item) return null
  const id = asString(item.id)
  const pluginId = asString(item.pluginId)
  const text = asString(item.text)
  const priority = typeof item.priority === 'number' ? item.priority : undefined
  if (id === null || pluginId === null || text === null || priority === undefined) return null
  const alignment = item.alignment === 'left' || item.alignment === 'right' ? item.alignment : 'left'
  return {
    id,
    pluginId,
    text,
    tooltip: asOptionalString(item.tooltip),
    alignment,
    priority,
    commandId: asOptionalString(item.commandId),
    scope: item.scope === 'per-session' || item.scope === 'global' ? item.scope : undefined,
    sessionId: asOptionalString(item.sessionId),
  }
}

function parseStatusSetUpdate(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const key = asString(payload.key)
  const text = asString(payload.text)
  if (key === null || text === null) return null
  return {
    kind: 'plugin-status-set-update',
    sessionId: resolveSessionId(msg, payload),
    status: [{ id: key, pluginId: '', text }],
  }
}

function parsePermissionRequest(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const pluginId = asString(payload.pluginId)
  if (pluginId === null) return null
  const permissions = asStringArray(payload.permissions)
  if (permissions === null) return null
  return {
    kind: 'plugin-permission-request',
    sessionId: resolveSessionId(msg, payload),
    request: { pluginId, permissions, requestId: `perm_${pluginId}` },
  }
}

function parseCrashed(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const pluginId = asString(payload.pluginId)
  const error = asOptionalString(payload.error)
  if (pluginId === null) return null
  return { kind: 'plugin-crashed', pluginId, error: error ?? '' }
}

function parseNotification(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const pluginId = asString(payload.pluginId)
  const message = asString(payload.message)
  if (pluginId === null || message === null) return null
  const notification: { pluginId: string; message: string; [key: string]: unknown } = {
    pluginId,
    message,
    ...(asOptionalString(payload.level) !== undefined ? { level: payload.level } : {}),
  }
  return { kind: 'plugin-notification', sessionId: resolveSessionId(msg, payload), notification }
}

function parseConfigChanged(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const pluginId = asString(payload.pluginId)
  if (pluginId === null) return null
  return { kind: 'plugin-config-changed', pluginId, config: payload.config }
}

function parseMessageDecoration(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const messageId = asString(payload.messageId)
  if (messageId === null) return null
  return {
    kind: 'plugin-message-decoration',
    sessionId: resolveSessionId(msg, payload),
    decoration: { messageId, decoration: payload.decoration },
  }
}

function parseStatusChange(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const pluginId = asString(payload.pluginId)
  if (pluginId === null) return null
  const newStatus = asOptionalString(payload.newStatus) ?? asOptionalString(payload.status)
  if (newStatus === undefined || !PLUGIN_STATUS_VALUES.has(newStatus)) return null
  return { kind: 'plugin-status-change', pluginId, status: newStatus as 'discovered' | 'loaded' | 'active' | 'inactive' | 'crashed' }
}

const DIALOG_KINDS = new Set(['select', 'confirm', 'input'])

function parseUiRequest(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const requestId = asString(payload.requestId)
  const pluginId = asOptionalString(payload.pluginId) ?? ''
  if (requestId === null) return null
  const method = asOptionalString(payload.method) ?? 'input'
  const kind = DIALOG_KINDS.has(method) ? (method as 'select' | 'confirm' | 'input') : 'input'
  // method 超界（如 editor）时 kind 兜底 'input'，原始 method 经索引签名保留（s4 适配层可恢复）。
  const request: { requestId: string; pluginId: string; kind: 'select' | 'confirm' | 'input'; title?: string; [key: string]: unknown } = {
    ...payload,
    requestId,
    pluginId,
    kind,
    title: asOptionalString(payload.title),
    method,
  }
  return { kind: 'ui-request', sessionId: resolveSessionId(msg, payload), request }
}

/**
 * plugin:viewUpdate 窄化守卫（s3 链路，MF-1 修复）。
 *
 * runtime plugin-rpc-setup.ts handleViewUpdate 广播 payload 形状：
 * { sessionId, viewId, pluginId, guiTree, updatedAt }（guiTree 为 GuiComponent[]）。
 * 与 extension:widget 同事件（extension-widget）：ViewHostStore 消费按 viewId 分区更新，
 * guiTree 结构化数组直存（窄化规则同 widgetGui——isGuiComponent 校验 + string 行包装）。
 */
function parseViewUpdate(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const viewId = asString(payload.viewId)
  const pluginId = asOptionalString(payload.pluginId) ?? ''
  const guiTree = Array.isArray(payload.guiTree) ? payload.guiTree : null
  if (viewId === null || guiTree === null) return null
  return {
    kind: 'extension-widget',
    sessionId: resolveSessionId(msg, payload),
    widget: { viewId, pluginId, guiTree },
  }
}

// ── 5 个 extension:* 窄化守卫（pluginId 一律 ''，wire 无该字段）──────

function parseExtensionWidget(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const widgetKey = asString(payload.widgetKey)
  if (widgetKey === null) return null
  if (msg.type === 'extension:widget') {
    const lines = asStringArray(payload.lines)
    if (lines === null) return null
    return {
      kind: 'extension-widget',
      sessionId: resolveSessionId(msg, payload),
      widget: { viewId: widgetKey, pluginId: '', guiTree: lines },
    }
  }
  // extension:widgetGui —— gui 为 null 时保留清除语义（[null] 进 guiTree，消费端据此删条目）。
  // meta（v1.1 wire 的 widget 宿主元数据）透传，ViewHostStore 窄化后供 WidgetArea head 渲染。
  if (!('gui' in payload)) return null
  return {
    kind: 'extension-widget',
    sessionId: resolveSessionId(msg, payload),
    widget: { viewId: widgetKey, pluginId: '', guiTree: [payload.gui], meta: payload.meta },
  }
}

function parseExtensionStatus(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const text = asString(payload.text)
  if (text === null) return null
  return {
    kind: 'extension-status',
    sessionId: resolveSessionId(msg, payload),
    status: { pluginId: '', status: text, detail: asOptionalString(payload.textRaw) },
  }
}

function parseExtensionNotify(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const message = asString(payload.message)
  if (message === null) return null
  const notification: { pluginId: string; message: string; [key: string]: unknown } = {
    pluginId: '',
    message,
    ...(asOptionalString(payload.level) !== undefined ? { level: payload.level } : {}),
  }
  return { kind: 'extension-notify', sessionId: resolveSessionId(msg, payload), notification }
}

function parseExtensionUiRequest(msg: IncomingPluginMessage): InternalEvent | null {
  const payload = asRecord(msg.payload)
  if (!payload) return null
  const requestId = asString(payload.requestId)
  if (requestId === null) return null
  const method = asOptionalString(payload.method) ?? 'input'
  const kind = DIALOG_KINDS.has(method) ? (method as 'select' | 'confirm' | 'input') : 'input'
  const request: { requestId: string; pluginId: string; kind: 'select' | 'confirm' | 'input'; title?: string; [key: string]: unknown } = {
    ...payload,
    requestId,
    pluginId: '',
    kind,
    title: asOptionalString(payload.title),
    method,
  }
  return { kind: 'ui-request', sessionId: resolveSessionId(msg, payload), request }
}

// ── MessageBusBridge ───────────────────────────────────────────────

const PLUGIN_HANDLERS: Record<string, (msg: IncomingPluginMessage) => InternalEvent | null> = {
  'plugin:statusBarUpdate': parseStatusBarUpdate,
  'plugin:statusSetUpdate': parseStatusSetUpdate,
  'plugin:permissionRequest': parsePermissionRequest,
  'plugin:crashed': parseCrashed,
  'plugin:notification': parseNotification,
  'plugin:config': parseConfigChanged,
  'plugin:messageDecoration': parseMessageDecoration,
  'plugin:statusChange': parseStatusChange,
  'plugin:uiRequest': parseUiRequest,
  'plugin:viewUpdate': parseViewUpdate,
}

const EXTENSION_HANDLERS: Record<string, (msg: IncomingPluginMessage) => InternalEvent | null> = {
  'extension:widget': parseExtensionWidget,
  'extension:widgetGui': parseExtensionWidget,
  'extension:status': parseExtensionStatus,
  'extension:notify': parseExtensionNotify,
  'extension.ui_request': parseExtensionUiRequest,
}

/**
 * extension:* 下行进 bridge 的精确白名单（renderer-deepening D10② SSOT）。
 * 从 EXTENSION_HANDLERS keys 派生——新增 handler 自动进白名单，壳的 source filter
 * import 同一份（此前壳持手抄数组靠注释对齐，双写必漂移）。plugin:* 前缀全放行、
 * 其余 extension:* 由 source filter 静默丢弃的职责边界不变（见壳 useExtensionHostBridge）。
 */
export const EXTENSION_BRIDGE_TYPES: readonly string[] = Object.keys(EXTENSION_HANDLERS)

export class MessageBusBridge {
  private readonly bus: InternalEventBus
  private unsubscribe: (() => void) | null = null

  constructor(deps: { source: PluginMessageSource; bus: InternalEventBus }) {
    this.bus = deps.bus
    this.unsubscribe = deps.source.subscribe((msg) => this.handleMessage(msg))
  }

  /** 归一分发一条下行消息。未知 type / payload 解析失败 → error 事件（ERR2，不静默吞）。 */
  private handleMessage(msg: IncomingPluginMessage): void {
    const handler = PLUGIN_HANDLERS[msg.type] ?? EXTENSION_HANDLERS[msg.type]
    if (!handler) {
      this.bus.emit({ kind: 'error', source: msg.type, message: `unknown message type: ${msg.type}` })
      return
    }
    const event = handler(msg)
    if (event === null) {
      this.bus.emit({ kind: 'error', source: msg.type, message: `${msg.type} payload parse failed: unparseable shape` })
      return
    }
    this.bus.emit(event)
  }

  /** 停止接收消息并解除订阅。幂等（重复调用安全）。 */
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
