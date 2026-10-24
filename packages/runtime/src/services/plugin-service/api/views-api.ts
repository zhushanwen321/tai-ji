/**
 * Views API 模块
 *
 * 提供视图更新的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerViewRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.views.update / plugin.views.listMountPoints 两个 RPC 方法。
 *   update 校验归属二选一（provider-plugin-access U2 分区键泛化）后委托 handleViewUpdate
 *   回调（快照写入 + generation 分配 + 下行广播 plugin:viewUpdate），
 *   listMountPoints 读取挂载点集合副本（TC4：runtime 中继 renderer 上报的挂载点状态）。
 *
 * Worker 侧：createViewsApi() 返回代理对象，通过 RPC 转发到主线程。
 */

import type { GuiComponent } from '@zhushanwen/extension-protocol'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { PluginViewScope } from '@taiji/shared'
import { errorWithCode } from '../../../utils/errors.js'
import { asSafeKey, asString, asOptionalString } from '../validation.js'

/** Views 服务依赖（主线程侧） */
export interface ViewService {
  /** 挂载点集合（AC10：renderer 经 plugin.mountPoints.sync 上报的副本，listMountPoints 读取） */
  mountPoints: string[]
  /**
   * 视图更新处理（快照写入 + generation 分配 + 下行广播 plugin:viewUpdate）。
   * 归属为 scope 联合（provider-plugin-access U2）：会话域 { sessionId } 定向投递该
   * 会话；全局域 { mountId, pluginId } 走全局广播（Provider 页等无会话挂载位，插件
   * 维度已并入分区键）。旧「payload.sessionId 显式必填」契约已泛化（二选一，都缺或
   * 都给 → INVALID_VIEW_SCOPE）。
   */
  handleViewUpdate: (pluginId: string, viewId: string, guiTree: GuiComponent[], scope: PluginViewScope) => void
}

/**
 * views.update 的归属参数解析（U2 校验序）：sessionId / mountId 恰好其一。
 *
 * 错误码分层：都缺或都给 → INVALID_VIEW_SCOPE（归属形态错误）；present 但类型错 /
 * 非白名单字符 → INVALID_SESSION_ID / INVALID_MOUNT_ID（asSafeKey，值进分区键的
 * 路径安全校验，'provider.authorize' 形态的点号在白名单内）。globalPluginId = 全局
 * 域的插件维度（调用方已按「通道身份优先、载荷自报回落」解析，见 register 内注释）。
 */
export function resolveViewScope(params: Record<string, unknown>, globalPluginId: string): PluginViewScope {
  const sessionId = asOptionalString(params.sessionId, 'sessionId')
  const mountId = asOptionalString(params.mountId, 'mountId')
  if ((sessionId === undefined) === (mountId === undefined)) {
    throw errorWithCode(
      sessionId !== undefined
        ? 'Invalid view scope: sessionId and mountId are mutually exclusive — pass exactly one '
          + '(sessionId for a session-scoped view, mountId for a global mount point like "provider.authorize"). '
          + 'Remove the field you do not need and retry.'
        : 'Invalid view scope: exactly one of sessionId or mountId is required — pass sessionId '
          + '(session-scoped view) or mountId (global mount point like "provider.authorize"). '
          + 'Add the field matching where the view should render and retry.',
      'INVALID_VIEW_SCOPE',
    )
  }
  if (sessionId !== undefined) {
    return { kind: 'session', sessionId: asSafeKey(sessionId, 'sessionId') }
  }
  return { kind: 'global', mountId: asSafeKey(mountId!, 'mountId'), pluginId: globalPluginId }
}

/**
 * 在 PluginRpcServer 上注册视图相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.views.update` — 更新视图（校验归属二选一 + 委托 handleViewUpdate）
 * - `plugin.views.listMountPoints` — 查询挂载点集合（返回副本）
 */
export function registerViewRpcHandlers(
  rpcServer: PluginRpcServer,
  service: ViewService,
): void {
  rpcServer.registerMethod('plugin.views.update', async (params, dispatchCtx) => {
    // S3-W3 窄校验：viewId 进 ViewHostStore 分区键（白名单排除路径分隔符），
    // guiTree 必须是数组（条目结构由渲染端 ViewHostStore 二次窄化）。
    // 畸形即抛 INVALID_*，不触发广播。
    const viewId = asSafeKey(params.viewId, 'viewId')
    // pluginId 双源（U2 全局域键含插件维度）：全局域键用于多插件隔离（S25），插件维度
    // 取通道身份（sandbox fork 与 pluginId 一对一，宿主注册，不可伪造——消息体自报值
    // 任何安全判定不得引用，plugin-rpc-server.RpcIdentity 契约）；trusted 多插件共享
    // Worker 无唯一归属（identity.pluginId === undefined）→ 回落载荷自报（trusted 同
    // 进程对等体互不设防是既有设计语义）。会话域键不含插件维度，保持载荷自报（与
    // pluginId 进条目数据的既有行为一致）。
    const identityPluginId = dispatchCtx?.identity?.pluginId
    const globalPluginId = identityPluginId !== undefined
      ? identityPluginId
      : asString(params.pluginId, 'pluginId')
    const scope = resolveViewScope(params, globalPluginId)
    const guiTree = params.guiTree
    if (!Array.isArray(guiTree)) {
      throw errorWithCode(
        `Invalid guiTree: expected an array of GuiComponent but received (${typeof guiTree}).`,
        'INVALID_GUI_TREE',
      )
    }

    service.handleViewUpdate(globalPluginId, viewId, guiTree as GuiComponent[], scope)

    return { updated: true }
  })

  rpcServer.registerMethod('plugin.views.listMountPoints', async () => {
    // 返回浅拷贝（T2 tradeoff：RPC 序列化边界不暴露内部数组引用，隔离写侧）
    return [...service.mountPoints]
  })
}

/**
 * 创建 Worker 侧 Views API 代理对象。
 *
 * update(viewId, guiTree, opts)：经 RPC 把视图树推给主线程 → 校验归属二选一 +
 * 广播 plugin:viewUpdate。opts 归属二选一（U2）：{ sessionId } 会话域 / { mountId }
 * 全局域；都给或缺在 RPC 层拒绝（INVALID_VIEW_SCOPE）。
 * listMountPoints()：经 RPC 查询 runtime 中继的挂载点集合。
 */
export function createViewsApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  update(viewId: string, guiTree: GuiComponent[], opts: { sessionId: string } | { mountId: string }): Promise<void>
  listMountPoints(): Promise<string[]>
} {
  return {
    update: (viewId: string, guiTree: GuiComponent[], opts: { sessionId: string } | { mountId: string }) =>
      rpcClient
        .request('plugin.views.update', { pluginId, viewId, guiTree, ...opts })
        .then(() => {}),

    listMountPoints: () =>
      rpcClient.request('plugin.views.listMountPoints', { pluginId }) as Promise<string[]>,
  }
}
