/**
 * Plugin message handler for plugin.* message types.
 * Extracted from RuntimeServer to reduce file size.
 */
import type { WebSocket as WsType } from 'ws'
import type { ClientMessage, ClientMessageType } from '@taiji/shared'
import type { IPluginService } from '../interfaces.js'
import type { MessageHandlerContext } from './message-context.js'

export interface PluginHandlerContext extends MessageHandlerContext {
  pluginService: IPluginService | null
}

export class PluginMessageHandler {
  constructor(private ctx: PluginHandlerContext) {}

  /** D1: 本 handler 认领的 ClientMessageType 清单。 */
  readonly handles: ClientMessageType[] = [
    'plugin.list', 'plugin.toggle', 'plugin.uninstall', 'plugin.approvePermissions', 'plugin.revokePermissions',
    'plugin.denyPermissions',
    'plugin.executeCommand', 'plugin.config.get', 'plugin.config.set', 'plugin.install', 'plugin.uiResponse',
    'plugin.mountPoints.sync', 'plugin.ui.snapshot',
    // provider-plugin-access D9/D8/U5：plugin.invoke 业务方法调用、plugin.uiEvent 输入
    // 值回传、清单域两个无参只读 RPC。
    'plugin.invoke', 'plugin.uiEvent', 'plugin.listAvailable', 'plugin.catalog',
  ]

  async handlePluginMessage(msg: ClientMessage, ws: WsType): Promise<void> {
    // D3: service-not-available 前置检查（与 extension 的 requireExt 同形）。
    if (!this.ctx.pluginService) {
      return this.ctx.sendError(ws, 'handler_error', 'Plugin service not available', msg.id)
    }
    // 表驱动分发：查表命中即分发；未命中落空（与原 switch 无 default 逐字节一致——隐式
    // resolve undefined）。msg.type 即查表 key（运行时 guard），payload 收窄由各 case 函数
    // 依据同一 key 断言（Extract 与 switch narrowing 同构，ClientMessageMap 为协议 SSOT）。
    // cast 仅放宽索引键域（Partial 化），不改变任何 handler 的签名与运行时行为。
    const handler = (PLUGIN_CASE_HANDLERS as Partial<Record<ClientMessageType, PluginCaseHandler>>)[msg.type]
    // RT-1#6：落空不再静默 return——handles 清单与分发表漂移（漏登记）时，前端 pending
    // Promise 只能等到泛化超时。显式 error 信封 + error 日志双显形。
    if (!handler) {
      console.error(`[plugin-handler] no case handler for type "${msg.type}" — handles/dispatch 表漂移？`)
      return this.ctx.sendError(
        ws,
        'handler_not_registered',
        `No case handler registered for message type: ${msg.type}`,
        msg.id,
      )
    }
    return handler(this.ctx, msg, ws, this.ctx.pluginService)
  }
}

/** 本 handler 认领的 plugin.* type 全集（与 handles 清单一一对应，TS 层收窄用）。 */
type PluginHandledType =
  | 'plugin.list' | 'plugin.toggle' | 'plugin.uninstall' | 'plugin.approvePermissions' | 'plugin.revokePermissions'
  | 'plugin.denyPermissions'
  | 'plugin.executeCommand' | 'plugin.config.get' | 'plugin.config.set' | 'plugin.install' | 'plugin.uiResponse'
  | 'plugin.mountPoints.sync' | 'plugin.ui.snapshot'
  | 'plugin.invoke' | 'plugin.uiEvent' | 'plugin.listAvailable' | 'plugin.catalog'

/** 按 type 字面量收窄 ClientMessage（查表 key = 运行时 guard，与原 switch narrowing 同构）。 */
type PluginMsgOf<K extends ClientMessageType> = Extract<ClientMessage, { type: K }>

/** 表驱动 case handler 统一签名。pluginService 由主函数前置检查后显式传递（收窄丢失补偿）。 */
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
  // reply = pong ack（对齐 plugin.executeCommand 先例）；approve 触发 activate 状态变化时
  // 由 plugin-service.approvePermissions 广播 config.plugins 刷新列表。
  await pluginService.approvePermissions(msg.payload.pluginId, msg.payload.permissions)
  return ctx.reply(ws, msg.id, 'pong', {})
}

async function handlePluginRevokePermissions(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.revokePermissions'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  // reply = pong ack；revoke 不改 PluginInfo 任何字段，无列表刷新广播。
  await pluginService.revokePermissions(msg.payload.pluginId)
  return ctx.reply(ws, msg.id, 'pong', {})
}

async function handlePluginDenyPermissions(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.denyPermissions'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  // reply = pong ack；deny 不改 PluginInfo 任何字段，无列表刷新广播。
  await pluginService.denyPermissions(msg.payload.pluginId)
  return ctx.reply(ws, msg.id, 'pong', {})
}

