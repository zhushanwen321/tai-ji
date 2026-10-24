/**
 * Plugin 域 —— 订阅（onPlugins）+ 权限审批命令（approvePermissions/revokePermissions/denyPermissions）。
 *
 * approvePermissions/denyPermissions 是 permissionRequest 闭环的回传通道：
 * runtime 广播 plugin:permissionRequest → bridge → Dialog → 用户操作 → 本域命令
 * → runtime plugin-service.approvePermissions/denyPermissions → reply pong ack；
 * 插件列表刷新经 config.plugins 广播（approve 触发 activate 状态变化时由
 * plugin-service 广播，onPlugins 订阅消费）。
 * denyPermissions=拒绝本次申请（不回收已授权限）；revokePermissions=撤销全部已授权限
 * （基线协议范围保留，审批弹窗的拒绝按钮不走它）。命令名对齐 runtime
 * transport/plugin-message-handler.ts。
 *
 * 依赖方向：events（订阅）+ command（类型化请求/动作原语）。
 */
import type { PluginEventPayload, PluginInfo, PluginInvokeReply, PluginCatalogReply, PluginListAvailableReply, PluginPrepareInstallReply, PluginConfirmInstallReply, PluginUiSnapshotPayload } from '@taiji/shared'
import { RPC_BACKSTOP_TIMEOUT_MS } from '../pending'
import { command } from '../request'
import * as events from '../events'

export function onPlugins(handler: (plugins: PluginInfo[]) => void): () => void {
  return events.onGlobalType('config.plugins', (msg) => {
    handler(msg.payload.plugins)
  })
}

/**
 * 拉取插件 UI 快照（headerAction 运行时状态 + 视图树，ADR-0097「拉为主、推补充」）。
 *
 * plugin:headerActionUpdate / plugin:viewUpdate 是 transient 推送（不入 ring、无重放），
 * renderer 重载/重连后的丢失由本拉取收敛：无过滤参数 = 全部（connected 边沿全量恢复）；
 * 过滤 = 单分区（ViewHost 挂载发现分区缺失时自举补拉）。过滤参数为 scope 二选一
 * （provider-plugin-access U2 分区键泛化）：会话域 { sessionId }、全局域
 * { mountId, pluginId }（Provider 页挂载位，插件维度必带），viewId 可组合做单视图补拉。
 */
