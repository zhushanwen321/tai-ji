/**
 * Plugin message handler for plugin.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { IPluginService } from '../interfaces.js'
import type { MessageHandlerContext } from './message-context.js'
import { dismissRuntimeModalFromHost, isPluginModalClosedReason } from '../services/plugin-service/api/ui-api.js'

export interface PluginHandlerContext extends MessageHandlerContext {
  pluginService: IPluginService | null
}

export class PluginMessageHandler {
  constructor(private ctx: PluginHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'plugin.list', 'plugin.toggle', 'plugin.uninstall', 'plugin.approvePermissions', 'plugin.revokePermissions',
    'plugin.executeCommand', 'plugin.config.get', 'plugin.config.set', 'plugin.install', 'plugin.uiResponse',
    'plugin.mountPoints.sync', 'plugin.dismissModal',
  ]

  async handlePluginMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    // D3: service-not-available 前置守卫（与 extension 的 requireExt 同形）。
    if (!this.ctx.pluginService) {
      return this.ctx.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
    }
    // 表驱动分发：查表命中即分发；未命中落空（与原 switch 无 default 逐字节一致——隐式
    // resolve undefined）。msg.type 即查表 key（运行时 guard），payload 收窄由各 case 函数
    // 依据同一 key 断言（Extract 与 switch narrowing 同构，ClientMessageMap 为协议 SSOT）。
    // cast 仅放宽索引键域（Partial 化），不改变任何 handler 的签名与运行时行为。
    const handler = (PLUGIN_CASE_HANDLERS as Partial<Record<ClientMessageType, PluginCaseHandler>>)[msg.type]
    if (!handler) return
    return handler(this.ctx, msg, ws, this.ctx.pluginService)
  }
}

/** 本 handler 认领的 plugin.* type 全集（与 handles 清单一一对应，TS 层收窄用）。 */
type PluginHandledType =
  | 'plugin.list' | 'plugin.toggle' | 'plugin.uninstall' | 'plugin.approvePermissions' | 'plugin.revokePermissions'
  | 'plugin.executeCommand' | 'plugin.config.get' | 'plugin.config.set' | 'plugin.install' | 'plugin.uiResponse'
  | 'plugin.mountPoints.sync' | 'plugin.dismissModal'

/** 按 type 字面量收窄 ClientMessage（查表 key = 运行时 guard，与原 switch narrowing 同构）。 */
type PluginMsgOf<K extends ClientMessageType> = Extract<ClientMessage, { type: K }>

/** 表驱动 case handler 统一签名。pluginService 由主函数前置守卫后显式传递（收窄丢失补偿）。 */
type PluginCaseHandler = (
  ctx: PluginHandlerContext,
  msg: ClientMessage,
  ws: WsType,
  pluginService: IPluginService,
) => Promise<void>

async function handlePluginList(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.list'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const plugins = pluginService.getDiscoveredPlugins()
  return ctx.reply(ws, msg.id, 'config.plugins', { plugins })
}

async function handlePluginToggle(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.toggle'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const toggledPlugins = await pluginService.togglePlugin(msg.payload.pluginId, msg.payload.enabled)
  return ctx.reply(ws, msg.id, 'config.plugins', { plugins: toggledPlugins })
}

async function handlePluginUninstall(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.uninstall'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const uninstalledPlugins = await pluginService.uninstallPlugin(msg.payload.pluginId)
  return ctx.reply(ws, msg.id, 'config.plugins', { plugins: uninstalledPlugins })
}

async function handlePluginApprovePermissions(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.approvePermissions'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  await pluginService.approvePermissions(msg.payload.pluginId, msg.payload.permissions)
  return ctx.reply(ws, msg.id, 'config.plugins', { plugins: pluginService.getDiscoveredPlugins() })
}

async function handlePluginRevokePermissions(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.revokePermissions'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  await pluginService.revokePermissions(msg.payload.pluginId)
  return ctx.reply(ws, msg.id, 'config.plugins', { plugins: pluginService.getDiscoveredPlugins() })
}

/**
 * E6（AP-3/D2）args 标量守卫：GUI 点击来源把 args 变成用户可点输入，非标量值
 * （嵌套对象/数组）等于给插件间传结构化 payload 开无 schema 旁路——runtime 主线程
 * 入口拒绝、不 dispatch handler。未知键无从校验（args 无 schema），只校验值域。
 */
function isScalarArgs(args: unknown): args is Record<string, string | number | boolean> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return false
  return Object.values(args).every(v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
}

async function handlePluginExecuteCommand(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.executeCommand'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const args = msg.payload.args
  if (args !== undefined && !isScalarArgs(args)) {
    return ctx.sendError(ws, 'INVALID_ARGS', 'Invalid args: expected a flat record of scalar values (string | number | boolean). Action-bar/headerAction clicks must not carry nested objects or arrays.', msg.id)
  }
  await pluginService.executeCommand(msg.payload.pluginId, msg.payload.commandId, args)
  return ctx.reply(ws, msg.id, 'pong', {})
}

async function handlePluginConfigGet(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.config.get'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const configValue = await pluginService.getPluginConfig(msg.payload.pluginId, msg.payload.key)
  const configKey = msg.payload.key ?? '__all__'
  return ctx.reply(ws, msg.id, 'plugin:config', { pluginId: msg.payload.pluginId, config: configKey === '__all__' ? (configValue as Record<string, unknown>) : { [configKey]: configValue } })
}

