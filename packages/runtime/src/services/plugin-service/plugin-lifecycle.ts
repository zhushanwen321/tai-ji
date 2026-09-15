/**
 * 插件服务启动生命周期编排（P4 收口）
 *
 * 从 PluginService.initialize() 抽取的 9 步顺序装配流程。此前 initialize() 是
 * 一个 god-orchestrator，混合了 descriptor 扫描、存储初始化、RPC 注册、权限加载、
 * 内存监控、事件派发、sessionData 恢复、hot-reload fan-out。
 *
 * 本模块只做**顺序编排**：把各已有内聚模块（registry / storage / rpcServer /
 * permissionChecker / activator / host / sessionDataStore）按正确顺序串起来。
 * 各步骤的业务逻辑仍由对应模块自己负责——本模块不含领域逻辑。
 *
 * 范围说明（PARTIAL）：Worker 回调（crash/rebuilt/reply）因紧耦合多个私有协作者
 * （activator.markCrashed、broker.broadcast、registry.getDescriptor、host.loadPlugin、
 * activator.activatePlugin），强行搬出会引入更宽更泄漏的注入缝，故仍留在
 * PluginService.registerWorkerCallbacks() 作为委托缝。本模块只搬顺序 init 步骤。
 *
 * 风格对齐：与 plugin-rpc-setup.ts 的 registerAllRpcMethods(ctx) 一致——
 * 传入显式 context 对象，无隐式 this。
 */

import type { PluginRegistry } from './plugin-registry.js'
import type { PluginStorage } from './plugin-storage.js'
import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginHost } from './plugin-host.js'
import type { PluginActivator } from './plugin-activator.js'
import type { SessionDataStore } from './session-data-store.js'
import type { PluginPermissionChecker } from './plugin-permission.js'

/** 启动流程需要的全部协作者（由 PluginService 装配后传入） */
export interface PluginLifecycleContext {
  registry: PluginRegistry
  storage: PluginStorage
  rpcServer: PluginRpcServer
  host: PluginHost
  activator: PluginActivator
  permissionChecker: PluginPermissionChecker
  sessionDataStore: SessionDataStore
  /** taiji 配置根（storage.init 需要） */
  configDir: string

  // ── 委托回 PluginService 的薄回调（避免本模块反向依赖 service）──────────
  /** 注册全部 RPC 方法（步骤 3） */
  registerRpcMethods: () => void
  /** 广播插件列表（步骤 7） */
  broadcastPluginList: () => void
  /** 为 external 已激活插件启动 hot-reload 监听（步骤 9） */
  watchExternalIfActive: (descriptor: import('./plugin-types.js').PluginDescriptor) => void
  /** 注册 onBeforeSendMessage hook（initialize 末尾） */
  registerSendMessageHook: () => void
}

/**
 * 执行插件服务启动的 9 步顺序装配。
 *
 * 步骤：
 *  1. 扫描插件 + 注册描述符
 *  2. 初始化存储
 *  3. 注册 RPC 方法
 *  3b. 加载权限
 *  3c. 设置 RPC 权限检查
 *  5. 启动内存监控
 *  6. 触发 onStartupFinished
 *  7. 广播插件列表
 *  8. 启动 sessionData flush 定时器
 *  8b. 从磁盘恢复 sessionData
 *  9. 为 external 已激活插件启动 hot-reload 监听
 *  末尾：注册 onBeforeSendMessage hook
 *
 * 注意：步骤 4/4a/4b（Worker crash/rebuilt/reply 回调注册）不在此处——
 * 见 PluginService.registerWorkerCallbacks()（委托缝）。
 */
export async function bootstrapPluginService(ctx: PluginLifecycleContext): Promise<void> {
  // 1. 扫描插件
  const descriptors = await ctx.registry.scan()
  ctx.activator.registerDescriptors(descriptors)

  // 2. 初始化存储
  ctx.storage.init(ctx.configDir, process.cwd())

  // 3. 注册 RPC 方法
  ctx.registerRpcMethods()

  // 3b. 加载权限
  await ctx.permissionChecker.load()

  // 3c. 设置 RPC 权限检查（签名收通道反查身份 RpcIdentity，dispatch 传入；
  // 消息体自报 pluginId 不进入 checker——见 plugin-rpc-server dispatch 的 D1 改造）
  ctx.rpcServer.setPermissionChecker((identity, method) => {
    return ctx.permissionChecker.check(identity, method)
  })

  // 6. 触发 onStartupFinished
  await ctx.activator.handleEvent(
    { type: 'onStartupFinished' },
    ctx.host,
  )

  // 7. 广播插件列表
  ctx.broadcastPluginList()

  // 8b. Restore sessionData from disk（WriteBackCache lazy load，扫描目录预热分区）
  ctx.sessionDataStore.restoreFromDisk()

  // 9. 为 external 已激活插件启动 hot-reload 监听
  for (const desc of ctx.registry.getAllDescriptors()) {
    ctx.watchExternalIfActive(desc)
  }

  // 注册 onBeforeSendMessage hook
  ctx.registerSendMessageHook()
}
