/**
 * Workspace API 模块
 *
 * 提供工作区信息的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerWorkspaceRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.workspace.rootPath / name / findFiles 三个 RPC 方法。
 *
 * Worker 侧：createWorkspaceApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * rootPath/name 是 getter（作为 RPC 方法实现），findFiles 异步查找文件。
 * Phase 2 中 findFiles 使用 fast-glob 或内置递归扫描。
 * 由于 Worker Thread 中不可用 process.cwd() 获取主线程 cwd，
 * 必须通过 RPC 请求主线程获取工作区信息。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import { asBoundedString } from '../validation.js'

/** glob pattern 长度上限（UTF-8 字节）：防超长 pattern 打爆 fast-glob 匹配 */
const GLOB_PATTERN_MAX_BYTES = 1024

/** Workspace 服务依赖（主线程侧） */
export interface WorkspaceHandlers {
  getRootPath(): string
  getName(): string
  findFiles(pattern: string): Promise<string[]>
}

export function registerWorkspaceRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: WorkspaceHandlers,
): void {
  rpcServer.registerMethod('plugin.workspace.rootPath', async () => {
    return deps.getRootPath()
  })

  rpcServer.registerMethod('plugin.workspace.name', async () => {
    return deps.getName()
  })

  rpcServer.registerMethod('plugin.workspace.findFiles', async (params) => {
    // S3-W3 窄校验：pattern 进 fast-glob（非字符串/超长 → INVALID_PATTERN）
    const pattern = asBoundedString(params.pattern, 'pattern', GLOB_PATTERN_MAX_BYTES)
    return deps.findFiles(pattern)
  })
}

import type { PluginRpcClient } from '../plugin-rpc-client.js'

export function createWorkspaceApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  readonly rootPath: string
  readonly name: string
  findFiles(pattern: string): Promise<string[]>
} {
  // rootPath 和 name 被设计为 getter（在 JS 上下文中通过属性访问）
  // 由于是异步 RPC，getter 在首次访问时通过 RPC 获取并缓存
  let cachedRootPath: string | undefined
  let cachedName: string | undefined

  const obj = {
    get rootPath(): string {
      // 同步 getter，通过 RPC 请求（实际使用时应确保已初始化）
      // 空字符串表示未初始化
      return cachedRootPath ?? ''
    },
    get name(): string {
      return cachedName ?? ''
    },
    findFiles: (pattern: string) =>
      rpcClient.request('plugin.workspace.findFiles', { pluginId, pattern })
        .then(v => (v as string[]) ?? []),
  }

  // 初始化时通过 RPC 获取缓存值
  Promise.allSettled([
    rpcClient.request('plugin.workspace.rootPath', { pluginId })
      .then(v => { cachedRootPath = v as string }),
    rpcClient.request('plugin.workspace.name', { pluginId })
      .then(v => { cachedName = v as string }),
  ]).catch(() => {
    // 初始化失败保持空值
  })

  return obj
}