async function handlePluginConfigSet(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.config.set'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  await pluginService.setPluginConfig(msg.payload.pluginId, msg.payload.key, msg.payload.value)
  const allConfig = await pluginService.getPluginConfig(msg.payload.pluginId)
  return ctx.reply(ws, msg.id, 'plugin:config', { pluginId: msg.payload.pluginId, config: allConfig as Record<string, unknown> })
}

async function handlePluginInstall(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.install'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const { packageSpec: packageSpecifier } = msg.payload as { packageSpec: string }
  if (!packageSpecifier) {
    return ctx.sendError(ws, 'invalid_params', 'Missing packageSpec', msg.id)
  }
  const result = await pluginService.installPlugin(packageSpecifier)
  if (result.success) {
    const plugins = pluginService.getDiscoveredPlugins()
    ctx.reply(ws, msg.id, 'config.plugins', { plugins })
  } else {
    ctx.sendError(ws, 'install_failed', result.error ?? 'Install failed', msg.id)
  }
  // 原 case 以 break 结束（函数末尾隐式返回 undefined）——落空语义逐字节保持。
}

async function handlePluginUiResponse(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.uiResponse'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  // handleUiResponse 已在 IPluginService 接口声明（interfaces.ts）；顶部 guard 保证非空
  // （提取后经 pluginService 参数显式传递，原 `?.` 的 null 短路不可达，等价改写为直接调用；
  // 原 payload 双重 as 断言由 PluginMsgOf 收窄等价替代——ClientMessageMap SSOT 同形状）。
  pluginService.handleUiResponse(msg.payload.requestId, msg.payload.result)
  return ctx.reply(ws, msg.id, 'pong', {})
}

async function handlePluginMountPointsSync(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.mountPoints.sync'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  // renderer→runtime 挂载点整表上报（DM3：覆盖式写入，不合并）。
  // renderer 壳层（s2/s5）在 MountPointRegistry 注册/注销后调用；
  // runtime 存副本供 plugin.views.listMountPoints 中继查询（AC10）。
  pluginService.syncMountPoints(msg.payload.mountPoints)
  return ctx.reply(ws, msg.id, 'pong', {})
}

/**
 * plugin.dismissModal（plugin-header-action-modal-points AP-2 关①，u5b 三处登记）：
 * 宿主 UI（Esc/关闭键、切会话、打开 Settings/Search）发起的关闭上报。
 * 处理 = 校验 (pluginId, modalId, epoch) 三元组与当前槽匹配（陈旧 epoch——关闭在途时
 * 的重开——或不匹配 → 忽略 + 日志，防陈旧 dismiss 关掉刚重开的层）→ 广播
 * plugin:modalState{closed, reason} + notify 插件 plugin.ui.modalClosed{modalId, reason}
 * （reason 词表单点：dismissed | session-switched | host-overlay | replaced | plugin-gone）。
 * 广播/notify 出线由 ui-api 的 wireRuntimeModalExits 装配（registerAllRpcMethods 注入）。
 */
async function handlePluginDismissModal(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.dismissModal'>, ws: WsType, _pluginService: IPluginService): Promise<void> {
  const { pluginId, modalId, epoch, reason } = msg.payload
  // 畸形帧（首方 renderer 之外的来源 / 字段漂移）→ error envelope 显式拒绝；
  // 形状合法但槽不匹配/epoch 陈旧 → 忽略 + 日志（幂等，closed 对已关层 no-op）。
  if (typeof pluginId !== 'string' || pluginId.length === 0
    || typeof modalId !== 'string' || modalId.length === 0
    || typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
    return ctx.sendError(ws, 'invalid_params', 'Invalid plugin.dismissModal payload: pluginId/modalId must be non-empty strings and epoch a positive safe integer.', msg.id)
  }
  if (!isPluginModalClosedReason(reason)) {
    return ctx.sendError(ws, 'invalid_params', `Invalid plugin.dismissModal reason: expected one of dismissed | session-switched | host-overlay | replaced | plugin-gone but received ${JSON.stringify(reason)}.`, msg.id)
  }
  const matched = dismissRuntimeModalFromHost({ pluginId, modalId, epoch, reason })
  if (!matched) {
    console.warn(`[plugin-message-handler] dismissModal ignored: no matching open slot (plugin=${pluginId}, modal=${modalId}, epoch=${epoch}) — stale dismiss or already closed`)
  }
  return ctx.reply(ws, msg.id, 'pong', {})
}

/**
 * plugin.* 分发表（形态 2 表驱动分发）：key = ClientMessageType 字面量，值 = 该 case 的
 * 处理函数（msg 参数按该 key 收窄）。主函数只留查表 + 落空（未命中行为与原 switch 无
 * default 一致）。
 */
const PLUGIN_CASE_HANDLERS: { readonly [K in PluginHandledType]: (
  ctx: PluginHandlerContext,
  msg: PluginMsgOf<K>,
  ws: WsType,
  pluginService: IPluginService,
) => Promise<void> } = {
  'plugin.list': handlePluginList,
  'plugin.toggle': handlePluginToggle,
  'plugin.uninstall': handlePluginUninstall,
  'plugin.approvePermissions': handlePluginApprovePermissions,
  'plugin.revokePermissions': handlePluginRevokePermissions,
  'plugin.executeCommand': handlePluginExecuteCommand,
  'plugin.config.get': handlePluginConfigGet,
  'plugin.config.set': handlePluginConfigSet,
  'plugin.install': handlePluginInstall,
  'plugin.uiResponse': handlePluginUiResponse,
  'plugin.mountPoints.sync': handlePluginMountPointsSync,
  'plugin.dismissModal': handlePluginDismissModal,
}