/**
 * E6（AP-3/D2）args 标量检查：GUI 点击来源把 args 变成用户可点输入，非标量值
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

async function handlePluginUiSnapshot(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.ui.snapshot'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  // renderer 拉取插件 UI 快照（ADR-0097 拉为主，C-comm-08）：transient 推送
  //（plugin:headerActionUpdate / plugin:viewUpdate）丢失后的收敛通道。
  // sessionId/viewId 过滤 = 单分区补拉（ViewHost 挂载缺失自举），缺省全量。
  return ctx.reply(ws, msg.id, 'plugin:uiSnapshot', pluginService.getUiSnapshot(msg.payload))
}

/**
 * plugin.invoke（provider-plugin-access D9）：renderer → 插件业务方法调用。
 * 执行链复用 commands-executor（invokeMethod，P-invoke）；reply 与请求同名——
 * PluginInvokeReply 信封 { result }（返回值 unknown 透传），请求级失败（插件不存在 /
 * 方法未注册 / 超时 / handler 抛错）走统一 error envelope，不占用信封。
 */
async function handlePluginInvoke(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.invoke'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  if (typeof msg.payload.method !== 'string' || msg.payload.method === '') {
    return ctx.sendError(ws, 'INVALID_ARGS', 'Invalid params: "method" must be a non-empty string.', msg.id)
  }
  const result = await pluginService.invokePlugin(msg.payload.pluginId, msg.payload.method, msg.payload.params)
  return ctx.reply(ws, msg.id, 'plugin.invoke', { result })
}

/**
 * plugin.uiEvent 的 value 形状上限（D8 契约）：标量，深度 ≤ 2。
 * 标量 = string | number | boolean | null；数组 / 普通对象最多嵌套两层，叶子必须是
 * 标量。数字 2 来自协议注释（protocol.ts ClientMessageMap['plugin.uiEvent']）。
 */
const UI_EVENT_VALUE_MAX_CONTAINER_DEPTH = 2

/**
 * uiEvent value 形状校验（D8「宿主只做形状校验，业务校验归插件」）：
 * 深度从容器层数计——root 容器 depth=2，子容器 depth=1，孙容器 depth=0 被拒。
 * 与 executeCommand 的 args 标量检查同纪律：不让结构化数据走无界旁路进插件。
 */
function isShallowUiEventValue(value: unknown, depth: number = UI_EVENT_VALUE_MAX_CONTAINER_DEPTH): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (depth === 0) return false
  if (Array.isArray(value)) return value.every((item) => isShallowUiEventValue(item, depth - 1))
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((item) => isShallowUiEventValue(item, depth - 1))
  }
  return false
}

/**
 * plugin.uiEvent（provider-plugin-access D8）：text-input 等输入组件的值回传。
 * fire-and-forget：投递给渲染该树的插件 Worker（PLUGIN_UI_EVENT_NOTIFY 单向通知，
 * 插件侧始终持有最新值），reply pong ack。宿主不解释 event 的业务含义、不做业务
 * 校验，但入口做窄形状校验：路由字段非空字符串、value 标量且容器深度 ≤ 2（D8
 * 契约）——坏值不投递，回结构化错误给渲染端（插件看不到非法形状）。
 */
async function handlePluginUiEvent(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.uiEvent'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  const { pluginId, viewId, componentId, event, value } = msg.payload
  const routingFieldsValid =
    typeof pluginId === 'string' && pluginId !== '' &&
    typeof viewId === 'string' && viewId !== '' &&
    typeof componentId === 'string' && componentId !== '' &&
    typeof event === 'string' && event !== ''
  if (!routingFieldsValid) {
    return ctx.sendError(ws, 'INVALID_ARGS', 'Invalid params: "pluginId", "viewId", "componentId" and "event" must be non-empty strings.', msg.id)
  }
  if (!isShallowUiEventValue(value)) {
    return ctx.sendError(
      ws,
      'INVALID_ARGS',
      'Invalid uiEvent value: expected a scalar (string | number | boolean | null), or an array/object nested at most 2 levels with scalar leaves. Business validation belongs to the plugin.',
      msg.id,
    )
  }
  await pluginService.deliverPluginUiEvent(pluginId, viewId, componentId, event, value)
  return ctx.reply(ws, msg.id, 'pong', {})
}

/** plugin.listAvailable（U5）：清单 service 组装的可安装视图（附本地安装状态比对）。 */
async function handlePluginListAvailable(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.listAvailable'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  return ctx.reply(ws, msg.id, 'plugin.listAvailable', await pluginService.listAvailablePlugins())
}

/** plugin.catalog（U5）：清单原始目录条目（含家族元数据）。 */
async function handlePluginCatalog(ctx: PluginHandlerContext, msg: PluginMsgOf<'plugin.catalog'>, ws: WsType, pluginService: IPluginService): Promise<void> {
  return ctx.reply(ws, msg.id, 'plugin.catalog', await pluginService.getPluginCatalog())
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
  'plugin.denyPermissions': handlePluginDenyPermissions,
  'plugin.executeCommand': handlePluginExecuteCommand,
  'plugin.config.get': handlePluginConfigGet,
  'plugin.config.set': handlePluginConfigSet,
  'plugin.install': handlePluginInstall,
  'plugin.uiResponse': handlePluginUiResponse,
  'plugin.mountPoints.sync': handlePluginMountPointsSync,
  'plugin.ui.snapshot': handlePluginUiSnapshot,
  'plugin.invoke': handlePluginInvoke,
  'plugin.uiEvent': handlePluginUiEvent,
  'plugin.listAvailable': handlePluginListAvailable,
  'plugin.catalog': handlePluginCatalog,
}