export function getPluginUiSnapshot(
  filter: { sessionId?: string; mountId?: string; pluginId?: string; viewId?: string } = {},
): Promise<PluginUiSnapshotPayload> {
  return command('plugin.ui.snapshot', filter, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 批准插件申请的权限（可部分选择）。reply pong ack；列表刷新经 config.plugins 广播。 */
export async function approvePermissions(pluginId: string, permissions: string[]): Promise<void> {
  // reply 为 pong ack（空 payload），await 只为等 RPC settle，无返回值可读
  await command('plugin.approvePermissions', { pluginId, permissions }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 撤销插件全部已授权限。reply pong ack；不改 PluginInfo 字段，无列表刷新广播。 */
export async function revokePermissions(pluginId: string): Promise<void> {
  await command('plugin.revokePermissions', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 拒绝插件本次权限申请（不回收已授权限）。reply pong ack；无列表刷新广播。 */
export async function denyPermissions(pluginId: string): Promise<void> {
  await command('plugin.denyPermissions', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}

// ── provider-plugin-access D9 / D8 / U5：invoke、uiEvent、plugin:event 订阅、清单域 ──

/**
 * 调用插件注册的业务方法（provider-plugin-access D9）：runtime 复用 commands-executor
 * 执行链（pending 登记 / 超时取值 / 同 handlerId 并发拒绝），路由键 = pluginId:method。
 * reply = PluginInvokeReply 信封，本函数解包返回 result（unknown 透传）；请求级失败
 * （插件不存在 / 方法未注册 / 超时）经统一 error envelope reject。
 */
export async function invokePlugin(pluginId: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const reply = await command('plugin.invoke', { pluginId, method, ...(params !== undefined ? { params } : {}) }, RPC_BACKSTOP_TIMEOUT_MS) as PluginInvokeReply
  return reply.result
}

/**
 * 发送输入组件值回传（provider-plugin-access D8）：text-input 值变更即发
 * （fire-and-forget，插件侧始终持有最新值）。reply pong ack，await 只为等 RPC settle；
 * 未送达（WS 未 OPEN）时 command 立即 reject（notDelivered，不留 65s 悬挂窗口）。
 */
export async function sendPluginUiEvent(payload: { pluginId: string; viewId: string; componentId: string; event: string; value: unknown }): Promise<void> {
  await command('plugin.uiEvent', payload, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 执行插件树内 action-bar 注册的命令（provider-plugin-access D7/S7）：action-bar 的
 * commandId 是插件 fork 内经 plugin.commands.register 注册的命令，不在宿主
 * CommandRegistry 表（那张表只收 pi 扩展 contribution），Provider 页容器直接经
 * 本方法把 (pluginId, commandId) 发往 runtime commands-executor 执行链。
 * reply pong ack，await 只为等 RPC settle。
 */
export async function executePluginCommand(payload: { pluginId: string; commandId: string; args?: Record<string, unknown> }): Promise<void> {
  await command('plugin.executeCommand', payload, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 订阅插件业务事件（provider-plugin-access D9）：插件经 runtime plugin.event RPC
 * 上报、宿主广播 'plugin:event' 帧（无 sessionId → global 通道）。首个消费方 =
 * 凭据状态上报（D5——拉取给已知事实，本订阅只作增量提示；推送丢失由下一次展开拉取
 * 收敛，不建推送补偿）。返回取消函数。
 */
export function onPluginEvent(handler: (payload: PluginEventPayload) => void): () => void {
  return events.onGlobalType('plugin:event', (msg) => {
    handler(msg.payload)
  })
}

/** 清单可安装视图（provider-plugin-access U5）：附本地安装状态比对（installed / installedVersion / updateAvailable）。 */
export function listAvailablePlugins(): Promise<PluginListAvailableReply> {
  return command('plugin.listAvailable', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 清单原始目录条目（provider-plugin-access U5：含家族元数据与安装知情面声明）。 */
export function getPluginCatalog(): Promise<PluginCatalogReply> {
  return command('plugin.catalog', {}, RPC_BACKSTOP_TIMEOUT_MS)
}

// ── 两段式安装（provider-plugin-access U4/U6：确认停点对接 Provider 页安装确认卡，S27）──

/**
 * 两段式安装第一段：下载校验解压至暂存并返回确认卡知情面（停在确认停点——未确认
 * 不发生安装落盘）。失败（下载/校验/NAMESPACE_MISMATCH）经统一 error envelope reject，
 * 消费方（PluginProviderFlow）按 message/code 分流提示。
 */
export function preparePluginInstall(packageSpec: string): Promise<PluginPrepareInstallReply> {
  return command('plugin.prepareInstall', { packageSpec }, RPC_BACKSTOP_TIMEOUT_MS)
}

/**
 * 两段式安装第二段（确认停点之后）：暂存换入 → 扫描 → 激活 → 安装登记；激活失败
 * 自动回滚（S18）。域内失败经 error 字段返回（success=false），请求级失败 reject。
 */
export function confirmPluginInstall(pluginId: string): Promise<PluginConfirmInstallReply> {
  return command('plugin.confirmInstall', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}

/** 两段式安装取消：清暂存与 pending 登记（未确认不发生安装落盘）。reply pong ack。 */
export async function cancelPluginInstall(pluginId: string): Promise<void> {
  await command('plugin.cancelInstall', { pluginId }, RPC_BACKSTOP_TIMEOUT_MS)
}
