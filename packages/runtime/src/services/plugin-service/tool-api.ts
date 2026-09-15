/**
 * Tool API 模块
 *
 * 提供 Tool 注册/注销的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerToolRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.tools.register / plugin.tools.unregister 两个 RPC 方法。
 *
 * Worker 侧：createToolApi() 返回代理对象，通过 RPC 转发到主线程。
 */

import type { PluginRpcServer } from './plugin-rpc-server.js'
import type { PluginRpcClient } from './plugin-rpc-client.js'
import type { ToolRegistration, ToolEntry } from './plugin-types.js'
import { PluginRpcErrorCodes } from './plugin-types.js'
import { asOptionalString, asRecord, asSafeKey, asString } from './validation.js'
import { errorWithCode } from '../../utils/errors.js'
/** Tool 注册服务依赖（主线程侧） */
export interface ToolService {
  /** 工具注册表，key 为 toolKey */
  toolRegistry: Map<string, ToolEntry>
  /** 工具变更后同步到 bridge 层 */
  syncToolsToBridge: () => Promise<void>
}

/**
 * 在 PluginRpcServer 上注册 tool 相关的 RPC handler。
 *
 * 注册的方法：
 * - `plugin.tools.register` — 注册工具，返回 toolKey
 * - `plugin.tools.unregister` — 注销工具，不存在的 key 静默成功（复合键归属隔离：
 *   只允许注销自身前缀 `${pluginId}:` 的 toolKey，D7 语义，见 handler 注释）
 */
export function registerToolRpcHandlers(
  rpcServer: PluginRpcServer,
  service: ToolService,
): void {
  rpcServer.registerMethod('plugin.tools.register', async (params) => {
    // S3-W3 窄校验：name 进复合键 toolKey `${pluginId}:${name}`，过 asSafeKey
    // 白名单从语法上排除 ':' 复合键注入与路径字符（与 commands.register 同语义）。
    const pluginId = asSafeKey(params.pluginId, 'pluginId')
    const name = asSafeKey(params.name, 'name')
    const description = asOptionalString(params.description, 'description') ?? ''
    const parameters = params.parameters === undefined
      ? {}
      : asRecord(params.parameters, 'parameters')

    // D1 声明通道窄校验（对齐 ui-api INVALID_* 风格）：timeoutMs 可选，present 即必须
    // 是 number 且非 NaN——脏值 fail-fast 拒注册（INVALID_TIMEOUT_MS）；0 / 负数 /
    // Infinity 是合法声明（显式 opt-out，运行时语义归 bridge-interop resolveToolTimeoutMs），
    // 原样透传存储。
    const timeoutMs = params.timeoutMs
    if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs))) {
      throw errorWithCode(
        `Invalid timeoutMs: expected a number (milliseconds; <=0 or Infinity = no limit) ` +
          `but received ${typeof timeoutMs === 'number' ? 'NaN' : typeof timeoutMs}.`,
        'INVALID_TIMEOUT_MS',
      )
    }

    const toolKey = `${pluginId}:${name}`

    // 验证 name 不重复
    if (service.toolRegistry.has(toolKey)) {
      throw Object.assign(
        new Error(`Tool already registered: ${toolKey}`),
        { code: PluginRpcErrorCodes.INTERNAL_ERROR },
      )
    }

    // 存储到注册表（timeoutMs 缺省不落键——合法值含 0/负数/Infinity 均透传）
    service.toolRegistry.set(toolKey, {
      pluginId,
      handlerId: toolKey,
      schema: {
        name,
        description,
        parameters,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
    })

    // 同步到 bridge
    await service.syncToolsToBridge()

    return toolKey
  })

  rpcServer.registerMethod('plugin.tools.unregister', async (params) => {
    // toolKey 是宿主返回的复合键 `${pluginId}:${name}`，合法含 ':'——过 asString
    // （白名单校验会误杀自身格式），只需防错类型
    const toolKey = asString(params.toolKey, 'toolKey')
    // D7 归属隔离（对齐 commands.unregister 复合键语义）：pluginId 必填，且只允许
    // 注销自身前缀 `${pluginId}:` 的 toolKey。sandbox 通道 params.pluginId 已被
    // dispatch 覆写为通道身份（不可伪造）——插件 B 传他人 toolKey（'A:xxx'）不属
    // 自身前缀 → no-op，A 的注册不受影响。
    const pluginId = asSafeKey(params.pluginId, 'pluginId')
    if (!toolKey.startsWith(`${pluginId}:`)) return
    if (service.toolRegistry.has(toolKey)) {
      service.toolRegistry.delete(toolKey)
      await service.syncToolsToBridge()
    }
  })
}

/**
 * 创建 Worker 侧 Tool API 代理对象。
 *
 * 代理对象通过 RPC 转发 tool 注册/注销请求到主线程。
 */
export function createToolApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  register(registration: ToolRegistration): Promise<string>
  unregister(toolKey: string): Promise<void>
} {
  return {
    /**
     * 注册工具，返回 toolKey。
     * toolKey 格式: `${pluginId}:${name}`
     */
    register: async (registration: ToolRegistration): Promise<string> => {
      const toolKey = `${pluginId}:${registration.name}`
      // 先通过 RPC 注册 schema 到主线程，成功后再存本地 handler
      const result = await rpcClient.request('plugin.tools.register', {
        pluginId,
        name: registration.name,
        description: registration.description,
        parameters: registration.parameters,
        // D1 声明通道：timeoutMs 随载荷透传主线程（缺省不发键）
        ...(registration.timeoutMs !== undefined ? { timeoutMs: registration.timeoutMs } : {}),
      }) as string
      // RPC 成功后才存本地 handler，避免 RPC 失败时 handler 残留
      if (registration.execute) {
        const { registerToolHandler: rth } = await import('./plugin-bootstrap.js')
        rth(toolKey, registration.execute)
      }
      return result
    },

    /**
     * 注销工具。不存在的 toolKey 静默成功。
     */
    unregister: async (toolKey: string): Promise<void> => {
      await rpcClient.request('plugin.tools.unregister', { pluginId, toolKey })
      // 清理本地 handler
      const { unregisterToolHandler } = await import('./plugin-bootstrap.js')
      unregisterToolHandler(toolKey)
    },
  }
}
