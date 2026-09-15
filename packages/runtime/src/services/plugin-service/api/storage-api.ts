/**
 * Storage API 模块
 *
 * 提供插件 KV 存储读写的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerStorageRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.storage.{global|workspace}.{get|set|delete|keys} 八个 RPC 方法。
 *
 * Worker 侧：createStorageApi() 返回 PluginStateStorage 代理对象，通过 RPC
 * 转发到主线程的 PluginStorage 执行。Worker 本身不直接读写文件系统。
 *
 * 此前这些 handler 内联在 plugin-rpc-setup.ts，Worker 侧代理内联在
 * plugin-bootstrap.ts（createStateStorageProxy）。P6 收口到本 api 文件，
 * 与其它 6 个域（session/config/session-data/ui/agent/workspace）保持一致。
 *
 * [SEC-A5 路径注入防御] pluginId 来自插件 Worker 的 RPC params（可伪造），
 * 且会 join 进持久化路径（plugins/<pluginId>/*.json），`../../` 可越出
 * 数据目录。入口层对 pluginId 过 asSafeKey 白名单，拒绝即抛
 * INVALID_PLUGIN_ID 结构化错误；PluginStorage.getFilePath 另有
 * path.resolve 深度防御兜底。scope 取自方法名枚举（主线程常量，非插件
 * 输入），仍过 asSafeKey 作零成本深度防御——未来若 scope 改由 params
 * 传入，校验已在位。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import type { PluginStorage } from '../plugin-storage.js'
import type { PluginStateStorage } from '../plugin-types.js'
import { asSafeKey } from '../validation.js'

const STORAGE_SCOPES = ['global', 'workspace'] as const
type StorageScope = (typeof STORAGE_SCOPES)[number]

/** Storage 服务依赖（主线程侧）——经 PluginStorage 的 scoped 方法操作 */
export interface StorageHandlers {
  get(pluginId: string, key: string, scope: StorageScope): unknown | undefined
  set(pluginId: string, key: string, value: unknown, scope: StorageScope): void
  delete(pluginId: string, key: string, scope: StorageScope): void
  keys(pluginId: string, scope: StorageScope): string[]
}

/**
 * 在 PluginRpcServer 上注册 storage 相关的 RPC handler（global + workspace 两 scope）。
 *
 * handler 保持 async 以守 RPC 调用约定（storage 已 sync）。
 */
export function registerStorageRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: StorageHandlers,
): void {
  for (const scope of STORAGE_SCOPES) {
    // scope 来自方法名枚举（主线程常量），不来自插件输入；asSafeKey 是零成本
    // 深度防御——未来若 scope 改由 params 传入，校验已在位。
    asSafeKey(scope, 'scope')
    rpcServer.registerMethod(`plugin.storage.${scope}.get`, async (params) => {
      return deps.get(asSafeKey(params.pluginId, 'pluginId'), asSafeKey(params.key, 'key'), scope)
    })
    rpcServer.registerMethod(`plugin.storage.${scope}.set`, async (params) => {
      deps.set(asSafeKey(params.pluginId, 'pluginId'), asSafeKey(params.key, 'key'), params.value, scope)
    })
    rpcServer.registerMethod(`plugin.storage.${scope}.delete`, async (params) => {
      deps.delete(asSafeKey(params.pluginId, 'pluginId'), asSafeKey(params.key, 'key'), scope)
    })
    rpcServer.registerMethod(`plugin.storage.${scope}.keys`, async (params) => {
      return deps.keys(asSafeKey(params.pluginId, 'pluginId'), scope)
    })
  }
}

/**
 * 由 PluginStorage 构造主线程侧 StorageHandlers（薄适配：PluginStorage.get/set/delete/keys
 * 已支持 scope 参数，默认 'global'）。
 */
export function storageHandlersFrom(storage: PluginStorage): StorageHandlers {
  return {
    get: (pluginId, key, scope) => storage.get(pluginId, key, scope),
    set: (pluginId, key, value, scope) => storage.set(pluginId, key, value, scope),
    delete: (pluginId, key, scope) => storage.delete(pluginId, key, scope),
    keys: (pluginId, scope) => storage.keys(pluginId, scope),
  }
}

/**
 * 创建 Worker 侧 PluginStateStorage 代理对象。
 *
 * 所有 storage 操作通过 RPC 转发到主线程的 PluginStorage 执行。
 * get 兼容 PluginStateStorage 的两个重载签名。
 */
export function createStorageApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
  scope: StorageScope,
): PluginStateStorage {
  return {
    get: <T,>(key: string, defaultValue?: T): Promise<T | undefined> =>
      rpcClient
        .request(`plugin.storage.${scope}.get`, { pluginId, key })
        .then(v => (v as T | undefined) ?? defaultValue),

    set: (key: string, value: unknown): Promise<void> =>
      rpcClient.request(`plugin.storage.${scope}.set`, { pluginId, key, value }).then(() => {}),

    delete: (key: string): Promise<void> =>
      rpcClient.request(`plugin.storage.${scope}.delete`, { pluginId, key }).then(() => {}),

    keys: (): Promise<string[]> =>
      rpcClient
        .request(`plugin.storage.${scope}.keys`, { pluginId })
        .then(v => (v as string[]) ?? []),
  }
}
