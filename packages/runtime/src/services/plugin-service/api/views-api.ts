/**
 * Views API 模块
 *
 * 提供视图更新的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerViewRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.views.update / plugin.views.listMountPoints 两个 RPC 方法。
 *   update 委托 handleViewUpdate 回调（校验 + 下行广播 plugin:viewUpdate），
 *   listMountPoints 读取挂载点集合副本（TC4：runtime 中继 renderer 上报的挂载点状态）。
 *
 * Worker 侧：createViewsApi() 返回代理对象，通过 RPC 转发到主线程。
 */

import type { GuiComponent } from '@taiji/extension-protocol'
import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import { errorWithCode } from '../../../utils/errors.js'
import { asSafeKey, asString } from '../validation.js'

/** Views 服务依赖（主线程侧） */
export interface ViewService {
  /** 挂载点集合（AC10：renderer 经 plugin.mountPoints.sync 上报的副本，listMountPoints 读取） */
  mountPoints: string[]
  /**
   * 视图更新处理（校验 + 下行广播 plugin:viewUpdate）。
   * ES2：无活跃 session 时由实现方丢弃广播 + warning；未知 viewId 仍广播（渲染端按需激活兜底）。
   */
  handleViewUpdate: (pluginId: string, viewId: string, guiTree: GuiComponent[]) => void
}

/**
 * 在 PluginRpcServer 上注册视图相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.views.update` — 更新视图（委托 handleViewUpdate 校验 + 广播）
 * - `plugin.views.listMountPoints` — 查询挂载点集合（返回副本）
 */
export function registerViewRpcHandlers(
  rpcServer: PluginRpcServer,
  service: ViewService,
): void {
  rpcServer.registerMethod('plugin.views.update', async (params) => {
    // S3-W3 窄校验：viewId 进 ViewHostStore 分区键（白名单排除路径分隔符），
    // guiTree 必须是数组（条目结构由渲染端 ViewHostStore 二次窄化）。
    // 畸形即抛 INVALID_*，不触发广播。
    const pluginId = asString(params.pluginId, 'pluginId')
    const viewId = asSafeKey(params.viewId, 'viewId')
    const guiTree = params.guiTree
    if (!Array.isArray(guiTree)) {
      throw errorWithCode(
        `Invalid guiTree: expected an array of GuiComponent but received (${typeof guiTree}).`,
        'INVALID_GUI_TREE',
      )
    }

    service.handleViewUpdate(pluginId, viewId, guiTree as GuiComponent[])

    return { updated: true }
  })

  rpcServer.registerMethod('plugin.views.listMountPoints', async () => {
    // 返回浅拷贝（T2 tradeoff：RPC 序列化边界不暴露内部数组引用，隔离写面）
    return [...service.mountPoints]
  })
}

/**
 * 创建 Worker 侧 Views API 代理对象。
 *
 * update(viewId, guiTree)：经 RPC 把视图树推给主线程 → 校验 + 广播 plugin:viewUpdate。
 * listMountPoints()：经 RPC 查询 runtime 中继的挂载点集合。
 */
export function createViewsApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  update(viewId: string, guiTree: GuiComponent[]): Promise<void>
  listMountPoints(): Promise<string[]>
} {
  return {
    update: (viewId: string, guiTree: GuiComponent[]) =>
      rpcClient
        .request('plugin.views.update', { pluginId, viewId, guiTree })
        .then(() => {}),

    listMountPoints: () =>
      rpcClient.request('plugin.views.listMountPoints', { pluginId }) as Promise<string[]>,
  }
}
