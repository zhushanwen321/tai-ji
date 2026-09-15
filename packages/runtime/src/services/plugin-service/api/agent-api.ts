/**
 * Agent API 模块
 *
 * 提供 Agent 模型/思考级别查询的 RPC handler（主线程侧）和 Worker 侧代理对象。
 *
 * 主线程侧：registerAgentRpcHandlers() 在 PluginRpcServer 上注册
 *   plugin.agent.setModel / getModel / getThinkingLevel / setThinkingLevel / getActiveTools
 *   五个 RPC 方法。
 *
 * Worker 侧：createAgentApi() 返回代理对象，通过 RPC 转发到主线程。
 *
 * setModel / setThinkingLevel 为 trusted 插件专属。sandbox 插件调用时
 * 返回 PERMISSION_DENIED（权限检查由 PluginService dispatch 层完成）。
 *
 * setModel 经 modelService.switchModel 统一入口（persist + broadcast），
 * getModel / getThinkingLevel 读取 active session 的 modelId / thinkingLevel。
 */

import type { PluginRpcServer } from '../plugin-rpc-server.js'
import type { PluginRpcClient } from '../plugin-rpc-client.js'
import { asBoundedString } from '../validation.js'

/**
 * model / thinkingLevel 标识符长度上限（UTF-8 字节）。
 * provider/modelId 复合串与枚举值均远小于此；上限防超长串进入
 * sessionService.switchModel 的 split/join 与缓存键。
 */
const AGENT_ID_MAX_BYTES = 512

/**
 * Agent 服务依赖（主线程侧）。
 *
 * setModel / setThinkingLevel 返回生效值（U6 回执普查，D3④——改状态 RPC 一律回
 * pi 实际生效值，plugin 侧同口径）：setModel 返回 get_state 读回的 'provider/modelId'
 * 复合串；setThinkingLevel 返回钳制后的生效档。无活跃 session / 无 sessionService 的
 * 降级路径返回空串。
 */
export interface AgentHandlers {
  getModel(): string | Promise<string>
  setModel(model: string): string | Promise<string>
  getThinkingLevel(): string | Promise<string>
  setThinkingLevel(level: string): string | Promise<string>
  getActiveTools(): string[] | Promise<string[]>
}

export function registerAgentRpcHandlers(
  rpcServer: PluginRpcServer,
  deps: AgentHandlers,
): void {
  rpcServer.registerMethod('plugin.agent.setModel', async (params) => {
    // S3-W3 窄校验：model 非字符串/超长 → INVALID_MODEL，不进 switchModel
    const model = asBoundedString(params.model, 'model', AGENT_ID_MAX_BYTES)
    return deps.setModel(model)
  })

  rpcServer.registerMethod('plugin.agent.getModel', async () => {
    return deps.getModel()
  })

  rpcServer.registerMethod('plugin.agent.getThinkingLevel', async () => {
    return deps.getThinkingLevel()
  })

  rpcServer.registerMethod('plugin.agent.setThinkingLevel', async (params) => {
    const level = asBoundedString(params.level, 'level', AGENT_ID_MAX_BYTES)
    return deps.setThinkingLevel(level)
  })

  rpcServer.registerMethod('plugin.agent.getActiveTools', async () => {
    return deps.getActiveTools()
  })
}

export function createAgentApi(
  rpcClient: PluginRpcClient,
  pluginId: string,
): {
  /** 切换后 resolve 生效模型复合串（U6 回执：pi pattern 换模时 ≠ 请求值；降级路径空串） */
  setModel(model: string): Promise<string>
  getModel(): Promise<string>
  getThinkingLevel(): Promise<string>
  /** 设置后 resolve 生效档（U6 回执：pi 钳制时 ≠ 请求值；降级路径空串） */
  setThinkingLevel(level: string): Promise<string>
  getActiveTools(): Promise<string[]>
} {
  return {
    setModel: (model: string) =>
      rpcClient.request('plugin.agent.setModel', { pluginId, model }).then(v => (v as string) ?? ''),

    getModel: () =>
      rpcClient.request('plugin.agent.getModel', { pluginId }).then(v => (v as string) ?? ''),

    getThinkingLevel: () =>
      rpcClient.request('plugin.agent.getThinkingLevel', { pluginId }).then(v => (v as string) ?? ''),

    setThinkingLevel: (level: string) =>
      rpcClient.request('plugin.agent.setThinkingLevel', { pluginId, level }).then(v => (v as string) ?? ''),

    getActiveTools: () =>
      rpcClient.request('plugin.agent.getActiveTools', { pluginId }).then(v => (v as string[]) ?? []),
  }
}
